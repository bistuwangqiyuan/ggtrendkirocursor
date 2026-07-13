# -*- coding: utf-8 -*-
"""
verify_deck_math.py — 独立复现线下投资人商业计划书（bp/business-plan.html）的全部核心数字。

用法：
    python scripts/verify_deck_math.py

原则（实事求是、数据可证）：
  * 只用 BP 中明示的输入假设（估值路径、稀释、三情景概率与倍数），
    以确定性公式复算每一个对外展示的数字；
  * 每项打印 [PASS] 或 [DEVIATION]，偏差超出容差绝不掩饰；
  * 退出码：全部 PASS → 0；存在 DEVIATION → 1（供 CI 使用）。

BP 数字索引（bp/business-plan.html 行号，2026-07 版）：
  账面 ROI/MOIC 表        L943-955   风险调整三情景          L967-976
  核心回报指标            L986-1003  逐年风险调整            L1010-1020
  敏感性二维表            L1022-1031 现金流量表              L899-909
"""

import sys

# Windows GBK console cannot print ¥ etc.; force UTF-8 so output is identical everywhere.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PASS, DEV = "PASS", "DEVIATION"
results = []


def check(name, computed, stated, tol=0.005, unit=""):
    """tol 是相对容差（对 stated≈0 用绝对容差）。"""
    if abs(stated) > 1e-9:
        ok = abs(computed - stated) / abs(stated) <= tol
    else:
        ok = abs(computed - stated) <= tol
    tag = PASS if ok else DEV
    results.append(tag == PASS)
    print(f"  [{tag}] {name}: 复算 {computed:,.4g}{unit} | BP 声称 {stated:,.4g}{unit}")
    return ok


# ============================================================
# 1. 种子轮条款与稀释路径（L931-941）
# ============================================================
print("\n== 1. 稀释路径 ==")
SEED_INVEST = 800.0          # 万元
POST_MONEY = 4000.0          # 投后估值（万元）
stake0 = SEED_INVEST / POST_MONEY               # 20%
stake_after_A = stake0 * (1 - 0.20)             # A 轮稀释 −20%
stake_after_B = stake_after_A * (1 - 0.15)      # B 轮稀释 −15%
check("种子初始持股", stake0 * 100, 20.0, unit="%")
check("A 轮后持股", stake_after_A * 100, 16.0, unit="%")
check("B 轮后（退出时）净持股", stake_after_B * 100, 13.6, unit="%")

# ============================================================
# 2. 账面口径：逐年估值 × 净持股 / 成本（L943-955）
# ============================================================
print("\n== 2. 账面 MOIC / ROI（纸面） ==")
# (年度, 公司估值/万元, 当年种子持股, BP 声称 MOIC, BP 声称账面 ROI %)
book_rows = [
    ("Y0", 4000.0, stake0, 1.0, 0.0),
    ("Y1", 6000.0, stake0, 1.5, 50.0),
    ("Y2", 12000.0, stake_after_A, 2.4, 140.0),
    ("Y3", 24000.0, stake_after_A, 4.8, 380.0),
    ("Y4", 35000.0, stake_after_B, 5.95, 495.0),
    ("Y5", 45000.0, stake_after_B, 7.65, 665.0),
]
book_moic = {}
for year, valuation, stake, moic_stated, roi_stated in book_rows:
    moic = valuation * stake / SEED_INVEST
    book_moic[year] = moic
    check(f"{year} 账面 MOIC", moic, moic_stated)
    check(f"{year} 账面 ROI", (moic - 1) * 100, roi_stated, tol=0.01, unit="%")

book_annualized = book_moic["Y5"] ** (1 / 5) - 1
check("账面年化（5年）≈50%", book_annualized * 100, 50.0, tol=0.01, unit="%")

# ============================================================
# 3. 风险调整口径：现金退出三情景（L967-984）
# ============================================================
print("\n== 3. 现金退出三情景与 EV ==")
scenarios = [  # (名称, 概率, 现金 MOIC)
    ("失败/清算贱卖", 0.72, 0.1),
    ("一般退出", 0.20, 2.5),
    ("优异退出", 0.08, 10.0),
]
prob_sum = sum(p for _, p, _ in scenarios)
check("三情景概率之和 = 1", prob_sum, 1.0)

ev = sum(p * m for _, p, m in scenarios)
check("期望现金回报 EV (MOIC)", ev, 1.37, tol=0.01)
for name, p, m in scenarios:
    stated_cash = {"失败/清算贱卖": 80.0, "一般退出": 2000.0, "优异退出": 8000.0}[name]
    check(f"{name} 种子现金回报（万元）", m * SEED_INVEST, stated_cash)
check("EV 加权现金回报 ≈ ¥1,098 万", ev * SEED_INVEST, 1098.0, tol=0.005)

win_rate = sum(p for _, p, m in scenarios if m > 1)
check("胜率（盈利现金退出概率）", win_rate * 100, 28.0, unit="%")

