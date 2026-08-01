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
| `BP_BATCH_SIZE` | 否 | `5` | 每次定时批量生成的 BP 数量（自动钳制到 1-10）。8 次/天 × 5 = 40 份/天。错过窗口后自动上浮补产，上限 12 |
| `TRENDS_TABLE` | 否 | 自动探测 | 强制指定趋势表名（默认在 `google_trends` / `trends_trending_now` 间按行数自动选择） |
| `TRENDS_INTAKE_TTL_HOURS` | 否 | `48` | 断库时已抓取热词在 Blobs 队列中的保留时长，与选词器时效窗口对齐（§3c） |
| `BP_DEDUPE_CACHE_MAX_AGE_HOURS` | 否 | `72` | 断库降级生成所用去重缓存的可用上限，超期则拒绝降级生成 |
| `PIPELINE_RECOVERY_ENABLED` | 否 | `true` | 小时级恢复任务开关，设 `false` 关闭（它同时兼任快照冻结看门狗，见 §3d） |
| `PIPELINE_RECOVERY_MIN_INTERVAL_MINUTES` | 否 | `55` | 有积压时两次补录尝试的最小间隔；快照重建复用同一间隔 |
| `SNAPSHOT_MAX_AGE_SECONDS` | 否 | `25200`（7h） | 读取侧被判定为「冻结」的年龄阈值（两个写入窗口 + 1h 余量）。超过后 `/api/snapshots/status` 返回 503，看门狗自动重建（§3d） |
| `ADMIN_SECRET` | 否 | 回退到 `CRON_SECRET` | 运维接口/页面（`/admin/errors`、`/api/admin/*`）鉴权密钥。未设置时用 `CRON_SECRET`，但两者分离更安全 |
| `SITE_ROLE` | 否 | `writer` | 双部署角色。`reader` 的站点**不跑任何定时任务**（见 §9）；缺省为 `writer`，因为"变量丢失导致管线静默停摆"比"多跑一次"更难发现 |

支付与下载（未配置时买入口自动隐藏，站点行为与加支付前完全一致，见 §10）：

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `CREEM_API_KEY` | 收款需要 | — | Creem（主通道，支持支付宝/银行卡，Merchant of Record） |
| `CREEM_PRODUCT_ID` | 同上 | — | Creem 侧的 $1 产品 ID。**金额只在供应商侧配置**，浏览器永远不传价格 |
| `CREEM_WEBHOOK_SECRET` | 同上 | — | Webhook 签名密钥。缺此项则该通道**不会**被启用（收了钱却无法验证付款，是唯一不可接受的失败） |
| `CREEM_TEST_MODE` | 否 | `false` | `true` 时打 Creem 沙箱域名（测试密钥只对沙箱有效） |
| `LEMONSQUEEZY_API_KEY` / `_STORE_ID` / `_VARIANT_ID` / `_WEBHOOK_SECRET` | 备用通道需要 | — | Lemon Squeezy，Creem 建单失败时自动接管 |
| `PAYMENT_PROVIDER_ORDER` | 否 | `creem,lemonsqueezy` | 尝试顺序。未列出的通道仍会被追加，所以写错不会静默停掉一个已配置的通道 |
| `PAYMENT_PRICE_CENTS` | 否 | `100` | **仅用于前端展示**（≥100）。实际扣款金额取决于供应商产品配置，两者需人工保持一致 |
| `PAYMENT_TOKEN_SECRET` | 否 | 回退 `SESSION_SECRET` | 签发下载链接与找单/认领魔术链接（HMAC）。至少 16 位，两者皆无则付费下载 fail-closed 返回 503 |
| `RESEND_API_KEY` | 否 | — | 仅用于游客"找回我的下载"与"认领订单"邮件。未配置时刚付款仍可直接下载（成功页带购买参考号），只是事后无法再要一次链接 |
| `EMAIL_FROM` | 否 | `ioni.top <no-reply@ioni.top>` | 必须是 Resend 里已验证的域名，否则发信被拒 |

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
- **抓取与入库解耦**：`harvest()` 只访问 Google，`persist()` 只访问 Postgres。数据库不可用时，已抓取的热词写入 Blobs 待入库队列（[src/lib/services/trendIntake.ts](../../../src/lib/services/trendIntake.ts)）而**不是丢弃**——RSS 是滚动窗口，丢掉的一批热词是永久损失而非延迟。详见 §3c。
- 行为（等价于 `POST /api/trends/collect`，该端点保留供手动触发）：
  1. 抓取 Google Trends 实时热搜 RSS（`https://trends.google.com/trending/rss?geo=...`），默认地区 `US,GB,CA,AU,IN,SG`；
  2. 解析关键词与 `approx_traffic`（"200K+"→200000），按地区 24h 去重后写入活跃趋势表，采集时间戳 = 读取 RSS 的时刻（补录的批次保留其真实采集时刻，`created_at` 才是落库时刻）；
  3. `growth_rate` 由流量分级保守估算（界定 74-100，仅作内部评分信号，避免乐观偏差），确保新词在 BP 选词器中 > `MIN_TREND_SCORE`；
  4. **主题分类**：同时解析 RSS 里每个热词附带的新闻标题与来源域名，由 [src/lib/services/trendTriage.ts](../../../src/lib/services/trendTriage.ts) 判定 `sports` / `entertainment` / `general` 三类，写入 `google_trends.topic_class`。来源域名（espn.com、variety.com 等）是最强信号，其次是新闻标题里的赛事/娱乐词，最后才是热词本身，避免仅凭人名误判。该列由 `applyAdditiveMigrations()` 在每次 cron 开头自动补齐，老数据 `topic_class` 为空时在选词阶段按热词即时重分类。
