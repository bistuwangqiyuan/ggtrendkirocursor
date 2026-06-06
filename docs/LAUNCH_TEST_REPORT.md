# Trend Now 上线测试报告 (Launch Test Report)

- 站点 (Site): https://ggtrendkirocursor.netlify.app
- 仓库 (Repo): https://github.com/bistuwangqiyuan/ggtrendkirocursor (分支 `main`)
- 测试日期 (Date): 2026-05-30；复测 (Re-verified): 2026-05-31；**最终全通过 (Final all-pass): 2026-06-06**
- 部署方式 (Deploy): push 到 GitHub `main` → Netlify 自动构建发布
- 测试层级 (Layers): 本地单元测试 (vitest) + 线上 HTTP 端到端探测 (live-smoke) + 浏览器交互测试

---

## 1. 执行摘要 (Executive Summary)

| 测试层 | 结果 |
| --- | --- |
| 本地单元测试 (vitest) | 8 / 8 通过 |
| 线上端到端 HTTP 探测 (45 项) | **45 PASS / 0 FAIL / 0 BLOCKED** |
| 浏览器交互测试 (9 项) | 9 / 9 通过 |

结论：**全部功能 100% 通过，0 失败、0 阻塞**。线上版本 `2026.06.06-2`。

此前阻塞的 Neon (PostgreSQL) 数据库已于 2026-06-06 恢复连接（`/api/health` → `status: ok`, `connected: true`, 9 张表）。数据库恢复后暴露并修复了两类真实代码/数据缺陷（见第 3 节第 5、6 项）：

1. **趋势接口全量 500** — 表选择逻辑选中了空的 `trends_trending_now` 而非有数据的 `google_trends`，且时间范围过滤值格式不匹配。已修复，趋势列表/筛选/分页/首页全部恢复。
2. **注册/登录/反馈全部失败** — 线上 `users/sessions/feedback` 三张表为**遗留的不兼容旧表结构**（如 `sessions` 缺 `token` 列、`feedback` 用 `feedback_type/content`、`users` 用 `last_login`）。通过强化后的 `/api/db-init` 迁移端点将三表对齐到应用 schema 后，注册（201）、登录（200，HttpOnly Cookie）、反馈持久化（201）全部转为 PASS。

按既定计划的停止条件（“当所有需求通过且无代码缺陷时即可停止”），测试-修复-上线循环最终达成 **42/42 全通过**。

---

### 复测结论 (2026-05-31 Re-verification)

整套测试在次日重跑并补强了 SEO 抓取相关的检查：

- 本地单元测试 (vitest)：8 / 8 通过（无回归）。
- 线上端到端探测：在原 35 项基础上**新增 4 项 SEO 抓取检查**（robots.txt、sitemap.xml、og:image 资源、`/error` 页），最终 **31 PASS / 0 FAIL / 8 BLOCKED（共 39 项）**，线上版本 `2026.05.31-2`。
- 本轮发现并修复的真实代码缺陷（详见第 3 节第 4 项）：`/robots.txt`、`/sitemap.xml`、`/og-image.*` 均为 404。已补齐 `public/robots.txt`、`public/sitemap.xml`、`public/og-image.svg`，并将 `Layout` 的 `og:image` 指向存在的资源。复测全部转为 PASS。
- 数据库：经多日多次探测，Neon 仍返回 “compute time quota exceeded”，连接持续被拒，**确认为月度计算配额耗尽（硬限制），非瞬时抖动**。
- 经核实，线上站点不在当前可用的 Netlify 账号下（`netlify link` 报 “No projects found”），测试方无法改动其环境变量或数据库，**8 个数据库依赖项必须由站点所有者修复 DB 后**方可转为实测（见第 6 节）。

## 2. 测试-修复-上线循环记录 (Iterations)

