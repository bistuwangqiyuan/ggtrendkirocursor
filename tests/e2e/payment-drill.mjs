#!/usr/bin/env node
/**
 * Payment drill: the whole money path, end to end, with nothing mocked but the
 * provider's own website.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS
 * The unit tests prove each part in isolation with a stubbed database. They cannot
 * catch the failures that actually lose a sale: a webhook that never reaches its
 * route, an order row the download endpoint reads back differently than it wrote,
 * a PDF that renders in Vitest but not inside the server bundle, a refund that
 * updates a row nobody re-reads. So this runs a real server against a real
 * Postgres and drives it over HTTP exactly as Creem and a buyer would.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * Real: the server, the schema, the orders table, signature verification, token
 * issuing, PDF rendering, the refund revocation, the outage buffer.
 * Not real: the hosted checkout. Opening one requires a live Creem account and a
 * card, so the drill asserts instead that a provider which refuses fails cleanly,
 * and then plays the provider's signed webhook itself — which is the only thing
 * the site ever trusts anyway.
 *
 * Requirements: a local PostgreSQL the script may create a scratch database in.
 *   DRILL_ADMIN_URL   admin connection (default postgres:postgres@127.0.0.1:5432/postgres)
 *   DRILL_PORT        default 4332
 *
 * Usage:
 *   node tests/e2e/payment-drill.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.DRILL_PORT || 4340);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL =
  process.env.DRILL_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable';
const DB_NAME = 'ioni_payment_drill';
// Astro's first cold start on a loaded Windows box routinely exceeds two minutes.
const BOOT_TIMEOUT_MS = Number(process.env.DRILL_BOOT_MS || 360_000);

/** A host in TEST-NET-1: guaranteed unroutable, so pg fails to connect. */
const BROKEN_DATABASE_URL = 'postgresql://drill:drill@192.0.2.1:5432/nope?sslmode=disable';

const ADMIN_SECRET = 'drill-admin-secret-payment';
const CRON_SECRET = 'drill-cron-secret-payment';
const TOKEN_SECRET = 'drill-payment-token-secret-32-chars-long';
const WEBHOOK_SECRET = 'drill-creem-webhook-secret';