- 成本：**0 LLM token**。解决「词池静态、全历史去重后无新词可用」与 R3 采集时效问题（每词只分析一次，词池必须持续供应新词）。
- 手动触发：
  ```bash
  curl -X POST "https://<your-site>/api/trends/collect" \
    -H "Authorization: Bearer $CRON_SECRET" -H "Origin: https://<your-site>"
  # -> { success:true, inserted, skipped, geos:{...}, errors:[] }
  # 可选 ?geos=US,GB 覆盖默认地区
  ```

## 3c. Neon 达到限额时不漏掉热词与分析

Neon 免费版会周期性不可用（额度耗尽、休眠、冷启动）。此前一次不可用意味着该窗口的热词与商业机会**双重损失**：RSS 已滚动过去，抓不回来；PREPARE 阶段读不到去重集合，整批不生成。现在每一步都假定数据库随时可能不可用：

| 环节 | 断库时 | 恢复后 |
|---|---|---|
| 采集热词 | 按真实采集时刻写入 Blobs 队列 `trends/pending/*` | 按原采集时刻补录并按地区 24h 去重；保留期 `TRENDS_INTAKE_TTL_HOURS`（默认 48h，与选词器 `SCHEDULED_FRESHNESS_WINDOW` 对齐——超出这个窗口选词器本就不会选，留着没有意义） |
| 选候选词 | 用 Blobs 缓存的去重集合（[bpDedupeCache.ts](../../../src/lib/services/bpDedupeCache.ts)）+ 待入库队列 + 上一份趋势快照；缓存超过 `BP_DEDUPE_CACHE_MAX_AGE_HOURS`（默认 72h）则**拒绝**降级生成，如实报告无候选，不靠猜 | 恢复为实时集合，每次健康运行刷新缓存 |
| 生成 BP | 正常调用 LLM，每份落 `bp/pending/<batchId>` 缓冲 | 补写落库；落库前用 `getCompletedKeywordNormsAmong()` 对活库复核，缓存过期也不会产生重复报告（`failed` 占位行仍写入，它承载失败计数） |
| 补产量 | — | 由上次成功 flush 的时间推算错过了几个窗口，本次批量相应加大，上限 `MAX_CATCHUP_BATCH_SIZE`（12）。生成循环仍受 10 分钟截止时间约束，所以加大只会用掉剩余预算，不会超时 |

- **小时级恢复任务**：[netlify/functions/pipeline-recovery.ts](../../../netlify/functions/pipeline-recovery.ts)（`25 * * * *`）只读 Blobs 判断有无积压：无积压则**零数据库访问**直接返回；有积压才拉起 [pipeline-drain-background.ts](../../../netlify/functions/pipeline-drain-background.ts) 落库并重建快照。该函数不花 LLM 额度，且每小时最多触发一次（`PIPELINE_RECOVERY_MIN_INTERVAL_MINUTES`），所以真正宕库时是稳定重试而非猛打。`PIPELINE_RECOVERY_ENABLED=false` 可关闭。
- **积压可见**：`/admin/errors` 页面与 `GET /api/admin/errors` 的 `pipeline` 块给出待入库热词数、未落库报告数、错过窗口数、上次健康运行/上次落库时间。两者都只读 Blobs，因此在它们所描述的那次故障期间依然可用。
- 验证：`npx vitest run tests/unit/trendIntake.test.ts tests/unit/bpDedupeCache.test.ts tests/unit/pipelineState.test.ts tests/unit/trendsCollectorStore.test.ts tests/unit/bpBatchRunner.test.ts`；断库演练 `npm run test:outage` 会断言积压在断库期间可读。

## 3d. 快照写不进去时不让页面冻结

与「断库」相反、也更隐蔽的一类故障：**数据库一直在写，页面却停止更新**。2026-07-26 就是这样冻了 44 小时——`bp_reports` 每天正常新增 40 份，而所有页面停在 07-26 20:03（北京时间）。

- **根因**：后台批量是 v1（Lambda 兼容）函数，Netlify 把 Blobs 凭据放在 `event.blobs` 与请求头里，`@netlify/blobs` 只有在调用过 `connectLambda(event)` 之后才会读取它们。没调用 → `getStore()` 抛 `MissingBlobsEnvironmentError` → 快照层原先**静默回退到文件系统**；在 Lambda 里那是随容器销毁的临时目录，于是每次写入都"成功"且无人可读。错误日志本身也存在 Blobs，所以那两天连一条错误都没有。SSR 是 v2 函数，环境由平台自动注入，因此 `/api/snapshots/rebuild` 一直是好的——这也正是当时手工恢复页面所走的路径。
- **三层修复**（缺任何一层，故障仍会静默）：
  1. `connectSnapshotStoreToLambda(event)` 作为每个碰快照的 v1 handler 的第一条语句（bp-batch-background / pipeline-drain-background / pipeline-recovery）；
  2. 函数内 Blobs 不可用时状态为 `unavailable`，**拒绝写入**并让调用方拿到 `false`，不再假装成功（[src/lib/cache/snapshot.ts](../../../src/lib/cache/snapshot.ts)）；
  3. 批量结束时做**回读校验**：写入一个随机串 → 重置存储解析 → 读回比对（[src/lib/cache/snapshotDelivery.ts](../../../src/lib/cache/snapshotDelivery.ts)）。"写入返回 true"不算证据，只有回读到同一个串才算。
