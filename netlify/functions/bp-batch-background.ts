import { clampBatchSize } from '../../src/lib/bpBatch';
import { runBpBatch } from '../../src/lib/services/bpBatchRunner';
import { trendsCollector } from '../../src/lib/services/trendsCollector';
import { siteMonitorService } from '../../src/lib/services/siteMonitor';
import { applyAdditiveMigrations, runMaintenance } from '../../src/lib/services/maintenance';
import { rebuildAllSnapshots } from '../../src/lib/cache/snapshotBuilder';
import { connectSnapshotStoreToLambda, snapshotBackend } from '../../src/lib/cache/snapshot';
import { ensureSnapshotsDelivered } from '../../src/lib/cache/snapshotDelivery';
import { isLlmConfigured } from '../../src/lib/services/llm';
import { flushErrorLog, recordError } from '../../src/lib/observability/errorLog';
import { recordOpsAlert } from '../../src/lib/observability/opsAlerts';
import { runWithDbContext } from '../../src/lib/observability/dbContext';
import { catchUpBatchSize, loadPipelineState, missedRuns, savePipelineState } from '../../src/lib/services/pipelineState';

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
 * SURVIVING A NEON OUTAGE
 * Every step here assumes the database may be unavailable, because on the free
 * plan it periodically is. Harvested hotwords are queued in Blobs rather than
 * dropped, generation falls back to cached dedupe state and buffers its output,
 * and both backlogs are drained at the top of the next run — see trendIntake.ts
 * and bpDedupeCache.ts. A missed window becomes late data, not missing data.
 *
 * SURVIVING A BROKEN SNAPSHOT STORE
 * This is a v1 (Lambda-compatible) handler, so `connectSnapshotStoreToLambda`
 * must run before anything touches Blobs — without it the store is unreachable
 * here while working perfectly in SSR, and every snapshot write is discarded. The
 * run ends by proving the writes are readable and, if they are not, rebuilding
 * through the SSR route and recording the incident in Postgres, because the blob
 * log cannot report its own store being down.
 *
 * Tunables:
 *   BP_BATCH_SIZE  number of BPs to attempt per run (default 5, clamped 1-10;
 *                  raised automatically after missed windows)
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

/** Leave this much of the budget for the delivery check and its repair. */
const DELIVERY_BUDGET_MS = 4 * 60 * 1000;

