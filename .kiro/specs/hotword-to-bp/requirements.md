# 需求文档

## 简介

本功能在 Trend Now 现有趋势展示能力之上，新增「**热词第一名 → 商业计划书（BP）**」能力：以排名第一的 Google 趋势热词为输入，调用大语言模型（LLM）自动完成「头脑风暴可线上化商业机会 → 六维评分 → 遴选投入产出比最高者 → 生成结构化商业计划书」，并将**全部相关信息**（来源趋势快照、候选机会及评分、选定机会、完整 BP 内容、模型与用量元数据）持久化到 Neon 数据库；同时提供站内 BP 列表页与详情页查看。

本功能严格遵循 kiro spec 工作流：需求（本文档）→ 设计（design.md）→ 任务（tasks.md）→ 实现。

## 术语表

- **BP**: 商业计划书（Business Plan），本功能生成的结构化文档
- **热词第一名 / 第一名趋势**: 在所选时间范围内按搜索量（search_volume）降序排列的第 1 条趋势记录
- **LLM**: 大语言模型，通过 OpenAI 兼容的 Chat Completions 接口调用
- **候选机会**: LLM 头脑风暴产出的可线上化商业机会
- **六维评分**: 市场规模、投入产出比（ROI）、可线上化程度、技术可行性、上市速度、护城河 6 个维度的加权评分
- **种子轮回报指标**: 逐年（第 1–5 年）投资收益率、年化收益、胜率（盈利现金退出概率）、盈亏比、期望收益倍数 EV
- **BP 报告（bp_reports）**: 存储一份生成的 BP 主记录的数据库表
- **候选机会（bp_opportunities）**: 存储某份 BP 的候选机会与评分的数据库表
- **生成状态**: BP 报告的生命周期状态，取值 pending / generating / completed / failed

## 需求

### 需求 1: 获取第一名热词

**用户故事:** 作为用户，我希望系统能准确识别当前排名第一的热词，以便基于最热的需求生成商业计划书。

#### 验收标准

1. WHEN 用户在第一名趋势上触发生成 AND 未指定关键词 THEN BP 系统 SHALL 以所选时间范围（默认 `4h`）内 `search_volume` 降序的第 1 条趋势作为输入
2. WHEN 调用方显式传入 `keyword` 或 `trendId` THEN BP 系统 SHALL 以该指定趋势作为输入而非默认第一名
3. WHEN 选定时间范围内无任何趋势数据 THEN BP 系统 SHALL 返回明确的「无可用趋势」错误而非崩溃
4. WHEN 确定第一名趋势 THEN BP 系统 SHALL 记录该趋势的快照（关键词、搜索量、增长速度、分类、时间范围、地区、排名）以保证可溯源

### 需求 2: AI 驱动的机会脑暴与遴选

**用户故事:** 作为用户，我希望系统基于热词自动头脑风暴可线上化的商业机会并选出投入产出比最高者，以便获得有理有据的方向。

#### 验收标准

1. WHEN 系统基于第一名热词发起生成 THEN BP 系统 SHALL 调用 LLM 产出至少 5 个可线上化（网站/SaaS 服务）的候选商业机会
2. WHEN LLM 产出候选机会 THEN BP 系统 SHALL 为每个机会给出六维评分（1–10）与加权总分
3. WHEN 计算加权总分 THEN BP 系统 SHALL 使用固定权重（市场规模 0.20、ROI 0.25、可线上化 0.15、技术可行性 0.15、上市速度 0.10、护城河 0.15），且权重之和为 1
4. WHEN 候选机会评分完成 THEN BP 系统 SHALL 选定加权总分最高者标记为 `isSelected`
5. WHEN 选定最高分机会 THEN BP 系统 SHALL 基于该机会生成完整的结构化 BP

### 需求 3: 结构化 BP 内容生成（公允、可溯源）

**用户故事:** 作为投资人/用户，我希望生成的 BP 含市场与财务数据，并明确给出种子轮回报指标，以便评估机会。

#### 验收标准

1. WHEN 生成 BP THEN BP 系统 SHALL 包含执行摘要、选定机会说明、市场分析、商业模式、五年财务概要等结构化字段
2. WHEN 生成 BP 的财务部分 THEN BP 系统 SHALL 给出种子轮第 1/2/3/4/5 年投资收益率（ROI）
3. WHEN 生成种子轮回报 THEN BP 系统 SHALL 给出以**现金成功退出**为口径的年化收益、胜率（盈利现金退出概率）、盈亏比、期望收益倍数 EV
4. WHEN 生成回报指标 THEN BP 系统 SHALL 在内容中区分「账面口径」与「风险调整口径」，不得以账面存活冒充现金退出
5. IF LLM 返回的内容缺少必填结构字段 THEN BP 系统 SHALL 判定为生成失败并记录错误，而非保存不完整数据

### 需求 4: LLM 调用与配置

