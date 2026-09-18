/**
 * Dream Cycle 2026-09-18 (memory) — regression tests for AgentDBAdapter.store()
 * same-(namespace,key) idempotency.
 *
 * Baseline bug: store() minted a fresh random id per call (createDefaultEntry ->
 * generateMemoryId()) and never looked up an existing entry under the same
 * (namespace, key) before writing. The prior occupant was left as an orphan:
 * unreachable via getByKey()/keyIndex, but still present in entries/
 * namespaceIndex/tagIndex, and — for embedded entries — still a live point in
 * the HNSW index, so search()/semanticSearch() returned stale duplicates
 * forever. Fixed by evicting the prior (namespace,key) occupant via the
 * adapter's own existing delete() path before storing the new entry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentDBAdapter } from './agentdb-adapter.js';
import { createDefaultEntry } from './types.js';

function unitVector(dims: number, hotIndex: number): Float32Array {
  const v = new Float32Array(dims);
  v[hotIndex % dims] = 1;
  return v;
}

function allInNamespace(namespace: string) {
  return { type: 'prefix' as const, keyPrefix: '', namespace, limit: 1000 };
}

describe('AgentDBAdapter.store() — same-key upsert idempotency (Dream Cycle 2026-09-18)', () => {
  let adapter: AgentDBAdapter;

  beforeEach(async () => {
    adapter = new AgentDBAdapter({ dimensions: 8, cacheEnabled: true });
    await adapter.initialize();
  });

  it('a second store() under the same (namespace,key) does not leave two entries reachable', async () => {
    const first = createDefaultEntry({ key: 'profile', namespace: 'ns1', content: 'v1' });
    await adapter.store(first);

    const second = createDefaultEntry({ key: 'profile', namespace: 'ns1', content: 'v2' });
    await adapter.store(second);

    expect(first.id).not.toBe(second.id); // ids are independently random, as today

    const byKey = await adapter.getByKey('ns1', 'profile');
    expect(byKey?.content).toBe('v2');

    // The prior occupant must be fully gone, not just unreachable via getByKey.
    const stale = await adapter.get(first.id);
    expect(stale).toBeNull();

    const all = await adapter.query(allInNamespace('ns1'));
    expect(all.filter((e) => e.key === 'profile')).toHaveLength(1);
  });

  it('a second store() under the same (namespace,key) evicts the stale HNSW point, so search() never returns the old content', async () => {
    const first = createDefaultEntry({ key: 'fact', namespace: 'ns1', content: 'stale-fact' });
    first.embedding = unitVector(8, 0);
    await adapter.store(first);

    const second = createDefaultEntry({ key: 'fact', namespace: 'ns1', content: 'fresh-fact' });
    second.embedding = unitVector(8, 0); // same embedding direction, different content/id
    await adapter.store(second);

    const results = await adapter.search(unitVector(8, 0), { k: 10 });
    const contents = results.map((r) => r.entry.content);
    expect(contents).toContain('fresh-fact');
    expect(contents).not.toContain('stale-fact');
    expect(contents.filter((c) => c === 'fresh-fact')).toHaveLength(1);
  });

  it('storing a genuinely new (namespace,key) is unaffected (no eviction, both entries reachable)', async () => {
    const a = createDefaultEntry({ key: 'a', namespace: 'ns1', content: 'A' });
    const b = createDefaultEntry({ key: 'b', namespace: 'ns1', content: 'B' });
    await adapter.store(a);
    await adapter.store(b);

    expect((await adapter.get(a.id))?.content).toBe('A');
    expect((await adapter.get(b.id))?.content).toBe('B');
    expect(await adapter.query(allInNamespace('ns1'))).toHaveLength(2);
  });

  it('the same (namespace,key) in two different namespaces are independent (no cross-namespace eviction)', async () => {
    const a = createDefaultEntry({ key: 'shared', namespace: 'ns1', content: 'from-ns1' });
    const b = createDefaultEntry({ key: 'shared', namespace: 'ns2', content: 'from-ns2' });
    await adapter.store(a);
    await adapter.store(b);

    expect((await adapter.getByKey('ns1', 'shared'))?.content).toBe('from-ns1');
    expect((await adapter.getByKey('ns2', 'shared'))?.content).toBe('from-ns2');
  });
});
