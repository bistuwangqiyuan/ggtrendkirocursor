import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SNAPSHOT_KEYS,
  readSnapshot,
  readSnapshotData,
  writeSnapshot,
  listSnapshotKeys,
  deleteSnapshot,
  resetSnapshotStore,
  isDbReadFallbackAllowed,
} from '../../src/lib/cache/snapshot';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snap-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  delete process.env.ALLOW_DB_READ_FALLBACK;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.ALLOW_DB_READ_FALLBACK;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('snapshot round-trip', () => {
  it('writes and reads back the payload with metadata', async () => {
    const ok = await writeSnapshot('trends/top', [{ keyword: 'a', volume: 1 }]);
    expect(ok).toBe(true);

    resetSnapshotStore();
    const snap = await readSnapshot<{ keyword: string; volume: number }[]>('trends/top');
    expect(snap).not.toBeNull();
    expect(snap!.data).toEqual([{ keyword: 'a', volume: 1 }]);
    expect(snap!.version).toBeTruthy();
    expect(Number.isNaN(Date.parse(snap!.generatedAt))).toBe(false);
  });

  it('returns null for a missing key instead of throwing', async () => {
    await expect(readSnapshot('does/not/exist')).resolves.toBeNull();
  });

  it('readSnapshotData returns the fallback when missing', async () => {
    await expect(readSnapshotData('nope', { empty: true })).resolves.toEqual({ empty: true });
  });

  it('overwrites an existing snapshot', async () => {
    await writeSnapshot('bp/list', [1]);
    await writeSnapshot('bp/list', [1, 2, 3]);
    resetSnapshotStore();
    const snap = await readSnapshot<number[]>('bp/list');
    expect(snap!.data).toEqual([1, 2, 3]);
  });

  it('survives CJK and punctuation in keys (filesystem-unsafe characters)', async () => {
    const key = SNAPSHOT_KEYS.landingDetail('东京-2026:test?x');
    expect(await writeSnapshot(key, { ok: true })).toBe(true);
    resetSnapshotStore();
    const snap = await readSnapshot<{ ok: boolean }>(key);
    expect(snap!.data).toEqual({ ok: true });
  });

  it('tolerates a corrupted payload by returning null', async () => {
    await mkdir(join(dir, 'trends'), { recursive: true });
    await writeFile(join(dir, 'trends', 'top.json'), '{not json', 'utf8');
    resetSnapshotStore();
    await expect(readSnapshot('trends/top')).resolves.toBeNull();
  });

  it('rejects a payload missing the data envelope', async () => {
    await mkdir(join(dir, 'trends'), { recursive: true });
    await writeFile(join(dir, 'trends', 'top.json'), '{"generatedAt":"x"}', 'utf8');
    resetSnapshotStore();
    await expect(readSnapshot('trends/top')).resolves.toBeNull();
  });
});

describe('listSnapshotKeys', () => {
  it('lists keys under a prefix and round-trips encoded segments', async () => {
    await writeSnapshot(SNAPSHOT_KEYS.landingDetail('taylor-swift'), { a: 1 });
    await writeSnapshot(SNAPSHOT_KEYS.landingDetail('东京-2026'), { a: 2 });
    await writeSnapshot(SNAPSHOT_KEYS.bpList, []);
    resetSnapshotStore();

    const keys = await listSnapshotKeys('landing/detail/');
    expect(keys.sort()).toEqual([
      'landing/detail/taylor-swift',
      'landing/detail/东京-2026',
    ].sort());
  });

  it('returns [] for an empty store', async () => {
    await expect(listSnapshotKeys('anything/')).resolves.toEqual([]);
  });
});

describe('deleteSnapshot', () => {
  it('removes a key so subsequent reads miss', async () => {
    await writeSnapshot('monitor/latest', { sites: [] });
    expect(await deleteSnapshot('monitor/latest')).toBe(true);
    resetSnapshotStore();
    await expect(readSnapshot('monitor/latest')).resolves.toBeNull();
  });

  it('is idempotent for a missing key', async () => {
    await expect(deleteSnapshot('monitor/latest')).resolves.toBe(true);
  });
});

describe('isDbReadFallbackAllowed', () => {
  it('defaults to false so read paths cannot silently revert to Postgres', () => {
    expect(isDbReadFallbackAllowed()).toBe(false);
  });

  it('is true only for the exact opt-in value', () => {
    process.env.ALLOW_DB_READ_FALLBACK = 'true';
    expect(isDbReadFallbackAllowed()).toBe(true);
    process.env.ALLOW_DB_READ_FALLBACK = 'yes';
    expect(isDbReadFallbackAllowed()).toBe(false);
  });
});

describe('SNAPSHOT_KEYS', () => {
  it('builds slash-separated keys so prefix listing works', () => {
    expect(SNAPSHOT_KEYS.landingDetail('abc')).toBe('landing/detail/abc');
    expect(SNAPSHOT_KEYS.bpDetail('id-1')).toBe('bp/detail/id-1');
    expect(SNAPSHOT_KEYS.trendsTop).toBe('trends/top');
  });
});
