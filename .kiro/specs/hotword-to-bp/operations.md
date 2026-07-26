# 运维附录（Operations）

本附录为「热词第一名 → 商业计划书（BP）」功能的部署、配置、巡检与故障处理手册，配合 [requirements.md](requirements.md)、[design.md](design.md)、[tasks.md](tasks.md) 使用。

## 1. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 是 | — | Neon PostgreSQL 连接串（亦可用 `NETLIFY_DATABASE_URL` / `NEON_DATABASE_URL`） |
| `LLM_API_KEY` | 二选一 | — | 单端点：OpenAI 兼容密钥 |
| `LLM_API_BASE` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 单端点：API Base |
| `LLM_MODEL` | 否 | `qwen-plus` | 单端点：模型名 |
| `LLM_API_ENDPOINTS` | 二选一 | — | 多端点 JSON 数组，配置后**优先**于单端点，失败自动切换 |
| `LLM_TIMEOUT_MS` | 否 | `45000` | 单次 LLM 请求超时（毫秒） |
| `LLM_MODEL_AUTOUPGRADE` | 否 | `true` | 自动升级到供应商同系列最新/最优模型（如 `glm-4`→`glm-5.2`）。设 `false`/`0`/`off` 关闭 |
| `LLM_MODELS_CACHE_TTL_MS` | 否 | `43200000`（12h） | 自动选型探测结果缓存时长 |
| `LLM_PROVIDER_RANK` | 否 | 内置排名 | 跨供应商优先级覆盖（JSON：`{"glm":99,"qwen":80}`），数值越大越优先尝试 |
| `CRON_SECRET` | 是（启用定时） | — | 定时任务鉴权密钥，建议 32+ 位随机串（采集与批量生成共用） |
| `BP_BATCH_SIZE` | 否 | `5` | 每次定时批量生成的 BP 数量（自动钳制到 1-10）。8 次/天 × 5 = 40 份/天 |
| `TRENDS_TABLE` | 否 | 自动探测 | 强制指定趋势表名（默认在 `google_trends` / `trends_trending_now` 间按行数自动选择） |

> 二选一：`LLM_API_KEY` 与 `LLM_API_ENDPOINTS` 至少配置其一，否则 BP 生成端点返回 503（fail-closed，不做模板回退）。

`LLM_API_ENDPOINTS` 示例（单行）：

```json
[{"name":"dashscope","base":"https://dashscope.aliyuncs.com/compatible-mode/v1","key":"sk-xxx","model":"qwen-plus"},{"name":"openai","base":"https://api.openai.com/v1","key":"sk-yyy","model":"gpt-4o-mini"}]
```

### 模型自动切换与自动升级

- **自动升级**：每次调用前，从各供应商 OpenAI 兼容的 `GET {base}/models` 拉取在线模型清单，在「同系列」中按「代次→小版本→档位」启发式择优（如新出 `glm-5.2` 时，`glm-4` 端点自动升级到 `glm-5.2`；`qwen3-max` 优于 `qwen-plus`）。结果按 `LLM_MODELS_CACHE_TTL_MS` 缓存（默认 12h），探测失败回退到 `model` 配置值，且**永不低于**已配置模型。
- **自动切换（排名优先）**：多端点按 `LLM_PROVIDER_RANK`（含内置默认）排序，优先尝试排名最高且健康的端点；失败仍自动切换到其余端点（沿用冷却/失效逻辑）。
- **每端点可选字段**：`family`（覆盖系列识别，如 `"glm"`）、`autoUpgrade:false` 或 `pin:true`（锁定该端点模型，不自动升级）。
- **排除项**：自动选型只在通用对话模型中择优，跳过 embedding/vision/image/audio/realtime/coder/math 等专用变体（已配置的 `model` 除外，作为下限）。
- **查看当前选型**：`GET /api/llm/health?resolve=1`（探测并返回各端点 `family`/`rank`/`resolvedModel`，不暴露密钥）。

## 2. 首次部署清单

1. 在 Netlify 控制台设置上述环境变量（至少 `DATABASE_URL` + 一个 LLM 密钥 + `CRON_SECRET`）。
2. 推送 `main` 触发部署，等待完成。
3. 通过 `/api/health` 确认新版本与数据库连通：
   ```bash
   curl https://<your-site>/api/health
   # 期望: status=ok, database.connected=true, version=<最新>
   ```
4. 建表（幂等；密钥为环境变量 `ADMIN_SECRET`，未配置时回退 `CRON_SECRET`，两者皆无则端点禁用）：
   ```bash
   curl -X POST "https://<your-site>/api/db-init?secret=$ADMIN_SECRET" -H "Origin: https://<your-site>"
   ```
