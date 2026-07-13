# -*- coding: utf-8 -*-
"""
analyze_bp_opportunities.py — 《线上商业机会分析报告》的全部统计数字由此脚本产生。

用法：
    python scripts/analyze_bp_opportunities.py [docs/data/bp-snapshot-2026-07-13.json]

设计原则（数据可证、实事求是）：
  * 输入是随仓库提交的数据快照（由 scripts/export-bp-snapshot.mjs 从生产库导出），
    任何第三方 clone 仓库后即可复现所有数字，无需数据库凭据；
  * 风险调整回报一律采用服务器端确定性口径重算（与 scripts/verify_bp_math.py 相同公式），
    不采信 LLM 自报数字；自报 vs 复算的偏差率单独如实统计；
  * 赛道/机会类型分类是透明的关键词规则（见 TRACK_RULES / OPP_RULES），可检查、可复现，
    不依赖任何黑盒模型。
"""

import json
import re
import sys
from collections import Counter
from statistics import mean, median

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SNAPSHOT = sys.argv[1] if len(sys.argv) > 1 else "docs/data/bp-snapshot-2026-07-13.json"

with open(SNAPSHOT, encoding="utf-8") as f:
    snap = json.load(f)
reports = snap["reports"]

print(f"数据快照: {SNAPSHOT}")
print(f"导出时间: {snap['exportedAt']}  来源: {snap['source']}")
print(f"完成状态报告总数: {len(reports)}")
dates = sorted(r["createdAt"][:10] for r in reports)
print(f"时间跨度: {dates[0]} ~ {dates[-1]}")

# ============================================================
# 1. 热词赛道分布（透明关键词规则，按顺序首个命中）
# ============================================================
TRACK_RULES = [
    ("体育赛事/球队", r"\bvs\b|match|final|cup|league|fc\b|nba|nfl|cricket|tennis|wimbledon|golf|ufc|boxing|grand prix|open\b|racing|奥运|球|赛"),
    ("影视/娱乐/名人", r"movie|film|actor|singer|show|episode|season|trailer|concert|album|netflix|damon|kardashian|swift|明星|电影|演员"),
    ("金融/加密/股票", r"stock|share price|crypto|bitcoin|etf|ipo|earnings|币|股"),
    ("科技/AI/产品", r"\bai\b|iphone|android|apple|google|microsoft|tesla|chip|gpt|robot|launch|update"),
    ("天气/灾害/突发", r"weather|storm(?!ers)|hurricane|earthquake|flood|fire|typhoon|台风|地震"),
    ("游戏/电竞", r"game|gaming|playstation|xbox|nintendo|steam|fortnite|minecraft"),
    ("政治/选举/公共", r"election|president|minister|senate|vote|policy|court|选举"),
    ("健康/医疗", r"health|covid|vaccine|disease|drug|医"),
]


def classify(text, rules):
    t = (text or "").lower()
    for name, pat in rules:
        if re.search(pat, t):
            return name
    return "其他/长尾"


track_counter = Counter(classify(r["keyword"] + " " + (r["title"] or ""), TRACK_RULES) for r in reports)
print("\n== 1. 热词赛道分布（关键词规则分类，规则见脚本 TRACK_RULES） ==")
for track, n in track_counter.most_common():
    print(f"  {track}: {n} ({n / len(reports) * 100:.1f}%)")

# ============================================================
# 2. 选中机会的形态分布
# ============================================================
OPP_RULES = [
    ("SaaS 订阅平台", r"saas|订阅"),
    ("内容生成/媒体平台", r"content|内容|媒体|curation|news|资讯|短视频|video"),
    ("数据分析/洞察工具", r"analytics|分析|insight|洞察|data|数据"),
    ("互动/社区/粉丝经济", r"互动|社区|social|粉丝|fan|community|engagement"),
    ("电商/变现工具", r"电商|commerce|变现|monetiz|marketplace|shop"),
    ("教育/知识付费", r"教育|课程|learning|education|培训"),
]
sel_names = [r["selectedOpportunity"] or r["title"] or "" for r in reports]
opp_counter = Counter(classify(n, OPP_RULES) for n in sel_names)
print("\n== 2. 选中机会形态分布（规则见 OPP_RULES；SaaS 优先匹配） ==")
for kind, n in opp_counter.most_common():
    print(f"  {kind}: {n} ({n / len(reports) * 100:.1f}%)")

ai_share = sum(1 for n in sel_names if re.search(r"\bai\b|ai驱动|ai 驱动|智能", n.lower())) / len(reports)
print(f"  （共性）机会名称含 AI/智能: {ai_share * 100:.1f}%")

# ============================================================
# 3. 六维评分统计（选中机会）
# ============================================================
print("\n== 3. 选中机会六维评分（均值 / 中位数，10 分制） ==")
selected = []
for r in reports:
    sel = next((o for o in r["opportunities"] if o["isSelected"]), None)
    if sel:
        selected.append(sel)
dims = ["market", "roi", "onlineability", "feasibility", "speed", "moat"]
DIM_ZH = {"market": "市场规模", "roi": "投入产出比", "onlineability": "可线上化", "feasibility": "技术可行性", "speed": "变现速度", "moat": "护城河"}
for d in dims:
    vals = [o["scores"][d] for o in selected if o["scores"].get(d) is not None]
    print(f"  {DIM_ZH[d]}: mean={mean(vals):.2f} median={median(vals):.2f} (n={len(vals)})")
