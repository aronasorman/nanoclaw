import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'path';

// --- Mocks (must be before imports that use them) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({ GROUPS_DIR: '/tmp/wsf-test-groups' }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('ws', () => ({
  default: class MockWs {
    on() {}
    close() {}
  },
}));

// Mock fs module
const mkdirSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const copyFileSyncMock = vi.fn();
const lstatSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const readdirSyncMock = vi.fn((..._args: unknown[]) => [] as string[]);
const readFileSyncMock = vi.fn((..._args: unknown[]) => '');
vi.mock('fs', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mkdirSync: (...args: any[]) => mkdirSyncMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    existsSync: (...args: any[]) => existsSyncMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    copyFileSync: (...args: any[]) => copyFileSyncMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lstatSync: (...args: any[]) => lstatSyncMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unlinkSync: (...args: any[]) => unlinkSyncMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readdirSync: (...args: any[]) => readdirSyncMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: (...args: any[]) => readFileSyncMock(...args),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mkdirSync: (...args: any[]) => mkdirSyncMock(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existsSync: (...args: any[]) => existsSyncMock(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copyFileSync: (...args: any[]) => copyFileSyncMock(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lstatSync: (...args: any[]) => lstatSyncMock(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unlinkSync: (...args: any[]) => unlinkSyncMock(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readdirSync: (...args: any[]) => readdirSyncMock(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readFileSync: (...args: any[]) => readFileSyncMock(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { WsfChannel } from './wsf.js';
import { ChannelOpts } from './registry.js';

// --- Helpers ---
const ROLES_DIR = '/home/aron/vaults/02-AGENTS/_global/roles';
const WIKI_VAULT_PATH = '/home/aron/vaults/02-AGENTS';

function createOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

describe('WsfChannel.ensureThreadRegistered', () => {
  let channel: WsfChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);
    existsSyncMock.mockReturnValue(false);
  });

  it('sets claudeMdSource when thread has a role with a matching file', async () => {
    const threadId = 'thread_abc123';
    const jid = `wsf:${threadId}`;
    const rolePath = path.join(ROLES_DIR, 'pm.md');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: threadId, role: 'pm', status: 'open' }),
    });

    existsSyncMock.mockImplementation((p: unknown) => String(p) === rolePath);

    await (channel as any).ensureThreadRegistered(jid);

    expect(opts.registerGroup).toHaveBeenCalledOnce();
    const call = (opts.registerGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    const groupConfig = call[1];
    expect(groupConfig.containerConfig).toBeDefined();
    expect(groupConfig.containerConfig.claudeMdSource).toBe(rolePath);

    // Wiki mount should be added
    const mounts = groupConfig.containerConfig.additionalMounts ?? [];
    const wikiMount = mounts.find(
      (m: { containerPath: string }) => m.containerPath === 'wiki',
    );
    expect(wikiMount).toBeDefined();
    expect(wikiMount.hostPath).toBe(WIKI_VAULT_PATH);
    expect(wikiMount.readonly).toBe(true);

    // Should NOT copy CLAUDE.md when claudeMdSource is set
    expect(copyFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to copying CLAUDE.md when role file does not exist', async () => {
    const threadId = 'thread_def456';
    const jid = `wsf:${threadId}`;
    const baseClaude = '/tmp/wsf-test-groups/wsf-tasks/CLAUDE.md';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: threadId,
        role: 'nonexistent-role',
        status: 'open',
      }),
    });

    // Role file doesn't exist, but base CLAUDE.md does
    existsSyncMock.mockImplementation((p: unknown) => String(p) === baseClaude);

    await (channel as any).ensureThreadRegistered(jid);

    expect(opts.registerGroup).toHaveBeenCalledOnce();
    const call = (opts.registerGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    const groupConfig = call[1];

    // claudeMdSource should NOT be set
    expect(groupConfig.containerConfig?.claudeMdSource).toBeUndefined();

    // Should fall back to copying CLAUDE.md
    expect(copyFileSyncMock).toHaveBeenCalledWith(
      baseClaude,
      expect.stringContaining('wsf-thread-def456'),
    );
  });

  it('uses default CLAUDE.md copy when thread has no role', async () => {
    const threadId = 'thread_ghi789';
    const jid = `wsf:${threadId}`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: threadId, status: 'open' }), // no role field
    });

    existsSyncMock.mockReturnValue(false);

    await (channel as any).ensureThreadRegistered(jid);

    expect(opts.registerGroup).toHaveBeenCalledOnce();
    const call = (opts.registerGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    const groupConfig = call[1];
    expect(groupConfig.containerConfig?.claudeMdSource).toBeUndefined();
  });

  it('skips already-registered jids', async () => {
    const jid = 'wsf:thread_already';
    opts = createOpts({
      registeredGroups: vi.fn(() => ({ [jid]: { folder: 'already' } as any })),
    });
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);

    await (channel as any).ensureThreadRegistered(jid);

    expect(opts.registerGroup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Phase 3: @Mention Routing ────────────────────────────────────────

describe('WsfChannel static helpers', () => {
  it('roleJid builds role-specific JID', () => {
    expect(WsfChannel.roleJid('t_abc', 'architect')).toBe(
      'wsf:t_abc:architect',
    );
  });

  it('parseRoleFromJid extracts role from role JID', () => {
    expect(WsfChannel.parseRoleFromJid('wsf:t_abc:architect')).toBe(
      'architect',
    );
  });

  it('parseRoleFromJid returns undefined for base JID', () => {
    expect(WsfChannel.parseRoleFromJid('wsf:t_abc')).toBeUndefined();
  });

  it('parseRoleFromJid returns undefined for non-wsf JID', () => {
    expect(WsfChannel.parseRoleFromJid('wa:123')).toBeUndefined();
  });

  it('threadIdFromJid handles role JIDs', () => {
    expect(WsfChannel.threadIdFromJid('wsf:t_abc:architect')).toBe('t_abc');
  });

  it('threadIdFromJid handles base JIDs', () => {
    expect(WsfChannel.threadIdFromJid('wsf:t_abc')).toBe('t_abc');
  });

  it('parseMentions returns valid roles only', () => {
    // Invalidate role cache before each parseMentions test
    (WsfChannel as any)._roleCache = null;
    readdirSyncMock.mockReturnValue(['architect.md', 'designer.md']);
    const result = WsfChannel.parseMentions(
      'Hey @architect please review @unknown',
    );
    expect(result).toEqual(['architect']);
  });

  it('parseMentions returns empty for no mentions', () => {
    (WsfChannel as any)._roleCache = null;
    readdirSyncMock.mockReturnValue([]);
    expect(WsfChannel.parseMentions('no mentions here')).toEqual([]);
  });

  it('parseMentions deduplicates mentions', () => {
    (WsfChannel as any)._roleCache = null;
    readdirSyncMock.mockReturnValue(['architect.md']);
    const result = WsfChannel.parseMentions('@architect do this @architect');
    expect(result).toEqual(['architect']);
  });
});

describe('WsfChannel @mention routing (deliverMessage)', () => {
  let channel: WsfChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);
    existsSyncMock.mockReturnValue(false);
  });

  it('routes @architect mention to both base and role JID', async () => {
    (WsfChannel as any)._roleCache = null;
    readdirSyncMock.mockReturnValue(['architect.md']);
    const architectPath = path.join(ROLES_DIR, 'architect.md');
    existsSyncMock.mockImplementation(
      (p: unknown) => String(p) === architectPath,
    );

    // Mock fetch: thread history (empty) + thread metadata
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ id: 't_3dcd0c25', status: 'open' }) };
    });

    const msg = {
      id: 'msg1',
      threadId: 't_3dcd0c25',
      sender: 'did:user:alice',
      body: 'Hey @architect please review',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };

    // Access private method via bracket notation
    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(2);

    // First call: base JID
    expect(onMessage.mock.calls[0][0]).toBe('wsf:t_3dcd0c25');
    // Second call: role JID
    expect(onMessage.mock.calls[1][0]).toBe('wsf:t_3dcd0c25:architect');
  });

  it('delivers only to base JID when @mention has no matching role file', async () => {
    (WsfChannel as any)._roleCache = null;
    readdirSyncMock.mockReturnValue([]);
    existsSyncMock.mockReturnValue(false); // no role files exist

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ id: 't_abc', status: 'open' }) };
    });

    const msg = {
      id: 'msg2',
      threadId: 't_abc',
      sender: 'did:user:bob',
      body: 'Hey @unknown do something',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toBe('wsf:t_abc');
  });

  it('delivers only to base JID when no @mentions present', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });

    const msg = {
      id: 'msg3',
      threadId: 't_xyz',
      sender: 'did:user:carol',
      body: 'Just a regular message',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toBe('wsf:t_xyz');
  });

  it('skips self-delivery when sender is botDid', async () => {
    const msg = {
      id: 'msg4',
      threadId: 't_xyz',
      sender: 'did:test:bot',
      body: 'Bot reply @architect',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('WsfChannel.sendMessage with role JIDs', () => {
  let channel: WsfChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);
  });

  it('posts to correct thread when sending from role JID', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await channel.sendMessage('wsf:t_abc:architect', 'Role reply');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8085/threads/t_abc/messages');
  });

  it('posts to correct thread when sending from base JID', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await channel.sendMessage('wsf:t_abc', 'Base reply');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8085/threads/t_abc/messages');
  });
});

