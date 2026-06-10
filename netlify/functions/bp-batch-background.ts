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
 *   BP_BATCH_SIZE  number of BPs to attempt per run (default 6, clamped 1-10)
 *   CRON_SECRET    bearer secret required by /api/bp/cron
 */
export const handler = async () => {
  const secret = process.env.CRON_SECRET?.trim();
  const base = (process.env.URL || process.env.DEPLOY_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');

  if (!secret) {
    console.error('[bp-batch] CRON_SECRET not set; skipping run');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }

  const batchSize = clampBatchSize(process.env.BP_BATCH_SIZE);
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;

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
      } else if (res.ok && body?.action === 'skipped') {
        // Keyword pool exhausted (no eligible trend); stop early.
        skipped++;
        console.log('[bp-batch] no eligible trend; stopping batch early');
        break;
      } else {
        failed++;
        consecutiveFailures++;
        // Two failures in a row usually means LLM/all-endpoints down; bail out.
        if (consecutiveFailures >= 2) {
          console.error('[bp-batch] 2 consecutive failures; stopping batch early');
          break;
        }
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      console.error(`[bp-batch] ${i + 1}/${batchSize} invoke error:`, (err as Error).message);
      if (consecutiveFailures >= 2) break;
    } finally {
      clearTimeout(timer);
    }

    // Small spacing between calls to be gentle on the LLM endpoints / DB pool.
    if (i < batchSize - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  const summary = `generated=${generated} skipped=${skipped} failed=${failed} of batchSize=${batchSize}`;
  console.log(`[bp-batch] done: ${summary}`);
  return { statusCode: 200, body: summary };
};
