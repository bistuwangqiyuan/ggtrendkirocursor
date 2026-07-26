import { clampBatchSize } from '../../src/lib/bpBatch';
import { runBpBatch } from '../../src/lib/services/bpBatchRunner';
import { trendsCollector } from '../../src/lib/services/trendsCollector';
import { siteMonitorService } from '../../src/lib/services/siteMonitor';
import { runMaintenance } from '../../src/lib/services/maintenance';
import { rebuildAllSnapshots } from '../../src/lib/cache/snapshotBuilder';
import { isLlmConfigured } from '../../src/lib/services/llm';
import { flushErrorLog, recordError } from '../../src/lib/observability/errorLog';
import { runWithDbContext } from '../../src/lib/observability/dbContext';

/**
 * The single scheduled window in which this site is allowed to touch Postgres.
 *
 * The `-background` filename suffix gives this function the 15-minute execution
 * budget (vs. the 26s sync limit).
 *
 * WHY EVERYTHING IS IN ONE FUNCTION
 * Neon's free plan bills compute time, not queries, and auto-suspends after 5
 * idle minutes. Three separate cron functions (collect at :50, BP at :00,
 * monitor at :20) meant three separate wake-ups, each dragging a 5-minute idle
 * tail behind it — roughly 0.73 wasted hours/day in suspend timers alone.
 * Running collect -> generate -> monitor -> maintenance back to back in one
 * invocation costs one wake-up and one idle tail.
 *
 * Generation runs IN-PROCESS (esbuild bundles src + pg, so the DB is reachable
 * directly). This is deliberate: an earlier design called the synchronous
 * /api/bp/cron endpoint over HTTP, which is capped at 26s — any LLM call slower
 * than that got the SSR function killed mid-write and left the report stuck at
 * 'generating' forever (the root cause of the July 2026 all-failed streak).
 *
 * Order matters: collect first so the keyword pool is fresh before generation
 * picks candidates; snapshots last so they reflect everything this run wrote.
 *
 * Tunables:
 *   BP_BATCH_SIZE  number of BPs to attempt per run (default 5, clamped 1-10)
 *   CRON_SECRET    bearer secret required to invoke this function
 */

/**
 * Stop starting new generations once this much of the 15-min budget is spent.
 * Reasoning-tier models (auto-upgraded, e.g. qwen3.7-max) take ~2min per BP, so
 * a full batch can overrun the budget. The reserve after this cutoff covers the
 * flush, monitoring, maintenance and snapshot rebuild that follow.
 */
const GENERATE_BUDGET_MS = 10 * 60 * 1000;
/** Reserve for the post-generation steps, so they are never cut off. */
const TAIL_BUDGET_MS = 3 * 60 * 1000;

export const handler = async (event: { headers?: Record<string, string | undefined> }) => {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET?.trim();

  if (!secret) {
    console.error('[bp-batch] CRON_SECRET not set; skipping run');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }

  // This function is publicly reachable and spends LLM credits, so require the
  // same bearer secret the scheduled trigger sends (fail closed on mismatch).
  const headers = event?.headers || {};
  const authHeader = headers.authorization || headers.Authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (provided !== secret) {
    console.error('[bp-batch] unauthorized invocation rejected');
    return { statusCode: 401, body: 'unauthorized' };
  }

  const parts: string[] = [];

  return runWithDbContext({ reason: 'cron', route: 'bp-batch-background' }, async () => {
    // --- 1. Trends collection (was: trends-collector at :50) --------------
    try {
      const collected = await trendsCollector.collect();
      parts.push(`collected=${collected.inserted}`);
      console.log(
        `[bp-batch] collect: inserted=${collected.inserted} skipped=${collected.skipped} errors=${collected.errors.length}`
      );
      // Rebuild the trends snapshot before generation, not with the others at the
      // end: the candidate picker reads that snapshot, so without this the batch
      // would select from keywords collected three hours ago and every new
      // keyword would wait a full cycle.
      const trendsSnapshot = await rebuildAllSnapshots({ only: ['trends'] });
      parts.push(`trendsSnapshot=${trendsSnapshot.written.trends ?? 0}`);
    } catch (error) {
      parts.push('collect=error');
      console.error('[bp-batch] collect failed:', (error as Error).message);
      recordError('bp-batch', error, { context: { stage: 'collect' } });
    }

    // --- 2. BP generation -------------------------------------------------
    if (!isLlmConfigured()) {
      parts.push('bp=skipped(no LLM)');
      console.error('[bp-batch] LLM not configured; skipping generation');
    } else {
      const batchSize = clampBatchSize(process.env.BP_BATCH_SIZE);
      const summary = await runBpBatch({
        batchSize,
        generateUntil: startedAt + GENERATE_BUDGET_MS,
        spacingMs: 1500,
      });
      parts.push(
        `generated=${summary.generated} dup=${summary.duplicates} failed=${summary.failed} replayed=${summary.replayed} of batchSize=${batchSize}`
      );
      console.log(
        `[bp-batch] generation done: ${JSON.stringify({
          ...summary,
          errors: summary.errors.slice(0, 5),
        })}`
      );
    }

    // --- 3. Site monitoring (was: site-monitor at :20) --------------------
    // Skipped if the batch already ate the budget; monitoring is the least
    // time-critical step and runs again in 3 hours.
    if (Date.now() - startedAt < 15 * 60 * 1000 - TAIL_BUDGET_MS) {
      try {
        const checks = await siteMonitorService.runChecks();
        const down = checks.filter((c) => !c.ok).length;
        parts.push(`monitored=${checks.length} down=${down}`);
        console.log(`[bp-batch] monitor: ${checks.length} site(s), ${down} down`);
      } catch (error) {
        parts.push('monitor=error');
        console.error('[bp-batch] monitor failed:', (error as Error).message);
        recordError('bp-batch', error, { context: { stage: 'monitor' } });
      }
    } else {
      parts.push('monitor=skipped(budget)');
    }

    // --- 4. Storage housekeeping -----------------------------------------
    const maintenance = await runMaintenance();
    parts.push(
      `pruned=trends:${maintenance.trendsDeleted},checks:${maintenance.siteChecksDeleted},logs:${maintenance.logsDeleted}`
    );

    // --- 5. Snapshot rebuild (the whole point: read paths never touch DB) --
    // Trends were already rebuilt in step 1 and nothing since then changed them.
    try {
      const snapshots = await rebuildAllSnapshots({ only: ['landing', 'bp', 'monitor'] });
      const totalWritten = Object.values(snapshots.written).reduce((a, b) => a + b, 0);
      parts.push(`snapshots=${totalWritten}`);
      console.log(`[bp-batch] snapshots: ${JSON.stringify(snapshots)}`);
    } catch (error) {
      parts.push('snapshots=error');
      console.error('[bp-batch] snapshot rebuild failed:', (error as Error).message);
      recordError('bp-batch', error, { context: { stage: 'snapshots' } });
    }

    const body = `${parts.join(' ')} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`;
    console.log(`[bp-batch] done: ${body}`);
    // Persist buffered log entries; this must be the last thing we do.
    await flushErrorLog();
    return { statusCode: 200, body };
  });
};
