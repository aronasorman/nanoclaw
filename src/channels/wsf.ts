/**
 * WSF v2 Channel for NanoClaw — Multi-thread support
 *
 * Connects to the WSF Go server via WebSocket. Polls for unclaimed threads,
 * claims them, and delivers task messages to NanoClaw agents. Agent replies
 * are posted back to the WSF thread.
 *
 * Each thread gets its own virtual JID (wsf:{threadId}) so the group-queue
 * can run multiple containers in parallel, one per thread.
 *
 * Env vars:
 *   WSF_SERVER_URL  - HTTP base URL (default: http://localhost:8085)
 *   WSF_BOT_DID     - This bot's DID for claiming/sending
 */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { GROUPS_DIR } from '../config.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, ContainerConfig, NewMessage } from '../types.js';

const WSF_JID_PREFIX = 'wsf:';
const LEGACY_JID = 'wsf:default';
const POLL_INTERVAL_MS = 15_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

const WIKI_VAULT_PATH =
  process.env.WIKI_VAULT_PATH || '/home/aron/vaults/02-AGENTS';
const ROLES_DIR = path.join(WIKI_VAULT_PATH, '_global', 'roles');
const ROLES_CONFIG_PATH = path.join(ROLES_DIR, 'config.yml.md');

/** Provider env var presets. Keys match the `provider` field in config.yml.md. */
const PROVIDER_ENV: Record<string, Record<string, string>> = {
  zai: {
    ANTHROPIC_AUTH_TOKEN: process.env.ZAI_API_KEY || '',
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    API_TIMEOUT_MS: '3000000',
    // Route all Claude model aliases to GLM-5-Turbo
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5-turbo',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5-turbo',
  },
  // 'anthropic' is the default — no overrides needed
};

/** Per-role configuration parsed from config.yml.md */
interface RoleConfig {
  provider: string; // e.g. 'anthropic', 'zai'
  target: string; // e.g. '', 'host', 'machine:quiet4'
}

/**
 * Machine identity for this NanoClaw instance.
 * Used to filter execution targets: if a role's target is 'machine:X' and
 * X doesn't match this machine, the role is skipped (left for another instance).
 * Empty target means any machine can grab it.
 * 'host' means only the machine where the WSF Go server runs (i.e. this one).
 */
const MACHINE_NAME = process.env.NANOCLAW_MACHINE_NAME || 'host';

/**
 * Parse the fenced YAML block from config.yml.md and return a role→config map.
 * Falls back to empty map on any error (all roles default to anthropic, target: any).
 */