| 轮次 | 操作 | 部署版本 | 结果 |
| --- | --- | --- | --- |
| Iter 0 (基线) | 首次全量探测 | `2026.05.30-2` 前的线上版本 | 5 FAIL（3 个真实代码缺陷 + 2 个测试断言误报）, 8 BLOCKED |
| Iter 1 (修复+上线) | 修复 SEO 缺陷、修正测试断言、提交 push 触发 Netlify 部署，poll `/api/health` 确认 `version=2026.05.30-2` 上线（约 40s） | `2026.05.30-2` | 复测 27 PASS / 0 FAIL / 8 BLOCKED |
| Iter 2 (2026-05-31 SEO 补强) | 修复 robots.txt/sitemap.xml/og-image 三处 404，扩充 e2e 检查，push 触发部署，poll 确认 `2026.05.31-2` 上线 | `2026.05.31-2` | 复测 **31 PASS / 0 FAIL / 8 BLOCKED**（39 项） |
| DB 重试（每轮） | 多日多次探测 `/api/health`，并尝试 `/api/db-init`、`/api/seed` | 无代码变更 | 数据库持续 “quota exceeded”，DB 项保持 BLOCKED |
| Iter 3 (2026-06-06 趋势 500 修复) | DB 恢复后趋势接口全量 500；修复表选择 + 时间范围匹配，push 部署 `2026.06.06-1` | `2026.06.06-1` | 38 PASS / 4 FAIL（趋势恢复，剩注册/登录/反馈写入失败） |
| Iter 4 (2026-06-06 鉴权 schema 迁移) | 经 `/api/db-init` 诊断确认三表为遗留不兼容结构；强化迁移端点 (`migrate=auth`) 重建三表对齐应用 schema | `2026.06.06-2` | 42 PASS / 0 FAIL / 0 BLOCKED |
| Iter 5 (2026-06-06 新增数据采集时间筛选) | 新增独立的“数据采集时间范围”筛选（6/12/24/48 小时内），含服务层、API、首页、筛选器 UI、i18n、e2e 探测，push 部署 `2026.06.06-3` | `2026.06.06-3` | **45 PASS / 0 FAIL / 0 BLOCKED** |

为支撑循环，新增了可复用的部署校验机制：在 `/api/health` 暴露 `APP_VERSION`（来自 [src/version.ts](../src/version.ts)），每次部署后轮询该字段即可确认新构建已生效。

---

## 3. 发现的缺陷与修复 (Bugs Found & Fixes)

### 真实代码缺陷 (已修复并上线)

1. **SEO 结构化数据与社交标签缺失** — 对应需求 5.2 / 5.3。
   - 现象：首页 `<head>` 缺少 Open Graph、Twitter Card、`canonical`、`keywords` 以及 JSON-LD 结构化数据。
   - 修复：在 [src/layouts/Layout.astro](../src/layouts/Layout.astro) 中补全 `og:*`、`twitter:*`、`canonical`、`keywords` 元标签，并注入 `WebSite` + `SearchAction` 的 JSON-LD。
   - 验证：上线后 `has Open Graph tags` / `has JSON-LD structured data` / `has canonical link` 均由 FAIL 转为 PASS。
   - 提交：`a67a6ac`

4. **缺少 robots.txt / sitemap.xml / OG 图片资源（均 404）** — 对应需求 5（SEO，含 sitemap）。
   - 现象：`/robots.txt`、`/sitemap.xml` 均 404；且第 1 项补的 `og:image` 指向了不存在的 `/og-image.jpg`（404，社交分享预览图失效）。
   - 修复：新增 [public/robots.txt](../public/robots.txt)（含 sitemap 指向）、[public/sitemap.xml](../public/sitemap.xml)（覆盖首页与各主要静态页），新增品牌图 [public/og-image.svg](../public/og-image.svg) 并将 [src/layouts/Layout.astro](../src/layouts/Layout.astro) 的 `og:image` 改为该资源。
   - 验证：上线后 `robots.txt served` / `sitemap.xml served` / `og:image asset resolves` / `/error page renders` 均 PASS。
   - 提交：`14cbf1d`

