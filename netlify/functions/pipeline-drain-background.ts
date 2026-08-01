import { trendsCollector } from '../../src/lib/services/trendsCollector';
import { replayPendingBatches } from '../../src/lib/services/bpBatchRunner';
import { ALL_SECTIONS, rebuildAllSnapshots, type SnapshotSection } from '../../src/lib/cache/snapshotBuilder';
import { connectSnapshotStoreToLambda } from '../../src/lib/cache/snapshot';
import { ensureSnapshotsDelivered } from '../../src/lib/cache/snapshotDelivery';
import { savePipelineState } from '../../src/lib/services/pipelineState';
import { drainBufferedPaymentEvents } from '../../src/lib/payments/orderBuffer';
import { applyPaymentEvent } from '../../src/lib/services/orders';
import { paymentAlert } from '../../src/lib/payments/alerts';
import { flushErrorLog, recordError } from '../../src/lib/observability/errorLog';
import { recordOpsAlert } from '../../src/lib/observability/opsAlerts';
import { runWithDbContext } from '../../src/lib/observability/dbContext';
import { isWriter, siteRole } from '../../src/lib/utils/siteRole';

/**
 * Land whatever an outage left in Blobs, as soon as the database is reachable.
 *
 * WHY THIS IS SEPARATE FROM bp-batch-background
 * That function is the three-hourly write window: it harvests, generates plans,
 * monitors sites and prunes. Waiting for it means a backlog can sit unpublished
 * for up to three hours after Neon recovers. This function does only the part
 * that is worth doing early — moving queued hotwords and buffered plans into
 * Postgres, then refreshing the snapshots the site reads — and spends no LLM
 * credits, so the recovery job may call it often without cost.
 *
 * It is only ever invoked when pipeline-recovery has already confirmed, from
 * Blobs alone, that there is something to do. On a healthy site it therefore never
 * runs and never wakes the database.
 *
 * `?repairSnapshots=<sections|all>` asks for a rebuild even with nothing to drain.
 * That is the watchdog's answer to a frozen read side: rebuilding can take several
 * passes, which does not fit the scheduled handler's synchronous budget but fits
 * this one's fifteen minutes.
 */
export const handler = async (event: {
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  blobs?: string;
}) => {
  const startedAt = Date.now();
  // The backlog this function drains lives in Blobs, which a v1 function cannot
  // reach until the event's credentials are handed to the client.
  await connectSnapshotStoreToLambda(event);

  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error('[pipeline-drain] CRON_SECRET not set; skipping');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }
  const headers = event?.headers || {};
  const authHeader = headers.authorization || headers.Authorization || '';
  if (authHeader.replace(/^Bearer\s+/i, '').trim() !== secret) {
    console.error('[pipeline-drain] unauthorized invocation rejected');
    return { statusCode: 401, body: 'unauthorized' };
  }

  const parts: string[] = [];
  const repairRequest = event?.queryStringParameters?.repairSnapshots?.trim() || '';
  const requestedSections = repairRequest
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SnapshotSection => (ALL_SECTIONS as string[]).includes(s));

  return runWithDbContext({ reason: 'cron', route: 'pipeline-drain-background' }, async () => {
    let landed = 0;

    // A reader deployment may repair its own snapshots but must not land queued
    // work: the queues are filled by the batch, which only the writer runs, so
    // draining them from both accounts would insert the same hotwords twice.
    if (isWriter()) {
      // Hotwords first: a buffered plan may reference a queued trend row, so the
      // row it points at should exist by the time the plan is written.
      try {
        const drained = await trendsCollector.drainPending();
        landed += drained.inserted;
        parts.push(
          `trends=${drained.inserted}` +
          (drained.expiredRows > 0 ? ` expired=${drained.expiredRows}` : '') +
          (drained.remaining > 0 ? ` stillQueued=${drained.remaining}` : '')
        );
        if (drained.errors.length > 0) {
          recordError('pipeline-drain', drained.errors.join('; '), { context: { stage: 'drain-intake' } });
        }
      } catch (error) {
        parts.push('trends=error');
        recordError('pipeline-drain', error, { context: { stage: 'drain-intake' } });
      }

      try {
        const replayed = await replayPendingBatches();
        landed += replayed;
        parts.push(`reports=${replayed}`);
        if (replayed > 0) await savePipelineState({ lastFlushAt: new Date().toISOString() });
      } catch (error) {
        parts.push('reports=error');
        recordError('pipeline-drain', error, { context: { stage: 'replay' } });
      }

    } else {
      parts.push(`role=${siteRole()} drain=skipped`);
    }

    // Payments are drained by BOTH roles, unlike everything above.
    //
    // Blobs are per-site, and the deployment serving the public domain is the one
    // the provider posts webhooks to — which is the reader. Its buffered payments
    // are invisible to the writer's store, so gating this on the role would leave
    // a paid order stranded in Blobs for as long as the reader served traffic.
    // Landing the same event twice is harmless: it is keyed on
    // provider_order_id and applied idempotently.
    //
    // Never counted into `landed`: a purchase changes no page, so it must not be
    // the reason snapshots are rebuilt.
    try {
      const drained = await drainBufferedPaymentEvents(async (paymentEvent) => {
        await applyPaymentEvent(paymentEvent);
      });
      if (drained.applied > 0 || drained.remaining > 0) {
        parts.push(`payments=${drained.applied}` + (drained.remaining > 0 ? ` stuck=${drained.remaining}` : ''));
      }
      if (drained.errors.length > 0) {
        await paymentAlert('drain_failed', `buffered payments could not be landed: ${drained.errors.join('; ')}`, {
          applied: drained.applied,
          remaining: drained.remaining,
        });
      }
    } catch (error) {
      parts.push('payments=error');
      await paymentAlert('drain_failed', (error as Error).message, { stage: 'drain-payments' });
    }

    // Rebuild when something landed, or when the watchdog asked because readers
    // are looking at frozen pages. Otherwise skip it: an unchanged database would
    // produce identical snapshots at the cost of another read pass.
    const sections: SnapshotSection[] =
      requestedSections.length > 0 && landed === 0 ? requestedSections : [...ALL_SECTIONS];
    if (landed > 0 || repairRequest) {
      if (repairRequest) parts.push(`repairRequest=${sections.join(',')}`);
      try {
        const snapshots = await rebuildAllSnapshots({ only: sections });
        parts.push(`snapshots=${Object.values(snapshots.written).reduce((a, b) => a + b, 0)}`);
      } catch (error) {
        parts.push('snapshots=error');
        recordError('pipeline-drain', error, { context: { stage: 'snapshots' } });
      }
      // The point of this function is to publish, so confirm it was published
      // rather than assuming the store took it.
      try {
        const delivery = await ensureSnapshotsDelivered({ sections, budgetMs: 5 * 60 * 1000 });
        parts.push(delivery.summary);
        if (!delivery.probe.ok) {
          await recordOpsAlert(
            'snapshot-store',
            `Snapshot store unusable from pipeline-drain-background: ${delivery.probe.detail}`,
            { backend: delivery.probe.backend, blobsError: delivery.probe.error, repaired: delivery.ok }
          );
        }
      } catch (error) {
        parts.push('delivery=error');
        recordError('pipeline-drain', error, { context: { stage: 'delivery' } });
      }
    }

    const body = `${parts.join(' ')} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`;
    console.log(`[pipeline-drain] done: ${body}`);
    await flushErrorLog();
    return { statusCode: 200, body };
  });
};
