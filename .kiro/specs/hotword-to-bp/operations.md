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
| `CRON_SECRET` | 是（启用定时） | — | 定时任务鉴权密钥，建议 32+ 位随机串 |

> 二选一：`LLM_API_KEY` 与 `LLM_API_ENDPOINTS` 至少配置其一，否则 BP 生成端点返回 503（fail-closed，不做模板回退）。

`LLM_API_ENDPOINTS` 示例（单行）：

```json
[{"name":"dashscope","base":"https://dashscope.aliyuncs.com/compatible-mode/v1","key":"sk-xxx","model":"qwen-plus"},{"name":"openai","base":"https://api.openai.com/v1","key":"sk-yyy","model":"gpt-4o-mini"}]
```

## 2. 首次部署清单

1. 在 Netlify 控制台设置上述环境变量（至少 `DATABASE_URL` + 一个 LLM 密钥 + `CRON_SECRET`）。
2. 推送 `main` 触发部署，等待完成。
3. 通过 `/api/health` 确认新版本与数据库连通：
   ```bash
   curl https://<your-site>/api/health
   # 期望: status=ok, database.connected=true, version=<最新>
   ```
4. 建表（幂等）：
   ```bash
   curl -X POST "https://<your-site>/api/db-init?secret=trendnow-seed" -H "Origin: https://<your-site>"
   ```
5. 校验 `bp_reports` / `bp_opportunities` 已存在且 schema 正确（见 §5 故障 B）。

## 3. 定时自动生成

- 实现：[netlify/functions/bp-scheduled.ts](../../../netlify/functions/bp-scheduled.ts)，`schedule('0 */6 * * *', ...)`，UTC 每 6 小时整点。
- 行为：调用 `POST /api/bp/cron`（带 `Authorization: Bearer ${CRON_SECRET}`）→ `bpService.runScheduledGeneration()`：
  1. `resetStaleGenerating()` 把超过 15 分钟仍 `generating/pending` 的记录置为 `failed`；
  2. 取所选窗口（`4h`）下搜索量第 1 的趋势；
  3. 24h 去重：同关键词已有 `completed` 则 `action=reused`，不调用 LLM；
  4. 否则生成并落库，`action=generated`。
- 手动触发（验证用）：
  ```bash
  curl -X POST "https://<your-site>/api/bp/cron" \
    -H "Authorization: Bearer $CRON_SECRET" -H "Origin: https://<your-site>"
  # -> { success:true, action:"generated"|"reused"|"skipped", reportId, keyword, status }
  ```

### 鉴权与返回码

| 场景 | HTTP |
|---|---|
| 未配置 `CRON_SECRET` | 503（定时禁用，fail-closed） |
| 缺失/错误 `Authorization` | 401 |
| 未配置 LLM 密钥 | 503 |
| 无可用趋势 | 400 |
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

## 5. 常见故障处理

### A. BP 生成返回 503
- 原因：未配置 LLM 密钥，或所有端点失败。
- 处置：检查 `LLM_API_KEY`/`LLM_API_ENDPOINTS`；查看函数日志中 `LLM_ALL_ENDPOINTS_FAILED` 末尾错误；确认供应商可用、额度充足。

### B. `bp_opportunities` 旧 schema（index 报 `column "report_id" does not exist`）
- 原因：历史遗留表结构（`plan_id/scores/roi_score`）与现版本不兼容。
- 处置（**破坏性重建，仅在两表数据可丢弃时**）：
  ```bash
  curl -X POST "https://<your-site>/api/db-init?secret=trendnow-seed&migrate=bp" -H "Origin: https://<your-site>"
  ```
  重建后 `bp_opportunities` 列应为：`id, report_id, name, description, score_market, score_roi, score_onlineability, score_feasibility, score_speed, score_moat, weighted_score, is_selected, rank, created_at`。

### C. 报告长期卡在 `generating`
- 原因：Netlify 函数 26s 超时中断了同步生成。
- 处置：下一次 cron 会自动 `resetStaleGenerating()` 置为 `failed` 并重试；也可手动调用 cron。缓解：优先用更快模型、缩短输出、依赖 24h 去重避免重复消耗。

### D. 定时任务未执行
- 检查：Netlify → Functions → `bp-scheduled` 是否存在且有调用记录；`CRON_SECRET` 是否已配置；时区为 UTC。

## 6. 成本与安全

- **成本控制**：24h 去重 + `max_tokens` 限制 + 失败不重复落库；定时频率默认 6h。
- **安全**：cron 强制 `CRON_SECRET`；所有 DB 访问参数化查询；详情页对 LLM 文本默认转义（不使用 `set:html` 渲染不可信内容）；生成端点要求登录用户（cron 除外，靠密钥鉴权）。

## 7. 变更频率（如需调整）

- 修改 [netlify/functions/bp-scheduled.ts](../../../netlify/functions/bp-scheduled.ts) 中的 cron 表达式（如 `0 */12 * * *` 改为每 12 小时）。
- 修改 [src/lib/services/bp.ts](../../../src/lib/services/bp.ts) 中 `REUSE_WINDOW_HOURS`（去重窗口）与 `resetStaleGenerating(maxAgeMinutes)`（卡死阈值）。
