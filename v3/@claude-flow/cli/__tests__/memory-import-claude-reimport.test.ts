/**
 * memory_import_claude must be re-runnable.
 *
 * Its keys are deterministic (claude:<project>:<name>:<section>), and storeEntry
 * refuses an existing key unless `upsert` is set. Before this fix a second
 * import of the same memory files failed every section, counted each file as
 * skipped and returned success: false, so an edited Claude memory note never
 * reached the store again. The store mock below refuses an existing key
 * without upsert, the way storeEntry and bridgeStoreEntry do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type StoreOptions = { key: string; value: string; namespace?: string; upsert?: boolean };

const layer = vi.hoisted(() => {
  const rows = new Map<string, string>();
  return {
    rows,
    storeEntry: vi.fn(async (options: StoreOptions): Promise<{ success: boolean; id: string; error?: string }> => {
      const id = `${options.namespace}:${options.key}`;
      if (rows.has(id) && !options.upsert) {
        return { success: false, id: '', error: `key "${options.key}" already exists in namespace "${options.namespace}"` };
      }
      rows.set(id, options.value);
      return { success: true, id };
    }),
  };
});

vi.mock('../src/memory/memory-initializer.js', () => ({
  storeEntry: layer.storeEntry,
  searchEntries: vi.fn(),
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true })),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true })),
  generateEmbedding: vi.fn(async () => ({ backend: 'mock' })),
}));

vi.mock('../src/mcp-tools/validate-input.js', () => ({
  validateIdentifier: () => ({ valid: true }),
}));

const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');
const importer = memoryTools.find((tool) => tool.name === 'memory_import_claude')!;

type ImportResult = { success: boolean; imported: number; skipped: number };

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ruflo-claude-reimport-'));
  process.env.HOME = home;
  layer.rows.clear();
  layer.storeEntry.mockClear();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeNote(file: string, contents: string): void {
  const dir = join(home, '.claude', 'projects', '-test-project', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), contents);
}

const run = async () => importer.handler({ projectPath: '/test/project' }) as Promise<ImportResult>;

describe('memory_import_claude is re-runnable', () => {
  it('a second import of unchanged notes succeeds and stores nothing twice', async () => {
    writeNote('workflow.md', '## Build\nRun the build before every commit.\n\n## Release\nTag, then publish the three packages.\n');

    const first = await run();
    const second = await run();

    expect(first).toMatchObject({ success: true, imported: 2, skipped: 0 });
    expect(second).toMatchObject({ success: true, imported: 2, skipped: 0 });
    expect(layer.rows.size).toBe(2);
  });

  it('an edited note replaces the stored section instead of being skipped', async () => {
    writeNote('workflow.md', '## Build\nRun the build before every commit.\n');
    await run();

    writeNote('workflow.md', '## Build\nRun the build and the tests before every commit.\n');
    const again = await run();

    expect(again).toMatchObject({ success: true, imported: 1, skipped: 0 });
    expect([...layer.rows.values()]).toEqual(['Run the build and the tests before every commit.']);
  });

  it('a section added to an already imported note is imported', async () => {
    writeNote('workflow.md', '## Build\nRun the build before every commit.\n');
    await run();

    writeNote('workflow.md', '## Build\nRun the build before every commit.\n\n## Deploy\nDeploy from the release tag only.\n');
    const again = await run();

    expect(again).toMatchObject({ success: true, imported: 2, skipped: 0 });
    expect(layer.rows.size).toBe(2);
  });

  it('every store call asks for upsert', async () => {
    writeNote('single.md', 'A note with no level-two headings, stored as one entry.');
    await run();

    expect(layer.storeEntry).toHaveBeenCalled();
    for (const [options] of layer.storeEntry.mock.calls) expect(options.upsert).toBe(true);
  });
});