- **自愈**：回读失败时，批量改走已验证可用的 SSR 路径 `POST /api/snapshots/rebuild?sections=<段>`（分段多轮，直到不再 `truncated`），并把事故写入 **Postgres 的 `ops_alerts` 表**——那是这种状态下唯一确定可写的存储。运行摘要里会出现 `store=BROKEN(...) repair=ok`。
- **看门狗**：小时级 [pipeline-recovery.ts](../../../netlify/functions/pipeline-recovery.ts) 顺带检查读取侧年龄（只读 Blobs，零数据库访问）：超过 `SNAPSHOT_MAX_AGE_SECONDS`（默认 25200 秒 = 7h，两个窗口 + 1h 余量）就带 `?repairSnapshots=<段>` 参数拉起后台函数重建，每小时最多一次，避免结构性故障变成持续读库。
- **外部可见**：`GET /api/snapshots/status` 在陈旧或缺失时返回 **503**（正常 200），任何 uptime 监控指向它即可发现冻结，不需要解析响应体。`/admin/errors` 的 "Read side" 面板显示最旧快照年龄、当前存储后端与上次自动修复时间；"Storage incidents" 面板按需（`?alerts=1`）从 Postgres 读取 `ops_alerts`——默认不读，保持运维页面零数据库唤醒。
- 验证：`npx vitest run tests/unit/snapshot.test.ts tests/unit/snapshotDelivery.test.ts`（含 503 看门狗与"函数内拒绝写入"用例）；`npm run test:outage` 断言 503 不会误报，且运维页面在断库时仍渲染这两个面板。

## 3b. 定时批量自动生成

- 实现：[netlify/functions/bp-scheduled.ts](../../../netlify/functions/bp-scheduled.ts)，`schedule('0 */3 * * *', ...)`，UTC 每 3 小时整点（8 次/天 × 5 份 = 最多 40 份/天）。这是全站**唯一**的定时触发器，**仅异步拉起**后台批量函数并立即返回（不占用定时函数时长）。
- 后台批量：[netlify/functions/bp-batch-background.ts](../../../netlify/functions/bp-batch-background.ts)（`-background` 后缀 → 15 分钟时长上限）是全站**唯一的数据库写入窗口**，一次调用内依次完成：①采集热词 → ②生成 BP 批次 → ③站点巡检 → ④保留期清理与补表 → ⑤重建快照。
- BP 批次三阶段（[src/lib/services/bpBatchRunner.ts](../../../src/lib/services/bpBatchRunner.ts)）：
  1. **PREPARE（唤醒 1 次）**：重放上次未 flush 的缓冲、`resetStaleGenerating()`、一次取齐去重集合/候选词/回避清单/全部规范商业模式，并把去重状态缓存到 Blobs 供断库时使用；数据库不可用时改用该缓存降级运行（§3c）；
  2. **GENERATE（零数据库访问）**：仅调用 LLM，去重全在内存完成。每份生成完成后立刻写入 Netlify Blobs 缓冲（`bp/pending/<batchId>`）——这是崩溃安全点，取代了原先"先插占位行、后更新"的写法（那种写法每 ~2 分钟落一次查询，休眠计时器永远清零）；
  3. **FLUSH（唤醒 1 次）**：单事务批量插入最终状态（completed/failed）。失败则保留缓冲，下次运行重放，绝不丢弃已付费的 LLM 产出。
- 时间预算：生成阶段截止到第 10 分钟，尾部预留 3 分钟给 flush/巡检/清理/快照。
- 单次 `POST /api/bp/cron` → `bpService.runScheduledGeneration()`：
  1. `resetStaleGenerating()` 把超过 15 分钟仍 `generating/pending` 的记录置为 `failed`；
  2. 按 `4h` 窗口、`search_volume` 降序扫描趋势（每页 50 条，最多 5 页）；
  3. **热词全历史去重**：跳过历史上任一时刻已有 `completed` BP 的热词，自动顺延下一个不重复的热词。每个热词只分析一次，永不重复生成；
  4. **评分筛选**：综合百分制分 > 60 才合格（`50%×增长速度% + 50%×搜索量对数归一化`，见 `computeTrendHotwordScore`）；
  4b. **品类排除**：`topic_class` 为 `sports` / `entertainment` 的热词直接跳过（体育赛事、运动员、娱乐明星）。这类热词产出的商业计划书高度雷同（粉丝周边、赛事直播、明星联名），持续分析只是重复消耗 LLM 额度。剩余候选再按 `rankTrendForAnalysis` 重排：在热度分之上叠加 `commercialIntentScore × 0.15` 的商业意图分，让"可在线服务化"的热词（app / tool / platform / 订阅 / 预订 / 报税 / 保险……）优先出队；
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