describe('WsfChannel.ensureRoleRegistered', () => {
  let channel: WsfChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);
    existsSyncMock.mockReturnValue(false);
  });

  it('registers role group with claudeMdSource and wiki mount', async () => {
    const rolePath = path.join(ROLES_DIR, 'architect.md');
    existsSyncMock.mockImplementation((p: unknown) => String(p) === rolePath);

    await (channel as any).ensureRoleRegistered('t_abc', 'architect');

    const registerGroup = opts.registerGroup as ReturnType<typeof vi.fn>;
    expect(registerGroup).toHaveBeenCalledOnce();

    const [jid, config] = registerGroup.mock.calls[0];
    expect(jid).toBe('wsf:t_abc:architect');
    expect(config.folder).toBe('wsf-t-abc-architect');
    expect(config.name).toBe('WSF Tasks (architect)');
    expect(config.containerConfig.claudeMdSource).toBe(rolePath);

    const wikiMount = config.containerConfig.additionalMounts?.find(
      (m: { containerPath: string }) => m.containerPath === 'wiki',
    );
    expect(wikiMount).toBeDefined();
    expect(wikiMount.hostPath).toBe(WIKI_VAULT_PATH);
    expect(wikiMount.readonly).toBe(true);
  });

  it('skips registration when role file does not exist', async () => {
    existsSyncMock.mockReturnValue(false);

    await (channel as any).ensureRoleRegistered('t_abc', 'nonexistent');

    expect(opts.registerGroup).not.toHaveBeenCalled();
  });

  it('skips already-registered role JIDs', async () => {
    const roleJid = 'wsf:t_abc:architect';
    opts = createOpts({
      registeredGroups: vi.fn(() => ({
        [roleJid]: { folder: 'existing' } as any,
      })),
    });
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);

    await (channel as any).ensureRoleRegistered('t_abc', 'architect');

    expect(opts.registerGroup).not.toHaveBeenCalled();
  });
});

