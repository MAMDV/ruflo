import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { authorizeMcpTool } from '../src/services/policy-runtime.js';

const initialCwd = process.cwd();
const roots: string[] = [];
afterEach(() => {
  process.chdir(initialCwd);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true});
});
function worker(envelope: object): string {
  const root = mkdtempSync(join(tmpdir(), 'ruflo-authority-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  process.chdir(root);
  vi.stubEnv('CLAUDE_FLOW_CAPABILITY_ENVELOPE', JSON.stringify(envelope));
  return root;
}
describe('MCP delegated authority composition', () => {
  it('does not let a tool ceiling replace inherited authority in legacy mode', async () => {
    worker({tools:['memory_search']});
    const decision = await authorizeMcpTool('memory_store', {}, {}, {envelope:{tools:['*']}});
    expect(decision.enforcedOutcome).toBe('denied');
    expect(decision.reason).toBe('tool-outside-envelope');
  });
  it('enforces a disjoint intersection as deny all', async () => {
    worker({tools:['memory_search']});
    const decision = await authorizeMcpTool('memory_store', {}, {}, {envelope:{tools:['memory_store']}});
    expect(decision.enforcedOutcome).toBe('denied');
  });
  it('allows a tool inside both envelopes', async () => {
    worker({tools:['memory_*']});
    expect((await authorizeMcpTool('memory_search', {}, {}, {
      envelope:{tools:['memory_search']},
    })).enforcedOutcome).toBe('allowed');
  });
  it('requires an explicit namespace rather than guessing a handler default', async () => {
    worker({tools:['memory_search'],readNamespaces:['tenant-a']});
    await expect(authorizeMcpTool('memory_search', {}, {}, {
      actionType:'memory.read', namespaceAccess:'read',
    })).rejects.toThrow('namespace-required-by-capability-envelope');
    expect((await authorizeMcpTool('memory_search', {namespace:'tenant-b'}, {}, {
      actionType:'memory.read', namespaceAccess:'read',
    })).enforcedOutcome).toBe('denied');
    expect((await authorizeMcpTool('memory_search', {namespace:'tenant-a'}, {}, {
      actionType:'memory.read', namespaceAccess:'read',
    })).enforcedOutcome).toBe('allowed');
  });
  it('denies malformed worker authority', async () => {
    worker({tools:'*'});
    const decision = await authorizeMcpTool('memory_search', {});
    expect(decision.enforcedOutcome).toBe('denied');
  });
});