### E. Neon 达到限额，连不上数据库
- 症状：函数日志出现 `[DB] circuit breaker opened`；`bp-batch` 日志出现 `queued=N`（热词进队列）与 `bp=degraded` / `bp=buffered`（降级生成、产出待落库）。
- 判断损失范围：`GET /api/admin/errors?secret=$ADMIN_SECRET` 的 `pipeline` 块，或直接看 `/admin/errors` 页面。`queuedTrendRows` / `bufferedReports` 是**已保住**的工作量，`missedRuns` 是仍需补产的窗口数。
- 处置：通常无需人工干预——小时级恢复任务会在数据库恢复后自动落库，下一个批量窗口自动加大产量补回落下的分析（机制见 §3c）。
- 需要立即补录时：
  ```bash
  curl -X POST "https://<your-site>/.netlify/functions/pipeline-drain-background" \
    -H "Authorization: Bearer $CRON_SECRET"
  ```
- 唯一真正的损失是超过 `TRENDS_INTAKE_TTL_HOURS`（48h）的队列批次：那些热词已超出选词窗口，补录也不会被分析，会记为 `expired` 并丢弃。若单次故障可能超过两天，先临时上调该变量。

### F. 数据库在写、页面却不更新（快照冻结）

区分这一类与 E 的判据只有一条：**库里有新数据，页面没有**。

1. 先看读取侧年龄：`curl -i https://<your-site>/api/snapshots/status`。返回 **503** 且 `stale:true` 即为冻结；`generatedAt` 停在某一刻不动是同一个症状。
2. 再确认写入侧其实是好的：`GET /api/stats/overview` 或直接查库 `SELECT count(*) FROM bp_reports WHERE created_at > NOW() - interval '1 day'`。若库在增长而快照不动，就是本节的故障，与 Neon 额度无关。
3. 看后台函数摘要里的 `blobs=` 与 `store=` 字段（Netlify → Functions → `bp-batch-background`）：`blobs=ambient:unavailable` 说明 `connectLambda` 没拿到凭据，`store=BROKEN(...)` 说明回读校验失败。
4. 取事故记录（这一步会唤醒数据库）：`GET /api/admin/errors?secret=$ADMIN_SECRET&alerts=1` 的 `opsAlerts`，或 `/admin/errors?...&alerts=1` 的 "Storage incidents" 面板。
- 处置：通常无需人工干预——批量在同一次运行内改走 SSR 路径重建，小时级看门狗最多 1 小时内也会重建（机制见 §3d）。
- 需要立刻恢复页面时（这条路径与看门狗走的完全相同，2026-07-28 手工恢复用的就是它）：
  ```bash
  BASE_URL=https://<your-site> CRON_SECRET=$CRON_SECRET node scripts/snapshot-bootstrap.mjs
  ```
- 建议：把外部 uptime 监控指向 `/api/snapshots/status`。它是 DB-free 的，陈旧即 503，这样下一次同类故障不必等到有人肉眼发现内容没更新。
- 站外兜底已常态化：GitHub Actions 工作流 [.github/workflows/publish-snapshots.yml](../../../.github/workflows/publish-snapshots.yml) 在每个批量窗口后 25 分钟跑同一条 SSR 重建路径，再断言读取侧年龄（`npm run snapshots:check`，超过 4 小时即失败并邮件通知仓库所有者）。它不依赖 Netlify 构建与站内看门狗，因此上述两种"站内自己救不了自己"的情形都能兜住；只需一个仓库 Secret：`SNAPSHOT_REBUILD_SECRET`（填站点的 `ADMIN_SECRET` 或 `CRON_SECRET`）。

### G. Netlify 额度耗尽：部署被拒（站点仍在运行）

- 症状：`git push` 后 Netlify 出现 `error` 状态的部署，`error_message` 为 `Skipped due to account credit usage exceeded`；`netlify deploy` 也会以 `JSONHTTPError: Forbidden` 失败。站点本身照常服务，函数照常执行。
- 判断：
  ```bash
  # 部署状态与拒绝原因
  npx netlify api listSiteDeploys --data "{\"site_id\":\"<site-id>\"}"
  # 计费周期与套餐额度（credits 按周期计，周期见 current_usage_period_start）
  curl -H "Authorization: Bearer <netlify-token>" https://api.netlify.com/api/v1/accounts/<slug>
  ```
- 影响：**代码改不动**。此时环境变量的新增/修改也不会生效——Netlify 只在部署时注入，正在运行的函数仍持有旧值（2026-07-29 就是这样：当天新设的 `ADMIN_SECRET` 对线上无效，运维接口只能继续用 `CRON_SECRET`）。
- 处置：额度靠充值或等下一个周期恢复；在此期间页面更新靠 §F 的站外工作流维持，它只用运行中的 SSR 端点，不需要部署。

## 6. 成本与安全

