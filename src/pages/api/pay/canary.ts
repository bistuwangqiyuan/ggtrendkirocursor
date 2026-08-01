/**
 * Daily proof that someone could actually buy something.
 *
 * The failure this exists for is silent: an expired API key, a product archived
 * in the provider's dashboard, a rotated webhook secret. Nothing on this site
 * breaks — the pages render, the pipeline runs — and the first person to notice
 * is a customer who wanted to pay and could not. Revenue is the one metric where
 * zero looks exactly like healthy.
 *
 * So once a day a scheduled job asks every configured provider to open a checkout
 * session and then throws the URL away. An abandoned session costs nothing, and
 * no order row is created, so the canary leaves no trace in the buyer-facing
 * data. What it does leave, on failure, is an ops alert.
 *
 * Authenticated with CRON_SECRET: it spends provider API calls, so it is not
 * something the public may trigger.
 */
import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { availableAdapters, paymentsEnabled } from '../../../lib/payments';
import { paymentAlert } from '../../../lib/payments/alerts';
import { tokenSecret } from '../../../lib/payments/tokens';
import { emailConfigured } from '../../../lib/email/resend';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

interface ProbeResult {
  provider: string;
  ok: boolean;
  checkoutId?: string;
  error?: string;
  ms: number;
}

export const GET: APIRoute = async ({ request, url }) => {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return json({ success: false, error: 'cron_secret_missing' }, 503);
  const provided = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (provided !== secret) return json({ success: false, error: 'unauthorized' }, 401);

  const configuration = {
    paymentsEnabled: paymentsEnabled(),
    providers: availableAdapters().map((a) => a.provider),
    downloadTokens: !!tokenSecret(),
    orderEmails: emailConfigured(),
  };

  // A deployment with no provider configured is not selling anything, and is not
  // broken either. Reporting it as unhealthy would mail an alert every morning
  // until the accounts exist — which is how a monitor teaches its owner to ignore
  // it. So this case is explicitly "disabled", and the workflow accepts it.
  if (!configuration.paymentsEnabled) {
    return json({
      success: true,
      healthy: false,
      disabled: true,
      configuration,
      configProblems: ['no provider has both an API key and a webhook secret'],
      probes: [],
    });
  }

  // Configuration problems are reported before any network call, because they are
  // the likelier cause and the cheaper thing to check.
  const configProblems: string[] = [];
  if (!configuration.downloadTokens) configProblems.push('PAYMENT_TOKEN_SECRET/SESSION_SECRET missing: downloads cannot be signed');
  if (!configuration.orderEmails) configProblems.push('RESEND_API_KEY missing: buyers cannot retrieve lost download links');

  const probes: ProbeResult[] = [];
  for (const adapter of availableAdapters()) {
    const startedAt = Date.now();
    try {
      // A synthetic report id: the canary must not touch real orders, and no
      // provider validates our metadata. The session is abandoned immediately.
      const session = await adapter.createCheckout({
        reportId: randomUUID(),
        email: `canary+${Date.now()}@ioni.top`,
        locale: 'en',
        successUrl: `${url.protocol}//${url.host}/bp/canary`,
        reference: `canary-${randomUUID()}`,
      });
      probes.push({
        provider: adapter.provider,
        ok: !!session.url,
        checkoutId: session.checkoutId,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      probes.push({
        provider: adapter.provider,
        ok: false,
        error: (error as Error).message,
        ms: Date.now() - startedAt,
      });
    }
  }

  const healthy = probes.length > 0 && probes.every((p) => p.ok) && configProblems.length === 0;

  if (!healthy) {
    const detail = [
      ...configProblems,
      ...probes.filter((p) => !p.ok).map((p) => `${p.provider}: ${p.error || 'no checkout url'}`),
    ].join('; ');
    await paymentAlert('canary_failed', detail, { configuration, probes });
  }

  // 200 either way: the caller is a cron job, and the body is the report. A
  // non-2xx would only make the workflow log look like the workflow was broken.
  return json({ success: true, healthy, configuration, configProblems, probes });
};