const ZH_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const EN_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BUYER = 'drill-buyer@example.com';
const NOW = new Date().toISOString();

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' -> ' + detail : ''}`);
}

// ---------------------------------------------------------------- fixtures ---

/** Same envelope shape cache/snapshot.ts writes, so the readers accept it. */
async function writeFixture(dir, key, data) {
  const file = join(dir, ...key.split('/').map(encodeURIComponent)) + '.json';
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ generatedAt: NOW, version: 'drill', data }), 'utf8');
}

function contentFor(locale) {
  const zh = locale === 'zh';
  const opportunities = Array.from({ length: 5 }, (_, i) => ({
    name: zh ? `在线服务机会 ${i + 1}` : `Online service opportunity ${i + 1}`,
    description: zh
      ? `围绕该热词的第 ${i + 1} 个在线服务机会，包含定价、获客与交付方式的说明。`
      : `Opportunity ${i + 1}: pricing, acquisition and delivery for an online service.`,
    scores: { market: 8, roi: 8, onlineability: 9, feasibility: 7, speed: 7, moat: 6 },
    weightedScore: 8 - i * 0.1,
    isSelected: i === 0,
    rank: i + 1,
  }));
  return {
    title: zh ? '付费下载演练商业计划书' : 'Payment drill business plan',
    summary: zh
      ? '本报告用于验证付费下载全流程：签名校验、订单入库、令牌签发与 PDF 渲染。'
      : 'This report exercises the paid download path end to end.',
    selectedOpportunity: opportunities[0].name,
    businessModel: zh ? '订阅制在线服务，按月收费。' : 'Subscription online service, billed monthly.',
    opportunities,
    market: { tam: '$1B', sam: '$100M', som: '$10M', notes: zh ? '市场备注' : 'Market note' },
    financials: {
      years: [
        { year: 1, revenue: '120000', cost: '80000', profit: '40000', margin: '33%' },
        { year: 2, revenue: '360000', cost: '200000', profit: '160000', margin: '44%' },
      ],
    },
    seedReturn: {
      annualizedBook: '80%',
      winRate: '15%',
      profitLossRatio: '3:1',
      expectedValueMOIC: '2.1x',
      riskAdjustedAnnualized: '40%',
      bookRoiByYear: [1, 2, 3, 4, 5],
      notes: zh ? '种子期回报备注' : 'Seed return note',
    },
  };
}

function reportFor(id, locale) {
  const content = contentFor(locale);
  return {
    id,
    keyword: locale === 'zh' ? '付费下载演练热词' : 'payment drill keyword',
    keywordNorm: locale === 'zh' ? '付费下载演练热词' : 'payment drill keyword',
    status: 'completed',
    title: content.title,
    summary: content.summary,
    selectedOpportunity: content.selectedOpportunity,
    searchVolume: 123_456,
    growthRate: 42,
    category: 'trending',
    timeRange: '4h',
    region: 'US',
    rank: 1,
    contentJson: content,
    opportunities: content.opportunities,
    model: 'drill',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function seedSnapshots(dir) {
  const zh = reportFor(ZH_ID, 'zh');
  const en = reportFor(EN_ID, 'en');
  await writeFixture(dir, `bp/detail/${ZH_ID}`, { report: zh });
  await writeFixture(dir, `bp/detail/${EN_ID}`, { report: en });
  await writeFixture(dir, 'bp/list', {
    reports: [zh, en].map((r) => ({
      id: r.id,
      keyword: r.keyword,
      title: r.title,
      status: 'completed',
      selectedOpportunity: r.selectedOpportunity,
      riskAdjustedAnnualized: '40%',
      riskAdjustedNum: 40,
      createdAt: NOW,
    })),
  });
  await writeFixture(dir, 'trends/top', { rows: [], totalRows: 0, truncated: false });
  await writeFixture(dir, 'trends/categories', []);
}

// ---------------------------------------------------------------- database ---

async function adminQuery(sql) {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

function drillDatabaseUrl() {
  return ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
}

async function drillQuery(sql, params = []) {
  const client = new pg.Client({ connectionString: drillDatabaseUrl(), connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function resetDatabase() {
  // A scratch database, dropped and recreated, so the drill never depends on
  // (or damages) whatever state a previous run left behind.
  await adminQuery(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE ${DB_NAME}`);
}

// ------------------------------------------------------------------ server ---

function startServer(snapshotDir, { databaseUrl }) {
  const child = spawn(
    process.execPath,
    [join('node_modules', 'astro', 'astro.js'), 'dev', '--port', String(PORT), '--host', '127.0.0.1'],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        SNAPSHOT_BACKEND: 'fs',
        SNAPSHOT_DIR: snapshotDir,
        ADMIN_SECRET,
        CRON_SECRET,
        SESSION_SECRET: 'drill-session-secret-32-characters-x',
        PAYMENT_TOKEN_SECRET: TOKEN_SECRET,
        PAYMENT_PRICE_CENTS: '100',
        // Enough for the site to consider Creem live. The API key is deliberately
        // invalid: a checkout attempt must fail cleanly, not 500.
        CREEM_API_KEY: 'drill-invalid-api-key',
        CREEM_PRODUCT_ID: 'prod_drill',
        CREEM_WEBHOOK_SECRET: WEBHOOK_SECRET,
        CREEM_TEST_MODE: 'true',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }
  );
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}