- **成本控制**：全历史去重（每词只分析一次）+ `max_tokens` 限制 + 失败不重复落库；精简提示词 + 商业模式回避清单减少无效调用；关键词采集 0 token；定时频率默认 3h。批量产量由 `BP_BATCH_SIZE`（默认 5 → 约 40 份/天）控制。
- **安全**：cron 强制 `CRON_SECRET`；所有 DB 访问参数化查询；详情页对 LLM 文本默认转义（不使用 `set:html` 渲染不可信内容）；生成端点要求登录用户（cron 除外，靠密钥鉴权）。

## 7. 变更频率（如需调整）

- 修改 [netlify/functions/bp-scheduled.ts](../../../netlify/functions/bp-scheduled.ts) 中的 cron 表达式（当前每 3 小时：`0 */3 * * *`）。采集与巡检已并入同一窗口，无需单独调频；增加窗口数会线性增加 Neon 计算消耗，调整前先跑 `python scripts/neon-budget.py --cron-runs N`。
- 调整批量产量：设置环境变量 `BP_BATCH_SIZE`（1-10，默认 5）。错过窗口后本次批量会自动上浮到最多 12（见 §3c），这个上限在 [src/lib/services/pipelineState.ts](../../../src/lib/services/pipelineState.ts) 的 `MAX_CATCHUP_BATCH_SIZE`。提升地区覆盖：修改 [src/lib/services/trendsCollector.ts](../../../src/lib/services/trendsCollector.ts) 中 `DEFAULT_GEOS`。
- 去重为**全历史**（热词去重、手动复用与商业模式去重均不设时间窗，每个热词只分析一次）；`resetStaleGenerating(maxAgeMinutes)`（卡死阈值）仍在 [src/lib/services/bp.ts](../../../src/lib/services/bp.ts) 中调整。

## 8. 迁移到独立 Neon 项目

100 CU-hours 按**项目**计，当前项目还有兄弟应用的 10 张表，节省下来的额度可能被它吃掉，且用量无法归因。[scripts/neon-migrate.mjs](../../../scripts/neon-migrate.mjs) 只复制本站拥有的 10 张表（表清单与 DDL 来自 [src/lib/db/schema.ts](../../../src/lib/db/schema.ts)），只读源库，可重复执行。

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

## 9. 双 Netlify 账号部署与域名自动切换

2026-07 的教训不是代码问题：账号额度耗尽后**部署被拒了一个月**（§5G），站点还在跑，但改不动任何东西。所以同一份代码部署在两个 Netlify 账号上，任一账号出问题都不影响对外服务。

### 9.1 角色划分（关键：不重复烧钱）

两个部署连同一个 Neon 库、同一份代码，唯一区别是 `SITE_ROLE`：

| | writer | reader |
|---|---|---|
| `bp-scheduled`（`0 */3 * * *`） | 跑 | **直接返回**，不拉起批量 |
| `pipeline-recovery` 补录热词/落库报告 | 跑 | 不跑（队列是 writer 的批量产生的，两边都落库会插入重复热词） |
| `pipeline-recovery` 快照冻结看门狗 | 跑 | **跑**（它的本职就是页面不能冻结，重建是读操作） |
| 落库缓冲的支付事件 | 跑 | **跑**（Blobs 按站点隔离，webhook 打到哪个站点就只有那个站点能落它；`provider_order_id` 幂等，两边各落自己的不会重复） |
| SSR 页面 / 支付 / 下载 | 跑 | 跑（否则切换过去没有意义） |

`SITE_ROLE` 缺省是 `writer`：变量丢失导致管线静默停摆，比多跑一轮更难发现。所以**必须显式**给备用站点设 `SITE_ROLE=reader`。

### 9.2 备用站点的快照从哪来

Netlify Blobs 按站点隔离，备用站点有自己的快照存储，没人填就是空的。[.github/workflows/publish-snapshots.yml](../../../.github/workflows/publish-snapshots.yml) 在同一次运行里依次重建**两个**站点：第二次重建读到的是第一次刚唤醒的 Neon 计算实例，所以边际成本是页面读取时间，而不是一个新的唤醒窗口 + 5 分钟休眠尾。

仓库配置（Settings → Actions）：

| 类型 | 名称 | 说明 |
|---|---|---|
| Variable | `PRIMARY_BASE_URL` | 默认 `https://ioni.top` |
| Variable | `STANDBY_BASE_URL` | 备用站点地址；**未设置时所有备用步骤整段跳过**，可以先合代码后建站 |
| Secret | `SNAPSHOT_REBUILD_SECRET` | 主站点的 `CRON_SECRET` |
| Secret | `SNAPSHOT_REBUILD_SECRET_STANDBY` | 仅当备用站点用了不同密钥（否则回退上一项） |

备用站点首次上线需要手工灌一次（否则第一个访客看到空页面）：

```bash
BASE_URL=https://<standby>.netlify.app CRON_SECRET=<standby-cron-secret> node scripts/snapshot-bootstrap.mjs
BASE_URL=https://<standby>.netlify.app node scripts/snapshot-freshness.mjs
```

### 9.3 自动切换

[.github/workflows/failover.yml](../../../.github/workflows/failover.yml)（每 15 分钟）→ [scripts/failover.mjs](../../../scripts/failover.mjs)。