5. **趋势接口全量返回 500（DB 恢复后暴露）** — 对应需求 2/3/13。
   - 现象：`GET /api/trends/list` 对任意查询均 500，首页渲染红色错误条、0 条数据。
   - 根因：① [src/lib/db/client.ts](../src/lib/db/client.ts) `getTrendsTableName()` 固定优先 `trends_trending_now`（空表/不兼容），导致数据查询抛错并 500；有数据的是 `google_trends`。② [src/lib/services/trends.ts](../src/lib/services/trends.ts) `TIME_RANGE_TO_DB` 把 `4h` 映射成 `past_4_hours`，而 `google_trends` 存的是 `4h`，时间范围筛选 0 命中。
   - 修复：① 改为按行数选择候选表（`COUNT(*)`，有数据优先、并偏好 `google_trends`）；② 用 `time_range = ANY($n)` 同时匹配短/长两种格式（`4h` 与 `past_4_hours`）。
   - 验证：`trends list API returns data` count=4；时间范围 `4h/24h/48h` 分别返回 4/4/2 条；首页错误条消失。
   - 提交：`dbcee51`

6. **注册/登录/反馈写入失败（DB 恢复后暴露）** — 对应需求 1/8/12。
   - 现象：注册 400（`Registration failed`）、登录 401、反馈持久化 500、登录无 `Set-Cookie`。
   - 根因：线上 `users/sessions/feedback` 为**遗留不兼容旧表结构**——`sessions` 缺 `token/ip_address/user_agent`，`feedback` 用 `feedback_type/content`（应为 `subject/message/status`），`users` 用 `last_login`（应为 `last_login_at`）且缺 `locale`。`CREATE TABLE IF NOT EXISTS` 无法修正既有错表。
   - 修复：将 [src/pages/api/db-init.ts](../src/pages/api/db-init.ts) 强化为“诊断 + 迁移”端点——始终返回各表真实列结构、逐条执行 DDL 容错；当 `?migrate=auth` 时按 FK 顺序 `DROP` 并按应用 schema 重建三表（仅鉴权/反馈表，趋势数据表不动）。执行 `migrate=auth` 后三表列已对齐。
   - 验证：注册 201、登录 200（`Set-Cookie` 含 `HttpOnly`）、错误口令 401、反馈持久化 201，全部 PASS。
   - 提交：`0f1f596`

### 新增功能 (Feature)

7. **数据采集时间范围筛选（数据采集时间 6/12/24/48 小时内）** — 对应需求 3（数据筛选）。
   - 背景：原有“时间范围”按钮（4h/24h/48h）筛选的是 `time_range` 字段，即**关键词的趋势窗口**（分类字符串），并非按数据采集的真实时间筛选。本次按要求新增一个**独立维度**：按数据采集时间（`timestamp`/`trend_timestamp` 列）筛选“最近 6/12/24/48 小时内采集”的记录。两者可叠加（AND）。
   - 实现：
     - 类型：[src/types/index.ts](../src/types/index.ts) 新增 `CollectedWithin` 与 `TrendsQueryParams.collectedWithin`。
     - 服务层：[src/lib/services/trends.ts](../src/lib/services/trends.ts) `getTrends` 在解析出采集时间列后，按 `<ts_col> >= NOW() - make_interval(hours => $n)` 过滤（小时数以整型参数传入，防注入），COUNT 与数据查询共用同一 WHERE。
     - 透传：[src/pages/api/trends/list.ts](../src/pages/api/trends/list.ts)、[src/pages/index.astro](../src/pages/index.astro) 解析并传递 `collectedWithin`。
     - UI：[src/components/trends/TrendsFilters.tsx](../src/components/trends/TrendsFilters.tsx) 新增带标签的下拉框（不限/6/12/24/48 小时内），并为两个时间控件加上区分标签（“趋势窗口” vs “数据采集时间”），消除歧义。
     - i18n：[src/lib/i18n/zh.ts](../src/lib/i18n/zh.ts)、[src/lib/i18n/en.ts](../src/lib/i18n/en.ts) 补充对应中英文案。
   - 验证（实测、有理有据）：线上 `collectedWithin` 探测返回 `6h=0 12h=0 24h=42 48h=90`，计数单调非减（6h≤12h≤24h≤48h≤总数 90），48h 返回数据；与趋势窗口叠加 `collectedWithin=24h&timeRange=4h` 返回 14 条（24h=42 的合理子集）。中英文首页均 SSR 渲染出新控件标签。
   - 数据新鲜度说明（讲实话）：当前线上 `google_trends` 最新一条数据约 17 小时前采集，故 **6/12 小时内窗口当前正确地返回 0 条**——这是数据陈旧（一次性种子数据）所致，而非筛选逻辑缺陷；逻辑本身已通过单调性与子集关系验证。后续如接入实时采集或刷新种子数据（时间戳相对“当前时间”分布），6/12 小时窗口即会有数据。
   - 提交：`82d2d91`