/** `astro dev` serves from a grandchild; a survivor would answer the next run. */
function stopServer(child) {
  if (!child) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function waitForServer() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/robots.txt`, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ------------------------------------------------------------------- client ---

async function get(path, init = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
    ...init,
    headers: { Cookie: 'locale=zh', ...(init.headers || {}) },
  });
  const type = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type,
    headers: res.headers,
    buffer,
    text: type.startsWith('application/pdf') ? '' : buffer.toString('utf8'),
    json() {
      try {
        return JSON.parse(buffer.toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}

function postJson(path, body, headers = {}) {
  return get(path, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The provider's signature: HMAC-SHA256 of the exact bytes, hex. */
function creemSigned(payload) {
  const raw = JSON.stringify(payload);
  return { raw, signature: createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') };
}

function sendWebhook(payload, { signature } = {}) {
  const signed = creemSigned(payload);
  return postJson('/api/pay/webhook/creem', signed.raw, {
    'creem-signature': signature ?? signed.signature,
  });
}

/** Same construction as lib/payments/tokens.ts, so the drill can forge and expire. */
function issueToken(claims, ttlMs, secret = TOKEN_SECRET) {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs })).toString('base64url');
  return `p1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function paidWebhook({ orderId, reference, reportId, email = BUYER, checkoutId = `ch_${orderId}` }) {
  return {
    eventType: 'checkout.completed',
    object: {
      id: checkoutId,
      request_id: reference,
      customer: { email },
      order: { id: orderId, amount_paid: 100, currency: 'USD' },
      metadata: { reportId, reference, locale: 'zh' },
    },
  };
}

// -------------------------------------------------------------------- drill ---

async function phaseStorefront() {
  const page = await get(`/bp/${ZH_ID}`);
  record(
    'D1  report page offers the PDF for $1',
    page.status === 200 && page.text.includes('$1') && page.text.includes('bp-buy'),
    `status=${page.status}`
  );

  const badEmail = await postJson('/api/pay/checkout', { reportId: ZH_ID, email: 'not-an-email' });
  record(
    'D2  checkout refuses an unusable email',
    badEmail.status === 400 && badEmail.json()?.error === 'invalid_email',
    `status=${badEmail.status} ${badEmail.json()?.error || ''}`
  );

  const unknown = await postJson('/api/pay/checkout', {
    reportId: '99999999-9999-4999-8999-999999999999',
    email: BUYER,
  });
  record(
    'D3  checkout refuses a report that does not exist',
    unknown.status === 404 && unknown.json()?.error === 'unknown_report',
    `status=${unknown.status} ${unknown.json()?.error || ''}`
  );

  // The API key is invalid, so every provider must refuse. What matters is that
  // the buyer gets a JSON error and the failure is recorded, not a 500 page.
  const refused = await postJson('/api/pay/checkout', { reportId: ZH_ID, email: BUYER });
  const body = refused.json();
  record(
    'D4  a provider outage fails cleanly instead of crashing',
    refused.status === 502 && body?.error === 'checkout_failed' && Array.isArray(body?.failures),
    `status=${refused.status} ${body?.error || ''} providers=${(body?.failures || []).join(',')}`
  );

  const alerts = await drillQuery(`SELECT source, message FROM ops_alerts ORDER BY created_at`);
  record(
    'D5  the failed checkout raised a durable ops alert',
    alerts.rows.some((r) => /checkout/i.test(r.message)),
    `${alerts.rowCount} alert(s)`
  );
}

async function phaseMoneyPath() {
  const forged = await sendWebhook(paidWebhook({ orderId: 'ord_forged', reference: randomUUID(), reportId: ZH_ID }), {
    signature: 'deadbeef'.repeat(8),
  });
  record('D6  a forged webhook signature is rejected', forged.status === 401, `status=${forged.status}`);

  const zhRef = randomUUID();
  const zhOrder = 'ord_drill_zh_1';
  const paid = await sendWebhook(paidWebhook({ orderId: zhOrder, reference: zhRef, reportId: ZH_ID }));
  record('D7  a signed payment is recorded', paid.status === 200, `status=${paid.status} ${paid.text.trim()}`);

  const row = await drillQuery(
    `SELECT id, status, email, amount_cents, report_id, reference FROM orders WHERE provider_order_id = $1`,
    [zhOrder]
  );
  record(
    'D8  the order row says paid, for this buyer and this report',
    row.rowCount === 1 &&
      row.rows[0].status === 'paid' &&
      row.rows[0].email === BUYER &&
      row.rows[0].amount_cents === 100 &&
      row.rows[0].report_id === ZH_ID,
    row.rowCount === 1 ? `status=${row.rows[0].status} amount=${row.rows[0].amount_cents}` : `rows=${row.rowCount}`
  );

  // A provider retry must not become a second purchase.
  await sendWebhook(paidWebhook({ orderId: zhOrder, reference: zhRef, reportId: ZH_ID }));
  const again = await drillQuery(`SELECT COUNT(*)::int AS n FROM orders WHERE provider_order_id = $1`, [zhOrder]);
  record('D9  a redelivered webhook does not duplicate the order', again.rows[0].n === 1, `rows=${again.rows[0].n}`);

  const status = await get(`/api/pay/status?reportId=${ZH_ID}&reference=${zhRef}`);
  const statusBody = status.json();
  record(
    'D10 the buyer’s reference alone unlocks the download',
    status.status === 200 && statusBody?.status === 'paid' && !!statusBody?.downloadUrl,
    `status=${statusBody?.status}`
  );
  if (!statusBody?.downloadUrl) {
    throw new Error(`status did not return a downloadUrl: ${JSON.stringify(statusBody)}`);
  }

  const pdf = await get(statusBody.downloadUrl);
  const pdfOk =
    pdf.status === 200 &&
    pdf.type.startsWith('application/pdf') &&
    pdf.buffer.subarray(0, 5).toString('latin1') === '%PDF-' &&
    pdf.buffer.length > 10_000;
  record(
    'D11 the Chinese report downloads as a real PDF',
    pdfOk,
    `status=${pdf.status} ${Math.round(pdf.buffer.length / 1024)}KB ${pdf.status !== 200 ? pdf.text.slice(0, 200) : ''}`
  );
  if (!pdfOk && server?.log?.length) {
    const hint = server.log
      .join('')
      .split(/\r?\n/)
      .filter((l) => /pdf|download|font|render|Error|error/i.test(l))
      .slice(-20);
    if (hint.length) console.error('server log (pdf-related):\n' + hint.join('\n'));
  }

  // The same purchase must not open a different report.
  const crossReport = await get(
    `/api/download/bp/${EN_ID}?token=${encodeURIComponent(new URL(BASE + statusBody.downloadUrl).searchParams.get('token'))}`
  );
  record(
    'D12 a purchase of one report cannot download another',
    crossReport.status === 403,
    `status=${crossReport.status} ${crossReport.json()?.error || ''}`
  );

  const enRef = randomUUID();
  await sendWebhook(paidWebhook({ orderId: 'ord_drill_en_1', reference: enRef, reportId: EN_ID }));
  const enStatus = (await get(`/api/pay/status?reportId=${EN_ID}&reference=${enRef}`)).json();
  const enPdf = await get(enStatus.downloadUrl, { headers: { Cookie: 'locale=en' } });
  record(
    'D13 the English report downloads as a real PDF',
    enPdf.status === 200 &&
      enPdf.buffer.subarray(0, 5).toString('latin1') === '%PDF-' &&
      enPdf.buffer.length > 10_000,
    `status=${enPdf.status} ${Math.round(enPdf.buffer.length / 1024)}KB ${enPdf.status !== 200 ? enPdf.text.slice(0, 200) : ''}`
  );

  const orderId = row.rows[0].id;
  const tampered = await get(`/api/download/bp/${ZH_ID}?token=${issueToken({ purpose: 'download', orderId, reportId: ZH_ID }, 3_600_000, 'wrong-secret-but-long-enough')}`);
  record(
    'D14 a link signed with the wrong key is refused',
    tampered.status === 403 && tampered.json()?.error === 'token_signature',
    `status=${tampered.status} ${tampered.json()?.error || ''}`
  );

  const expired = await get(`/api/download/bp/${ZH_ID}?token=${issueToken({ purpose: 'download', orderId, reportId: ZH_ID }, -1000)}`);
  record(
    'D15 an expired link is refused',
    expired.status === 403 && expired.json()?.error === 'token_expired',
    `status=${expired.status} ${expired.json()?.error || ''}`
  );

  const wrongPurpose = await get(`/api/download/bp/${ZH_ID}?token=${issueToken({ purpose: 'orders', email: BUYER }, 3_600_000)}`);
  record(
    'D16 an order-list link cannot be replayed as a download',
    wrongPurpose.status === 403 && wrongPurpose.json()?.error === 'token_purpose',
    `status=${wrongPurpose.status} ${wrongPurpose.json()?.error || ''}`
  );

  // The cap exists to stop a paid link posted publicly from serving unlimited
  // renders. Setting the counter is how it gets tested without 20 renders.
  await drillQuery(`UPDATE orders SET download_count = 20 WHERE id = $1`, [orderId]);
  const capped = await get(`/api/download/bp/${ZH_ID}?token=${issueToken({ purpose: 'download', orderId, reportId: ZH_ID }, 3_600_000)}`);
  record(
    'D17 the download cap holds',
    capped.status === 429 && capped.json()?.error === 'download_limit',
    `status=${capped.status} ${capped.json()?.error || ''}`
  );
  await drillQuery(`UPDATE orders SET download_count = 0 WHERE id = $1`, [orderId]);

  const refunded = await sendWebhook({
    eventType: 'refund.created',
    object: { transaction: { order: zhOrder } },
  });
  record('D18 a refund webhook is accepted', refunded.status === 200, `status=${refunded.status}`);

  const afterRefund = await drillQuery(`SELECT status, refunded_at FROM orders WHERE provider_order_id = $1`, [zhOrder]);
  record(
    'D19 the refund is recorded on the order',
    afterRefund.rows[0]?.status === 'refunded' && !!afterRefund.rows[0]?.refunded_at,
    `status=${afterRefund.rows[0]?.status}`
  );

  const revoked = await get(`/api/download/bp/${ZH_ID}?token=${issueToken({ purpose: 'download', orderId, reportId: ZH_ID }, 3_600_000)}`);
  record(
    'D20 a refunded purchase stops downloading, even with a live link',
    revoked.status === 403 && revoked.json()?.error === 'order_refunded',
    `status=${revoked.status} ${revoked.json()?.error || ''}`
  );

  const refundStatus = (await get(`/api/pay/status?reportId=${ZH_ID}&reference=${zhRef}`)).json();
  record('D21 the status endpoint reports the refund', refundStatus?.status === 'refunded', `status=${refundStatus?.status}`);

  // A refund for an order we never saw revokes nothing, which must be visible.
  await sendWebhook({ eventType: 'refund.created', object: { transaction: { order: 'ord_never_seen' } } });
  const unmatched = await drillQuery(`SELECT message FROM ops_alerts ORDER BY created_at`);
  record(
    'D22 a refund matching no order raises an alert',
    unmatched.rows.some((r) => /matched no order/i.test(r.message)),
    `${unmatched.rowCount} alert(s)`
  );

  return { enRef, enOrderId: 'ord_drill_en_1' };
}

async function phaseOrderRetrieval() {
  const listed = await get(`/orders?token=${encodeURIComponent(issueToken({ purpose: 'orders', email: BUYER }, 600_000))}`);
  record(
    'D23 a magic link lists that email’s purchases',
    listed.status === 200 && listed.text.includes('/api/download/bp/'),
    `status=${listed.status}`
  );
  record(
    'D24 the order list is never cached by a shared cache',
    /no-store/.test(listed.headers.get('cache-control') || ''),
    listed.headers.get('cache-control') || '(none)'
  );

  const wrongPurpose = await get(`/orders?token=${encodeURIComponent(issueToken({ purpose: 'download', orderId: 'x', reportId: ZH_ID }, 600_000))}`);
  record(
    'D25 a download link cannot be replayed as an order list',
    wrongPurpose.status === 200 && !wrongPurpose.text.includes('/api/download/bp/'),
    `status=${wrongPurpose.status}`
  );

  // No Resend key is configured here. The endpoint must name that reason instead
  // of claiming a mail is on its way — a buyer told "sent" would wait forever.
  const lookup = await postJson('/api/pay/lookup', { email: BUYER });
  const lookupBody = lookup.json();
  record(
    'D26 order lookup is honest when email is not configured',
    lookup.status === 503 && lookupBody?.error === 'email_unavailable' && lookupBody?.sent !== true,
    `status=${lookup.status} ${lookupBody?.error || ''}`
  );
}

async function phaseOutage(snapshotDir) {
  const ref = randomUUID();
  const orderId = 'ord_drill_outage_1';
  const paid = await sendWebhook(paidWebhook({ orderId, reference: ref, reportId: EN_ID }));
  record(
    'D27 a payment during a database outage is still accepted',
    paid.status === 200 && paid.text.trim() === 'buffered',
    `status=${paid.status} ${paid.text.trim()}`
  );

  const buffered = await readdir(join(snapshotDir, 'orders', 'pending')).catch(() => []);
  record('D28 the verified event is parked in the buffer', buffered.length > 0, buffered.join(', ') || '(empty)');

  const status = (await get(`/api/pay/status?reportId=${EN_ID}&reference=${ref}`)).json();
  record(
    'D29 the buyer is entitled from the buffered webhook alone',
    status?.status === 'paid' && status?.degraded === true && !!status?.downloadUrl,
    `status=${status?.status} degraded=${status?.degraded}`
  );

  const pdf = await get(status.downloadUrl);
  record(
    'D30 the PDF downloads during the outage',
    pdf.status === 200 && pdf.buffer.subarray(0, 5).toString('latin1') === '%PDF-',
    `status=${pdf.status} ${Math.round(pdf.buffer.length / 1024)}KB`
  );

  const orders = await get(`/orders?token=${encodeURIComponent(issueToken({ purpose: 'orders', email: BUYER }, 600_000))}`);
  record('D31 the downloads page survives the outage', orders.status === 200, `status=${orders.status}`);

  return { orderId, ref };
}

async function phaseDrain(snapshotDir, buffered) {
  // The drain runs in a Netlify background function; what matters here is that
  // the buffered event lands in Postgres once it is reachable again, which is
  // exactly what the function calls.
  const drained = spawnSync(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/e2e/drain-buffered-payments.ts'],
    {
      env: {
        ...process.env,
        DATABASE_URL: drillDatabaseUrl(),
        SNAPSHOT_BACKEND: 'fs',
        SNAPSHOT_DIR: snapshotDir,
      },
      encoding: 'utf8',
    }
  );
  const out = `${drained.stdout || ''}${drained.stderr || ''}`.trim();
  record('D32 the drain job replays the buffered payment', drained.status === 0, out.split('\n').pop() || '');

  const row = await drillQuery(`SELECT status, email, report_id FROM orders WHERE provider_order_id = $1`, [
    buffered.orderId,
  ]);
  record(
    'D33 the buffered payment is now a paid order in Postgres',
    row.rowCount === 1 && row.rows[0].status === 'paid' && row.rows[0].report_id === EN_ID,
    row.rowCount === 1 ? `status=${row.rows[0].status}` : `rows=${row.rowCount}`
  );

  const left = await readdir(join(snapshotDir, 'orders', 'pending')).catch(() => []);
  record('D34 the buffer is emptied once the payment is stored', left.length === 0, left.join(', ') || '(empty)');
}

// --------------------------------------------------------------------- main ---

let snapshotDir;
let server;

try {
  console.log('Payment drill\n=============');
  console.log(`admin db: ${ADMIN_URL.replace(/:[^:@/]*@/, ':***@')}`);

  await resetDatabase();
  snapshotDir = await mkdtemp(join(tmpdir(), 'ioni-pay-drill-'));
  await seedSnapshots(snapshotDir);
  console.log(`snapshots: ${snapshotDir}\n`);

  server = startServer(snapshotDir, { databaseUrl: drillDatabaseUrl() });
  if (!(await waitForServer())) {
    const tail = server.log.slice(-60).join('');
    console.error(tail || '(no server log captured)');
    throw new Error(`server did not start on ${BASE} within ${BOOT_TIMEOUT_MS}ms`);
  }

  const init = await postJson(`/api/db-init`, {}, { Authorization: `Bearer ${ADMIN_SECRET}` });
  if (init.status !== 200 || init.json()?.success !== true) {
    console.error(init.text.slice(0, 2000));
    throw new Error(`db-init failed (${init.status})`);
  }
  console.log('schema provisioned\n');

  await phaseStorefront();
  await phaseMoneyPath();
  await phaseOrderRetrieval();

  // Same snapshot directory, unreachable database: the outage the free Neon plan
  // actually produces.
  console.log('\n-- database outage --');
  stopServer(server.child);
  server = startServer(snapshotDir, { databaseUrl: BROKEN_DATABASE_URL });
  if (!(await waitForServer())) {
    console.error(server.log.join(''));
    throw new Error('server did not restart for the outage phase');
  }
  const buffered = await phaseOutage(snapshotDir);

  console.log('\n-- recovery --');
  await phaseDrain(snapshotDir, buffered);
} catch (error) {
  record('drill harness', false, error.message);
  if (server?.log?.length) console.error(server.log.slice(-40).join(''));
} finally {
  stopServer(server?.child);
  if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('failed:');
  for (const f of failed) console.log(`  ${f.name}${f.detail ? ' -> ' + f.detail : ''}`);
}
process.exit(failed.length === 0 ? 0 : 1);