- **什么算宕机**：只有硬不可用——连接失败、超时、5xx，且连续 `PROBES`（默认 3 次，间隔 10s）全部失败。任何一次成功就不切。
- **内容陈旧故意不作为触发条件**：两个部署读同一个库，陈旧几乎总是管线问题，切域名只会把问题一起搬过去（这类故障由 §3d 的看门狗与发布工作流分别报告）。
- **备用站点必须先被证明健康**，否则拒绝切换：用坏的换坏的只是多加一段 DNS 传播延迟。两边都宕会明确报 `BOTH DEPLOYMENTS ARE DOWN` 并退出非 0，不动域名。
- **两步都要做**：Netlify 侧一个自定义域名只能绑一个站点（先从故障站点释放，再绑到备用站点），Aliyun 侧把 `@` 与 `www` 的 CNAME 指向备用站点的 `*.netlify.app`。只做一半会拿到一张指向已不应答站点的证书。
- 缺少 Aliyun 凭据时：Netlify 那半自动完成，DNS 那半打印出来等人工改，并以非 0 退出（工作流失败 → 邮件通知）。

仓库 Secrets：`NETLIFY_TOKEN_PRIMARY` / `NETLIFY_SITE_ID_PRIMARY` / `NETLIFY_TOKEN_STANDBY` / `NETLIFY_SITE_ID_STANDBY`，可选 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`；Variable `PRIMARY_DOMAIN`（默认 `ioni.top`）。**备用账号的 Secret 未配置前工作流自身直接退出**，可以安全先合。

站点 ID 从 `.netlify/state.json` 或 `npx netlify api listSites` 取。

手动操作：

```bash
# 只看决策，不改任何东西（演练第一步）
DOMAIN=ioni.top NETLIFY_TOKEN_PRIMARY=... NETLIFY_SITE_ID_PRIMARY=... \
NETLIFY_TOKEN_STANDBY=... NETLIFY_SITE_ID_STANDBY=... node scripts/failover.mjs --dry-run

# 计划内切换（灰度、维护、切回）
node scripts/failover.mjs --to=standby
node scripts/failover.mjs --to=primary
```

也可在 GitHub Actions 页面手动触发该工作流，`to` 填 `primary`/`standby`，`dry_run` 勾选即只报告。

### 9.4 纯手工兜底（凭据全丢、Actions 也用不了时，约 2 分钟）

1. Netlify 控制台 → 故障站点 → Domain management → 移除 `ioni.top` 与 `www.ioni.top`；
2. 切到另一个账号 → 健康站点 → Domain management → Add domain → `ioni.top`（自动带 `www`）；
3. 阿里云 DNS 控制台 → `ioni.top` → 把 `@` 与 `www` 的 CNAME 值改为健康站点的 `<name>.netlify.app`（若 `@` 是 A 记录，先删掉再加 CNAME）；TTL 600。
4. 等证书签发（通常几分钟），用 `curl -I https://ioni.top` 确认 200。

切换后**必须**做的两件事：把两个支付平台的 webhook URL 指向新的对外地址（否则付款不会被记账，只会进 Blobs 缓冲），以及跑一次 §10.6 的验证清单。

## 10. 支付与付费下载（$1 报告 PDF）

网页阅读永远免费（SEO 不受影响），付费的是**服务端生成的排版 PDF**：封面、页眉页脚、页码、表格不跨页断行、买家授权水印行。免费的"打印"按钮保留——Ctrl+P 本来就拿不走，假装拿得走是不诚实的。

### 10.1 钱的流向

- 两家都是 **Merchant of Record**：它们是法律上的卖方，负责全球 VAT/GST、发票、卡组织合规（PCI 不落到本站，卡号一秒都不经过我们的服务器）。对中国个人开发者是唯一现实可行的结构。
- **Creem** 为主通道（支持支付宝/银行卡）；**Lemon Squeezy** 为备用，Creem 建单失败时自动接管，且失败会被记录——否则主通道坏一周而收入看起来正常。
- $1 售价的净额约 **$0.56（Creem）/ $0.45（Lemon Squeezy）**，两家都是次月按平台结算周期打款。定价靠 `PAYMENT_PRICE_CENTS` 展示 + 供应商产品配置，**两处必须人工保持一致**。
- 一个通道只有在 API 密钥**和** webhook 签名密钥都配置好时才会被启用：收了钱却无法验证付款，是唯一没有可接受恢复手段的失败。两家都没配时买入口自动消失。

### 10.2 一次购买经过的路径

```
/bp/[id] 买按钮 ──POST /api/pay/checkout──▶ 供应商建单（金额只在供应商侧）
                        │ 同时写一行 pending 订单（记住 reportId 与账号关联）
                        ▼
                 供应商托管收银台（卡 / Apple Pay / 支付宝…）
                        │
       ┌────────────────┴─────────────────┐
       ▼                                  ▼
webhook（验签）→ orders 表 paid      浏览器带 ?purchase=<reference> 回到 /bp/[id]
                                          │ 轮询 GET /api/pay/status
                                          ▼
                          HMAC 下载令牌（7 天）→ /api/download/bp/[id]?token=…
```

