import { clampBatchSize } from '../../src/lib/bpBatch';

/**
 * Background BP batch generator. The `-background` filename suffix gives this
 * function the 15-minute execution budget (vs. the 26s sync limit), letting it
 * loop and generate several BPs per run. It calls the in-app cron endpoint,
 * which generates exactly one BP per call (each within the sync limit).
 *
 * Invoked (fire-and-forget) by the scheduled `bp-scheduled` function. Netlify
 * returns 202 to the caller immediately; this body keeps running.
 *
 * Tunables:
 *   BP_BATCH_SIZE  number of BPs to attempt per run (default 10, clamped 1-10)
 *   CRON_SECRET    bearer secret required by /api/bp/cron
 */
export const handler = async (event: { headers?: Record<string, string | undefined> }) => {
  const secret = process.env.CRON_SECRET?.trim();
  const base = (process.env.URL || process.env.DEPLOY_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');

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

  const batchSize = clampBatchSize(process.env.BP_BATCH_SIZE);
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let reused = 0;
  let consecutiveFailures = 0;
  // Report ids already produced this run. findReusable returns an EXISTING id
  // (same-keyword reuse); business-model dedup and fresh generations each yield
  // a NEW id. A repeated id therefore means the picker can't advance to a new
  // hotword (pool of genuinely-new keywords exhausted) -> stop early instead of
  // spending the remaining iterations re-emitting the same report.
  const seenReportIds = new Set<string>();

  for (let i = 0; i < batchSize; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 27000);
    try {
      const res = await fetch(`${base}/api/bp/cron`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Origin: base,
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* non-JSON */ }
      console.log(`[bp-batch] ${i + 1}/${batchSize} -> ${res.status} ${text.slice(0, 200)}`);

      if (res.ok && body?.action === 'generated') {
        generated++;
        consecutiveFailures = 0;
        const rid: string | undefined = body?.reportId;
        if (rid && seenReportIds.has(rid)) {
          reused++;
          console.log('[bp-batch] repeated report id (reuse-loop / new-keyword pool exhausted); stopping batch early');
          break;
        }
        if (rid) seenReportIds.add(rid);
      } else if (res.ok && body?.action === 'skipped') {
        // Keyword pool exhausted (no eligible trend); stop early.
        skipped++;
        console.log('[bp-batch] no eligible trend; stopping batch early');
        break;
      } else {
        failed++;
        consecutiveFailures++;
        // Several failures in a row usually means LLM/all-endpoints down; bail
        // out. Tolerate transient single timeouts so one hiccup doesn't cut a
        // 10-BP run short.
        if (consecutiveFailures >= 3) {
          console.error('[bp-batch] 3 consecutive failures; stopping batch early');
          break;
        }
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      console.error(`[bp-batch] ${i + 1}/${batchSize} invoke error:`, (err as Error).message);
      if (consecutiveFailures >= 3) break;
    } finally {
      clearTimeout(timer);
    }

    // Small spacing between calls to be gentle on the LLM endpoints / DB pool.
    if (i < batchSize - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  const summary = `generated=${generated} reused=${reused} skipped=${skipped} failed=${failed} of batchSize=${batchSize}`;
  console.log(`[bp-batch] done: ${summary}`);
  return { statusCode: 200, body: summary };
};