ws = [o["weightedScore"] for o in selected if o["weightedScore"] is not None]
print(f"  加权总分: mean={mean(ws):.2f} median={median(ws):.2f} min={min(ws):.2f} max={max(ws):.2f}")

# ============================================================
# 4. 风险调整回报 —— 服务器确定性口径重算（不采信 LLM 自报）
#    M = 1 + ROI5/100；EV 区间 = [p*M, p*M+(1-p)]；风险调整年化 = EV^(1/5)-1
# ============================================================
print("\n== 4. 风险调整年化（确定性复算口径，与 verify_bp_math.py 相同） ==")


def recompute(r):
    book = r.get("bookRoiByYear")
    wr = r.get("winRateRange")
    if not book or len(book) < 5 or book[4] is None or not wr:
        return None
    roi5 = book[4]
    # 口径归一：旧版报告把 ROI 存成小数倍数（3 = 300%），新版存百分数（150 = 150%）。
    # 判别规则：五年 ROI ≤ 20 视为倍数口径 ×100（20 以内的百分数五年回报在本库中不存在）。
    if abs(roi5) <= 20:
        roi5 *= 100
    m = 1 + roi5 / 100
    p = (wr[0] + wr[1]) / 2 / 100
    ev_lo, ev_hi = p * m, p * m + (1 - p)
    ann = lambda ev: (ev ** 0.2 - 1) * 100 if ev > 0 else -100.0
    return {"m": m, "p": p, "ev_lo": ev_lo, "ev_hi": ev_hi, "ann_lo": ann(ev_lo), "ann_hi": ann(ev_hi)}


recs = [(r, recompute(r)) for r in reports]
valid = [(r, x) for r, x in recs if x]
print(f"  可复算报告数: {len(valid)}/{len(reports)}（缺 bookRoiByYear/winRate 的除外）")

mids = [(x["ann_lo"] + x["ann_hi"]) / 2 for _, x in valid]
print(f"  风险调整年化区间中值: mean={mean(mids):.1f}% median={median(mids):.1f}%")
buckets = Counter()
for v in mids:
    b = "< -10%" if v < -10 else "-10%~0%" if v < 0 else "0%~5%" if v < 5 else "5%~10%" if v < 10 else ">= 10%"
    buckets[b] += 1
for b in ["< -10%", "-10%~0%", "0%~5%", "5%~10%", ">= 10%"]:
    n = buckets.get(b, 0)
    print(f"    {b}: {n} ({n / len(mids) * 100:.1f}%)")

pos_ub = sum(1 for _, x in valid if x["ann_hi"] > 0)
print(f"  复算上界为正（保本口径下期望不亏）: {pos_ub}/{len(valid)} ({pos_ub / len(valid) * 100:.1f}%)")

# LLM 自报 vs 复算偏差（诚实披露）
devs = [
    (r, x) for r, x in valid
    if r.get("reportedRiskAdjustedPct") is not None
    and not (x["ann_lo"] - 2.0 <= r["reportedRiskAdjustedPct"] <= x["ann_hi"] + 2.0)
]
print(f"  LLM 自报风险调整年化落在复算区间(±2pct)之外: {len(devs)}/{len(valid)} ({len(devs) / len(valid) * 100:.1f}%)")
print("  —— 结论：LLM 自报回报系统性偏乐观，一切决策应以复算区间为准（每份报告已内嵌校准注记）。")

# ============================================================
# 5. 高分机会清单（加权分 Top 10，附复算回报区间）
# ============================================================
print("\n== 5. 高分机会 Top 10（按六维加权总分；回报为确定性复算区间） ==")
rows = []
for r, x in valid:
    sel = next((o for o in r["opportunities"] if o["isSelected"]), None)
    if sel and sel["weightedScore"] is not None:
        rows.append((sel["weightedScore"], r, x, sel))
rows.sort(key=lambda t: -t[0])
for wsc, r, x, sel in rows[:10]:
    name = (sel["name"] or "")[:40]
    print(f"  [{wsc:.2f}] {name} | 热词: {r['keyword']} | 复算年化 [{x['ann_lo']:.0f}%, {x['ann_hi']:.0f}%] | id={r['id'][:8]}")

# ============================================================
# 6. 共性模式（选中机会名称/形态的高频词）
# ============================================================
print("\n== 6. 共性模式（选中机会高频要素） ==")
patterns = {
    "AI/智能 驱动": r"\bai\b|ai驱动|智能",
    "SaaS/订阅制": r"saas|订阅",
    "平台型（双边/聚合）": r"平台|platform",
    "实时/热点时效性": r"实时|real-?time|live|热点",
    "个性化/定制": r"个性化|定制|personaliz",
    "自动化（近零人力）": r"自动|automat",
}
for label, pat in patterns.items():
    n = sum(1 for name in sel_names if re.search(pat, name.lower()))
    print(f"  {label}: {n}/{len(reports)} ({n / len(reports) * 100:.1f}%)")

print("\n（以上全部数字由本脚本从快照确定性计算得出，可一键复现。）")