# ============================================================
# 4. 核心回报指标（L986-1003）
# ============================================================
print("\n== 4. 核心回报指标 ==")
avg_win = sum(p * m for _, p, m in scenarios if m > 1) / win_rate
check("平均盈利倍数（条件于成功）", avg_win, 4.64, tol=0.005)

LOSS_RECOVERY = 0.1
pl_ratio = (avg_win - 1) / (1 - LOSS_RECOVERY)
check("盈亏比 ≈ 4.0:1", pl_ratio, 4.0, tol=0.02)

cond_annualized = avg_win ** (1 / 5) - 1
check("成功退出条件年化（5年）≈36%", cond_annualized * 100, 36.0, tol=0.01, unit="%")

risk_adj_annualized = ev ** (1 / 5) - 1
check("风险调整年化（5年）≈6.5%", risk_adj_annualized * 100, 6.5, tol=0.01, unit="%")
check("风险调整年化（6年口径）≈5.4%", (ev ** (1 / 6) - 1) * 100, 5.4, tol=0.01, unit="%")

# ============================================================
# 5. 逐年风险调整期望（L1010-1020）
#    公式：胜率 28% × 当年账面 MOIC + 失败概率 72% × 清算回收 0.1×
# ============================================================
print("\n== 5. 逐年风险调整期望 MOIC / ROI ==")
yearly_stated = {  # 年: (期望 MOIC, 期望 ROI %)
    "Y1": (0.49, -51), "Y2": (0.74, -26), "Y3": (1.42, 42), "Y4": (1.74, 74), "Y5": (2.21, 121),
}
for year, (moic_stated, roi_stated) in yearly_stated.items():
    exp_moic = win_rate * book_moic[year] + (1 - win_rate) * LOSS_RECOVERY
    check(f"{year} 风险调整期望 MOIC", exp_moic, moic_stated, tol=0.01)
    check(f"{year} 风险调整期望 ROI", (exp_moic - 1) * 100, roi_stated, tol=0.02, unit="%")

# ============================================================
# 6. 敏感性二维表（L1022-1031）
#    方法论（BP 原文）：行=胜率 p，列=优异退出倍数 X；
#    失败回收 0.1×、一般退出 2.5×、一般:优异概率比 ≈ 2.5:1 不变。
#    ⇒ p_一般 = p×2.5/3.5, p_优异 = p×1/3.5, EV = (1-p)×0.1 + p_一般×2.5 + p_优异×X
# ============================================================
print("\n== 6. 敏感性二维表（按 BP 声明的方法论复算） ==")
# 注：2026-07-13 复盘发现旧版 BP 此表 5 个非基准单元格与其声明的方法论不符
# （复算偏差 1.5%~8%），已按复算值修正 HTML；基准行三格原本就一致。
sens_stated = {  # (胜率, 优异倍数): BP 表格值
    (0.20, 8): 0.89, (0.20, 10): 1.01, (0.20, 13): 1.18,
    (0.28, 8): 1.21, (0.28, 10): 1.37, (0.28, 13): 1.62,
    (0.35, 8): 1.49, (0.35, 10): 1.69, (0.35, 13): 1.99,
}
for (p, x), stated in sens_stated.items():
    p_ord = p * 2.5 / 3.5
    p_exc = p * 1.0 / 3.5
    ev_cell = (1 - p) * LOSS_RECOVERY + p_ord * 2.5 + p_exc * x
    check(f"敏感性 EV（胜率{p:.0%} × 优异{x}×）", ev_cell, stated, tol=0.015)

# ============================================================
# 7. 现金流量勾稽（L899-909）
# ============================================================
print("\n== 7. 现金流量表勾稽 ==")
opening = [800, 394, 3765, 3212, 18245]
op_cf = [-406, -629, -553, 33, 1535]
financing = [0, 4000, 0, 15000, 0]
closing_stated = [394, 3765, 3212, 18245, 19780]
for i in range(5):
    closing = opening[i] + op_cf[i] + financing[i]
    check(f"Y{i+1} 期末现金余额", closing, closing_stated[i])
    if i < 4:
        check(f"Y{i+2} 期初 = Y{i+1} 期末（勾稽）", opening[i + 1], closing_stated[i])
cum_burn_y1_3 = -sum(op_cf[:3])
check("Y1–Y3 累计经营净流出 ≈ ¥1,588 万", cum_burn_y1_3, 1588.0)

# ============================================================
# 8. 退出估值倍数（L867-873）
# ============================================================
print("\n== 8. 退出估值倍数 ==")
check("基准退出倍数 ≈ 6×（¥4.5亿 / ¥7,380万）", 45000 / 7380, 6.0, tol=0.02)
check("乐观退出倍数 ≈ 7×（¥8亿 / ¥1.2亿）", 80000 / 12000, 7.0, tol=0.05)

# ============================================================
# 汇总
# ============================================================
total = len(results)
passed = sum(results)
print(f"\n=== 汇总: {passed}/{total} PASS, {total - passed} DEVIATION ===")
if passed < total:
    print("存在偏差项：BP 展示值与按其声明方法论的复算值不一致，应以复算口径审慎解读（或修正 BP 展示值）。")
sys.exit(0 if passed == total else 1)
