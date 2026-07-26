import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readForPage } from '../../src/lib/cache/readPath';
import { resetSnapshotStore } from '../../src/lib/cache/snapshot';
import { readDayLog, resetErrorLogBuffer } from '../../src/lib/observability/errorLog';
import type { SnapshotRead } from '../../src/lib/cache/snapshotReaders';

let dir: string;

const today = () => new Date().toISOString().slice(0, 10);
const hit = <T>(data: T): SnapshotRead<T> => ({ hit: true, data, generatedAt: new Date() });
const miss = <T>(data: T): SnapshotRead<T> => ({ hit: false, data, generatedAt: null });

async function loggedMessages(): Promise<string[]> {
  const log = await readDayLog(today());
  return log.entries.map((e) => e.message);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'readpath-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  delete process.env.ALLOW_DB_READ_FALLBACK;
  resetSnapshotStore();
  resetErrorLogBuffer();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.ALLOW_DB_READ_FALLBACK;
  resetSnapshotStore();
  resetErrorLogBuffer();
  await rm(dir, { recursive: true, force: true });
});

describe('readForPage source selection', () => {
  it('serves the snapshot and reports it as the source', async () => {
    const result = await readForPage('trends:list', async () => hit(['a', 'b']));

    expect(result.source).toBe('snapshot');
    expect(result.pending).toBe(false);
    expect(result.data).toEqual(['a', 'b']);
    expect(await loggedMessages()).toEqual([]);
  });

  it('does not query Postgres on a miss unless the fallback is enabled', async () => {
    let queried = false;
    const result = await readForPage('trends:list', async () => miss<string[]>([]), async () => {
      queried = true;
      return ['from-db'];
    });

    expect(queried).toBe(false);
    expect(result.source).toBe('pending');
    expect(await loggedMessages()).toHaveLength(1);
  });

  it('falls back to Postgres when ALLOW_DB_READ_FALLBACK is on, and says so', async () => {
    process.env.ALLOW_DB_READ_FALLBACK = 'true';
    const result = await readForPage('trends:list', async () => miss<string[]>([]), async () => ['from-db']);

    expect(result.source).toBe('db');
    expect(result.pending).toBe(false);
    expect(result.data).toEqual(['from-db']);
    const log = await readDayLog(today());
    expect(log.entries[0].level).toBe('warn');
  });

  it('degrades to pending when the snapshot read throws', async () => {
    const result = await readForPage('trends:list', async () => {
      throw new Error('blob store unreachable');
    });

    expect(result.source).toBe('pending');
    // Both the cause and the resulting degradation are recorded: the first says
    // why, the second says what the visitor saw.
    expect(await loggedMessages()).toContain('blob store unreachable');
    expect(await loggedMessages()).toHaveLength(2);
  });
});

describe('readForPage keyed lookups', () => {
  it('stays silent for a key the index says does not exist', async () => {
    const result = await readForPage(
      'landing:detail',
      async () => miss<null>(null),
      undefined,
      { keyKnown: async () => false }
    );

    // Still pending so the caller renders its 404 — but a dead URL followed by a
    // crawler is not an incident, and must not fill the daily log.
    expect(result.pending).toBe(true);
    expect(await loggedMessages()).toEqual([]);
  });

  it('logs when the key exists but its detail snapshot has not been built', async () => {
    const result = await readForPage(
      'landing:detail',
      async () => miss<null>(null),
      undefined,
      { keyKnown: async () => true }
    );

    expect(result.pending).toBe(true);
    expect(await loggedMessages()).toHaveLength(1);
  });

  it('logs when the index needed to answer is itself missing', async () => {
    const result = await readForPage(
      'bp:detail',
      async () => miss<null>(null),
      undefined,
      { keyKnown: async () => null }
    );

    expect(result.pending).toBe(true);
    expect(await loggedMessages()).toHaveLength(1);
  });

  it('logs when the existence check throws, rather than swallowing the miss', async () => {
    await readForPage('bp:detail', async () => miss<null>(null), undefined, {
      keyKnown: async () => {
        throw new Error('index read failed');
      },
    });

    expect(await loggedMessages()).toHaveLength(1);
  });

  it('never consults the index when the snapshot hit', async () => {
    let checked = false;
    await readForPage('bp:detail', async () => hit({ id: 'x' }), undefined, {
      keyKnown: async () => {
        checked = true;
        return true;
      },
    });

    // The check costs a second blob read; it must only happen on the miss path.
    expect(checked).toBe(false);
  });
});
