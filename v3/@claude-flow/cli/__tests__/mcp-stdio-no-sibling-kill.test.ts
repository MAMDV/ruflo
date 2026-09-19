// #3364: `mcp start` on the stdio transport SIGKILLed whichever MCP server was
// recorded in the per-user PID file ($TMPDIR/claude-flow-mcp.pid): another
// stdio server started from a terminal, or a running http/websocket server.
// commands/mcp.ts forced a "restart" for stdio (`shouldForceRestart = force ||
// transport === 'stdio'`) because a stdio server can't be health-checked, and
// MCPServerManager.start() refused to start next to any live recorded PID.
// This path runs whenever `mcp start` goes through the command parser: stdin is
// a TTY (a terminal), or argv does not begin with `mcp [start]` (a leading
// global flag, e.g. `-Q mcp start`), or the transport is http/websocket.
// bin/cli.js answers the documented piped-stdin `mcp start` from its inline
// fast path, which never reads the file.
//
// A stdio server is owned by the client that spawned it, over that client's own
// pipes, so any number can run side by side. The single-instance PID file only
// makes sense for a port-bound transport. These tests pin both halves:
//   1. commands/mcp.ts — stdio start never kills or clears a recorded server
//      unless --force is given; http keeps its "already running" guard.
//   2. MCPServerManager — a stdio server neither refuses to start over, nor
//      overwrites, nor removes, nor health-checks the PID file of another
//      server. The fix keys on transport, so it covers every route above.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const h = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  manager: {
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ healthy: true })),
  },
}));

// Command-level tests drive commands/mcp.ts against a fake manager. The real
// MCPServerManager is loaded with vi.importActual in the second block.
vi.mock('../src/mcp-server.js', () => ({
  MCPServerManager: class {},
  createMCPServerManager: vi.fn(),
  getServerManager: vi.fn(() => h.manager),
  startMCPServer: vi.fn(),
  stopMCPServer: vi.fn(),
  getMCPServerStatus: vi.fn(async () => h.status),
  filterAdvertisedMcpTools: (tools: unknown[]) => tools,
  parseMcpToolSelection: () => 'all',
}));

// mcp-client.js pulls in the full tool registry; the start path never needs it.
vi.mock('../src/mcp-client.js', () => ({
  listMCPTools: () => [],
  callMCPTool: vi.fn(),
  hasTool: vi.fn(),
  getToolMetadata: vi.fn(),
}));

vi.mock('../src/runtime/parent-death-watchdog.js', () => ({ installParentDeathWatchdog: vi.fn() }));
vi.mock('../src/prompt.js', () => ({ select: vi.fn(), confirm: vi.fn() }));
vi.mock('../src/output.js', () => ({
  output: {
    writeln: vi.fn(),
    printInfo: vi.fn(),
    printWarning: vi.fn(),
    printError: vi.fn(),
    printSuccess: vi.fn(),
    printTable: vi.fn(),
    dim: (value: string) => value,
    success: (value: string) => value,
    bold: (value: string) => value,
  },
}));

import { mcpCommand } from '../src/commands/mcp.js';

// A real, live node process standing in for the other server: the manager's
// isProcessRunning() checks both `kill -0` and that the PID is a node process.
let sibling: ChildProcess;
beforeAll(() => {
  sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
});
afterAll(() => {
  sibling.kill('SIGKILL');
});
const siblingAlive = () => sibling.exitCode === null && sibling.signalCode === null;