5. 校验 `bp_reports` / `bp_opportunities` 已存在且 schema 正确（见 §5 故障 B）。

## 3. 定时关键词采集（零 LLM token）

- 实现：并入 [netlify/functions/bp-batch-background.ts](../../../netlify/functions/bp-batch-background.ts) 的**第 1 步**，在进程内直接调用 `trendsCollector.collect()`。原独立函数 `trends-collector`（`50 */3 * * *`）已于 2026-07-26 删除：Neon 免费版按**计算时长**计费，每个独立定时函数都会唤醒数据库并额外拖一条 5 分钟休眠尾（约 0.73 小时/天）。
- 行为（等价于 `POST /api/trends/collect`，该端点保留供手动触发）：
  1. 抓取 Google Trends 实时热搜 RSS（`https://trends.google.com/trending/rss?geo=...`），默认地区 `US,GB,CA,AU,IN,SG`；
  2. 解析关键词与 `approx_traffic`（"200K+"→200000），按地区 24h 去重后写入活跃趋势表，采集时间戳 = `NOW()`；
  3. `growth_rate` 由流量分级保守估算（界定 74-100，仅作内部评分信号，避免乐观偏差），确保新词在 BP 选词器中 > `MIN_TREND_SCORE`。
- 成本：**0 LLM token**。解决「词池静态、全历史去重后无新词可用」与 R3 采集时效问题（每词只分析一次，词池必须持续供应新词）。
- 手动触发：
  ```bash
  curl -X POST "https://<your-site>/api/trends/collect" \
    -H "Authorization: Bearer $CRON_SECRET" -H "Origin: https://<your-site>"
  # -> { success:true, inserted, skipped, geos:{...}, errors:[] }
  # 可选 ?geos=US,GB 覆盖默认地区
  ```

## 3b. 定时批量自动生成

- 实现：[netlify/functions/bp-scheduled.ts](../../../netlify/functions/bp-scheduled.ts)，`schedule('0 */3 * * *', ...)`，UTC 每 3 小时整点（8 次/天 × 5 份 = 最多 40 份/天）。这是全站**唯一**的定时触发器，**仅异步拉起**后台批量函数并立即返回（不占用定时函数时长）。
- 后台批量：[netlify/functions/bp-batch-background.ts](../../../netlify/functions/bp-batch-background.ts)（`-background` 后缀 → 15 分钟时长上限）是全站**唯一的数据库写入窗口**，一次调用内依次完成：①采集热词 → ②生成 BP 批次 → ③站点巡检 → ④保留期清理与补表 → ⑤重建快照。
- BP 批次三阶段（[src/lib/services/bpBatchRunner.ts](../../../src/lib/services/bpBatchRunner.ts)）：
  1. **PREPARE（唤醒 1 次）**：重放上次未 flush 的缓冲、`resetStaleGenerating()`、一次取齐去重集合/候选词/回避清单/全部规范商业模式；
  2. **GENERATE（零数据库访问）**：仅调用 LLM，去重全在内存完成。每份生成完成后立刻写入 Netlify Blobs 缓冲（`bp/pending/<batchId>`）——这是崩溃安全点，取代了原先"先插占位行、后更新"的写法（那种写法每 ~2 分钟落一次查询，休眠计时器永远清零）；
  3. **FLUSH（唤醒 1 次）**：单事务批量插入最终状态（completed/failed）。失败则保留缓冲，下次运行重放，绝不丢弃已付费的 LLM 产出。
- 时间预算：生成阶段截止到第 10 分钟，尾部预留 3 分钟给 flush/巡检/清理/快照。
- 单次 `POST /api/bp/cron` → `bpService.runScheduledGeneration()`：
  1. `resetStaleGenerating()` 把超过 15 分钟仍 `generating/pending` 的记录置为 `failed`；
  2. 按 `4h` 窗口、`search_volume` 降序扫描趋势（每页 50 条，最多 5 页）；
  3. **热词全历史去重**：跳过历史上任一时刻已有 `completed` BP 的热词，自动顺延下一个不重复的热词。每个热词只分析一次，永不重复生成；
  4. **评分筛选**：综合百分制分 > 60 才合格（`50%×增长速度% + 50%×搜索量对数归一化`，见 `computeTrendHotwordScore`）；
  5. 对首个合格且未生成 BP 的热词调用 LLM，`action=generated`；无合格热词则 `action=skipped`（200，非错误）。
  6. **商业模式去重（同样为全历史）**：生成并校验后，按归一化 `businessModel`（`normalizeBusinessModel`：小写、压缩空白、去首尾标点）比对**全部历史**的 `completed` 报告。若已存在相同商业模式的报告，则**不重复存储内容**，将本次记录标记为 `completed` 并通过 `canonical_report_id` 指向原报告，直接复用其商业计划书（详情/列表读取时自动解析指向）。
  7. **省 token：商业模式回避清单**：调用 LLM 前注入最近使用过的去重商业模式清单（`getRecentBusinessModels` + `buildAvoidModelsLine`，约 +150-250 输入 token），引导模型另辟差异化方向，把「生成后才发现模式重复」的整次浪费调用转化为新内容。配合精简后的提示词，单份约 5k→4.3k token。
  8. **全 AI 无人公司硬约束**：`SYSTEM_PROMPT` 与 `buildUserPrompt` 要求所选机会必须是可由全 AI 自动化运营的"无人公司"承载的在线服务（内容/获客/转化/客服/交付/计费/风控等环节近零人工），自动化程度计入 onlineability/feasibility，`businessModel`/`summary` 须逐环节说明无人化实现路径与近零人力成本结构；关键财务参数须可复算（注明公式与取值，便于 Python 验证）；须合法合规、符合社会公序良俗。