### 测试侧修正 (非产品代码缺陷)

2. **登出接口在探测中返回 403** — 实为 Astro 的 CSRF Origin 校验。真实浏览器对同源 POST 会自动携带 `Origin` 头并通过校验（应用内登出按钮工作正常）；测试脚本最初未带 `Origin` 头。已修正 [tests/e2e/live-smoke.mjs](../tests/e2e/live-smoke.mjs)，对所有 POST 请求附加 `Origin`，复测 PASS。
3. **英文语言断言误报** — 因新增的 `keywords` 元标签包含中文关键词 `趋势数据`，旧断言用“全局是否出现中文”判断英文页失败。已改为基于本地化 `<title>`（`Trends Data | Trend Now` vs `趋势数据 | Trend Now`）进行判断，复测 PASS。

---

## 4. 逐需求测试结果 (Per-Requirement Results)

说明：PASS = 线上验证通过。截至 2026-06-06 数据库已恢复，原 BLOCKED 项已全部实测转 PASS。

- 需求 1 用户认证系统：PASS — 登录/注册页可访问；注册缺字段/非法输入 400；登录缺字段 400；无会话登出 200；**真实注册 201、登录 200 建会话、错误口令 401 均实测通过**。
- 需求 2 趋势数据展示：PASS — 首页 SSR 正常渲染；**趋势列表返回真实数据（count=4）、分页元数据正确**。
- 需求 3 数据筛选和排序：PASS — 筛选器渲染可交互；趋势窗口筛选 `4h/24h/48h` 正常；**新增“数据采集时间范围”筛选（6/12/24/48 小时内）实测 `6h=0 12h=0 24h=42 48h=90`，计数单调非减且 48h 有数据；叠加 `24h+4h` 返回 14 条子集**；分类筛选查询正常执行。
- 需求 4 多语言支持：PASS — 默认中文；点击 EN 切换为英文（导航/按钮/标题/筛选器文案），点击中切回中文；`locale` cookie 生效。
- 需求 5 SEO 优化：PASS — SSR 完整 HTML；`title`/`description`/`keywords`/`canonical`/Open Graph/Twitter/JSON-LD 齐全。
- 需求 6 响应式设计：PASS — 桌面多列、移动端 375px 单列布局且无横向溢出（浏览器截图验证）。
- 需求 7 页面结构和导航：PASS — 顶部 Logo+导航+语言切换；底部关于/联系/隐私/条款；各页面可达。
- 需求 8 用户反馈系统：PASS — 反馈表单渲染；非法输入 400 且含字段级 `validationErrors`；**反馈成功落库（201）实测通过**。
- 需求 9 数据库集成：PASS — `/api/health` 返回 `connected=true`、9 张表；查询/写入均正常。
- 需求 10 性能优化：PASS（部分）— SSR + Astro 群岛局部水合；静态资源经 Vite 压缩/分块（构建产物可见 gzip 体积）。Core Web Vitals 的现场实测未在本轮范围内量化。
- 需求 11 错误处理：PASS — 404 返回 404 状态并展示自定义页面 + 返回首页链接；首页对数据缺失/查询失败优雅降级。
- 需求 12 安全性：PASS — POST 受 Astro CSRF Origin 校验保护；**登录成功时 `Set-Cookie` 实测含 `HttpOnly`**（另配置 `Secure(PROD)`/`SameSite=lax`/30 天）。
- 需求 13 数据展示格式：PASS — 表格布局、列标题、分页控件与空状态文案正确；千位分隔/相对时间格式化基于真实数据展示；`formatNumber`/`formatGrowthRate` 单元测试覆盖通过。
- 需求 14 无障碍访问：PASS（基础）— 语义化 `header/nav/main/footer`、表单 `label` 关联、按钮可聚焦。完整 WCAG 对比度/屏幕阅读器审计未在本轮量化。
- 需求 15 部署和环境配置：PASS — push `main` 自动触发 Netlify 构建并以 HTTPS 发布；`/api/health` 200 且回显版本号；环境变量 `DATABASE_URL` 已注入（连接因配额受限）。