export const handler = async (event: {
  headers?: Record<string, string | undefined>;
  /** Base64 Blobs credentials, present only on v1 function events. */
  blobs?: string;
}) => {
  const startedAt = Date.now();

  // Before anything else: every step below reads or writes snapshots, and in a v1
  // function they are unreachable until the event's credentials are handed to the
  // Blobs client.
  const connected = await connectSnapshotStoreToLambda(event);

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
    // Say which store is in play up front: if this reads `unavailable`, every
    // snapshot number below is meaningless and step 5b will explain why.
    parts.push(`blobs=${connected ? 'lambda' : 'ambient'}:${await snapshotBackend()}`);

    // --- 0. Additive schema migrations ------------------------------------
    // Ahead of collection, not with the other housekeeping in step 4: the
    // collector writes topic_class, so running this afterwards would waste the
    // first cycle after a schema change silently collecting unclassified rows.
    try {
      const columns = await applyAdditiveMigrations();
      if (columns) parts.push(`migrations=${columns}`);
    } catch (error) {
      parts.push('migrations=error');
      recordError('bp-batch', error, { context: { stage: 'migrations' } });
    }

    const pipeline = await loadPipelineState();
    const missed = missedRuns(pipeline, new Date(startedAt));
    if (missed > 0) parts.push(`missedRuns=${missed}`);
    await savePipelineState({ lastRunStartedAt: new Date(startedAt).toISOString() });

    // --- 1. Trends collection (was: trends-collector at :50) --------------
    let collectOk = false;
    try {
      const collected = await trendsCollector.collect();
      collectOk = collected.deferred === 0;
      parts.push(`collected=${collected.inserted}`);
      if (collected.deferred > 0) parts.push(`queued=${collected.deferred}`);
      parts.push(
        `topics=s:${collected.topics.sports},e:${collected.topics.entertainment},g:${collected.topics.general}`
      );
      console.log(
        `[bp-batch] collect: inserted=${collected.inserted} skipped=${collected.skipped} ` +
        `deferred=${collected.deferred} topics=${JSON.stringify(collected.topics)} ` +
        `stored=${collected.topicClassStored} errors=${collected.errors.length}`
      );
      if (collected.errors.length > 0) {
        recordError('bp-batch', collected.errors.join('; '), {
          level: collected.deferred > 0 ? 'error' : 'warn',
          context: { stage: 'collect', deferred: collected.deferred },
        });
      }
    } catch (error) {
      parts.push('collect=error');
      console.error('[bp-batch] collect failed:', (error as Error).message);
      recordError('bp-batch', error, { context: { stage: 'collect' } });
    }

    // --- 1b. Drain hotwords queued during an earlier outage ---------------
    // After collection, not before: a keyword that is still trending gets stored
    // with today's timestamp, and the older queued copy is then deduplicated away.
    try {
      const drained = await trendsCollector.drainPending();
      if (drained.batches > 0 || drained.expiredBatches > 0 || drained.remaining > 0) {
        parts.push(
          `drained=${drained.inserted}` +
          (drained.expiredRows > 0 ? ` expired=${drained.expiredRows}` : '') +
          (drained.remaining > 0 ? ` stillQueued=${drained.remaining}` : '')
        );
        console.log(`[bp-batch] intake drain: ${JSON.stringify(drained)}`);
      }
      if (drained.errors.length > 0) {
        recordError('bp-batch', drained.errors.join('; '), { context: { stage: 'drain-intake' } });
      }
    } catch (error) {
      parts.push('drain=error');
      recordError('bp-batch', error, { context: { stage: 'drain-intake' } });
    }

    // Rebuild the trends snapshot before generation, not with the others at the
    // end: the candidate picker reads that snapshot, so without this the batch
    // would select from keywords collected three hours ago and every new keyword
    // would wait a full cycle.
    try {
      const trendsSnapshot = await rebuildAllSnapshots({ only: ['trends'] });
      parts.push(`trendsSnapshot=${trendsSnapshot.written.trends ?? 0}`);
    } catch (error) {
      parts.push('trendsSnapshot=error');
      recordError('bp-batch', error, { context: { stage: 'trends-snapshot' } });
    }

    // --- 2. BP generation -------------------------------------------------
    let generationDegraded = false;
    if (!isLlmConfigured()) {
      parts.push('bp=skipped(no LLM)');
      console.error('[bp-batch] LLM not configured; skipping generation');
    } else {
      // Missed windows are work already owed, so ask for extra candidates. The
      // generation loop still stops at its own deadline.
      const batchSize = catchUpBatchSize(clampBatchSize(process.env.BP_BATCH_SIZE), pipeline, new Date(startedAt));
      const summary = await runBpBatch({
        batchSize,
        generateUntil: startedAt + GENERATE_BUDGET_MS,
        spacingMs: 1500,
      });
      generationDegraded = summary.degraded;
      parts.push(
        `generated=${summary.generated} dup=${summary.duplicates} failed=${summary.failed} replayed=${summary.replayed} of batchSize=${batchSize}`
      );
      if (summary.degraded) parts.push('bp=degraded');
      if (summary.buffered) parts.push('bp=buffered');
      console.log(
        `[bp-batch] generation done: ${JSON.stringify({
          ...summary,
          errors: summary.errors.slice(0, 5),
        })}`
      );
      if (summary.generated + summary.duplicates + summary.replayed > 0) {
        await savePipelineState({ lastFlushAt: new Date().toISOString() });
      }
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
      `pruned=trends:${maintenance.trendsDeleted},checks:${maintenance.siteChecksDeleted},` +
      `logs:${maintenance.logsDeleted},alerts:${maintenance.opsAlertsDeleted}`
    );

    // --- 5. Snapshot rebuild (the whole point: read paths never touch DB) --
    // Trends were already rebuilt in step 1 and nothing since then changed them.
    try {
      const snapshots = await rebuildAllSnapshots({ only: ['landing', 'bp', 'monitor', 'stats'] });
      const totalWritten = Object.values(snapshots.written).reduce((a, b) => a + b, 0);
      parts.push(`snapshots=${totalWritten}`);
      console.log(`[bp-batch] snapshots: ${JSON.stringify(snapshots)}`);
    } catch (error) {
      parts.push('snapshots=error');
      console.error('[bp-batch] snapshot rebuild failed:', (error as Error).message);
      recordError('bp-batch', error, { context: { stage: 'snapshots' } });
    }

    // --- 5b. Prove the read side actually received all of that -------------
    // A snapshot write that reports success but reaches no reader is the failure
    // mode that froze every page for 44 hours in July 2026, so the run verifies
    // its own effect instead of trusting it.
    try {
      const delivery = await ensureSnapshotsDelivered({
        budgetMs: Math.max(30_000, Math.min(DELIVERY_BUDGET_MS, startedAt + 14 * 60 * 1000 - Date.now())),
      });
      parts.push(delivery.summary);
      if (!delivery.probe.ok) {
        console.error(`[bp-batch] snapshot store unusable: ${delivery.probe.detail}`);
        // Postgres, not the blob log: the blob log is the thing that is down.
        const recorded = await recordOpsAlert(
          'snapshot-store',
          `Snapshot store unusable from bp-batch-background: ${delivery.probe.detail}`,
          {
            backend: delivery.probe.backend,
            blobsError: delivery.probe.error,
            lambdaConnected: connected,
            repaired: delivery.ok,
            repair: delivery.repair?.detail ?? null,
          }
        );
        if (!recorded) parts.push('alert=unrecorded');
      }
    } catch (error) {
      parts.push('delivery=error');
      console.error('[bp-batch] delivery check failed:', (error as Error).message);
      recordError('bp-batch', error, { context: { stage: 'delivery' } });
    }

    // --- 6. Record how the run went, for catch-up and the recovery job -----
    const healthy = collectOk && !generationDegraded;
    await savePipelineState(
      healthy
        ? { lastHealthyRunAt: new Date().toISOString(), consecutiveDegradedRuns: 0 }
        : { consecutiveDegradedRuns: pipeline.consecutiveDegradedRuns + 1 }
    );
    if (!healthy) parts.push(`degradedStreak=${pipeline.consecutiveDegradedRuns + 1}`);

    const body = `${parts.join(' ')} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`;
    console.log(`[bp-batch] done: ${body}`);
    // Persist buffered log entries; this must be the last thing we do.
    await flushErrorLog();
    return { statusCode: 200, body };
  });
};
