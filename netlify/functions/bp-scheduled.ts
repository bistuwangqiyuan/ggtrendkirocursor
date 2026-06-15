import { schedule } from '@netlify/functions';

/**
 * Scheduled BP auto-generation. Runs every 6 hours (UTC) and fires the
 * `bp-batch-background` function (15-min budget), which loops and generates
 * several BPs per run (BP_BATCH_SIZE, default 10) for the next eligible
 * ungenerated hotwords (score > 60, skip duplicates within the 7-day window).
 *
 * This trigger only kicks off the background job and returns immediately, so it
 * stays well within the scheduled-function time limit. Requires CRON_SECRET.
 */
export const handler = schedule('0 */6 * * *', async () => {
  const secret = process.env.CRON_SECRET?.trim();
  // Netlify provides URL (production) / DEPLOY_URL (deploy previews).
  const base = (process.env.URL || process.env.DEPLOY_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');

  if (!secret) {
    console.error('[bp-scheduled] CRON_SECRET not set; skipping run');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    // Background functions return 202 immediately; the batch keeps running.
    const res = await fetch(`${base}/.netlify/functions/bp-batch-background`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Origin: base,
      },
      signal: controller.signal,
    });
    console.log(`[bp-scheduled] triggered bp-batch-background -> ${res.status}`);
    return { statusCode: 200, body: `batch triggered ${res.status}` };
  } catch (err) {
    console.error('[bp-scheduled] failed to trigger batch:', (err as Error).message);
    return { statusCode: 200, body: 'error triggering batch' };
  } finally {
    clearTimeout(timer);
  }
});
