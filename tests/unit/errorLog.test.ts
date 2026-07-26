import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSnapshotStore } from '../../src/lib/cache/snapshot';
import {
  flushErrorLog,
  listLogDates,
  pruneOldLogs,
  readDayLog,
  recordDbWake,
  recordError,
  resetErrorLogBuffer,
  retentionDays,
} from '../../src/lib/observability/errorLog';

let dir: string;
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'errlog-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  delete process.env.ERROR_LOG_RETENTION_DAYS;
  resetSnapshotStore();
  resetErrorLogBuffer();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.ERROR_LOG_RETENTION_DAYS;
  resetErrorLogBuffer();
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('recordError', () => {
  it('persists an entry into today\'s partition', async () => {
    recordError('read-path', new Error('snapshot missing'), { route: '/trends' });
    await flushErrorLog();

    const log = await readDayLog(today());
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].source).toBe('read-path');
    expect(log.entries[0].message).toBe('snapshot missing');
    expect(log.entries[0].route).toBe('/trends');
    expect(log.entries[0].level).toBe('error');
  });

  it('accepts non-Error values without throwing', async () => {
    recordError('db', 'plain string failure');
    recordError('db', { weird: true });
    await flushErrorLog();
    const log = await readDayLog(today());
    expect(log.entries).toHaveLength(2);
  });

  it('merges across flushes instead of overwriting the day', async () => {
    recordError('a', new Error('first'));
    await flushErrorLog();
    recordError('b', new Error('second'));
    await flushErrorLog();

    const log = await readDayLog(today());
    expect(log.entries.map((e) => e.message).sort()).toEqual(['first', 'second']);
  });

  it('truncates an oversized message rather than storing it whole', async () => {
    recordError('x', new Error('y'.repeat(5000)));
    await flushErrorLog();
    const log = await readDayLog(today());
    expect(log.entries[0].message.length).toBeLessThan(1100);
    expect(log.entries[0].message.endsWith('…')).toBe(true);
  });

  it('returns newest entries first', async () => {
    recordError('s', new Error('old'));
    await flushErrorLog();
    await new Promise((r) => setTimeout(r, 5));
    recordError('s', new Error('new'));
    await flushErrorLog();
    const log = await readDayLog(today());
    expect(log.entries[0].message).toBe('new');
  });
});

describe('filters', () => {
  beforeEach(async () => {
    recordError('read-path', new Error('e1'), { route: '/trends' });
    recordError('db', new Error('e2'), { route: '/bp', level: 'warn' });
    recordError('bp-batch', new Error('e3'), { route: '/trends', level: 'info' });
    await flushErrorLog();
  });

  it('filters by level', async () => {
    const log = await readDayLog(today(), { level: 'warn' });
    expect(log.entries.map((e) => e.message)).toEqual(['e2']);
  });

  it('filters by source', async () => {
    const log = await readDayLog(today(), { source: 'bp-batch' });
    expect(log.entries.map((e) => e.message)).toEqual(['e3']);
  });

  it('filters by route', async () => {
    const log = await readDayLog(today(), { route: '/trends' });
    expect(log.entries.map((e) => e.message).sort()).toEqual(['e1', 'e3']);
  });

  it('summarises counts by level over the unfiltered day', async () => {
    const log = await readDayLog(today(), { level: 'warn' });
    expect(log.entriesByLevel).toEqual({ error: 1, warn: 1, info: 1 });
  });
});

describe('database wake metering', () => {
  it('groups wake events by cause', async () => {
    recordDbWake('cron', { route: '/api/bp/cron' });
    recordDbWake('cron', { route: '/api/trends/collect' });
    recordDbWake('auth', { route: '/trends' });
    await flushErrorLog();

    const log = await readDayLog(today());
    expect(log.wakes).toHaveLength(3);
    expect(log.wakesByReason).toEqual({ cron: 2, auth: 1 });
  });

  it('reports zero page-caused wakes when the read path stays off Postgres', async () => {
    recordDbWake('cron');
    await flushErrorLog();
    const log = await readDayLog(today());
    expect(log.wakesByReason.page ?? 0).toBe(0);
  });
});

describe('retention', () => {
  it('defaults to 30 days and honours the override', () => {
    expect(retentionDays()).toBe(30);
    process.env.ERROR_LOG_RETENTION_DAYS = '7';
    expect(retentionDays()).toBe(7);
    process.env.ERROR_LOG_RETENTION_DAYS = 'nonsense';
    expect(retentionDays()).toBe(30);
  });

  it('deletes partitions older than the window and keeps newer ones', async () => {
    process.env.ERROR_LOG_RETENTION_DAYS = '2';
    // Seed three explicit day partitions through the snapshot layer.
    const { writeSnapshot } = await import('../../src/lib/cache/snapshot');
    await writeSnapshot('errors/2020-01-01', { entries: [], wakes: [] });
    await writeSnapshot('errors/2026-07-01', { entries: [], wakes: [] });
    await writeSnapshot(`errors/${today()}`, { entries: [], wakes: [] });
    resetSnapshotStore();

    const deleted = await pruneOldLogs(new Date('2026-07-02T00:00:00Z'));
    expect(deleted).toContain('2020-01-01');
    expect(deleted).not.toContain(today());

    const remaining = await listLogDates();
    expect(remaining).not.toContain('2020-01-01');
  });
});

describe('failure isolation', () => {
  it('never throws even when the snapshot backend is unusable', async () => {
    // A file, not a directory: mkdir/writeFile inside it can only fail.
    const { writeFile } = await import('node:fs/promises');
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    process.env.SNAPSHOT_DIR = join(blocker, 'nested');
    resetSnapshotStore();
    expect(() => recordError('x', new Error('boom'))).not.toThrow();
    await expect(flushErrorLog()).resolves.toBeUndefined();
  });

  it('returns an empty result for a day with no log', async () => {
    const log = await readDayLog('2019-05-05');
    expect(log.entries).toEqual([]);
    expect(log.wakes).toEqual([]);
    expect(log.totalEntries).toBe(0);
  });
});
