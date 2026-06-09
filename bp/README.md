# 谷歌热词全自动 AI BP 生成网站 — 商业计划书（HTML → PDF）

投资人级中文商业计划书，Apple Keynote / macOS 视觉语言，自包含 HTML 一键渲染为高保真 A4 PDF。

**核心叙事：从热词到上线产品的全自动商业闭环** —— ① 谷歌热词挖掘（需求验证）→ ② AI 商业分析（机会脑暴 / 六维评分 / ROI 排序 / 自动 BP）→ ③ AI 编程（Claude）自动生成并部署服务网站；上线产品的真实使用与收入数据回流，持续优化前端信号，形成数据飞轮。

## 目录结构

```
bp/
├── business-plan.html                      # 自包含 BP（内联 CSS + 内联 SVG 图表），可直接双击打开
├── render-pdf.mjs                          # Puppeteer 渲染脚本（HTML → A4 PDF，含页码）
├── qa-screenshot.mjs                       # 自检脚本（逐页截图 + 溢出检测）
├── 谷歌热词AI-BP生成网站_商业计划书.pdf    # 最终高保真 PDF（29 页）
├── README.md
└── assets/
    ├── cover-hero.png                      # 封面 hero（AI 生成）
    ├── product-ui.png                      # 产品界面意象：三段闭环看板（AI 生成）
    └── engine-flywheel.png                 # 三段式闭环数据飞轮意象（AI 生成）
```

## 重新生成 PDF

依赖：Node.js 18+、Puppeteer（已在仓库根 `package.json` 的 devDependencies 中）。

```bash
# 1) 安装依赖（仓库根目录）
pnpm install
pnpm add -D puppeteer          # 如尚未安装

# 2) 下载 Chromium（pnpm 默认拦截 puppeteer 的安装脚本，需手动执行一次）
node ./node_modules/puppeteer/install.mjs

# 3) 渲染 PDF
node bp/render-pdf.mjs
# → 生成 bp/谷歌热词AI-BP生成网站_商业计划书.pdf
```

### 自检（可选）

```bash
node bp/qa-screenshot.mjs      # 输出 bp/assets/qa/*.png，并打印页数与可能溢出的页
```

## 设计与实现要点

- **视觉**：SF/Inter + 思源/系统中文字体；克制渐变、毛玻璃卡片、大留白；统一页眉留白与页脚页码。
- **图表**：评分矩阵、TAM/SAM/SOM、财务柱图、收入桥、漏斗、竞争象限、资金用途环形图、退出回报桥、概率树等
  全部用**内联 SVG / CSS** 渲染（矢量、可缩放、跨机一致）；仅封面/产品/飞轮三张意象图用 AI 生成。
- **渲染稳健性**：`render-pdf.mjs` 用 `domcontentloaded` + 显式等待图片就绪，Web 字体设 4s 超时回退系统字体，
  并提高 `protocolTimeout` 以适配大文档打印；`preferCSSPageSize` + `printBackground` 保真输出。

## 数据原则（公允、可溯源、风险调整）

- 所有市场与财务数字均给出测算口径或来源脚注（见 BP 第 19 节附录）。
- 创业成功率 / 退出率采用**国内同阶段同类公允数据**，并明确区分：①存活率 ②账面增值 ③**现金退出成功率（真正拿到钱）**。
- 种子轮回报同时给出**账面口径**与**风险调整口径**，核心结论以**现金成功退出**为准：

| 指标 | 数值 |
|---|---|
| 胜率（盈利现金退出概率） | **28%** |
| 盈亏比 | **≈ 4.0 : 1** |
| 期望现金回报 EV（风险调整 MOIC） | **1.37×** |
| 风险调整年化（5 年，含失败概率） | **≈ 6.5%** |
| 成功退出条件下年化 | **≈ 36%** |
| 账面 ROI（命中基准计划，纸面）第 1–5 年 | +50% / +140% / +380% / +495% / +665% |

## 主要数据来源（详见 BP 附录）

1. 企查查 × 吴晓波频道《企业生命力：中国中小企业十年洞察》（2024）：一年存活 92%、三年 76%、十年 ~50%。
2. IT 桔子《2022 年中国天使投资行业报告》：天使被投死亡率 31%、进入下一轮 45%、成功 IPO 2%。
3. 清科研究 / 千山资本：早期投资成功退出 IRR 中位数 ~30%，回报幂律偏态。
4. Mordor / Research and Markets / Precedence：生成式 AI 2026 市场 ≈ US$28–55B，CAGR ~30–37%。
5. World Bank / Creately 等：全球存量 startup &gt;1.5 亿、每年新创 ~5,000 万。
6. 商业计划软件市场 ≈ US$2.6B（2026）；竞品定价（LivePlan / Upmetrics / PrometAI 等官网）。
7. AI 编程 / 自动建站：Anthropic Claude（Claude Code）、Cursor、Lovable、Vercel v0、Bolt、Replit 等；AI 代码工具 + 无代码/建站市场合计 US$13–37B 级、CAGR ~20–25%；竞品定价（Lovable / v0 / Replit 官网）。

> 免责声明：本文件含前瞻性陈述，实际结果可能存在重大差异；不构成任何要约或投资建议。
