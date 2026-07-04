/**
 * End-to-end proof: register -> login -> generate a BP from a FRESH trend ->
 * poll until completed -> print the report id for verify_bp_math.py.
 * Non-destructive: creates one throwaway user + one BP report.
 */
const BASE = process.env.BASE_URL || 'https://ggtrendkirocursor.netlify.app';

async function http(path, opts = {}) {
  const headers = { Origin: BASE, ...(opts.headers || {}) };
  const res = await fetch(BASE + path, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// 1. Fresh trend (collected in the last 24h), top by volume.
const trends = await http('/api/trends/list?collectedWithin=24h&pageSize=5&page=1');
const list = trends.json?.data?.trends || [];
if (list.length === 0) throw new Error('no fresh trends found');
const trend = list[0];
console.log('fresh trend picked:', trend.keyword, trend.id, 'collected', trend.timestamp);

// 2. Register.
const uniq = Date.now();
const cred = { username: `proof_${uniq}`.slice(0, 20), email: `proof_${uniq}@example.com`, password: 'ProofPass123' };
const reg = await http('/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cred),
});
console.log('register:', reg.status);
if (reg.status !== 201) throw new Error(`register failed: ${reg.text.slice(0, 200)}`);

// 3. Login.
const login = await http('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: cred.email, password: cred.password }),
});
console.log('login:', login.status);
const cookie = (login.headers.get('set-cookie')?.match(/session_token=[^;]+/) || [])[0];
if (!cookie) throw new Error('no session cookie');

// 4. Generate.
const gen = await http('/api/bp/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ keyword: trend.keyword, trendId: trend.id, timeRange: '4h' }),
});
console.log('generate:', gen.status, JSON.stringify(gen.json).slice(0, 300));
const reportId = gen.json?.data?.id || gen.json?.reportId;
if (!reportId) throw new Error('no report id returned');

// 5. Poll detail until terminal status (completed/failed).
for (let i = 0; i < 20; i++) {
  const detail = await http(`/api/bp/${reportId}`);
  const status = detail.json?.data?.status;
  console.log(`poll ${i + 1}: status=${status}`);
  if (status === 'completed') {
    const d = detail.json.data;
    console.log('COMPLETED');
    console.log('keyword :', d.keyword);
    console.log('title   :', d.title);
    console.log('model   :', d.model);
    console.log('notes   :', (d.contentJson?.seedReturn?.notes || '').slice(0, 400));
    console.log('REPORT_ID=' + reportId);
    process.exit(0);
  }
  if (status === 'failed') {
    console.log('FAILED:', detail.json?.data?.error);
    console.log('REPORT_ID=' + reportId);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log('TIMEOUT waiting for terminal status; REPORT_ID=' + reportId);
process.exit(1);
