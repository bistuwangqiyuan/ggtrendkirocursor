import { schedule } from '@netlify/functions';

/**
 * Scheduled Google Trends RSS harvest. Runs every 3 hours at minute 50 (UTC),
 * ~10 minutes before the BP batch generator, so the keyword pool is freshly
 * topped up before generation begins. With all-history dedupe each keyword is
 * analyzed only once, so the pool must keep supplying genuinely new hotwords
 * (up to 40/day are consumed). Spends zero LLM tokens.
 *
 * Requires the CRON_SECRET environment variable to authorize the call.
 */
export const handler = schedule('50 */3 * * *', async () => {
  const secret = process.env.CRON_SECRET?.trim();
  const base = (process.env.URL || process.env.DEPLOY_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');

  if (!secret) {
    console.error('[trends-collector] CRON_SECRET not set; skipping run');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(`${base}/api/trends/collect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Origin: base,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    console.log(`[trends-collector] collect responded ${res.status}: ${text.slice(0, 300)}`);
    return { statusCode: 200, body: `collect status ${res.status}` };
  } catch (err) {
    console.error('[trends-collector] failed to invoke collect:', (err as Error).message);
    return { statusCode: 200, body: 'error invoking collect' };
  } finally {
    clearTimeout(timer);
  }
});
