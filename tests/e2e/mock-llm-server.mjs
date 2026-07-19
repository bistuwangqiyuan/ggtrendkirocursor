#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible Chat Completions server for local full-pipeline
 * testing when no real LLM key is available (production keys live only in
 * Netlify env). It returns a schema-valid BP JSON so the real pipeline code
 * (endpoint failover, JSON extraction, validateAndNormalizeBpContent, DB
 * persistence, detail-page SSR) is exercised end to end.
 *
 * Usage:  node tests/e2e/mock-llm-server.mjs   (listens on :8787)
 *   then: LLM_API_ENDPOINTS='[{"name":"local-mock","base":"http://localhost:8787/v1","key":"mock-key","model":"mock-bp-model","autoUpgrade":false}]'
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 8787);

function extractKeyword(userPrompt) {
  const m = /(?:热词|keyword|Keyword)[:：]?\s*[""「]?([^\n""」]{1,60})/.exec(userPrompt || '');
  return (m ? m[1] : 'trending keyword').trim();
}

function bpJsonFor(keyword) {
  const opp = (name, description, market, roi, onlineability, feasibility, speed, moat) => ({
    name, description, scores: { market, roi, onlineability, feasibility, speed, moat },
  });
  return {
    title: `${keyword} 商业机会分析与切入方案`,
    summary: `围绕热词「${keyword}」的搜索热度激增,我们识别出五个可线上化的商业机会,首选方向为内容聚合与工具化服务。按保守口径测算,种子轮账面年化回报约 32%,风险调整后年化约 18%,五年期望 MOIC 约 2.1x。核心策略是以最小可行产品在 4 周内上线,借助搜索流量红利完成冷启动。`,
    opportunities: [
      opp(`${keyword} 垂直资讯聚合站`, '聚合该话题的实时资讯与数据,广告+订阅变现', 78, 72, 90, 85, 88, 55),
      opp(`${keyword} 在线工具/计算器`, '围绕话题的实用工具,SEO 引流,affiliate 变现', 70, 75, 92, 88, 90, 50),
      opp(`${keyword} 付费社群与咨询`, '深度内容+社群订阅,高客单价', 62, 80, 85, 75, 70, 60),
      opp(`${keyword} 数据 API 服务`, '面向开发者与媒体售卖结构化数据接口', 58, 70, 88, 65, 60, 72),
      opp(`${keyword} 电商选品带货`, '话题相关商品的联盟带货与选品清单', 66, 68, 86, 80, 85, 40),
    ],
    market: {
      tam: '全球相关话题年搜索规模约 12 亿次,广告市场约 $8.5B',
      sam: '中英双语市场可服务规模约 $420M',
      som: '3 年内可获取约 $4.2M(0.1% 渗透)',
      notes: '按 Google Trends 与行业广告 CPM 中位数估算',
    },
    businessModel: '以 SEO 内容聚合获取自然流量,广告(AdSense/直客)+ 订阅 + 联盟佣金三层变现;后期以数据 API 提升毛利。',
    financials: {
      years: [
        { year: 1, revenue: '$45K', ebitda: '-$20K' },
        { year: 2, revenue: '$180K', ebitda: '$40K' },
        { year: 3, revenue: '$520K', ebitda: '$190K' },
        { year: 4, revenue: '$1.1M', ebitda: '$450K' },
        { year: 5, revenue: '$2.0M', ebitda: '$900K' },
      ],
    },
    seedReturn: {
      bookRoiByYear: [-0.4, 0.1, 0.8, 1.6, 2.1],
      annualizedBook: '32%',
      winRate: '12%',
      profitLossRatio: '4.5:1',
      expectedValueMOIC: '2.1x',
      riskAdjustedAnnualized: '18%',
      notes: '按国内种子期现金退出口径保守测算',
    },
  };
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-bp-model', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      let userPrompt = '';
      try {
        const payload = JSON.parse(body);
        userPrompt = payload?.messages?.find((m) => m.role === 'user')?.content ?? '';
      } catch { /* keep default */ }
      const keyword = extractKeyword(userPrompt);
      const content = JSON.stringify(bpJsonFor(keyword));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: 'mock-bp-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 800, completion_tokens: 1200, total_tokens: 2000 },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

server.listen(PORT, () => console.log(`[mock-llm] listening on http://localhost:${PORT}/v1`));