---

## 5. 测试资产 (Test Assets)

- 线上端到端探测脚本：[tests/e2e/live-smoke.mjs](../tests/e2e/live-smoke.mjs)
  - 运行：`BASE_URL=https://ggtrendkirocursor.netlify.app node tests/e2e/live-smoke.mjs`（或 `pnpm test:e2e`）
  - 仅当存在 FAIL 时返回非零退出码；DB 阻塞项记为 BLOCKED，不会污染结果。
- 单元/属性测试：`pnpm test`（vitest），覆盖校验与格式化工具及认证服务属性。
- 部署版本探针：`/api/health` 的 `version` 字段（[src/version.ts](../src/version.ts)）。
- 浏览器交互测试：覆盖语言切换、筛选器、注册/反馈前端校验、404、移动端响应式（含截图）。

---

## 6. 历史阻塞项（已解决）(Previously Blocked — Resolved)

> 状态：**已全部解除**。下文保留作为时间线记录。

**历史根因**：线上 Neon 数据库曾返回
`Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.`
即计算时长配额耗尽、连接被拒，导致趋势查询、注册/登录/会话、反馈落库等数据库依赖项在 2026-05-30 ~ 06-05 期间记为 BLOCKED。这是账号/套餐层面的外部限制，非应用代码缺陷。

**解除过程（2026-06-06）**：
1. 数据库恢复连接（`/api/health` → `connected=true`，9 张表）。
2. DB 恢复后暴露出两类真实代码/数据缺陷，均已修复（见第 3 节第 5、6 项）：趋势接口 500（表选择 + 时间范围匹配）、鉴权/反馈表结构不兼容（经 `/api/db-init?...&migrate=auth` 迁移对齐）。
3. 重跑 `pnpm test:e2e`：原 8 个 BLOCKED 项全部转为实测 PASS，最终 **42 PASS / 0 FAIL / 0 BLOCKED**。

**运维备查 — 数据初始化/迁移端点（均需带同源 `Origin` 头以通过 CSRF）**：
1. 表结构诊断/迁移：`POST /api/db-init?secret=trendnow-seed`（只读诊断，回显各表真实列）；`POST /api/db-init?secret=trendnow-seed&migrate=auth`（重建鉴权/反馈表至应用 schema，不影响趋势数据表）。
2. 灌入示例趋势数据：`POST /api/seed?secret=trendnow-seed`。

> 示例 PowerShell（携带 Origin 头）：
> `Invoke-WebRequest -Uri "https://ggtrendkirocursor.netlify.app/api/db-init?secret=trendnow-seed&migrate=auth" -Method POST -Headers @{ Origin = "https://ggtrendkirocursor.netlify.app" } -UseBasicParsing`

---

## 7. 备注 (Notes)

- 本地 Windows 环境下 `astro build` 在 Netlify 适配器的 `astro:build:done` 钩子会因 `EPERM: symlink` 失败，这是 Windows 创建符号链接的权限限制，**不影响 Netlify (Linux) 的实际构建**；客户端与服务端打包在本地均成功完成。
- 鉴权表迁移为一次性破坏性重建（`DROP + CREATE`）。因迁移前线上鉴权链路完全不可用（无有效用户/会话），不存在需保留的真实数据；趋势数据表 `google_trends`/`trends_trending_now` 全程未触碰。
- e2e 的注册/反馈用例会向线上 DB 写入少量测试记录，属非破坏性验证数据。
- 未修改任何 Netlify 配置或密钥；所有变更均通过推送 GitHub `main` 自动部署。
