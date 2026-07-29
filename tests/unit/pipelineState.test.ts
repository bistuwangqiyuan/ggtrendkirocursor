import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSnapshotStore } from '../../src/lib/cache/snapshot';
import {
  EMPTY_PIPELINE_STATE,
  MAX_CATCHUP_BATCH_SIZE,
  catchUpBatchSize,
  loadPipelineState,
  missedRuns,
  recoveryDue,
  savePipelineState,
  snapshotRepairDue,
  type PipelineState,
} from '../../src/lib/services/pipelineState';

let dir: string;

const HOUR = 3_600_000;
const state = (patch: Partial<PipelineState> = {}): PipelineState => ({ ...EMPTY_PIPELINE_STATE, ...patch });
const hoursAgo = (n: number) => new Date(Date.now() - n * HOUR).toISOString();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  delete process.env.PIPELINE_RECOVERY_MIN_INTERVAL_MINUTES;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.PIPELINE_RECOVERY_MIN_INTERVAL_MINUTES;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('persistence', () => {
  it('returns a zeroed state before anything has run', async () => {
    expect(await loadPipelineState()).toEqual(EMPTY_PIPELINE_STATE);
  });

  it('merges a patch instead of replacing the record', async () => {
    await savePipelineState({ lastFlushAt: hoursAgo(1) });
    await savePipelineState({ consecutiveDegradedRuns: 2 });

    const loaded = await loadPipelineState();
    expect(loaded.lastFlushAt).not.toBeNull();
    expect(loaded.consecutiveDegradedRuns).toBe(2);
  });
});

describe('missed windows', () => {
  it('counts nothing when the last flush was in the current window', () => {
    expect(missedRuns(state({ lastFlushAt: hoursAgo(2) }))).toBe(0);
  });

  it('counts nothing on a site that has never flushed', () => {
    // A first deploy is not a backlog, and treating it as one would inflate the
    // very first batch.
    expect(missedRuns(state())).toBe(0);
  });

  it('counts one window per three-hour gap, excluding the current one', () => {
    expect(missedRuns(state({ lastFlushAt: hoursAgo(7) }))).toBe(1);
    expect(missedRuns(state({ lastFlushAt: hoursAgo(25) }))).toBe(7);
  });
});

describe('catch-up sizing', () => {
  it('leaves a healthy run at its configured size', () => {
    expect(catchUpBatchSize(5, state({ lastFlushAt: hoursAgo(3) }))).toBe(5);
  });

  it('adds a slot per missed window', () => {
    expect(catchUpBatchSize(5, state({ lastFlushAt: hoursAgo(10) }))).toBe(7);
  });

  it('caps the request however long the outage was', () => {
    expect(catchUpBatchSize(5, state({ lastFlushAt: hoursAgo(24 * 30) }))).toBe(MAX_CATCHUP_BATCH_SIZE);
  });
});

describe('recovery throttle', () => {
  it('allows the first attempt', () => {
    expect(recoveryDue(state())).toBe(true);
  });

  it('holds off while a recent attempt is still in the interval', () => {
    expect(recoveryDue(state({ lastRecoveryTriggerAt: new Date(Date.now() - 5 * 60_000).toISOString() }))).toBe(false);
  });

  it('allows another attempt once the interval has passed', () => {
    expect(recoveryDue(state({ lastRecoveryTriggerAt: hoursAgo(2) }))).toBe(true);
  });

  it('honours a configured interval', () => {
    process.env.PIPELINE_RECOVERY_MIN_INTERVAL_MINUTES = '10';
    const at = new Date(Date.now() - 15 * 60_000).toISOString();
    expect(recoveryDue(state({ lastRecoveryTriggerAt: at }))).toBe(true);
  });
});

describe('snapshot repair throttle', () => {
  it('allows the first repair of a frozen read side', () => {
    expect(snapshotRepairDue(state())).toBe(true);
  });

  it('holds off after a recent attempt, so a structural failure is not retried in a loop', () => {
    // Each repair drives the SSR rebuild, which wakes Neon; hourly is the cap.
    expect(
      snapshotRepairDue(state({ lastSnapshotRepairAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
    ).toBe(false);
  });

  it('allows another attempt once the interval has passed', () => {
    expect(snapshotRepairDue(state({ lastSnapshotRepairAt: hoursAgo(2) }))).toBe(true);
  });

  it('is independent of the backlog drain throttle', () => {
    // A store the batch cannot write to produces stale snapshots with an empty
    // queue, so one timer must not suppress the other.
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(snapshotRepairDue(state({ lastRecoveryTriggerAt: recent }))).toBe(true);
    expect(recoveryDue(state({ lastSnapshotRepairAt: recent }))).toBe(true);
  });
});
