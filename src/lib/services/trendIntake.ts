/**
 * Durable intake queue for harvested hotwords.
 *
 * WHY THIS EXISTS
 * The Google Trends RSS feed is a rolling window: what is trending right now is
 * gone from the feed a day later. The collector used to fetch that feed and
 * INSERT in one breath, so whenever Neon was unavailable — quota exhausted,
 * suspended, cold — the whole harvest was thrown away. Those hotwords were then
 * unrecoverable: not late, *lost*, and with them every business opportunity they
 * would have produced.
 *
 * So harvesting and storing are now separate steps with a queue between them.
 * The queue lives in Netlify Blobs, which costs no Neon compute and stays
 * writable precisely when Postgres is not. A harvest is durable the moment the
 * feed is parsed; reaching Postgres is a separate, retryable concern.
 *
 * TWO DELIBERATE CHOICES
 *
 * 1. Queued rows keep their REAL harvest time. Re-stamping them with the
 *    recovery time would make a two-day-old spike look like breaking news on
 *    /trends. The row is genuinely that old, and the analysis window is wide
 *    enough (48h) to still pick it up.
 *
 * 2. The queue expires. A harvest is kept exactly as long as it could still be
 *    analyzed — the BP picker's freshness window — and dropped after that. There
 *    is no value in replaying a hotword the picker would refuse anyway, and an
 *    unbounded queue would grow through a long outage.
 */
import { deleteSnapshot, listSnapshotKeys, readSnapshot, writeSnapshot } from '../cache/snapshot';
import type { Trend } from '../../types';
import type { CollectedTrendRow } from './trendsCollector';

const PREFIX = 'trends/pending/';

/**
 * Matches SCHEDULED_FRESHNESS_WINDOW in bp.ts: keep a harvest exactly as long as
 * the picker would still consider it.
 */
const DEFAULT_TTL_HOURS = 48;

/**
 * Safety valve. At 8 runs/day the TTL already bounds this to ~16 batches; the cap
 * only matters if something triggers the collector in a tight loop.
 */
const MAX_BATCHES = 48;

export interface QueuedTrendRow extends CollectedTrendRow {
  /**
   * Assigned at harvest, not at insert, so a business plan generated from this
   * row during the outage can reference it before it reaches Postgres.
   */
  id: string;
}

export interface PendingTrendBatch {
  batchId: string;
  /** When the RSS feed was actually read. Preserved through the queue. */
  harvestedAt: string;
  rows: QueuedTrendRow[];
}

export interface PendingBatchRef {
  key: string;
  batch: PendingTrendBatch;
}

