# 实施计划

- [ ] 1. 类型与数据模型

  - 在 `src/types/index.ts` 定义 `BpStatus`、`BpOpportunity`、`BpScores`、`BpSeedReturn`、`BpContent`、`BpReport`、`GenerateBpInput`、`BpReportListItem`
  - _需求: 3.1, 5.1, 5.3_

- [ ] 2. 数据库表与迁移

  - 在 `src/pages/api/db-init.ts` 的 `BASE_STATEMENTS` 增加 `bp_reports`、`bp_opportunities`（含外键、索引，幂等）
  - 在 `REQUIRED_COLUMNS` 增加两表的诊断列；新增 `?migrate=bp` 破坏性重建分支
  - _需求: 5.1, 5.5, 5.5_

- [ ] 3. LLM 服务

  - 新增 `src/lib/services/llm.ts`：OpenAI 兼容 `chat/completions`，读 `LLM_API_KEY/LLM_API_BASE/LLM_MODEL/LLM_TIMEOUT_MS`
  - 缺 `LLM_API_KEY` 抛 `LLM_NOT_CONFIGURED`；超时/非 JSON 重试 1 次；返回解析后的对象 + 模型/用量
  - _需求: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 4. 评分与校验工具

  - 在 `src/lib/services/bp.ts`（或同目录工具）实现固定权重加权计算与 JSON 契约校验、选定项一致化
  - _需求: 2.2, 2.3, 2.4, 3.5_

- [ ] 5. BP 服务编排与持久化

  - 新增 `src/lib/services/bp.ts`：`resolveSourceTrend`、`findReusable`、`createPlaceholder`、`generate`、`getById`、`list`
  - 全程参数化查询；成功写 `completed`，失败写 `failed`+error；候选机会写 `bp_opportunities`
  - _需求: 1.1, 1.2, 1.3, 1.4, 2.1, 2.5, 3.1, 3.2, 3.3, 3.4, 5.2, 5.3, 5.4, 5.6, 6.3, 9.2, 9.4_

- [ ] 6. 生成 API

  - 新增 `src/pages/api/bp/generate.ts`（POST，`prerender=false`）：登录校验（`locals.user`，401）、入参解析、503/400/500 处理
  - _需求: 4.2, 6.1, 6.2, 8.1, 8.2, 8.4, 9.1_

- [ ] 7. 查询 API

  - 新增 `src/pages/api/bp/list.ts`（GET 分页）与 `src/pages/api/bp/[id].ts`（GET 单份+opportunities，404）
  - _需求: 7.1, 7.4, 8.3_

- [ ] 8. 站内入口 CTA

  - 在 `src/components/trends/TrendsTable.astro` 榜首行加「生成 BP」按钮；`src/pages/index.astro` 顶部加 CTA 卡片（未登录引导 `/login`）
  - _需求: 6.1, 6.2_

- [ ] 9. BP 列表与详情页

  - 新增 `src/pages/bp/index.astro`（列表）与 `src/pages/bp/[id].astro`（详情：摘要/评分矩阵/选定/市场财务/种子轮回报；`generating` 轮询）
  - 渲染不可信文本经转义；沿用全站视觉与中英文
  - _需求: 7.1, 7.2, 7.3, 7.5, 9.3_

- [ ] 10. 导航与多语言

  - `src/lib/i18n/zh.ts`/`en.ts` 增加 `bp.*`；`src/components/layout/Header.astro` 增加 BP 入口
  - _需求: 7.5_

- [ ] 11. 测试与配置

  - 单测：加权评分、JSON 解析/校验（vitest）
  - `tests/e2e/live-smoke.mjs` 增 `/api/bp/*` 探针；更新 `.env.example`（LLM 变量）
  - `npm run build` 通过
  - _需求: 2.3, 3.5, 4.2, 6.1, 7.1_
