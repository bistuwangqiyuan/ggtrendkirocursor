# -*- coding: utf-8 -*-
"""
verify_subdivfinder_math.py — SubDivFinder BP 全部数字的独立复算 + 修正后模型重建。

用法：
    python scripts/verify_subdivfinder_math.py

复算对象：docs/data/subdivfinder-bp-original.md（BP 原文存档）
事实输入：docs/data/subdivfinder-sources.json（每项均有出处与抓取日期）

两部分输出：
  Part A — 按 BP 自己的假设复算其算术是否自洽（PASS / DEVIATION）；
  Part B — 用核实后的事实输入重建市场规模与单位经济（悲观/基准/乐观三情景区间）。

退出码：0 = 审计完成（DEVIATION 是对被审计 BP 的发现，不是本脚本的失败；
偏差数在汇总行打印，报告正文引用的正是这些发现）。异常中断才返回非零。
"""

import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

with open("docs/data/subdivfinder-sources.json", encoding="utf-8") as f:
    SRC = json.load(f)
CI = SRC["correctedInputs"]

results = []


def check(mid, name, computed, stated, tol=0.005, unit=""):
    ok = (abs(computed - stated) <= tol) if abs(stated) < 1e-9 else (abs(computed - stated) / abs(stated) <= tol)
    tag = "PASS" if ok else "DEVIATION"
    results.append(ok)
    print(f"  [{tag}] {mid} {name}: 复算 {computed:,.4g}{unit} | BP 声称 {stated:,.4g}{unit}")
    return ok


print("=" * 72)
print("Part A — BP 自身算术自洽性复算（用 BP 自己的假设）")
print("=" * 72)

# M1: TAM = 210万 × 15% × $120
print("\nM1. 市场规模算式（前提已被 C1 证伪，此处只验算术）")
check("M1", "TAM = 2.1M×15%×$120", 2.1e6 * 0.15 * 120 / 1e6, 37.8, unit="M$")

# M2: CAC = CPC $0.8 × 3.2 次点击
print("\nM2. CAC 算式（BP 声称 $2.1，但其自己的算式给出：）")
check("M2", "CAC = $0.8×3.2", 0.8 * 3.2, 2.1, tol=0.02, unit="$")

# M3: LTV = $9.99 × 12
print("\nM3. LTV 算式（$9.99×12 算术本身：）")
check("M3a", "LTV = $9.99×12", 9.99 * 12, 119.88, unit="$")
# 口径矛盾：若真按其引用的 3.5%/月流失率，LTV 应为 P/churn
ltv_churn = 9.99 / 0.035
print(f"  [口径矛盾] M3b BP 同时引用 churn 3.5%/月：该口径下 LTV = $9.99/0.035 = ${ltv_churn:,.2f}（平均生命周期 {1/0.035:.1f} 个月），")
print(f"             与其声称的 $119.88（恰为 12 个月收入）不一致——两种口径混用。")

# M4: LTV/CAC = 57.1
print("\nM4. LTV/CAC")
check("M4a", "LTV/CAC = 119.88/2.1", 119.88 / 2.1, 57.1, tol=0.01)
print(f"  [推论] M4b 若用其自己算式的 CAC $2.56：LTV/CAC = {119.88 / 2.56:.1f}；健康基准为 3~5x，57x 本身即为强烈的输入失真信号。")

# M5: 评分说明的用户量推导："5000+月搜索量对应约6万年活跃用户（按CTR 2%×转化率15%×12月）"
print("\nM5. 评分卡用户量推导（5000/月 × CTR2% × 转化15% × 12月）")
derived_users = 5000 * 0.02 * 0.15 * 12
check("M5", "年活跃用户", derived_users, 60000, tol=0.05)
need_search = 60000 / (0.02 * 0.15 * 12)
print(f"  [推论] 按该链条要得到 6 万年活跃用户，需月搜索量 {need_search:,.0f}（≈167 万），是声称量的 333 倍。")