/** How long a queued harvest stays replayable. */
export function intakeTtlHours(): number {
  const raw = Number(process.env.TRENDS_INTAKE_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
}

/** Chronologically sortable key, so listing returns batches oldest-first. */
function batchKey(harvestedAt: Date): string {
  const stamp = harvestedAt.toISOString().replace(/[:.]/g, '-');
  return `${PREFIX}${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Park a harvest that could not be stored. Returns the queue key, or null when
 * there was nothing to queue or the blob store itself refused the write.
 */
export async function enqueueTrendHarvest(
  rows: QueuedTrendRow[],
  harvestedAt: Date = new Date()
): Promise<string | null> {
  if (rows.length === 0) return null;
  const key = batchKey(harvestedAt);
  const written = await writeSnapshot<PendingTrendBatch>(key, {
    batchId: key.slice(PREFIX.length),
    harvestedAt: harvestedAt.toISOString(),
    rows,
  });
  if (!written) return null;
  await trimQueue();
  return key;
}

/** Drop the oldest batches once the queue exceeds MAX_BATCHES. */
async function trimQueue(): Promise<void> {
  const keys = (await listSnapshotKeys(PREFIX)).sort();
  const excess = keys.length - MAX_BATCHES;
  for (let i = 0; i < excess; i++) await deleteSnapshot(keys[i]);
}

/** Every queued batch, oldest first. Unreadable entries are skipped, not thrown. */
export async function listPendingTrendBatches(): Promise<PendingBatchRef[]> {
  const refs: PendingBatchRef[] = [];
  for (const key of (await listSnapshotKeys(PREFIX)).sort()) {
    const snap = await readSnapshot<PendingTrendBatch>(key);
    const batch = snap?.data;
    if (!batch || !Array.isArray(batch.rows) || !batch.harvestedAt) continue;
    refs.push({ key, batch });
  }
  return refs;
}

/**
 * Split batches into those still worth replaying and those too old to analyze.
 * Pure, so the expiry rule is testable without a store.
 */
export function partitionByFreshness(
  batches: PendingBatchRef[],
  now: Date = new Date(),
  ttlHours: number = intakeTtlHours()
): { fresh: PendingBatchRef[]; expired: PendingBatchRef[] } {
  const cutoff = now.getTime() - ttlHours * 3_600_000;
  const fresh: PendingBatchRef[] = [];
  const expired: PendingBatchRef[] = [];
  for (const ref of batches) {
    const at = Date.parse(ref.batch.harvestedAt);
    // An unparseable timestamp is treated as expired: it can't be aged, and
    // keeping it forever would be the worse failure.
    if (Number.isFinite(at) && at >= cutoff) fresh.push(ref);
    else expired.push(ref);
  }
  return { fresh, expired };
}

/**
 * Queued rows shaped as trends, so the BP picker can select from hotwords that
 * have not reached Postgres yet. This is what lets analysis continue during an
 * outage instead of merely resuming after it.
 */
export async function pendingTrendsAsTrends(now: Date = new Date()): Promise<Trend[]> {
  const { fresh } = partitionByFreshness(await listPendingTrendBatches(), now);
  const trends: Trend[] = [];
  for (const { batch } of fresh) {
    const harvestedAt = new Date(batch.harvestedAt);
    for (const row of batch.rows) {
      trends.push({
        id: row.id,
        keyword: row.keyword,
        searchVolume: row.searchVolume,
        growthRate: row.growthRate,
        category: row.category,
        timeRange: row.timeRange as Trend['timeRange'],
        region: row.region,
        timestamp: harvestedAt,
        createdAt: harvestedAt,
        topicClass: row.topicClass,
      });
    }
  }
  return trends;
}

export interface DrainSummary {
  /** Rows accepted by Postgres. */
  inserted: number;
  /** Rows the store deduplicated away (already present for that region). */
  skipped: number;
  /** Batches replayed successfully. */
  batches: number;
  /** Batches dropped for being older than the analysis window. */
  expiredBatches: number;
  expiredRows: number;
  /** Batches left in the queue because the store is still unavailable. */
  remaining: number;
  errors: string[];
}

/**
 * Persist queued harvests, oldest first, and drop expired ones.
 *
 * `persist` receives the original harvest time so the rows keep their real age.
 * The first failure stops the drain: if the store rejected one batch it will
 * reject the rest, and retrying each in turn would just burn the run's budget.
 */
export async function drainPendingTrends(
  persist: (rows: QueuedTrendRow[], harvestedAt: Date) => Promise<{ inserted: number; skipped: number }>,
  now: Date = new Date()
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    inserted: 0, skipped: 0, batches: 0,
    expiredBatches: 0, expiredRows: 0, remaining: 0, errors: [],
  };

  const { fresh, expired } = partitionByFreshness(await listPendingTrendBatches(), now);

  for (const ref of expired) {
    summary.expiredBatches++;
    summary.expiredRows += ref.batch.rows.length;
    await deleteSnapshot(ref.key);
  }

  for (let i = 0; i < fresh.length; i++) {
    const ref = fresh[i];
    try {
      const result = await persist(ref.batch.rows, new Date(ref.batch.harvestedAt));
      summary.inserted += result.inserted;
      summary.skipped += result.skipped;
      summary.batches++;
      await deleteSnapshot(ref.key);
    } catch (error) {
      summary.errors.push(`${ref.batch.batchId}: ${(error as Error).message}`);
      summary.remaining = fresh.length - i;
      return summary;
    }
  }
  return summary;
}

/** Delete batches past the analysis window. Used by the maintenance pass. */
export async function pruneExpiredTrendBatches(now: Date = new Date()): Promise<number> {
  const { expired } = partitionByFreshness(await listPendingTrendBatches(), now);
  let deleted = 0;
  for (const ref of expired) {
    if (await deleteSnapshot(ref.key)) deleted++;
  }
  return deleted;
}

/** Backlog size for the recovery job and the ops dashboard, without a DB touch. */
export async function pendingTrendBacklog(now: Date = new Date()): Promise<{
  batches: number;
  rows: number;
  oldestHarvestedAt: string | null;
}> {
  const { fresh } = partitionByFreshness(await listPendingTrendBatches(), now);
  return {
    batches: fresh.length,
    rows: fresh.reduce((sum, ref) => sum + ref.batch.rows.length, 0),
    oldestHarvestedAt: fresh[0]?.batch.harvestedAt ?? null,
  };
}