- 手动触发（验证用）：
  ```bash
  curl -X POST "https://<your-site>/api/bp/cron" \
    -H "Authorization: Bearer $CRON_SECRET" -H "Origin: https://<your-site>"
  # generated -> { success:true, action:"generated", reportId, keyword, status, trendScore, rank }
  # skipped   -> { success:true, action:"skipped", reason:"no_eligible_trend" }
  ```

### 鉴权与返回码

| 场景 | HTTP |
|---|---|
| 未配置 `CRON_SECRET` | 503（定时禁用，fail-closed） |
| 缺失/错误 `Authorization` | 401 |
| 未配置 LLM 密钥 | 503 |
| 无合格新热词（均已生成或评分≤60） | 200，`action=skipped` |
| 全部 LLM 端点失败 | 503 |
| 成功 | 200 |

## 4. 巡检与验证（E2E）

```bash
# 基础巡检（不含鉴权 cron 生成，R-BP7/8/9 标记 BLOCKED）
node tests/e2e/live-smoke.mjs

# 完整巡检（含真实 cron 生成 → 落库 → 详情页渲染）
BASE_URL=https://<your-site> E2E_CRON_SECRET=<同 CRON_SECRET> node tests/e2e/live-smoke.mjs
```

- 退出码：仅当存在 `FAIL` 时为非 0；外部依赖缺失（DB 配额、未配密钥）记为 `BLOCKED`，不算失败。
- 报告产物：`tests/e2e/last-run.json`、`tests/e2e/last-run.md`（均已 gitignore）。

BP 相关探针：

| 编号 | 检查 | 通过条件 |
|---|---|---|
| R-BP1 | `/bp` 列表页 SSR | 200 且含标题 |
| R-BP2 | Header BP 导航链接 | 存在 |
| R-BP3 | 首页「一键生成 BP」CTA | 有趋势数据时存在 |
| R-BP4 | 无密钥调用 cron | 401 或 503 |
| R-BP5 | 错误密钥调用 cron | 401 或 503 |
| R-BP6 | `bp_reports` 表已建 | health.tables 含 `bp_reports` |
| R-BP7 | 带密钥触发生成 | 200 且 `action` 合法（缺密钥 BLOCKED） |
| R-BP8 | cron 结果落库可查 | `/api/bp/[id]` 200 |
| R-BP9 | 已完成 BP 详情渲染 | 详情页含「执行摘要」 |
| R-COL1 | 无/错误密钥调用采集 | 401 或 503（fail-closed） |
| R-COL2 | 带密钥触发采集 + 时效 | 200 且 `inserted` 为数字，48h 内可见行（缺密钥 BLOCKED；0 token） |

## 5. 常见故障处理

### A. BP 生成返回 503
- 原因：未配置 LLM 密钥，或所有端点失败。
- 处置：检查 `LLM_API_KEY`/`LLM_API_ENDPOINTS`；查看函数日志中 `LLM_ALL_ENDPOINTS_FAILED` 末尾错误；确认供应商可用、额度充足。

### B. `bp_opportunities` 旧 schema（index 报 `column "report_id" does not exist`）
- 原因：历史遗留表结构（`plan_id/scores/roi_score`）与现版本不兼容。
- 处置（**破坏性重建，仅在两表数据可丢弃时**）：
  ```bash
  curl -X POST "https://<your-site>/api/db-init?secret=$ADMIN_SECRET&migrate=bp" -H "Origin: https://<your-site>"
  ```
  重建后 `bp_opportunities` 列应为：`id, report_id, name, description, score_market, score_roi, score_onlineability, score_feasibility, score_speed, score_moat, weighted_score, is_selected, rank, created_at`。
