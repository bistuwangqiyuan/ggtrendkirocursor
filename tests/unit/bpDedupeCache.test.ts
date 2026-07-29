import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSnapshotStore, writeSnapshot } from '../../src/lib/cache/snapshot';
import {
  dedupeCacheMaxAgeHours,
  loadBpDedupeState,
  saveBpDedupeState,
} from '../../src/lib/services/bpDedupeCache';

let dir: string;

const HOUR = 3_600_000;

const canonical = (norm: string) => ({
  id: `id-${norm}`,
  businessModelNorm: norm,
  title: `title ${norm}`,
  summary: null,
  selectedOpportunity: null,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dedupe-cache-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  delete process.env.BP_DEDUPE_CACHE_MAX_AGE_HOURS;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.BP_DEDUPE_CACHE_MAX_AGE_HOURS;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('round trip', () => {
  it('accepts the sets the prepare phase holds and returns them as arrays', async () => {
    await saveBpDedupeState({
      completedKeywordNorms: new Set(['alpha', 'beta']),
      failedKeywordNorms: new Set(['gamma']),
      avoidModels: ['模式A'],
      canonicalModels: [canonical('模式a')].values(),
    });

    const loaded = await loadBpDedupeState();

    expect(loaded?.stale).toBe(false);
    expect(loaded?.state.completedKeywordNorms).toEqual(['alpha', 'beta']);
    expect(loaded?.state.failedKeywordNorms).toEqual(['gamma']);
    expect(loaded?.state.avoidModels).toEqual(['模式A']);
    expect(loaded?.state.canonicalModels[0].businessModelNorm).toBe('模式a');
  });

  it('returns null before the first healthy run has cached anything', async () => {
    expect(await loadBpDedupeState()).toBeNull();
  });

  it('returns null for a payload that is not a dedupe state', async () => {
    await writeSnapshot('bp/dedupe-state', { unexpected: 'shape' });
    expect(await loadBpDedupeState()).toBeNull();
  });

  it('returns null when the capture time is unreadable', async () => {
    await writeSnapshot('bp/dedupe-state', {
      capturedAt: 'whenever',
      completedKeywordNorms: [],
      failedKeywordNorms: [],
      avoidModels: [],
      canonicalModels: [],
    });
    expect(await loadBpDedupeState()).toBeNull();
  });
});

describe('staleness', () => {
  it('marks a copy older than the limit, so the caller can refuse it', async () => {
    await writeSnapshot('bp/dedupe-state', {
      capturedAt: new Date(Date.now() - 80 * HOUR).toISOString(),
      completedKeywordNorms: [],
      failedKeywordNorms: [],
      avoidModels: [],
      canonicalModels: [],
    });

    const loaded = await loadBpDedupeState();
    expect(loaded?.stale).toBe(true);
    expect(Math.round((loaded?.ageMs ?? 0) / HOUR)).toBe(80);
  });

  it('honours BP_DEDUPE_CACHE_MAX_AGE_HOURS', async () => {
    process.env.BP_DEDUPE_CACHE_MAX_AGE_HOURS = '6';
    expect(dedupeCacheMaxAgeHours()).toBe(6);
    await saveBpDedupeState({
      completedKeywordNorms: [],
      failedKeywordNorms: [],
      avoidModels: [],
      canonicalModels: [],
    });
    // Just written, so still inside even a six-hour limit.
    expect((await loadBpDedupeState())?.stale).toBe(false);
  });

  it('falls back to 72 hours for a nonsensical limit', () => {
    process.env.BP_DEDUPE_CACHE_MAX_AGE_HOURS = 'soon';
    expect(dedupeCacheMaxAgeHours()).toBe(72);
  });
});
