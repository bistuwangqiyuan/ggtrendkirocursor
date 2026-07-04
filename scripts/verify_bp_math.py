#!/usr/bin/env python3
"""Independently recompute the seed-round return metrics of a generated BP.

Reproduces (in plain Python, no dependencies) exactly the deterministic basis
the server uses in src/lib/services/bp.ts (recomputeSeedReturn):

    book multiple M       = 1 + bookRoiByYear[4] / 100      # year-5 cumulative book ROI
    annualized book       = M ** (1/5) - 1                   # point value
    EV MOIC interval      = [p*M, p*M + (1-p)]               # p = mid win rate (cash-exit
                            # probability); lower bound = total loss on the losing branch,
                            # upper bound = principal recovered
    risk-adjusted annual. = [EV_lo ** (1/5) - 1, EV_hi ** (1/5) - 1]

Usage:
    # From the live API (default site):
    python scripts/verify_bp_math.py --id <report-uuid>
    python scripts/verify_bp_math.py --id <report-uuid> --base https://ggtrendkirocursor.netlify.app

    # From a saved JSON file (either the API response or the bare contentJson):
    python scripts/verify_bp_math.py --file report.json

Exit code 0 = all reported metrics within tolerance of the recomputed
value/interval; 1 = at least one deviation (matches the server's
calibration-note thresholds); 2 = input error.
"""

import argparse
import json
import re
import sys
import urllib.request

DEFAULT_BASE = "https://ggtrendkirocursor.netlify.app"

# Must match SEED_RECOMPUTE_TOLERANCE in src/lib/services/bp.ts.
TOLERANCE = {"annualized_pct": 5.0, "moic": 0.1, "risk_adjusted_pct": 2.0}


def parse_first_signed_number(s):
    """'约6.5%' -> 6.5; '-12%（悲观）' -> -12.0; None when absent."""
    if not isinstance(s, str):
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


def parse_win_rate_range(s):
    """'约8%-12%' -> (8.0, 12.0, 10.0); '10%' -> (10.0, 10.0, 10.0)."""
    if not isinstance(s, str):
        return None
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", s)]
    if not nums:
        return None
    lo, hi = min(nums), max(nums)
    return lo, hi, (lo + hi) / 2


def annualize_pct(ev):
    return (ev ** 0.2 - 1) * 100.0 if ev > 0 else -100.0


def recompute(seed):
    roi_by_year = seed.get("bookRoiByYear")
    if not isinstance(roi_by_year, list) or len(roi_by_year) < 5:
        raise ValueError("seedReturn.bookRoiByYear must have 5 yearly values")
    roi5 = float(roi_by_year[4])
    rng = parse_win_rate_range(seed.get("winRate"))
    if rng is None:
        raise ValueError("seedReturn.winRate has no parsable percentage")
    _, _, p_mid = rng

    m = 1 + roi5 / 100.0
    if m <= 0:
        raise ValueError(f"book multiple must be positive, got {m}")
    p = p_mid / 100.0
    ev_lo = p * m
    ev_hi = p * m + (1 - p)

    return {
        "book_multiple": m,
        "annualized_book_pct": (m ** 0.2 - 1) * 100.0,
        "win_rate_mid_pct": p_mid,
        "ev_moic_lo": ev_lo,
        "ev_moic_hi": ev_hi,
        "risk_adjusted_lo_pct": annualize_pct(ev_lo),
        "risk_adjusted_hi_pct": annualize_pct(ev_hi),
    }


def extract_seed(payload):
    """Accept the API response, a report object, or a bare contentJson."""
    node = payload
    if isinstance(node, dict) and "data" in node and isinstance(node["data"], dict):
        node = node["data"]
    if isinstance(node, dict) and "contentJson" in node and isinstance(node["contentJson"], dict):
        node = node["contentJson"]
    if isinstance(node, dict) and "seedReturn" in node:
        return node["seedReturn"]
    raise ValueError("could not locate seedReturn in the input JSON")


def verdict_point(reported, calc, tol):
    if reported is None:
        return "info"
    return "OK" if abs(reported - calc) <= tol else "DEVIATION"


def verdict_interval(reported, lo, hi, tol):
    if reported is None:
        return "info"
    return "OK" if (lo - tol) <= reported <= (hi + tol) else "DEVIATION"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--id", help="BP report UUID (fetched from the live API)")
    src.add_argument("--file", help="Path to a JSON file containing the report")
    ap.add_argument("--base", default=DEFAULT_BASE, help=f"Site base URL (default {DEFAULT_BASE})")
    args = ap.parse_args()

    try:
        if args.id:
            url = f"{args.base.rstrip('/')}/api/bp/{args.id}"
            with urllib.request.urlopen(url, timeout=30) as res:
                payload = json.load(res)
        else:
            with open(args.file, "r", encoding="utf-8") as f:
                payload = json.load(f)
        seed = extract_seed(payload)
        rc = recompute(seed)
    except Exception as e:  # noqa: BLE001 - CLI surface, report and exit
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    rep_annualized = parse_first_signed_number(str(seed.get("annualizedBook", "")))
    rep_moic = parse_first_signed_number(str(seed.get("expectedValueMOIC", "")))
    rep_risk_adj = parse_first_signed_number(str(seed.get("riskAdjustedAnnualized", "")))

    rows = [
        ("book multiple (M)", None, f"{rc['book_multiple']:.2f}x", "info"),
        ("win rate (mid)", None, f"{rc['win_rate_mid_pct']:.1f}%", "info"),
        (
            "annualized book",
            f"{rep_annualized:.2f}%" if rep_annualized is not None else "—",
            f"{rc['annualized_book_pct']:.2f}% (±{TOLERANCE['annualized_pct']})",
            verdict_point(rep_annualized, rc["annualized_book_pct"], TOLERANCE["annualized_pct"]),
        ),
        (
            "expected value MOIC",
            f"{rep_moic:.2f}x" if rep_moic is not None else "—",
            f"[{rc['ev_moic_lo']:.2f}, {rc['ev_moic_hi']:.2f}]x (±{TOLERANCE['moic']})",
            verdict_interval(rep_moic, rc["ev_moic_lo"], rc["ev_moic_hi"], TOLERANCE["moic"]),
        ),
        (
            "risk-adjusted annualized",
            f"{rep_risk_adj:.2f}%" if rep_risk_adj is not None else "—",
            f"[{rc['risk_adjusted_lo_pct']:.2f}, {rc['risk_adjusted_hi_pct']:.2f}]% (±{TOLERANCE['risk_adjusted_pct']})",
            verdict_interval(rep_risk_adj, rc["risk_adjusted_lo_pct"], rc["risk_adjusted_hi_pct"], TOLERANCE["risk_adjusted_pct"]),
        ),
    ]

    print(f"{'metric':<26}{'reported':>12}  {'recomputed (server basis)':<34}verdict")
    print("-" * 84)
    deviations = 0
    for name, rep, calc, verdict in rows:
        if verdict == "DEVIATION":
            deviations += 1
        print(f"{name:<26}{(rep or '—'):>12}  {calc:<34}{verdict}")

    print("-" * 84)
    print("basis: M = 1 + bookRoiByYear[4]/100; annualized = M^(1/5)-1; "
          "EV = [p*M, p*M+(1-p)]; risk-adj = EV^(1/5)-1  (p = mid win rate)")
    if deviations:
        print(f"RESULT: {deviations} metric(s) outside tolerance — see the report's "
              "seedReturn.notes calibration flag.")
        return 1
    print("RESULT: all reported metrics within tolerance of the deterministic recomputation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