describe('mcp start: stdio never kills a recorded server (#3364)', () => {
  const start = mcpCommand.subcommands!.find((command) => command.name === 'start')!;
  const run = (flags: Record<string, unknown>) =>
    start.action!({ args: [], flags, interactive: false } as never);
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.status = { running: true, pid: sibling.pid, transport: 'stdio' };
    // A successful start blocks forever (#2984), so park it inside
    // manager.start(): every kill/cleanup decision is made before that.
    h.manager.start.mockReset().mockImplementation(() => new Promise(() => {}));
    h.manager.stop.mockClear();
    h.manager.checkHealth.mockReset().mockResolvedValue({ healthy: true });
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => {
    kill.mockRestore();
  });

  it('starts next to a running server without signalling it or clearing its PID file', async () => {
    void run({ transport: 'stdio' });
    await vi.waitFor(() => expect(h.manager.start).toHaveBeenCalled());

    expect(kill).not.toHaveBeenCalled();
    expect(h.manager.stop).not.toHaveBeenCalled();
  });

  it('still kills the recorded server when --force is given (explicit opt-in)', async () => {
    void run({ transport: 'stdio', force: true });
    await vi.waitFor(() => expect(h.manager.start).toHaveBeenCalled());

    expect(kill).toHaveBeenCalledWith(sibling.pid, 'SIGKILL');
    expect(h.manager.stop).toHaveBeenCalled();
  });

  it('keeps the single-instance guard for http: refuses while the recorded server is healthy', async () => {
    const result = await run({ transport: 'http' });

    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(kill).not.toHaveBeenCalled();
    expect(h.manager.start).not.toHaveBeenCalled();
  });
});

describe('MCPServerManager: stdio servers stay out of the PID file (#3364)', () => {
  type Manager = import('../src/mcp-server.js').MCPServerManager;
  let MCPServerManager: typeof import('../src/mcp-server.js').MCPServerManager;
  let dir: string;
  let pidFile: string;
  const managers: Manager[] = [];
  const originalCwdEnv = process.env.CLAUDE_FLOW_CWD;

  beforeAll(async () => {
    ({ MCPServerManager } = await vi.importActual<typeof import('../src/mcp-server.js')>('../src/mcp-server.js'));
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-pidfile-'));
    pidFile = path.join(dir, 'claude-flow-mcp.pid');
    // removePidFile() also unlinks a legacy <CLAUDE_FLOW_CWD>/.claude-flow/mcp-server.pid.
    process.env.CLAUDE_FLOW_CWD = dir;
    // The transports themselves (stdin hooks, http listener) are out of scope.
    vi.spyOn(MCPServerManager.prototype as any, 'startStdioServer').mockResolvedValue(undefined);
    vi.spyOn(MCPServerManager.prototype as any, 'startHttpServer').mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop().catch(() => {});
    vi.restoreAllMocks();
    if (originalCwdEnv === undefined) delete process.env.CLAUDE_FLOW_CWD;
    else process.env.CLAUDE_FLOW_CWD = originalCwdEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const create = (transport: 'stdio' | 'http') => {
    const manager = new MCPServerManager({ transport, pidFile, port: 1 });
    managers.push(manager);
    return manager;
  };

  it('starts while another live server is recorded, and never overwrites or removes its PID file', async () => {
    fs.writeFileSync(pidFile, String(sibling.pid));
    const manager = create('stdio');

    const status = await manager.start();
    expect(status).toMatchObject({ running: true, pid: process.pid, transport: 'stdio' });
    expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(sibling.pid));

    // Twice: the "I served stdio" flag has to outlive the first stop(), or the
    // second one reads the other server's live record and deletes it.
    await manager.stop();
    await manager.stop();
    expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(sibling.pid));
    expect(siblingAlive()).toBe(true);
  });

  it('does not claim the PID file for itself', async () => {
    await create('stdio').start();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('reports itself healthy and leaves a stale record alone (the 30s health monitor runs this)', async () => {
    fs.writeFileSync(pidFile, '999999999'); // no such process
    const manager = create('stdio');
    await manager.start();

    await expect(manager.checkHealth()).resolves.toEqual({ healthy: true });
    expect(fs.readFileSync(pidFile, 'utf8')).toBe('999999999');
  });

  it('keeps the single-instance guard for http', async () => {
    fs.writeFileSync(pidFile, String(sibling.pid));
    await expect(create('http').start()).rejects.toThrow(`MCP Server already running (PID: ${sibling.pid})`);
    expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(sibling.pid));
  });
});