- `bp_reports` 新增列 `business_model_norm`、`canonical_report_id`（商业模式去重用）为**附加式**变更：普通 `POST /api/db-init?secret=$ADMIN_SECRET` 即通过 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 自动补齐，无需破坏性重建。

### C. 报告长期卡在 `generating`
- 原因：Netlify 函数 26s 超时中断了同步生成。
- 处置：下一次 cron 会自动 `resetStaleGenerating()` 置为 `failed` 并重试；也可手动调用 cron。缓解：优先用更快模型、缩短输出、依赖全历史去重避免重复消耗。

### D. 定时任务未执行
- 检查：Netlify → Functions → `bp-scheduled` 是否存在且有调用记录；`CRON_SECRET` 是否已配置；时区为 UTC。

## 6. 成本与安全

- **成本控制**：全历史去重（每词只分析一次）+ `max_tokens` 限制 + 失败不重复落库；精简提示词 + 商业模式回避清单减少无效调用；关键词采集 0 token；定时频率默认 3h。批量产量由 `BP_BATCH_SIZE`（默认 5 → 约 40 份/天）控制。
- **安全**：cron 强制 `CRON_SECRET`；所有 DB 访问参数化查询；详情页对 LLM 文本默认转义（不使用 `set:html` 渲染不可信内容）；生成端点要求登录用户（cron 除外，靠密钥鉴权）。

## 7. 变更频率（如需调整）

- 修改 [netlify/functions/bp-scheduled.ts](../../../netlify/functions/bp-scheduled.ts) 中的 cron 表达式（当前每 3 小时：`0 */3 * * *`）。采集与巡检已并入同一窗口，无需单独调频；增加窗口数会线性增加 Neon 计算消耗，调整前先跑 `python scripts/neon-budget.py --cron-runs N`。
- 调整批量产量：设置环境变量 `BP_BATCH_SIZE`（1-10，默认 5）。提升地区覆盖：修改 [src/lib/services/trendsCollector.ts](../../../src/lib/services/trendsCollector.ts) 中 `DEFAULT_GEOS`。
- 去重为**全历史**（热词去重、手动复用与商业模式去重均不设时间窗，每个热词只分析一次）；`resetStaleGenerating(maxAgeMinutes)`（卡死阈值）仍在 [src/lib/services/bp.ts](../../../src/lib/services/bp.ts) 中调整。

## 8. 迁移到独立 Neon 项目

100 CU-hours 按**项目**计，当前项目还有兄弟应用的 10 张表，节省下来的额度可能被它吃掉，且用量无法归因。[scripts/neon-migrate.mjs](../../../scripts/neon-migrate.mjs) 只复制本站拥有的 9 张表（表清单与 DDL 来自 [src/lib/db/schema.ts](../../../src/lib/db/schema.ts)），只读源库，可重复执行。

步骤：

```bash
# 1. 先看行数，不写入
SOURCE_DATABASE_URL=<旧> node scripts/neon-migrate.mjs --dry-run
# 2. 建表 + 复制
SOURCE_DATABASE_URL=<旧> TARGET_DATABASE_URL=<新> node scripts/neon-migrate.mjs
# 3. 复核（行数 + 内容指纹）
SOURCE_DATABASE_URL=<旧> TARGET_DATABASE_URL=<新> node scripts/neon-migrate.mjs --verify
# 4. 让应用真的读一遍新库（重建全部快照并断言每个只读路由渲染真实内容）
DATABASE_URL=<新> ADMIN_SECRET=<secret> npx astro dev --port 4399
BASE_URL=http://localhost:4399 ADMIN_SECRET=<secret> npm run test:migrated
# 5. Netlify 切换 DATABASE_URL → 重新部署 → POST /api/db-init?secret=$ADMIN_SECRET 确认 schema
```

两条已在本地真机演练中验证过的要点：

- **值必须以文本搬运**。node-postgres 会把 `timestamptz` 解析成 JS `Date`（毫秒精度），Postgres 的微秒会被静默截断（`05:07:26.884298+08` → `.884+08`）。脚本改为 `col::text` 取出、落地时按目标列类型显式回转，本地 189 行 9 表迁移后逐行 md5 与源库完全一致。
- **行数相等不等于内容相等**。`--verify` 会对每表计算内容指纹（逐行 md5 排序后折叠，与行序无关）；人为改动目标库一个字段后该步骤会报 `MISMATCH` 并以非零码退出。

旧项目至少保留几天作为回滚路径，确认新项目跑完一个完整 cron 周期（`/api/snapshots/status` 新鲜）后再考虑清理。
