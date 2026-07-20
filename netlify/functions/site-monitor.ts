import { schedule } from '@netlify/functions';

/**
 * Scheduled site monitoring. Every 6 hours (UTC, minute 20 to stay clear of
 * the trends collector and BP batch) it triggers /api/monitor/run, which
 * probes every registered site for uptime and SEO health and stores the
 * results for the /monitor dashboard. Zero LLM tokens; requires CRON_SECRET.
 */
export const handler = schedule('20 */6 * * *', async () => {
  const secret = process.env.CRON_SECRET?.trim();
  const base = (process.env.URL || process.env.DEPLOY_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');

  if (!secret) {
    console.error('[site-monitor] CRON_SECRET not set; skipping run');
    return { statusCode: 200, body: 'skipped: no CRON_SECRET' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(`${base}/api/monitor/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Origin: base,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    console.log(`[site-monitor] run responded ${res.status}: ${text.slice(0, 300)}`);
    return { statusCode: 200, body: `monitor status ${res.status}` };
  } catch (err) {
    console.error('[site-monitor] failed to invoke run:', (err as Error).message);
    return { statusCode: 200, body: 'error invoking monitor run' };
  } finally {
    clearTimeout(timer);
  }
});
