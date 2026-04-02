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
  default: class MockWs { on() {} close() {} },
}));

// Mock fs module
const mkdirSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const copyFileSyncMock = vi.fn();
const lstatSyncMock = vi.fn();
vi.mock('fs', () => ({
  default: {
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
    lstatSync: (...args: unknown[]) => lstatSyncMock(...args),
  },
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
  lstatSync: (...args: unknown[]) => lstatSyncMock(...args),
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

    await channel.ensureThreadRegistered(jid);

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
      json: async () => ({ id: threadId, role: 'nonexistent-role', status: 'open' }),
    });

    // Role file doesn't exist, but base CLAUDE.md does
    existsSyncMock.mockImplementation((p: unknown) => String(p) === baseClaude);

    await channel.ensureThreadRegistered(jid);

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

    await channel.ensureThreadRegistered(jid);

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

    await channel.ensureThreadRegistered(jid);

    expect(opts.registerGroup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
