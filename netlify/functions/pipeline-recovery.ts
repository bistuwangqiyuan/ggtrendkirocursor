import { schedule } from '@netlify/functions';
import { pendingTrendBacklog } from '../../src/lib/services/trendIntake';
import { pendingBufferedReports } from '../../src/lib/services/bpBatchRunner';
import {
  loadPipelineState,
  recoveryDue,
  savePipelineState,
  snapshotRepairDue,
} from '../../src/lib/services/pipelineState';
import { connectSnapshotStoreToLambda } from '../../src/lib/cache/snapshot';
import { snapshotStaleness } from '../../src/lib/cache/snapshotDelivery';
import { bufferedPaymentBacklog } from '../../src/lib/payments/orderBuffer';
import { isWriter, siteRole } from '../../src/lib/utils/siteRole';

/**
 * Hourly check for work an outage left behind, and for a read side that stopped
 * being refreshed.
 *
 * THE PROBLEMS IT SOLVES
 * 1. The write window runs every three hours. If Neon is unavailable at :00 and
 *    recovers at :10, the hotwords harvested in that window sat in the Blobs queue
 *    for another two hours and fifty minutes with nothing to move them. This closes
 *    that gap to at most an hour.
 * 2. If the scheduled job's snapshot writes stop reaching readers — as they did
 *    for 44 hours in July 2026, when a v1 function could not see the Blobs
 *    environment — every page freezes while the database keeps filling up. Nothing
 *    noticed, because the thing that would have complained also writes to Blobs.
 *    So this checks the age of what readers can actually see, and rebuilds through
 *    the SSR route (a different runtime, with its own working store) when it is
 *    older than two missed windows.
 *
 * WHY IT DOESN'T COST ANYTHING
 * Both the backlog and the snapshot ages are visible in Blobs, so the checks never
 * touch Postgres — on a healthy site this function reads a few keys, finds nothing
 * wrong and returns. It only triggers work that wakes the database when there is
 * something wrong, and at most once an hour, so a genuinely broken state is
 * retried steadily rather than hammered.
 *
 * ON THE STANDBY DEPLOYMENT
 * A reader (SITE_ROLE=reader) keeps the snapshot watchdog, because its whole job
 * is serving pages that must not freeze, and repairing its own snapshots is a
 * read against an already-awake database rather than a duplicate write. It also
 * lands its own buffered payments, since it is the deployment providers post
 * webhooks to and Blobs are per-site. What it never does is drain the intake
 * queues: those are filled by the batch, which only the writer runs, so a reader
 * draining them would land the same hotwords twice.
 *
 * Set PIPELINE_RECOVERY_ENABLED=false to switch it off.
 */
export const handler = schedule('25 * * * *', async (event: { blobs?: string }) => {
  // Everything this function inspects lives in Blobs, which a v1 function cannot
  // reach until the event's credentials are handed to the client. Without this the
  // watchdog would see no snapshots at all and report a false freeze.
  await connectSnapshotStoreToLambda(event);

  if (process.env.PIPELINE_RECOVERY_ENABLED === 'false') {
    return { statusCode: 200, body: 'disabled' };
  }
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error('[pipeline-recovery] CRON_SECRET not set; skipping');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }

  const [trends, reports, payments, freshness] = await Promise.all([
    pendingTrendBacklog(),
    pendingBufferedReports(),
    bufferedPaymentBacklog(),
    snapshotStaleness(),
  ]);
  // Buffered payments count towards the backlog even though they publish nothing:
  // a purchase that only exists in Blobs is invisible in the buyer's downloads
  // list, so it deserves the same hourly nudge as unlanded hotwords.
  const backlog = trends.rows + reports.reports + payments.events;
  const state = await loadPipelineState();

  // Two independent reasons to act, deliberately kept separate: a store that the
  // batch cannot write to produces stale snapshots with an *empty* queue, so
  // gating the freshness check on a backlog would miss exactly the incident this
  // watchdog exists for.
  const repairSnapshots = freshness.stale && snapshotRepairDue(state);
  // Queued hotwords and buffered plans belong to the writer's batch. Buffered
  // payments do not: they were received by whichever deployment the provider
  // posted to, and Blobs are per-site, so the site holding them is the only one
  // that can land them.
  const queuedForWriter = trends.rows + reports.reports;
  const drainable = isWriter() ? backlog : payments.events;
  const drainBacklog = drainable > 0 && recoveryDue(state);
  if (queuedForWriter > 0 && !isWriter()) {
    console.warn(
      `[pipeline-recovery] role=${siteRole()}; leaving ${queuedForWriter} queued item(s) to the writer`
    );
  }

  if (freshness.stale) {
    console.error(
      `[pipeline-recovery] read side frozen: maxAge=${freshness.maxAgeSeconds}s ` +
      `threshold=${freshness.staleAfterSeconds}s sections=${freshness.staleSections.join(',')} ` +
      `missing=${freshness.missing.join(',') || 'none'}`
    );
  }
  if (!repairSnapshots && !drainBacklog) {
    const why = freshness.stale || drainable > 0 ? 'throttled' : 'nothing to do';
    console.log(`[pipeline-recovery] ${why}; backlog=${backlog} stale=${freshness.stale}`);
    return { statusCode: 200, body: `${why} backlog=${backlog} stale=${freshness.stale}` };
  }

  console.log(
    `[pipeline-recovery] triggering drain: ${trends.rows} hotword(s) in ${trends.batches} batch(es), ` +
    `${reports.reports} report(s) in ${reports.batches} buffer(s), ${payments.events} payment(s)` +
    (payments.oldestReceivedAt ? ` oldest=${payments.oldestReceivedAt}` : '') +
    `, repairSnapshots=${repairSnapshots}`
  );
  const now = new Date().toISOString();
  await savePipelineState({
    ...(drainBacklog ? { lastRecoveryTriggerAt: now } : {}),
    ...(repairSnapshots ? { lastSnapshotRepairAt: now } : {}),
  });

  // The repair itself runs in the background function: rebuilding a section can
  // need several passes, which does not fit the synchronous budget this scheduled
  // handler gets.
  const base = (process.env.URL || process.env.DEPLOY_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');
  const target =
    `${base}/.netlify/functions/pipeline-drain-background` +
    (repairSnapshots ? `?repairSnapshots=${encodeURIComponent(freshness.staleSections.join(',') || 'all')}` : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Origin: base,
      },
      signal: controller.signal,
    });
    return {
      statusCode: 200,
      body: `drain triggered ${res.status} backlog=${backlog} repairSnapshots=${repairSnapshots}`,
    };
  } catch (error) {
    console.error('[pipeline-recovery] failed to trigger drain:', (error as Error).message);
    return { statusCode: 200, body: 'error triggering drain' };
  } finally {
    clearTimeout(timer);
  }
});