# M6: Roadmap 自洽性
print("\nM6. Roadmap 一致性检验")
uv_3mo = 5000 * 3
implied_conv = 10000 / uv_3mo
print(f"  [口径矛盾] 0-3 月目标：SEO 5,000 UV/月 与 注册用户破 10,000 —— 3 个月累计 {uv_3mo:,.0f} UV，")
print(f"             隐含访客→注册转化率 {implied_conv:.0%}，而行业常见区间为 2%~5%（BP 未提供其它流量来源）。")
paid_needed = 1.2e6 / 99
signups_needed = paid_needed / CI["signupToPaidBpRoadmap"]
print(f"  [口径矛盾] 3-12 月目标 ARR $1.2M：按年费 $99 需 {paid_needed:,.0f} 名付费用户；")
print(f"             按其自称的付费转化率 4.3%，需注册用户 {signups_needed:,.0f} —— 是 0-3 月目标(1 万)的 {signups_needed/10000:.0f} 倍，")
print(f"             中间无任何获客量级跳变的机制说明。")

# ============================================================
print("\n" + "=" * 72)
print("Part B — 修正后模型（输入取自 subdivfinder-sources.json，均有出处）")
print("=" * 72)

# B1: 修正后市场规模
buyers = (CI["existingHomeSales2025"] + CI["newHomeSales2025"]) * CI["firstTimeBuyerShare2025"]
print(f"\nB1. 修正后首购族基数（NAR 2025：占比 21%；成屋 406.1 万 + 新房 67.9 万）")
print(f"    年首购族 ≈ {buyers:,.0f} 人（BP 声称 210 万，高估 {2.1e6/buyers:.1f} 倍）")
tam_corrected = buyers * CI["penetrationRateAssumption"] * CI["arpuPerYear"]
print(f"    修正 TAM = {buyers:,.0f} × 15% × $120 = ${tam_corrected/1e6:,.1f}M/年（BP 声称 $37.8M，高估 {37.8e6/tam_corrected:.1f} 倍）")
print(f"    注：15% 渗透率沿用 BP 假设（其标注出处'NAR 2023 Tech Adoption Report'未能核实），实际很可能更低。")

# B2: 修正后单位经济（付费获客）
print(f"\nB2. 修正后付费获客单位经济（CPC 取 2026 房地产行业中位数 ${CI['realEstateCpc2026']}）")
print(f"    转化链：访客→注册 2%~5%（假设区间）× 注册→付费 4.3%（BP 自称的行业基准）")
lo_conv, hi_conv = CI["visitToSignupRange"]
s2p = CI["signupToPaidBpRoadmap"]
scenarios = [("悲观", lo_conv), ("基准", (lo_conv + hi_conv) / 2), ("乐观", hi_conv)]
ltv = CI["monthlyPrice"] / CI["monthlyChurnAssumption"]
print(f"    LTV（churn 口径统一为 3.5%/月）= $9.99/0.035 = ${ltv:,.0f}")
for name, v2s in scenarios:
    cac = CI["realEstateCpc2026"] / (v2s * s2p)
    ratio = ltv / cac
    print(f"    [{name}] 访客→付费 {v2s*s2p:.2%} → CAC ≈ ${cac:,.0f} → LTV/CAC ≈ {ratio:.2f}")
print(f"    结论：三情景 LTV/CAC 全部 << 1（健康线 3），付费广告获客对 $9.99/月订阅不成立；")
print(f"    该机会若存在，唯一可能的获客路径是程序化 SEO 的自然流量（边际获客成本趋零）。")

# B3: 需求侧结构约束
print(f"\nB3. 需求侧结构约束（决定订阅制天花板）")
window_months = 6
print(f"    购房决策窗口通常仅数月（本模型取 {window_months} 个月），窗口结束即退订——")
print(f"    订阅生命周期存在结构性上限，与 28.6 个月的 churn 口径 LTV 不相容。")
ltv_window = CI["monthlyPrice"] * window_months
print(f"    按 {window_months} 个月窗口口径：LTV ≈ ${ltv_window:,.0f}，进一步压低上表比值 {ltv/ltv_window:.1f} 倍。")

# 汇总
total, passed = len(results), sum(results)
print("\n" + "=" * 72)
print(f"汇总：Part A 算术自洽性 {passed}/{total} PASS，{total-passed} 项 DEVIATION（审计发现，详见报告第 3 节）")
print("（Part B 为修正后重建，不计入 PASS/FAIL；结论见 docs/SUBDIVFINDER_OPPORTUNITY_ANALYSIS.md）")
sys.exit(0)
