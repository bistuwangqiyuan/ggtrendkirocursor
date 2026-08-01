/**
 * The paid download.
 *
 * WHAT IS CHECKED, AND IN WHICH ORDER
 * 1. The token's signature and expiry. Unsigned means no download, always.
 * 2. That the token was issued for THIS report. Otherwise one purchase would open
 *    every report in the catalogue.
 * 3. That the order is still paid. This is what makes a refund actually revoke
 *    access: the token cannot be recalled, so entitlement is re-read here.
 * 4. The download counter, which caps abuse of a shared link.
 *
 * DURING A DATABASE OUTAGE
 * Steps 3 and 4 need Postgres. When it is unavailable the download proceeds on the
 * strength of the signed token alone, and the counter is not incremented. That is
 * a deliberate trade in the buyer's favour: the token was only ever issued after a
 * verified payment, so the worst case is a refunded buyer getting one more copy of
 * a file they already have — against the alternative of a paying customer being
 * refused. Failing closed here would punish the wrong person.
 */
import type { APIRoute } from 'astro';
import { bpService } from '../../../../lib/services/bp';
import { getBpByIdFromSnapshot } from '../../../../lib/cache/snapshotReaders';
import { contentDisposition, pdfFilename, renderBpPdf } from '../../../../lib/pdf/bpPdf';
import { verifyToken } from '../../../../lib/payments/tokens';
import { getOrder, MAX_DOWNLOADS_PER_ORDER, noteDownload, OrdersUnavailableError } from '../../../../lib/services/orders';
import { recordError } from '../../../../lib/observability/errorLog';
import { paymentAlert } from '../../../../lib/payments/alerts';
import { clientIpFromRequest, rateLimit, rateLimitResponse } from '../../../../lib/utils/rateLimit';
import type { BpReport } from '../../../../types';

export const prerender = false;

/** Above this, a render is worth a line in the daily log. See the call site. */
const SLOW_RENDER_MS = 8_000;

function problem(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: code, message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ params, request, url, locals }) => {
  // Rendering a PDF is the most expensive thing this site does per request, so
  // the limit is per IP and low; a legitimate buyer clicks once.
  const rl = rateLimit(`download:${clientIpFromRequest(request)}`, 12, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  const reportId = (params.id || '').trim();
  const token = url.searchParams.get('token');
  if (!reportId) return problem(400, 'missing_report', 'No report id');

  const verified = verifyToken(token, 'download');
  if (!verified.ok) {
    if (verified.reason === 'unconfigured') {
      await paymentAlert('download_failed', 'no PAYMENT_TOKEN_SECRET/SESSION_SECRET configured', { reportId });
      return problem(503, 'downloads_unavailable', 'Downloads are not configured');
    }
    return problem(403, `token_${verified.reason}`, 'This download link is not valid');
  }
  if (verified.claims.reportId !== reportId) {
    return problem(403, 'token_scope', 'This link is for a different report');
  }

  const orderId = verified.claims.orderId || '';
  // A "buffered:" order id means the payment is verified but not yet in Postgres
  // (see /api/pay/status). There is no row to check or count against.
  const isBuffered = orderId.startsWith('buffered:');
  let buyerEmail: string | null = null;
  let reference: string | null = isBuffered ? orderId.slice('buffered:'.length) : null;

  if (!isBuffered) {
    try {
      const order = await getOrder(orderId);
      if (!order) return problem(403, 'order_missing', 'No purchase found for this link');
      if (order.reportId && order.reportId !== reportId) {
        return problem(403, 'order_scope', 'This purchase is for a different report');
      }
      if (order.status === 'refunded') {
        return problem(403, 'order_refunded', 'This purchase was refunded');
      }
      if (order.status !== 'paid') {
        return problem(402, 'order_unpaid', 'This purchase is not complete');
      }
      buyerEmail = order.email;
      reference = order.reference;

      const counted = await noteDownload(order.id);
      if (!counted.allowed) {
        return problem(
          429,
          'download_limit',
          `This purchase has been downloaded ${counted.count} times (limit ${MAX_DOWNLOADS_PER_ORDER}). Contact support if you need more.`
        );
      }
    } catch (error) {
      if (!(error instanceof OrdersUnavailableError)) throw error;
      // See the file header: proceed on the token alone rather than refusing.
      console.warn(`[download] order store unavailable; serving ${reportId} on token alone`);
    }
  }

  // The snapshot first, as everywhere else, so a download does not wake Neon.
  let report: BpReport | null = (await getBpByIdFromSnapshot(reportId)).data;
  if (!report?.contentJson) {
    const fresh = await bpService.getById(reportId);
    if (fresh.success) report = fresh.data;
  }
  if (!report || report.status !== 'completed' || !report.contentJson) {
    return problem(409, 'report_not_ready', 'This report has no content to export yet');
  }

  try {
    const renderStartedAt = Date.now();
    const rendered = await renderBpPdf(report, {
      locale: locals.locale === 'en' ? 'en' : 'zh',
      buyerEmail: buyerEmail || undefined,
      orderReference: reference || undefined,
      siteName: 'ioni.top',
      siteUrl: `${url.protocol}//${url.host}`,
    });
    const renderMs = Date.now() - renderStartedAt;

    // Embedding a 2 MB CJK font subset is the expensive part and it happens once
    // per invocation, not per container. Local measurement puts a warm render
    // near a second, but the function's budget is 26 seconds and a buyer holding
    // a receipt is the worst audience for a timeout — so log the outliers and let
    // production, rather than a developer's laptop, say whether this needs a cache.
    if (renderMs > SLOW_RENDER_MS) {
      recordError('pdf', `PDF render took ${renderMs}ms`, {
        level: 'warn',
        route: '/api/download/bp/[id]',
        context: { reportId, renderMs, bytes: rendered.bytes.length },
      });
    }

    // Not fatal, but worth knowing: it means the committed font subset is missing
    // characters the reports actually use, and a buyer saw '?' in their document.
    if (rendered.missingGlyphs.length > 0) {
      recordError(
        'pdf',
        `Font subset is missing ${rendered.missingGlyphs.length} character(s): ${rendered.missingGlyphs.join('')}`,
        { route: '/api/download/bp/[id]', context: { reportId } }
      );
    }

    // Node's fetch/Response accepts Buffer more reliably than a detached
    // Uint8Array view across the Astro adapter boundary.
    return new Response(Buffer.from(rendered.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // Must stay ASCII-safe — see contentDisposition(). Putting a Chinese
        // title straight into this header is what made every CJK download 500.
        'Content-Disposition': contentDisposition(pdfFilename(report)),
        'Content-Length': String(rendered.bytes.length),
        // A paid file must never be cached by a shared cache.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    const message = (error as Error).message || String(error);
    console.error(`[download] PDF render failed for ${reportId}:`, message, (error as Error).stack);
    recordError('pdf', error, { route: '/api/download/bp/[id]', context: { reportId } });
    await paymentAlert('download_failed', `PDF render failed for report ${reportId}: ${message}`, {
      reportId,
    });
    return problem(500, 'render_failed', 'The report could not be rendered. Your purchase is not lost — please retry.');
  }
};
