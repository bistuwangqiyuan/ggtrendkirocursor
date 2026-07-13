// Reproduce the EXACT model the auto-upgrade registry resolves for each
// configured endpoint, then measure a real BP-sized chat call against that
// resolved model. Run: pnpm dlx tsx scripts/diag-resolved-model.ts
import { readFileSync } from 'node:fs';
import { resolveBestModel } from '../src/lib/services/modelRegistry';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
process.env.LLM_API_ENDPOINTS = env.LLM_API_ENDPOINTS;

const endpoints = JSON.parse(env.LLM_API_ENDPOINTS);

const SYSTEM_PROMPT_SAMPLE =
    '你是资深早期风投分析师与连续创业者。基于给定"谷歌热搜关键词"，头脑风暴可完全线上化（纯网站/SaaS，无线下重资产）的商业机会，严谨评分并遴选其中ROI最高且可完全线上化者，产出投资人级、数据公允、可溯源、可执行的结构化商业计划书。仅输出一个 JSON 对象。';

for (const ep of endpoints) {
    const epLike = { name: ep.name, base: ep.base, apiKey: ep.key, model: ep.model };
    const resolved = await resolveBestModel(epLike);
    console.log(`${ep.name}: configured=${ep.model} -> resolved=${resolved}`);

    if (ep.name === 'mistral') continue; // key known dead (401)

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
        const res = await fetch(`${ep.base}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
            body: JSON.stringify({
                model: resolved,
                temperature: 0.7,
                max_tokens: 4000,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT_SAMPLE },
                    {
                        role: 'user',
                        content:
                            '谷歌热搜第一名关键词："ocbc share price"\n分类：trending | 搜索量：1000 | 增长速度：74 | 趋势窗口：4h | 地区：SG\n请输出完整结构化商业计划书 JSON（含 title、summary、opportunities×5、businessModel、五年财务）。',
                    },
                ],
            }),
        });
        const elapsed = Date.now() - started;
        if (!res.ok) {
            console.log(`  chat: HTTP ${res.status} in ${elapsed}ms -> ${(await res.text()).slice(0, 300)}`);
            continue;
        }
        const j: any = await res.json();
        const content = j?.choices?.[0]?.message?.content ?? '';
        console.log(`  chat: OK in ${elapsed}ms, model=${j?.model}, output_chars=${content.length}, usage=${JSON.stringify(j?.usage)}`);
    } catch (err) {
        console.log(`  chat: FAILED after ${Date.now() - started}ms -> ${(err as Error).message}`);
    } finally {
        clearTimeout(timer);
    }
}
