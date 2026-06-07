import { schedule } from '@netlify/functions';

/**
 * Scheduled BP auto-generation. Runs every 6 hours (UTC) and calls the
 * in-app cron endpoint, which generates a Business Plan for the current
 * #1 trending keyword (with 24h dedupe so it never double-charges the LLM).
 *
 * Requires the CRON_SECRET environment variable to authorize the call.
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
  const timer = setTimeout(() => controller.abort(), 25000);

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
    console.log(`[bp-scheduled] cron responded ${res.status}: ${text.slice(0, 300)}`);
    return { statusCode: 200, body: `cron status ${res.status}` };
  } catch (err) {
    console.error('[bp-scheduled] failed to invoke cron:', (err as Error).message);
    return { statusCode: 200, body: 'error invoking cron' };
  } finally {
    clearTimeout(timer);
  }
});