function loadRoleConfig(): Record<string, RoleConfig> {
  try {
    if (!fs.existsSync(ROLES_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(ROLES_CONFIG_PATH, 'utf-8');
    // Extract content between ```yaml and ```
    const match = raw.match(/```yaml\n([\s\S]*?)\n```/);
    if (!match) return {};
    const yaml = match[1];
    const result: Record<string, RoleConfig> = {};
    // Simple YAML parser — handles our flat structure
    let currentRole = '';
    for (const line of yaml.split('\n')) {
      const roleMatch = line.match(/^  (\w+):$/);
      if (roleMatch) {
        currentRole = roleMatch[1];
        result[currentRole] = { provider: 'anthropic', target: '' };
        continue;
      }
      if (!currentRole) continue;
      const providerMatch = line.match(/^    provider:\s*(\w+)/);
      if (providerMatch) {
        result[currentRole].provider = providerMatch[1];
      }
      const targetMatch = line.match(/^    target:\s*(\S+)/);
      if (targetMatch) {
        result[currentRole].target = targetMatch[1];
      }
    }
    return result;
  } catch (err) {
    logger.warn('[wsf] Failed to load role config', String(err));
    return {};
  }
}

/** Backward-compat wrapper — returns role→provider map */
function loadRoleProviders(): Record<string, string> {
  const config = loadRoleConfig();
  const result: Record<string, string> = {};
  for (const [role, cfg] of Object.entries(config)) {
    result[role] = cfg.provider;
  }
  return result;
}

/**
 * Check if this machine should execute a role based on its target config.
 * Returns true if the role should run here, false if it should be skipped.
 *
 * Rules:
 * - Empty target ("") → any machine can grab it → true
 * - "host" → only on the host machine (MACHINE_NAME === 'host') → true if match
 * - "machine:X" → only on machine X → true if MACHINE_NAME === X
 */
function shouldExecuteRole(role: string): boolean {
  const config = loadRoleConfig();
  const roleTarget = config[role]?.target || '';
  if (roleTarget === '') return true; // any machine
  if (roleTarget === 'host') return MACHINE_NAME === 'host';
  const machineMatch = roleTarget.match(/^machine:(.+)$/);
  if (machineMatch) return MACHINE_NAME === machineMatch[1];
  // Unknown target format — log and skip
  logger.warn(
    `[wsf] Unknown target format '${roleTarget}' for role '${role}', skipping`,
  );
  return false;
}

interface WsfThread {
  id: string;
  title: string;
  creator: string;
  participants: string[];
  status: string;
  budget: number;
  createdAt: string;
  role?: string;
  target?: string; // execution target: '', 'host', 'machine:{name}'
}

interface WsfMessage {
  id: string;
  threadId: string;
  sender: string;
  body: string;
  details?: string;
  tag: string;
  createdAt: string;
}

export class WsfChannel implements Channel {
  name = 'wsf';

  private serverUrl: string;
  private botDid: string;
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];
  private registerGroup: ChannelOpts['registerGroup'];
  private registeredGroups: ChannelOpts['registeredGroups'];
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = WS_RECONNECT_BASE_MS;
  private connected = false;
  private stopping = false;
  private claimedThreads = new Set<string>();
  private seenMessages = new Set<string>();
  // Active threads: threadId → true. Cleared when container finishes.
  private activeThreads = new Set<string>();
  // Role JIDs that have received their initial thread history injection.
  private historyInjected = new Set<string>();

  constructor(serverUrl: string, botDid: string, opts: ChannelOpts) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.botDid = botDid;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registerGroup = opts.registerGroup;
    this.registeredGroups = opts.registeredGroups;
  }

  /** Convert thread ID to virtual JID */
  static threadJid(threadId: string): string {
    return `${WSF_JID_PREFIX}${threadId}`;
  }

  /** Extract thread ID from virtual JID, or null if not a WSF JID.
   *  Handles both wsf:t_xxx and wsf:t_xxx:role formats. */
  static threadIdFromJid(jid: string): string | null {
    if (!jid.startsWith(WSF_JID_PREFIX)) return null;
    const rest = jid.slice(WSF_JID_PREFIX.length);
    if (rest === 'default') return null;
    // Strip role suffix if present: t_xxx:role -> t_xxx
    const colonIdx = rest.indexOf(':');
    return colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
  }

  /** Build a role-specific JID: wsf:t_{threadId}:{role} */
  static roleJid(threadId: string, role: string): string {
    return `${WSF_JID_PREFIX}${threadId}:${role}`;
  }

  /** Extract role from a role-specific JID, or undefined if base JID */
  static parseRoleFromJid(jid: string): string | undefined {
    if (!jid.startsWith(WSF_JID_PREFIX)) return undefined;
    const rest = jid.slice(WSF_JID_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    return colonIdx >= 0 ? rest.slice(colonIdx + 1) : undefined;
  }

  /** Return the set of available role names (cached, refreshed periodically). */
  private static _roleCache: Set<string> | null = null;
  private static _roleCacheTime = 0;
  private static readonly ROLE_CACHE_TTL_MS = 30_000;

  static availableRoles(): Set<string> {
    const now = Date.now();
    if (
      WsfChannel._roleCache &&
      now - WsfChannel._roleCacheTime < WsfChannel.ROLE_CACHE_TTL_MS
    ) {
      return WsfChannel._roleCache;
    }
    const roles = new Set<string>();
    try {
      const entries = fs.readdirSync(ROLES_DIR);
      for (const e of entries) {
        if (e.endsWith('.md')) roles.add(e.slice(0, -3));
      }
    } catch {
      // ROLES_DIR may not exist yet
    }
    WsfChannel._roleCache = roles;
    WsfChannel._roleCacheTime = now;
    return roles;
  }

  /** Extract valid @role mentions from message body.
   *  Only returns roles that have a matching file in ROLES_DIR. */
  static parseMentions(body: string): string[] {
    const matches = body.match(/@(\w+)/g);
    if (!matches) return [];
    const available = WsfChannel.availableRoles();
    const roles: string[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const role = m.slice(1); // strip @
      if (seen.has(role)) continue;
      seen.add(role);
      if (available.has(role)) {
        roles.push(role);
      }
    }
    return roles;
  }

  async connect(): Promise<void> {
    logger.info(`[wsf] Connecting to ${this.serverUrl} as ${this.botDid}`);
    this.connectWs();
    this.pollTimer = setInterval(
      () => this.pollOpenThreads(),
      POLL_INTERVAL_MS,
    );
    await this.pollOpenThreads();
    this.connected = true;
    logger.info('[wsf] Channel connected');
  }

  private connectWs(): void {
    if (this.stopping) return;
    const wsUrl =
      this.serverUrl.replace(/^http/, 'ws') +
      `/ws?did=${encodeURIComponent(this.botDid)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      logger.info('[wsf] WebSocket connected');
      this.reconnectDelay = WS_RECONNECT_BASE_MS;
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const envelope = JSON.parse(data.toString());
        // WSF server sends {type, threadId, message: {...}}
        const msg: WsfMessage = envelope.message ?? envelope;
        if (!msg.sender || !msg.body) return;
        if (msg.sender === this.botDid) return;
        if (this.seenMessages.has(msg.id)) return;
        this.seenMessages.add(msg.id);

        // If this is a new message on a claimed thread, ensure the group
        // is registered so the message loop can pick it up.
        if (msg.threadId) {
          const jid = WsfChannel.threadJid(msg.threadId);
          await this.ensureThreadRegistered(jid);
        }

        logger.info(
          `[wsf] WS message: ${msg.id} on ${msg.threadId} from ${msg.sender.slice(-8)}`,
        );
        await this.deliverMessage(msg);
      } catch {
        // skip unparseable messages
      }
    });

    this.ws.on('close', () => {
      if (this.stopping) return;
      logger.warn(
        `[wsf] WebSocket disconnected, reconnecting in ${this.reconnectDelay}ms`,
      );
      setTimeout(() => this.connectWs(), this.reconnectDelay);
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        WS_RECONNECT_MAX_MS,
      );
    });

    this.ws.on('error', (err: Error) => {
      logger.warn(`[wsf] WebSocket error: ${err.message}`);
    });
  }

  /**
   * Called by GroupQueue when a container finishes for a WSF thread.
   * The groupJid tells us which thread finished.
   * Checks if the thread is closed and cleans up if so.
   */
  clearActiveThread(groupJid: string): void {
    const threadId = WsfChannel.threadIdFromJid(groupJid);
    if (threadId && this.activeThreads.has(threadId)) {
      logger.info(`[wsf] Container done, clearing active thread ${threadId}`);
      this.activeThreads.delete(threadId);
      // Check if the thread is closed; if so, clean up the dynamic folder
      this.maybeCleanupThread(threadId).catch((err) =>
        logger.warn(`[wsf] Cleanup error for ${threadId}: ${err}`),
      );
    }
  }

  /** Remove per-thread group folder if the thread is closed. */
  private async maybeCleanupThread(threadId: string): Promise<void> {
    try {
      const resp = await fetch(`${this.serverUrl}/threads/${threadId}`);
      if (!resp.ok) return;
      const thread: WsfThread = (await resp.json()) as WsfThread;
      if (thread.status !== 'closed') return;

      const folder = `wsf-${threadId.replace(/_/g, '-')}`;
      const threadDir = path.join(GROUPS_DIR, folder);
      if (fs.existsSync(threadDir)) {
        fs.rmSync(threadDir, { recursive: true, force: true });
        logger.info(`[wsf] Cleaned up folder for closed thread ${threadId}`);
      }
      // Session data stays (for forensics) — only the group dir is cleaned
    } catch {
      // non-critical
    }
  }

  private async pollOpenThreads(): Promise<void> {
    try {
      const resp = await fetch(`${this.serverUrl}/threads?status=open`);
      if (!resp.ok) return;

      const threads: WsfThread[] = (await resp.json()) as WsfThread[];

      for (const thread of threads) {
        if (this.claimedThreads.has(thread.id)) continue;
        if (this.activeThreads.has(thread.id)) continue;

        const claimed = await this.claimThread(thread.id);
        if (!claimed) continue;

        logger.info(`[wsf] Claimed thread ${thread.id}: ${thread.title}`);
        this.claimedThreads.add(thread.id);
        this.activeThreads.add(thread.id);

        await this.fetchAndDeliverMessages(thread.id);
        // Don't break — claim all available threads
      }
    } catch (err) {
      logger.warn(`[wsf] Poll error: ${err}`);
    }
  }

  private async claimThread(threadId: string): Promise<boolean> {
    try {
      const resp = await fetch(`${this.serverUrl}/threads/${threadId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: this.botDid }),
      });
      if (resp.status === 200) return true;
      if (resp.status === 409) {
        this.claimedThreads.add(threadId);
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async fetchAndDeliverMessages(threadId: string): Promise<void> {
    try {
      const resp = await fetch(
        `${this.serverUrl}/threads/${threadId}/messages`,
      );
      if (!resp.ok) return;

      const messages: WsfMessage[] = (await resp.json()) as WsfMessage[];
      const jid = WsfChannel.threadJid(threadId);

      // Dynamically register this thread as a group so the message loop
      // and container-runner know how to handle it. The group-queue treats
      // each JID independently. Role-based threads get their own CLAUDE.md
      // via claudeMdSource; others share the wsf-tasks CLAUDE.md copy.
      await this.ensureThreadRegistered(jid);

      this.onChatMetadata(
        jid,
        new Date().toISOString(),
        'WSF Tasks',
        'wsf',
        false,
      );

      for (const msg of messages) {
        if (msg.sender === this.botDid) continue;
        if (this.seenMessages.has(msg.id)) continue;
        this.seenMessages.add(msg.id);
        await this.deliverMessage(msg);
      }
    } catch (err) {
      logger.warn(`[wsf] Fetch messages error: ${err}`);
    }
  }

  /**
   * Copy Claude credentials from wsf-tasks to a thread/role folder.
   * Handles initial copy and stale symlink replacement.
   */
  private copyCredentials(folder: string): void {
    const dataDir = path.resolve(GROUPS_DIR, '..', 'data');
    const baseCreds = path.join(
      dataDir,
      'sessions',
      'wsf-tasks',
      '.claude',
      '.credentials.json',
    );
    const sessionDir = path.join(dataDir, 'sessions', folder, '.claude');
    const creds = path.join(sessionDir, '.credentials.json');

    if (!fs.existsSync(baseCreds)) return;

    if (!fs.existsSync(creds)) {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.copyFileSync(baseCreds, creds);
      logger.info(`[wsf] Copied credentials for ${folder}`);
    } else if (fs.lstatSync(creds).isSymbolicLink()) {
      // Replace stale symlink with a copy
      fs.unlinkSync(creds);
      fs.copyFileSync(baseCreds, creds);
      logger.info(`[wsf] Replaced symlink with copy for ${folder} credentials`);
    }
  }

  /**
   * Register a WSF thread as a group if not already registered.
   * Each thread gets its own folder (wsf-t-XXXX) for session/IPC isolation.
   *
   * If the thread has a `role` field and a matching role file exists at
   * ROLES_DIR/{role}.md, sets claudeMdSource to that path
   * (container-runner.ts bind-mounts it as CLAUDE.md).
   * Otherwise falls back to copying CLAUDE.md from the base wsf-tasks folder.
   */
  private async ensureThreadRegistered(jid: string): Promise<void> {
    const groups = this.registeredGroups();
    if (groups[jid]) return;
    if (!this.registerGroup) {
      logger.warn(`[wsf] registerGroup not available, cannot register ${jid}`);
      return;
    }

    const threadId = WsfChannel.threadIdFromJid(jid);
    if (!threadId) return;

    // Fetch thread metadata to check for a role and execution target
    let role: string | undefined;
    let threadTarget: string | undefined;
    try {
      const resp = await fetch(`${this.serverUrl}/threads/${threadId}`);
      if (resp.ok) {
        const thread: WsfThread = (await resp.json()) as WsfThread;
        role = thread.role || undefined;
        threadTarget = thread.target || undefined;
      }
    } catch (err) {
      logger.warn(
        `[wsf] Failed to fetch thread metadata for ${threadId}: ${err}`,
      );
    }

    // Check thread-level execution target
    if (threadTarget) {
      const isHost =
        threadTarget === 'host' && MACHINE_NAME === 'host';
      const machineMatch = threadTarget.match(/^machine:(.+)$/);
      const isMachine = machineMatch && MACHINE_NAME === machineMatch[1];
      if (!isHost && !isMachine && threadTarget !== '') {
        logger.info(
          `[wsf] Skipping thread ${threadId} — target '${threadTarget}' doesn't match this machine '${MACHINE_NAME}'`,
        );
        return;
      }
    }

    // Resolve role file if specified
    let roleFilePath: string | undefined;
    if (role) {
      const candidate = path.join(ROLES_DIR, `${role}.md`);
      if (fs.existsSync(candidate)) {
        roleFilePath = candidate;
        logger.info(
          `[wsf] Thread ${threadId} has role '${role}', using ${candidate}`,
        );
      } else {
        logger.warn(
          `[wsf] Thread ${threadId} has role '${role}' but ${candidate} not found, falling back to default CLAUDE.md`,
        );
      }
    }

    // Folder name: wsf-t-XXXX (underscores in thread IDs replaced with hyphens)
    const folder = `wsf-${threadId.replace(/_/g, '-')}`;

    // Ensure the thread's group folder and logs dir exist
    const threadDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(path.join(threadDir, 'logs'), { recursive: true });

    // Only copy CLAUDE.md from wsf-tasks when no role-based claudeMdSource is set
    // (the bind mount in container-runner.ts handles it when claudeMdSource is set)
    if (!roleFilePath) {
      const baseDir = path.join(GROUPS_DIR, 'wsf-tasks');
      const baseClaude = path.join(baseDir, 'CLAUDE.md');
      const threadClaude = path.join(threadDir, 'CLAUDE.md');

      if (fs.existsSync(baseClaude) && !fs.existsSync(threadClaude)) {
        // Copy (not symlink) — Docker bind-mounts don't resolve host-path symlinks
        fs.copyFileSync(baseClaude, threadClaude);
        logger.info(`[wsf] Copied CLAUDE.md for ${folder}`);
      }
    }

    this.copyCredentials(folder);

    // Inherit containerConfig from the base wsf-tasks group (repo mounts, etc.)
    const baseGroup =
      groups['wsf:default'] ||
      Object.values(groups).find((g) => g.folder === 'wsf-tasks');

    const baseConfig: ContainerConfig = baseGroup?.containerConfig
      ? { ...baseGroup.containerConfig }
      : {};

    // When a role is specified, set claudeMdSource and add wiki vault mount
    if (roleFilePath) {
      baseConfig.claudeMdSource = roleFilePath;

      const existing = baseConfig.additionalMounts || [];
      const hasWiki = existing.some((m) => m.containerPath === 'wiki');
      if (!hasWiki) {
        baseConfig.additionalMounts = [
          ...existing,
          { hostPath: WIKI_VAULT_PATH, containerPath: 'wiki', readonly: true },
        ];
      }
    }

    this.registerGroup(jid, {
      name: 'WSF Tasks',
      folder,
      trigger: '',
      requiresTrigger: false,
      added_at: new Date().toISOString(),
      ...(Object.keys(baseConfig).length > 0
        ? { containerConfig: baseConfig }
        : {}),
    });
    logger.info(`[wsf] Registered thread group: ${jid} (folder: ${folder})`);
  }

  /**
   * Register a role-specific group JID (wsf:t_xxx:role) for @mention routing.
   * Each role gets its own folder and claudeMdSource pointing to the role file.
   */
  private async ensureRoleRegistered(
    threadId: string,
    role: string,
  ): Promise<void> {
    const jid = WsfChannel.roleJid(threadId, role);
    const groups = this.registeredGroups();
    if (groups[jid]) return;
    if (!this.registerGroup) {
      logger.warn(
        `[wsf] registerGroup not available, cannot register role ${jid}`,
      );
      return;
    }

    const roleFilePath = path.join(ROLES_DIR, `${role}.md`);
    if (!fs.existsSync(roleFilePath)) {
      logger.warn(`[wsf] Role file not found: ${roleFilePath}`);
      return;
    }

    const folder = `wsf-${threadId.replace(/_/g, '-')}-${role}`;
    fs.mkdirSync(path.join(GROUPS_DIR, folder, 'logs'), { recursive: true });
    this.copyCredentials(folder);

    // Inherit containerConfig from base wsf-tasks group
    const baseGroup =
      groups['wsf:default'] ||
      Object.values(groups).find((g) => g.folder === 'wsf-tasks');
    const baseConfig: ContainerConfig = baseGroup?.containerConfig
      ? { ...baseGroup.containerConfig }
      : {};

    baseConfig.claudeMdSource = roleFilePath;
    const existing = baseConfig.additionalMounts || [];
    const hasWiki = existing.some((m) => m.containerPath === 'wiki');
    if (!hasWiki) {
      // Scribe gets read-write wiki access; all other roles get read-only
      const wikiReadonly = role !== 'scribe';
      baseConfig.additionalMounts = [
        ...existing,
        {
          hostPath: WIKI_VAULT_PATH,
          containerPath: 'wiki',
          readonly: wikiReadonly,
        },
      ];
    }

    // Inject provider-specific env vars (e.g., Z.AI for implementer)
    const roleProviders = loadRoleProviders();
    const provider = roleProviders[role] || 'anthropic';
    const providerEnv = PROVIDER_ENV[provider];
    if (providerEnv) {
      baseConfig.envOverrides = {
        ...(baseConfig.envOverrides || {}),
        ...providerEnv,
      };
      logger.info(`[wsf] Role ${role} using provider: ${provider}`);
    }

    this.registerGroup(jid, {
      name: `WSF Tasks (${role})`,
      folder,
      trigger: '',
      requiresTrigger: false,
      added_at: new Date().toISOString(),
      containerConfig: baseConfig,
    });
    logger.info(`[wsf] Registered role group: ${jid} (folder: ${folder})`);
  }

  /**
   * Fetch all messages in a thread from the Go server and format them
   * as a conversation transcript for context injection.
   */
  private async fetchThreadHistory(
    threadId: string,
    excludeMessageId?: string,
  ): Promise<string | null> {
    try {
      const resp = await fetch(
        `${this.serverUrl}/threads/${threadId}/messages`,
      );
      if (!resp.ok) {
        logger.warn(`[wsf] Failed to fetch thread history: ${resp.status}`);
        return null;
      }
      const messages: WsfMessage[] = (await resp.json()) as WsfMessage[];
      // Filter out the current message to avoid duplication
      const history = messages.filter((m) => m.id !== excludeMessageId);
      if (history.length === 0) return null;

      const lines = history.map((m) => {
        const sender = m.sender.split(':').pop() || m.sender;
        const body = m.details ? `${m.body}\n\n${m.details}` : m.body;
        return `[${sender}]: ${body}`;
      });

      return (
        '--- Thread History ---\n' +
        lines.join('\n\n') +
        '\n--- End Thread History ---'
      );
    } catch (err) {
      logger.warn(`[wsf] Error fetching thread history: ${String(err)}`);
      return null;
    }
  }

  private async deliverMessage(msg: WsfMessage): Promise<void> {
    // Skip self-delivery: bot's own replies flow back via WebSocket
    if (msg.sender === this.botDid) return;

    const jid = WsfChannel.threadJid(msg.threadId);
    // Include details (full task spec) if present — body alone is just the summary
    const content = msg.details ? `${msg.body}\n\n${msg.details}` : msg.body;

    const buildMessage = (
      targetJid: string,
      contentOverride?: string,
    ): NewMessage => ({
      id: msg.id,
      chat_jid: targetJid,
      sender: msg.sender,
      sender_name: msg.sender.split(':').pop() || msg.sender,
      content: contentOverride ?? content,
      timestamp: msg.createdAt,
      thread_id: msg.threadId,
    });

    // Always deliver to the base thread JID (PM sees everything)
    // PM gets history injection on first message too
    if (!this.historyInjected.has(jid)) {
      this.historyInjected.add(jid);
      const history = await this.fetchThreadHistory(msg.threadId, msg.id);
      if (history) {
        const enriched = `${history}\n\n${content}`;
        logger.info(
          `[wsf] Delivering message ${msg.id} to ${jid} with thread history`,
        );
        this.onMessage(jid, buildMessage(jid, enriched));
      } else {
        logger.info(
          `[wsf] Delivering message ${msg.id} to ${jid} (no prior history)`,
        );
        this.onMessage(jid, buildMessage(jid));
      }
    } else {
      logger.info(`[wsf] Delivering message ${msg.id} to ${jid}`);
      this.onMessage(jid, buildMessage(jid));
    }

    // Parse @mentions and route to role-specific containers
    const roles = WsfChannel.parseMentions(msg.body);
    for (const role of roles) {
      // Check execution target — skip if this machine shouldn't run this role
      if (!shouldExecuteRole(role)) {
        logger.info(
          `[wsf] Skipping @${role} — target mismatch (this=${MACHINE_NAME})`,
        );
        continue;
      }
      const roleJid = WsfChannel.roleJid(msg.threadId, role);
      await this.ensureRoleRegistered(msg.threadId, role);

      // Inject thread history on first message to a role container
      if (!this.historyInjected.has(roleJid)) {
        this.historyInjected.add(roleJid);
        const history = await this.fetchThreadHistory(msg.threadId, msg.id);
        const enriched = history ? `${history}\n\n${content}` : content;
        logger.info(
          `[wsf] Routing @${role} mention to ${roleJid} with thread history`,
        );
        this.onMessage(roleJid, buildMessage(roleJid, enriched));
      } else {
        logger.info(`[wsf] Routing @${role} mention to ${roleJid}`);
        this.onMessage(roleJid, buildMessage(roleJid));
      }
    }

    // Scribe receives ALL messages as passive observer (like PM/base JID).
    // Only activate if scribe role file exists and target matches.
    const scribeRoleFile = path.join(ROLES_DIR, 'scribe.md');
    if (
      fs.existsSync(scribeRoleFile) &&
      !roles.includes('scribe') && // avoid double-delivery if explicitly @mentioned
      shouldExecuteRole('scribe')
    ) {
      const scribeJid = WsfChannel.roleJid(msg.threadId, 'scribe');
      await this.ensureRoleRegistered(msg.threadId, 'scribe');

      if (!this.historyInjected.has(scribeJid)) {
        this.historyInjected.add(scribeJid);
        const history = await this.fetchThreadHistory(msg.threadId, msg.id);
        const enriched = history ? `${history}\n\n${content}` : content;
        logger.info(
          `[wsf] Delivering to scribe ${scribeJid} with thread history`,
        );
        this.onMessage(scribeJid, buildMessage(scribeJid, enriched));
      } else {
        logger.info(`[wsf] Delivering to scribe ${scribeJid}`);
        this.onMessage(scribeJid, buildMessage(scribeJid));
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Extract thread ID from the virtual JID
    const threadId = WsfChannel.threadIdFromJid(jid);
    if (!threadId) {
      logger.warn(`[wsf] sendMessage: cannot extract thread from jid ${jid}`);
      return;
    }

    // Split agent output: first line = summary (≤280 chars for Bluesky),
    // full text goes into details.
    const MAX_SUMMARY = 280;
    let summary: string;
    let details: string | undefined;

    const firstNewline = text.indexOf('\n');
    const firstLine =
      firstNewline > 0 ? text.slice(0, firstNewline).trim() : text.trim();

    if (text.length <= MAX_SUMMARY) {
      summary = text;
    } else if (firstLine.length <= MAX_SUMMARY && firstNewline > 0) {
      summary = firstLine;
      details = text;
    } else {
      summary = text.slice(0, MAX_SUMMARY - 1) + '…';
      details = text;
    }

    const resp = await fetch(`${this.serverUrl}/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: this.botDid,
        message: summary,
        ...(details ? { details } : {}),
        tag: 'note',
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`WSF POST failed (${resp.status}): ${body}`);
    }

    logger.info(
      `[wsf] Reply posted to thread ${threadId} (summary: ${summary.length} chars, details: ${details ? details.length : 0} chars)`,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WSF_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('[wsf] Channel disconnected');
  }
}

// ── Self-register ────────────────────────────────────────────────────

registerChannel('wsf', (opts: ChannelOpts) => {
  const env = readEnvFile(['WSF_SERVER_URL', 'WSF_BOT_DID']);
  const serverUrl = env.WSF_SERVER_URL || process.env.WSF_SERVER_URL;
  const botDid = env.WSF_BOT_DID || process.env.WSF_BOT_DID;

  if (!serverUrl || !botDid) {
    logger.info('[wsf] WSF_SERVER_URL or WSF_BOT_DID not set, skipping');
    return null;
  }

  return new WsfChannel(serverUrl, botDid, opts);
});
