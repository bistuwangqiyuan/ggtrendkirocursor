// Measure real end-to-end latency of each configured LLM endpoint with a
// BP-sized generation request (maxTokens 4000), to pick a defensible
// LLM_TIMEOUT_MS. Usage: node scripts/diag-llm-latency.mjs
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const endpoints = JSON.parse(env.LLM_API_ENDPOINTS);

const HARD_CAP_MS = 180_000;

for (const ep of endpoints) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HARD_CAP_MS);
    try {
        const res = await fetch(`${ep.base}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
            body: JSON.stringify({
                model: ep.model,
                temperature: 0.7,
                max_tokens: 4000,
                messages: [
                    { role: 'system', content: 'You are a startup analyst. Reply in JSON only.' },
                    {
                        role: 'user',
                        content:
                            'Generate a detailed JSON business plan outline for a SaaS built around the trending keyword "ocbc share price". Include keys: title, summary, opportunities (array of 5 with name/description/score), businessModel, financials5y (array of 5 objects with year, revenue, cost, profit). Make it realistic and complete.',
                    },
                ],
            }),
        });
        const elapsed = Date.now() - started;
        if (!res.ok) {
            const text = (await res.text()).slice(0, 200);
            console.log(`${ep.name} (${ep.model}): HTTP ${res.status} in ${elapsed}ms -> ${text}`);
            continue;
        }
        const j = await res.json();
        const content = j?.choices?.[0]?.message?.content ?? '';
        const usage = j?.usage;
        console.log(
            `${ep.name} (${ep.model}): OK in ${elapsed}ms, output_chars=${content.length}, tokens=${JSON.stringify(usage)}`,
        );
    } catch (err) {
        console.log(`${ep.name} (${ep.model}): FAILED after ${Date.now() - started}ms -> ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}
