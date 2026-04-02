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

interface WsfThread {
  id: string;
  title: string;
  creator: string;
  participants: string[];
  status: string;
  budget: number;
  createdAt: string;
  role?: string;
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

  /** Extract thread ID from virtual JID, or null if not a WSF JID */
  static threadIdFromJid(jid: string): string | null {
    if (!jid.startsWith(WSF_JID_PREFIX)) return null;
    const id = jid.slice(WSF_JID_PREFIX.length);
    return id === 'default' ? null : id;
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
        this.deliverMessage(msg);
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
        this.deliverMessage(msg);
      }
    } catch (err) {
      logger.warn(`[wsf] Fetch messages error: ${err}`);
    }
  }

  /**
   * Register a WSF thread as a group if not already registered.
   * Each thread gets its own folder (wsf-t-XXXX) for session/IPC isolation.
   *
   * If the thread has a `role` field and a matching role file exists at
   * /home/aron/vaults/02-AGENTS/_global/roles/{role}.md, sets claudeMdSource
   * to that path (container-runner.ts bind-mounts it as CLAUDE.md).
   * Otherwise falls back to copying CLAUDE.md from the base wsf-tasks folder.
   */
  async ensureThreadRegistered(jid: string): Promise<void> {
    const groups = this.registeredGroups();
    if (groups[jid]) return;
    if (!this.registerGroup) {
      logger.warn(`[wsf] registerGroup not available, cannot register ${jid}`);
      return;
    }

    const threadId = WsfChannel.threadIdFromJid(jid);
    if (!threadId) return;

    // Fetch thread metadata to check for a role
    let role: string | undefined;
    try {
      const resp = await fetch(`${this.serverUrl}/threads/${threadId}`);
      if (resp.ok) {
        const thread: WsfThread = (await resp.json()) as WsfThread;
        role = thread.role || undefined;
      }
    } catch (err) {
      logger.warn(`[wsf] Failed to fetch thread metadata for ${threadId}: ${err}`);
    }

    // Resolve role file if specified
    let roleFilePath: string | undefined;
    if (role) {
      const candidate = path.join(ROLES_DIR, `${role}.md`);
      if (fs.existsSync(candidate)) {
        roleFilePath = candidate;
        logger.info(`[wsf] Thread ${threadId} has role '${role}', using ${candidate}`);
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

    // Copy Claude credentials so the container can authenticate.
    // OneCLI gateway isn't reachable; containers rely on this file.
    // We copy instead of symlink because Docker bind-mounts don't resolve
    // host-path symlinks inside the container.
    const dataDir = path.resolve(GROUPS_DIR, '..', 'data');
    const baseCreds = path.join(
      dataDir,
      'sessions',
      'wsf-tasks',
      '.claude',
      '.credentials.json',
    );
    const threadSessionDir = path.join(dataDir, 'sessions', folder, '.claude');
    const threadCreds = path.join(threadSessionDir, '.credentials.json');
    if (fs.existsSync(baseCreds) && !fs.existsSync(threadCreds)) {
      fs.mkdirSync(threadSessionDir, { recursive: true });
      fs.copyFileSync(baseCreds, threadCreds);
      logger.info(`[wsf] Copied credentials for ${folder}`);
    } else if (
      fs.existsSync(baseCreds) &&
      fs.lstatSync(threadCreds).isSymbolicLink()
    ) {
      // Replace stale symlink with a copy
      fs.unlinkSync(threadCreds);
      fs.copyFileSync(baseCreds, threadCreds);
      logger.info(`[wsf] Replaced symlink with copy for ${folder} credentials`);
    }

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

      const wikiMount = {
        hostPath: WIKI_VAULT_PATH,
        containerPath: 'wiki',
        readonly: true,
      };
      baseConfig.additionalMounts = [
        ...(baseConfig.additionalMounts || []),
        wikiMount,
      ];
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

  private deliverMessage(msg: WsfMessage): void {
    const jid = WsfChannel.threadJid(msg.threadId);
    // Include details (full task spec) if present — body alone is just the summary
    const content = msg.details ? `${msg.body}\n\n${msg.details}` : msg.body;
    const newMessage: NewMessage = {
      id: msg.id,
      chat_jid: jid,
      sender: msg.sender,
      sender_name: msg.sender.split(':').pop() || msg.sender,
      content,
      timestamp: msg.createdAt,
      thread_id: msg.threadId,
    };
    logger.info(
      `[wsf] Delivering message ${msg.id} to ${jid} (${msg.body.slice(0, 50)}...)`,
    );
    this.onMessage(jid, newMessage);
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