- **游客**：在买面板填邮箱（会预填到收银台），成功页 URL 带一个服务端生成的随机 `reference`——这就是他的凭据，无需账号、无需 cookie、无需收邮件即可立刻下载。
- **登录用户**：邮箱与 `user_id` 直接来自会话，订单从创建那一刻就归属账号，出现在「我的下载」`/orders`。
- **认领**：游客后来注册/登录同一邮箱，需要走 `/orders` 的「认领」按钮，通过魔术链接**验证邮箱**后才归属账号。绝不按裸邮箱匹配——本站注册邮箱未验证，裸匹配等于允许任何人冒名领走别人的下载。
- **找回**：`/orders` 输入购买邮箱 → 15 分钟有效的魔术链接（Resend 发信）→ 打开该邮箱的订单列表。

### 10.3 安全边界（逐条对应实现）

| 风险 | 处置 |
|---|---|
| 客户端篡改价格 | 金额与产品都在供应商侧，浏览器不传价格 |
| 伪造付款通知 | webhook 先验签（HMAC，原始字节，不重新序列化）后解析；验签失败 401 + 告警 |
| 供应商重复投递 | `provider_order_id` 唯一 + `ON CONFLICT DO UPDATE`，重放只更新同一行 |
| 下载链接被转发 | 令牌带 `purpose`/`reportId`/过期时间且在签名内；下载时**重新读订单状态**（所以退款能真正吊销）；每单最多 20 次下载 |
| 令牌无法单独撤销（无状态代价） | 下载令牌 7 天、魔术链接 15 分钟；退款走状态复核而非撤销令牌 |
| 刷接口 | checkout 8 次/分/IP、status 60 次/分/IP、下载 12 次/分/IP、找单/认领单独限流 |
| 越权看别人订单 | 订单页 `no-store` + `robots.txt` 屏蔽 `/orders`；游客访问必须持魔术链接令牌 |
| 用告警把 Neon 额度打光 | 陌生人能触发的告警（验签失败）每种每分钟最多写一行 `ops_alerts`，且库在宕机时不写；全量明细始终进 Blobs 日志 |

### 10.4 断库时不丢一笔钱

数据库不可用**不允许**表现为"查不到订单"——那会把付了钱的人拒之门外。所以 `orders.ts` 的每个读都先看断路器，宁可抛 `OrdersUnavailableError` 让调用方走替代路径：

| 环节 | 断库时 | 恢复后 |
|---|---|---|
| 建单 | 照常跳转收银台，只是不写 pending 行（webhook 自带重建所需的全部信息） |  — |
| webhook | 验签通过的事件写入 Blobs 缓冲，**仍然回 200**（回 503 会让供应商重试，但 200 更早止损；缓冲件本身就是付款证明）。连缓冲都失败才回 503 请供应商重试，并发 `webhook_unrecorded` 告警 | `pipeline-drain-background` 幂等落库（**两个角色都会落自己站点的缓冲**，见 §9.1） |
| 成功页轮询 | 读 Blobs 缓冲里的已验签事件，照常签发下载令牌（响应带 `degraded:true`） | 恢复为读库 |
| 下载 | 只凭签名令牌放行，不计数。令牌只可能在验签付款后签发，所以最坏情况是已退款的人多下一份他本来就有的文件——比拒绝付费用户正确 | 恢复为复核订单状态并计数 |

`/admin/errors` 与 `pipeline-recovery` 的日志会显示缓冲中的支付事件数（`payments=N`），它只读 Blobs，故障期间依然可用。

### 10.5 日常运维

- **看收入**：`/stats` 页面的收入板块（净额 = 已付 − 已退，含近 7/30 天与逐日），数据随三小时批量的快照生成，读页面不碰数据库。
- **退款**：在供应商后台退款即可，webhook 会把订单置为 `refunded`，下载立即失效（下载端点每次都复核状态）。**不要**直接改库。
- **告警含义**（`/admin/errors?...&alerts=1` 的 `payments` 类）：

| kind | 含义 | 处置 |
|---|---|---|
| `webhook_signature` | 验签失败：要么密钥配错（付款正在被静默丢弃），要么有人在扫端点 | 先核对 `*_WEBHOOK_SECRET`；若与真实付款时间无关联，多为扫描，已限流 |
| `webhook_buffered` | 已验签、已安全落 Blobs，等库恢复 | 一般无需干预；超过 1 小时不减少见下面手动落库命令 |
| `webhook_unrecorded` | 库和 Blobs 都拒收，已回 503 请供应商重试 | 最高优先级：查 Neon 与 Blobs 状态，唯一副本还在供应商那里 |
| `checkout_failed` | 所有通道都建不出单 = 收入停摆 | 查两家平台状态页与密钥有效性；`/api/pay/canary` 会给出具体报错 |
| `download_failed` | 付了钱但 PDF 生成/授权失败 | 看 `pdf` 类错误日志；字体缺失、报告无 `content_json` 是两个常见原因 |
| `drain_failed` | 缓冲支付事件落库失败 | 同 `webhook_unrecorded` 的排查路径 |
| `canary_failed` | 每日探针发现支付通路已坏 | 在有客户撞上之前修 |

