/**
 * A small, Blobs-resident record of how the write pipeline is doing.
 *
 * The scheduled window runs every three hours. When Neon is unavailable that
 * window produces nothing storable, and until now nothing remembered it: the next
 * healthy run generated its usual five plans and the missed windows were simply
 * gone from the archive. This state is what lets the pipeline notice the gap and
 * work through it, and lets the recovery job decide whether there is anything to
 * recover without asking the database.
 */
import { readSnapshot, writeSnapshot } from '../cache/snapshot';

const KEY = 'ops/pipeline-state';

/** Matches the cron in bp-scheduled.ts. Used to convert a time gap into missed runs. */
export const SCHEDULE_INTERVAL_HOURS = 3;

/**
 * Ceiling for a catch-up batch. Higher than the steady-state clamp because a
 * backlog is work already owed, but still bounded: the generation loop stops at
 * its own deadline, and an unbounded request would only inflate LLM spend.
 */
export const MAX_CATCHUP_BATCH_SIZE = 12;

/** Don't re-trigger the batch more often than this while a backlog persists. */
const DEFAULT_RECOVERY_MIN_INTERVAL_MINUTES = 55;

export interface PipelineState {
  lastRunStartedAt: string | null;
  /** Last run that got its writes into Postgres. */
  lastHealthyRunAt: string | null;
  /** Last time generated plans actually reached Postgres. */
  lastFlushAt: string | null;
  /** Consecutive runs that had to fall back to cached dedupe state. */
  consecutiveDegradedRuns: number;
  lastRecoveryTriggerAt: string | null;
  /** Last time the watchdog rebuilt frozen snapshots through the SSR route. */
  lastSnapshotRepairAt: string | null;
}

export const EMPTY_PIPELINE_STATE: PipelineState = {
  lastRunStartedAt: null,
  lastHealthyRunAt: null,
  lastFlushAt: null,
  consecutiveDegradedRuns: 0,
  lastRecoveryTriggerAt: null,
  lastSnapshotRepairAt: null,
};

export async function loadPipelineState(): Promise<PipelineState> {
  const snap = await readSnapshot<Partial<PipelineState>>(KEY);
  return { ...EMPTY_PIPELINE_STATE, ...(snap?.data ?? {}) };
}

/** Merge a patch into the stored state. Never throws. */
export async function savePipelineState(patch: Partial<PipelineState>): Promise<PipelineState> {
  const merged = { ...(await loadPipelineState()), ...patch };
  await writeSnapshot<PipelineState>(KEY, merged);
  return merged;
}

/**
 * How many scheduled windows produced nothing, inferred from the last successful
 * flush rather than counted, so a lost state blob can't inflate the number.
 *
 * The window that is running right now doesn't count as missed, hence the -1.
 */
export function missedRuns(state: PipelineState, now: Date = new Date()): number {
  const last = Date.parse(state.lastFlushAt ?? '');
  // No flush on record: a first deploy, not a backlog.
  if (!Number.isFinite(last)) return 0;
  const elapsedHours = (now.getTime() - last) / 3_600_000;
  return Math.max(0, Math.floor(elapsedHours / SCHEDULE_INTERVAL_HOURS) - 1);
}

/**
 * Batch size for this run: the configured size plus one slot per missed window,
 * capped. The generation loop is deadline-bounded, so asking for more candidates
 * can only help — it never lengthens the run beyond its budget.
 */
export function catchUpBatchSize(
  baseSize: number,
  state: PipelineState,
  now: Date = new Date(),
  cap: number = MAX_CATCHUP_BATCH_SIZE
): number {
  const missed = missedRuns(state, now);
  if (missed <= 0) return baseSize;
  return Math.min(cap, baseSize + missed);
}

export function recoveryMinIntervalMinutes(): number {
  const raw = Number(process.env.PIPELINE_RECOVERY_MIN_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECOVERY_MIN_INTERVAL_MINUTES;
}

/**
 * Whether the recovery job may trigger the batch now. Rate-limited so a backlog
 * that cannot be drained (a genuinely down database) is retried steadily rather
 * than on every tick.
 */
export function recoveryDue(state: PipelineState, now: Date = new Date()): boolean {
  const last = Date.parse(state.lastRecoveryTriggerAt ?? '');
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= recoveryMinIntervalMinutes() * 60_000;
}

/**
 * Whether the watchdog may rebuild frozen snapshots now.
 *
 * Rate-limited on the same interval as the drain: a repair wakes the database, so
 * a site that stays frozen for a structural reason must not turn the hourly check
 * into a continuous read load.
 */
export function snapshotRepairDue(state: PipelineState, now: Date = new Date()): boolean {
  const last = Date.parse(state.lastSnapshotRepairAt ?? '');
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= recoveryMinIntervalMinutes() * 60_000;
}