describe('WsfChannel thread history injection (Phase 4)', () => {
  let channel: WsfChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new WsfChannel('http://localhost:8085', 'did:test:bot', opts);
    existsSyncMock.mockReturnValue(false);
  });

  it('injects thread history on first message to base JID', async () => {
    const historyMessages = [
      {
        id: 'old1',
        threadId: 't_hist',
        sender: 'did:user:alice',
        body: 'I need help with auth',
        tag: 'note',
        createdAt: '2026-04-03T10:00:00Z',
      },
      {
        id: 'old2',
        threadId: 't_hist',
        sender: 'did:test:bot',
        body: 'Sure, what framework?',
        tag: 'note',
        createdAt: '2026-04-03T10:01:00Z',
      },
    ];

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => historyMessages };
      }
      return { ok: true, json: async () => ({}) };
    });

    const msg = {
      id: 'msg_new',
      threadId: 't_hist',
      sender: 'did:user:alice',
      body: 'NestJS please',
      tag: 'note',
      createdAt: '2026-04-03T10:02:00Z',
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);
    const delivered = onMessage.mock.calls[0][1];
    // Should contain history header + prior messages + current message
    expect(delivered.content).toContain('--- Thread History ---');
    expect(delivered.content).toContain('I need help with auth');
    expect(delivered.content).toContain('Sure, what framework?');
    expect(delivered.content).toContain('NestJS please');
    expect(delivered.content).toContain('--- End Thread History ---');
  });

  it('does NOT inject history on second message to same JID', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });

    const msg1 = {
      id: 'msg_a',
      threadId: 't_norepeat',
      sender: 'did:user:dave',
      body: 'First message',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };
    const msg2 = {
      id: 'msg_b',
      threadId: 't_norepeat',
      sender: 'did:user:dave',
      body: 'Second message',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };

    await (channel as any).deliverMessage(msg1);
    await (channel as any).deliverMessage(msg2);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(2);
    // Second message should NOT contain history markers
    const second = onMessage.mock.calls[1][1];
    expect(second.content).toBe('Second message');
    expect(second.content).not.toContain('--- Thread History ---');
  });

  it('excludes the current message from thread history', async () => {
    const historyMessages = [
      {
        id: 'msg_current',
        threadId: 't_excl',
        sender: 'did:user:eve',
        body: 'This should be excluded from history',
        tag: 'note',
        createdAt: '2026-04-03T10:00:00Z',
      },
      {
        id: 'msg_old',
        threadId: 't_excl',
        sender: 'did:user:frank',
        body: 'This should appear in history',
        tag: 'note',
        createdAt: '2026-04-03T09:00:00Z',
      },
    ];

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => historyMessages };
      }
      return { ok: true, json: async () => ({}) };
    });

    const msg = {
      id: 'msg_current',
      threadId: 't_excl',
      sender: 'did:user:eve',
      body: 'This should be excluded from history',
      tag: 'note',
      createdAt: '2026-04-03T10:00:00Z',
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    const delivered = onMessage.mock.calls[0][1];
    // History section should only have the old message, not the current one
    const historySection = delivered.content.split('--- End Thread History ---')[0];
    expect(historySection).toContain('This should appear in history');
    expect(historySection).not.toContain('This should be excluded from history');
  });

  it('injects history for role JIDs independently from base JID', async () => {
    (WsfChannel as any)._roleCache = null;
    readdirSyncMock.mockReturnValue(['architect.md']);
    const architectPath = path.join(ROLES_DIR, 'architect.md');
    existsSyncMock.mockImplementation(
      (p: unknown) => String(p) === architectPath,
    );

    const historyMessages = [
      {
        id: 'h1',
        threadId: 't_role',
        sender: 'did:user:alice',
        body: 'Initial task',
        tag: 'note',
        createdAt: '2026-04-03T10:00:00Z',
      },
    ];

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: true, json: async () => historyMessages };
      }
      return {
        ok: true,
        json: async () => ({ id: 't_role', status: 'open' }),
      };
    });

    const msg = {
      id: 'msg_role',
      threadId: 't_role',
      sender: 'did:user:alice',
      body: 'Hey @architect review this',
      tag: 'note',
      createdAt: '2026-04-03T10:05:00Z',
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(2);

    // Both base JID and role JID should get history on their first message
    const baseContent = onMessage.mock.calls[0][1].content;
    const roleContent = onMessage.mock.calls[1][1].content;
    expect(baseContent).toContain('--- Thread History ---');
    expect(roleContent).toContain('--- Thread History ---');
  });

  it('gracefully handles fetch failure for thread history', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/messages')) {
        return { ok: false, status: 500 };
      }
      return { ok: true, json: async () => ({}) };
    });

    const msg = {
      id: 'msg_fail',
      threadId: 't_fail',
      sender: 'did:user:grace',
      body: 'Should still deliver',
      tag: 'note',
      createdAt: new Date().toISOString(),
    };

    await (channel as any).deliverMessage(msg);

    const onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);
    // Falls back to delivering without history
    expect(onMessage.mock.calls[0][1].content).toBe('Should still deliver');
  });
});
