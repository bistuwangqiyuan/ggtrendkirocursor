import { clampBatchSize } from '../../src/lib/bpBatch';
import { bpService } from '../../src/lib/services/bp';
import { isLlmConfigured } from '../../src/lib/services/llm';

/**
 * Background BP batch generator. The `-background` filename suffix gives this
 * function the 15-minute execution budget (vs. the 26s sync limit).
 *
 * Generation runs IN-PROCESS via bpService (esbuild bundles src + pg, so the
 * DB is reachable directly). This is deliberate: the previous design called
 * the synchronous /api/bp/cron endpoint over HTTP, which is capped at 26s —
 * any LLM call slower than that got the SSR function killed mid-write and left
 * the report stuck at 'generating' forever (the root cause of the July 2026
 * all-failed streak). In here each generation may use the full LLM timeout.
 *
 * Invoked (fire-and-forget) by the scheduled `bp-scheduled` function. Netlify
 * returns 202 to the caller immediately; this body keeps running.
 *
 * Tunables:
 *   BP_BATCH_SIZE  number of BPs to attempt per run (default 5, clamped 1-10)
 *   CRON_SECRET    bearer secret required to invoke this function
 */

/**
 * Stop starting new generations once this much of the 15-min budget is spent.
 * Reasoning-tier models (auto-upgraded, e.g. qwen3.7-max) take ~2min per BP,
 * so a full batch can overrun the budget; an iteration started after this
 * cutoff risks being killed mid-DB-write and leaving a row stuck at
 * 'generating' — the exact failure mode this function exists to avoid.
 * 11 min leaves >= one full LLM timeout (150s) plus write headroom.
 */
const BATCH_TIME_BUDGET_MS = 11 * 60 * 1000;

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

  if (!isLlmConfigured()) {
    console.error('[bp-batch] LLM not configured; skipping run');
    return { statusCode: 200, body: 'skipped: LLM not configured' };
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
    if (Date.now() - startedAt > BATCH_TIME_BUDGET_MS) {
      console.log(`[bp-batch] time budget spent after ${i} iteration(s); stopping batch early`);
      break;
    }
    try {
      // Full default LLM timeout is fine here (15-min budget).
      const result = await bpService.runScheduledGeneration();

      if (result.success && result.data.action === 'generated') {
        generated++;
        consecutiveFailures = 0;
        const rid = result.data.report.id;
        console.log(`[bp-batch] ${i + 1}/${batchSize} -> generated ${rid} "${result.data.report.keyword}"`);
        if (seenReportIds.has(rid)) {
          reused++;
          console.log('[bp-batch] repeated report id (reuse-loop / new-keyword pool exhausted); stopping batch early');
          break;
        }
        seenReportIds.add(rid);
      } else if (result.success && result.data.action === 'skipped') {
        // Keyword pool exhausted (no eligible trend); stop early.
        skipped++;
        console.log(`[bp-batch] ${i + 1}/${batchSize} -> skipped (${result.data.reason}); stopping batch early`);
        break;
      } else if (!result.success) {
        failed++;
        consecutiveFailures++;
        console.error(`[bp-batch] ${i + 1}/${batchSize} -> failed: ${result.error.code} ${result.error.message}`);
        // Several failures in a row usually means LLM/all-endpoints down; bail
        // out. Tolerate transient single timeouts so one hiccup doesn't cut a
        // 10-BP run short.
        if (result.error.code === 'LLM_NOT_CONFIGURED') break;
        if (consecutiveFailures >= 3) {
          console.error('[bp-batch] 3 consecutive failures; stopping batch early');
          break;
        }
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      console.error(`[bp-batch] ${i + 1}/${batchSize} unexpected error:`, (err as Error).message);
      if (consecutiveFailures >= 3) break;
    }

    // Small spacing between calls to be gentle on the LLM endpoints / DB pool.
    if (i < batchSize - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  const summary = `generated=${generated} reused=${reused} skipped=${skipped} failed=${failed} of batchSize=${batchSize}`;
  console.log(`[bp-batch] done: ${summary}`);
  return { statusCode: 200, body: summary };
};