- **每日探针**：[.github/workflows/payment-canary.yml](../../../.github/workflows/payment-canary.yml)（01:40 UTC）对两个站点调 `GET /api/pay/canary`（`Authorization: Bearer $CRON_SECRET`）：检查配置完整性，并对每个通道真的建一次 checkout（建完即弃，不产生费用）。不返回 `healthy:true` 就让 job 失败并邮件通知。
- **手动落库缓冲的支付事件**：

```bash
curl -X POST "https://<站点>/.netlify/functions/pipeline-drain-background" \
  -H "Authorization: Bearer $CRON_SECRET"
# 摘要里的 payments=N 是本次落库数，stuck=N 是仍未落的
```

- **PDF 字体**：`public/fonts/NotoSansSC-subset.ttf`（约 2 MB，含 GB2312 全部汉字），由 [scripts/build-pdf-font.py](../../../scripts/build-pdf-font.py) 生成，经 `netlify.toml` 的 `included_files` 打进函数包。日志出现 `Font subset is missing …` 说明报告用到了子集外的字符（买家看到 `?`），需要扩子集重新生成。

### 10.6 上线/切换后的验证清单

每一项都要真做，不是假定（真实 $1 支付在验证后可在供应商后台退款，成本只剩通道手续费）：

1. 未配置支付时买入口消失、`/pricing` 文案不承诺收费；配置后买入口出现且价格与供应商一致。
2. 游客购买：真实付款 → 成功页自动出现下载 → 中文报告与英文报告各下一份，检查中文不是空框、页码正确、水印行有邮箱与订单号。
3. 找回：用购买邮箱在 `/orders` 要魔术链接 → 15 分钟内可打开订单列表并重新下载；过期链接被拒。
4. 登录购买：订单立刻出现在 `/orders`，跨设备登录仍可见。
5. 通道回退：故意把 `CREEM_API_KEY` 改错 → checkout 透明落到 Lemon Squeezy，走完一笔真实付款，且 `/admin/errors` 里能看到 Creem 的失败记录。
6. 退款：在后台退这几单 → `/orders` 状态变为已退款，旧下载链接 403 `order_refunded`。
7. 认领：用同一邮箱注册 → 走认领魔术链接 → 游客订单归入账号。
8. 越权：改 URL 里的 `reportId`（403 `token_scope`）、伪造 token（403）、用别人的 reference（只能开对应报告）。
9. 断库演练：`npm run test:outage` 期间下单 → webhook 进缓冲、成功页仍给出下载、库恢复后订单出现在 `/orders`。本地无真实卡时，用 `npm run test:pay` 覆盖签名 / 入库 / 退款 / 断库缓冲全路径（不碰真实供应商）。
10. 域名切换演练：`node scripts/failover.mjs --to=standby` → 站点仍服务、支付仍可用（记得同步 webhook URL），再 `--to=primary` 切回。

### 10.7 上线前你需要提供的凭据（缺一不可开收）

代码与本地演练不依赖这些；**正式收第一美元**需要你填齐。当前状态（以对话为准）：

| 凭据 | 状态 | 给谁 / 放哪 |
|---|---|---|
| Creem：API key、`$1` 产品 ID、webhook signing secret | **账号已注册，审核中** | 审核通过后：在 Creem 建 `$1 Report PDF` 产品；webhook URL 指到 `https://ioni.top/api/pay/webhook/creem`；密钥写入主站与备用站环境变量（`CREEM_*`） |
| Lemon Squeezy：API key、store id、variant id、webhook secret | 待注册 | 备用通道；webhook → `/api/pay/webhook/lemonsqueezy` |
| Resend：API key + `ioni.top` DNS 验证 | 待注册 | 游客魔术链接邮件；`RESEND_API_KEY` / `EMAIL_FROM` |
| 第二 Netlify 账号 PAT（`13426086861@139.com`） | 待提供 | `NETLIFY_TOKEN_STANDBY`；然后：`node scripts/create-standby-site.mjs` → `node scripts/standby-env.mjs --from=.env.standby` |
| （可选）阿里云 DNS AccessKey | 待提供 | 自动化 failover；没有则只做 Netlify 域名挪移，DNS 手工改 |

一键建备用站并灌环境：

```bash
# 1) 第二账号 PAT
NETLIFY_TOKEN_STANDBY=... node scripts/create-standby-site.mjs
# 2) 填 .env.standby（见 .env.standby.example；SITE_ROLE 由脚本强制为 reader）
NETLIFY_TOKEN_STANDBY=... NETLIFY_SITE_ID_STANDBY=... node scripts/standby-env.mjs --from=.env.standby
# 3) 触发部署后灌快照
BASE_URL=https://<standby>.netlify.app CRON_SECRET=... node scripts/snapshot-bootstrap.mjs
# 4) GitHub Actions Variables/Secrets：STANDBY_BASE_URL、NETLIFY_TOKEN_STANDBY、NETLIFY_SITE_ID_STANDBY
```

Creem 审核期间：买入口保持隐藏（未配密钥时 `paymentsEnabled()` 为 false）；本地用 `npm run test:pay` 把支付路径跑绿；审核通过当天填密钥 → 跑 §10.6 → 再切域名。