**用户故事:** 作为系统，我需要通过可配置的 LLM 接口生成内容，以便在线上稳定运行且可切换供应商。

#### 验收标准

1. WHEN 系统调用 LLM THEN BP 系统 SHALL 使用环境变量 `LLM_API_KEY`、`LLM_API_BASE`、`LLM_MODEL` 配置 OpenAI 兼容接口
2. IF 未配置 `LLM_API_KEY` THEN BP 系统 SHALL 返回明确的配置缺失错误（HTTP 503）且不回退到模板生成
3. WHEN LLM 请求超过设定超时 THEN BP 系统 SHALL 中止该请求并最多重试 1 次
4. WHEN LLM 返回非 JSON 或不可解析内容 THEN BP 系统 SHALL 重试 1 次，仍失败则判定生成失败
5. WHEN LLM 调用成功 THEN BP 系统 SHALL 记录所用模型名称与 token 用量（若供应商返回）

### 需求 5: 数据持久化（存入数据库）

**用户故事:** 作为系统，我需要把生成过程中的所有相关信息存入数据库，以便复用、追溯与展示。

#### 验收标准

1. WHEN 生成流程开始 THEN BP 系统 SHALL 在 `bp_reports` 创建一条记录并写入趋势快照与初始状态
2. WHEN BP 生成成功 THEN BP 系统 SHALL 将完整结构化内容写入 `bp_reports.content_json` 并将状态置为 `completed`
3. WHEN 候选机会产出 THEN BP 系统 SHALL 将每个候选机会及其六维评分写入 `bp_opportunities` 并以 `report_id` 关联
4. WHEN 执行任何数据库写入 THEN BP 系统 SHALL 使用参数化查询以防止 SQL 注入
5. WHEN 需要新表 THEN BP 系统 SHALL 仅新建 `bp_reports`、`bp_opportunities` 表而不修改现有表结构
6. WHEN 生成失败 THEN BP 系统 SHALL 将状态置为 `failed` 并写入 `error` 字段

### 需求 6: 触发权限与去重

**用户故事:** 作为运营者，我希望生成动作受控且不重复消耗，以便控制成本。

#### 验收标准

1. WHEN 未登录游客请求生成 THEN BP 系统 SHALL 拒绝并返回需登录提示（HTTP 401）
2. WHEN 已登录用户请求生成 THEN BP 系统 SHALL 允许触发并将 `user_id` 关联到报告
3. WHEN 某关键词近期已存在 `completed` 的 BP THEN BP 系统 SHALL 直接复用该报告而不再次调用 LLM
4. WHEN 游客访问 BP 列表或详情 THEN BP 系统 SHALL 允许只读查看已生成的 BP

### 需求 7: BP 查看（列表与详情）

**用户故事:** 作为用户，我希望在站内查看历史与单份 BP，以便阅读和分享。

#### 验收标准

1. WHEN 用户访问 BP 列表页 THEN BP 系统 SHALL 分页展示已生成的 BP（关键词、标题、状态、时间）
2. WHEN 用户访问某份 BP 详情页 THEN BP 系统 SHALL 渲染执行摘要、评分矩阵、选定机会、市场与财务、种子轮回报指标
3. WHEN BP 处于 `generating` 状态 THEN 详情页 SHALL 显示生成中状态并轮询直到 `completed` 或 `failed`
4. WHEN 请求不存在的 BP 详情 THEN BP 系统 SHALL 返回 404 并提供返回入口
5. WHEN 渲染 BP 详情 THEN BP 系统 SHALL 沿用全站视觉风格并支持中英文文案

### 需求 8: 错误处理与用户提示

**用户故事:** 作为用户，当生成出错时我希望收到清晰提示，以便了解原因。

#### 验收标准

1. WHEN 生成因 LLM 未配置而失败 THEN BP 系统 SHALL 提示「AI 服务未配置」类信息
2. WHEN 生成因超时或模型错误失败 THEN BP 系统 SHALL 提示「生成失败，请稍后重试」并保留失败记录
3. WHEN 数据库查询失败 THEN BP 系统 SHALL 返回友好错误而非空白或堆栈
4. WHEN 入参非法（无关键词且无趋势数据） THEN BP 系统 SHALL 返回 400 与具体原因

### 需求 9: 安全与性能

**用户故事:** 作为系统，我需要保证生成接口安全可控、响应可预期。

#### 验收标准

1. WHEN 处理生成 POST 请求 THEN BP 系统 SHALL 通过 Astro CSRF Origin 校验（同源 Origin 头）
2. WHEN 写入或读取数据库 THEN BP 系统 SHALL 全部使用参数化查询
3. WHEN 渲染来自 LLM 的文本到页面 THEN BP 系统 SHALL 进行转义/清理以防止 XSS
4. WHEN 控制单次生成成本 THEN BP 系统 SHALL 限制 LLM 输出规模并优先复用已生成结果（去重）
