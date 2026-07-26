#!/usr/bin/env python3
"""Neon free-plan compute budget model: before vs. after the snapshot refactor.

WHY A MODEL AT ALL
Neon's free plan meters *compute time*, not queries: 100 CU-hours per project per
month, where CU-hours = compute size (CU) x hours the compute is not suspended.
The compute auto-suspends after 5 idle minutes and free-plan users cannot turn
that off. So the only quantity that matters is "how many hours per month is the
compute awake", and the dominant term is the 5-minute suspend timer that every
single database touch restarts.

Sources (checked 2026-07-26):
  - Free plan limits & quotas: https://neon.com/faqs/free-plan-limits-and-quotas
  - Autosuspend (scale to zero) behaviour: https://neon.com/docs/introduction/auto-suspend

Run:
    python scripts/neon-budget.py
    python scripts/neon-budget.py --json
    python scripts/neon-budget.py --compute-size 0.5 --auth-events 200

Every number printed is derived from the constants in DEFAULTS below; nothing is
hard-coded prose. Change an assumption on the command line and the whole table
recomputes, which is the point: the conclusion should survive disagreement about
any single input.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, asdict, replace

HOURS_PER_DAY = 24.0
DAYS_PER_MONTH = 30.4375  # 365.25 / 12, so a month is not silently 30 or 31


@dataclass(frozen=True)
class Assumptions:
    """Every input to the model, with the reason each value was chosen."""

    # --- Neon plan mechanics (not our choice) ---
    free_cu_hours_per_month: float = 100.0
    """Free plan allowance, per PROJECT (not per database, not per branch)."""
    compute_size_cu: float = 0.25
    """Free-plan minimum autoscaling floor. Our workload never needs more."""
    autosuspend_minutes: float = 5.0
    """Fixed on the free plan. This is the term that dominates everything."""

    # --- Scheduled work ---
    cron_runs_per_day: int = 8
    """Every 3 hours: 24 / 3."""
    bp_active_minutes: float = 10.0
    """Observed wall clock of a 5-BP batch. AFTER the refactor only the first and
    last seconds of this touch the database, but the *window* is what counts for
    the before case, where a placeholder write landed every ~2 minutes."""
    bp_db_minutes_after: float = 0.5
    """Phase 1 (prepare) + phase 3 (flush) only; the LLM phase is DB-free, so the
    compute can suspend during it."""
    collect_active_minutes: float = 1.0
    """RSS fetch across 6 geos plus the insert."""
    monitor_active_minutes: float = 1.0
    """HTTP probe of each registered site plus the insert."""
    monitor_runs_per_day_before: int = 4
    """Was every 6 hours: 24 / 6."""
    maintenance_minutes: float = 0.5
    """Retention deletes + CREATE TABLE IF NOT EXISTS."""
    snapshot_build_minutes: float = 1.0
    """Bulk reads that produce the Blobs snapshots. New cost, introduced by this
    refactor; counted honestly against its savings."""

    # --- Web traffic ---
    web_requests_per_day: int = 2000
    """Crawler-dominated. The exact figure barely matters in the before case: any
    rate that keeps the mean gap under the 5-minute suspend timer pins the
    compute awake 24/7, and a single search-engine crawler does that alone."""
    read_paths_touch_db_before: bool = True
    read_paths_touch_db_after: bool = False
    """The claim the DB-outage drill (tests/e2e/db-outage-drill.mjs) proves."""

    # --- Traffic that legitimately still writes to Postgres ---
    auth_events_per_day: int = 20
    """Login / register / feedback / newsletter: synchronous writes that cannot be
    snapshotted. Modelled as a range, because whether they coalesce into one wake
    window depends on arrival times we do not control."""
    auth_active_seconds: float = 1.0

    def cu_hours(self, awake_hours: float) -> float:
        return awake_hours * self.compute_size_cu

    @property
    def autosuspend_hours(self) -> float:
        return self.autosuspend_minutes / 60.0


@dataclass(frozen=True)
class Scenario:
    name: str
    cron_awake_hours_per_day: float
    web_awake_hours_per_day: float
    auth_awake_hours_per_day_low: float
    auth_awake_hours_per_day_high: float
    wake_events_per_day: float
    notes: str

    def total_low(self) -> float:
        return self.cron_awake_hours_per_day + self.web_awake_hours_per_day + self.auth_awake_hours_per_day_low

    def total_high(self) -> float:
        return self.cron_awake_hours_per_day + self.web_awake_hours_per_day + self.auth_awake_hours_per_day_high


def window_hours(active_minutes: float, a: Assumptions) -> float:
    """Awake time for one isolated database touch: the work plus the idle timer.

    A 1-second query costs 5 minutes and 1 second of billed compute. This is why
    the number of *windows* matters far more than the amount of work in them.
    """
    return (active_minutes / 60.0) + a.autosuspend_hours


def auth_bounds(a: Assumptions) -> tuple[float, float]:
    """Awake hours/day from auth writes, as [coalesced, fully isolated].

    Lower bound: every event lands inside an existing wake window (e.g. all
    traffic in one busy hour, or during a cron window) and costs nothing extra.
    Upper bound: every event is isolated and pays a full suspend timer, capped at
    24h because the compute cannot be awake longer than the day is.
    """
    isolated = min(HOURS_PER_DAY, a.auth_events_per_day * window_hours(a.auth_active_seconds / 60.0, a))
    coalesced = 0.0 if a.auth_events_per_day == 0 else window_hours(a.auth_active_seconds / 60.0, a)
    return coalesced, isolated


def scenario_before(a: Assumptions) -> Scenario:
    """Three independent schedules, plus SSR pages querying on every request."""
    bp = a.cron_runs_per_day * window_hours(a.bp_active_minutes, a)
    collect = a.cron_runs_per_day * window_hours(a.collect_active_minutes, a)
    monitor = a.monitor_runs_per_day_before * window_hours(a.monitor_active_minutes, a)
    cron = bp + collect + monitor

    # Mean gap between requests, in minutes. If it is below the suspend timer the
    # compute never gets to suspend, so web traffic alone pins it awake all day.
    mean_gap_minutes = (HOURS_PER_DAY * 60.0) / max(a.web_requests_per_day, 1)
    if a.read_paths_touch_db_before and mean_gap_minutes < a.autosuspend_minutes:
        web = HOURS_PER_DAY
        note = (
            f"{a.web_requests_per_day} req/day = one every {mean_gap_minutes:.1f} min "
            f"< {a.autosuspend_minutes:.0f} min suspend timer -> compute never suspends"
        )
    elif a.read_paths_touch_db_before:
        web = min(HOURS_PER_DAY, a.web_requests_per_day * window_hours(0.0, a))
        note = f"one every {mean_gap_minutes:.1f} min, each paying a suspend timer"
    else:
        web = 0.0
        note = "read paths do not touch Postgres"

    low, high = auth_bounds(a)
    wakes = a.cron_runs_per_day * 2 + a.monitor_runs_per_day_before + a.web_requests_per_day
    return Scenario("before", cron, web, low, high, wakes, note)


def scenario_after(a: Assumptions) -> Scenario:
    """One consolidated window per cycle; reads served from Netlify Blobs."""
    active = (
        a.collect_active_minutes
        + a.bp_db_minutes_after
        + a.monitor_active_minutes
        + a.maintenance_minutes
        + a.snapshot_build_minutes
    )
    # One window per cycle: collect -> generate -> monitor -> prune -> snapshot all
    # run back to back inside a single invocation, so they share ONE suspend timer.
    cron = a.cron_runs_per_day * window_hours(active, a)
    web = 0.0 if not a.read_paths_touch_db_after else HOURS_PER_DAY
    low, high = auth_bounds(a)
    return Scenario(
        "after",
        cron,
        web,
        low,
        high,
        a.cron_runs_per_day,
        f"{active:.1f} min of DB work per window, {a.cron_runs_per_day} windows/day, reads served from Blobs",
    )


def report(a: Assumptions) -> dict:
    before, after = scenario_before(a), scenario_after(a)
    out = {"assumptions": asdict(a), "scenarios": {}}
    for s in (before, after):
        monthly_low = s.total_low() * DAYS_PER_MONTH
        monthly_high = s.total_high() * DAYS_PER_MONTH
        out["scenarios"][s.name] = {
            "awake_hours_per_day": {"low": s.total_low(), "high": s.total_high()},
            "components_hours_per_day": {
                "cron": s.cron_awake_hours_per_day,
                "web": s.web_awake_hours_per_day,
                "auth_low": s.auth_awake_hours_per_day_low,
                "auth_high": s.auth_awake_hours_per_day_high,
            },
            "awake_hours_per_month": {"low": monthly_low, "high": monthly_high},
            "cu_hours_per_month": {"low": a.cu_hours(monthly_low), "high": a.cu_hours(monthly_high)},
            "quota_usage_pct": {
                "low": 100.0 * a.cu_hours(monthly_low) / a.free_cu_hours_per_month,
                "high": 100.0 * a.cu_hours(monthly_high) / a.free_cu_hours_per_month,
            },
            "wake_events_per_day": s.wake_events_per_day,
            "notes": s.notes,
        }
    hi_before = out["scenarios"]["before"]["cu_hours_per_month"]["high"]
    hi_after = out["scenarios"]["after"]["cu_hours_per_month"]["high"]
    out["savings"] = {
        "cu_hours_per_month": hi_before - hi_after,
        "reduction_pct": 100.0 * (1.0 - hi_after / hi_before) if hi_before else 0.0,
        "headroom_cu_hours": a.free_cu_hours_per_month - hi_after,
        "fits_free_plan_after": hi_after <= a.free_cu_hours_per_month,
    }
    return out


def print_report(r: dict, a: Assumptions) -> None:
    print("=" * 78)
    print("Neon free-plan compute budget: before vs. after the snapshot refactor")
    print("=" * 78)
    print(f"\nPlan mechanics: {a.free_cu_hours_per_month:.0f} CU-hours/month/project, "
          f"{a.compute_size_cu} CU compute, {a.autosuspend_minutes:.0f}-minute autosuspend")
    print(f"Month length:   {DAYS_PER_MONTH} days (365.25 / 12)")
    print(f"Budget in wall-clock terms: "
          f"{a.free_cu_hours_per_month / a.compute_size_cu:.0f} awake hours/month = "
          f"{a.free_cu_hours_per_month / a.compute_size_cu / DAYS_PER_MONTH:.1f} h/day\n")

    for name in ("before", "after"):
        s = r["scenarios"][name]
        c = s["components_hours_per_day"]
        print(f"--- {name.upper()} ---")
        print(f"  scheduled jobs      {c['cron']:6.2f} h/day")
        print(f"  web traffic         {c['web']:6.2f} h/day   ({s['notes']})")
        print(f"  auth writes         {c['auth_low']:6.2f} - {c['auth_high']:.2f} h/day")
        print(f"  TOTAL awake         {s['awake_hours_per_day']['low']:6.2f} - "
              f"{s['awake_hours_per_day']['high']:.2f} h/day")
        print(f"  per month           {s['awake_hours_per_month']['low']:6.1f} - "
              f"{s['awake_hours_per_month']['high']:.1f} awake hours")
        print(f"  COST                {s['cu_hours_per_month']['low']:6.1f} - "
              f"{s['cu_hours_per_month']['high']:.1f} CU-hours "
              f"({s['quota_usage_pct']['low']:.0f}% - {s['quota_usage_pct']['high']:.0f}% of quota)")
        print(f"  DB wake events      {s['wake_events_per_day']:.0f}/day\n")

    sv = r["savings"]
    print("--- RESULT (worst case of each scenario) ---")
    print(f"  saved            {sv['cu_hours_per_month']:.1f} CU-hours/month "
          f"({sv['reduction_pct']:.1f}% reduction)")
    print(f"  headroom left    {sv['headroom_cu_hours']:.1f} CU-hours/month "
          f"(for the sibling app sharing this project, and for growth)")
    print(f"  fits free plan   {'YES' if sv['fits_free_plan_after'] else 'NO'}")

    print("\n--- SENSITIVITY: what would break the result ---")
    print(f"  {'variation':<44}{'after (CU-h/mo)':>16}{'fits?':>8}")
    variations = [
        ("baseline", a),
        ("BP batch runs 16x/day instead of 8", replace(a, cron_runs_per_day=16)),
        ("compute floor 0.5 CU instead of 0.25", replace(a, compute_size_cu=0.5)),
        ("10x the auth traffic (200 events/day)", replace(a, auth_events_per_day=200)),
        ("snapshot build 3x slower (3 min)", replace(a, snapshot_build_minutes=3.0)),
        ("regression: read paths query Postgres again", replace(a, read_paths_touch_db_after=True)),
    ]
    for label, variant in variations:
        vr = report(variant)
        cu = vr["scenarios"]["after"]["cu_hours_per_month"]["high"]
        fits = "YES" if vr["savings"]["fits_free_plan_after"] else "NO"
        print(f"  {label:<44}{cu:>16.1f}{fits:>8}")

    print("\nThe last row is the one to watch: leaving the read path on Postgres")
    print("blows the quota on its own, which is why ALLOW_DB_READ_FALLBACK defaults")
    print("to false and why tests/e2e/db-outage-drill.mjs asserts the drill on every run.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--compute-size", type=float, default=Assumptions.compute_size_cu,
                   help="compute size in CU (free-plan floor is 0.25)")
    p.add_argument("--cron-runs", type=int, default=Assumptions.cron_runs_per_day,
                   help="consolidated cron windows per day")
    p.add_argument("--web-requests", type=int, default=Assumptions.web_requests_per_day,
                   help="page/API requests per day")
    p.add_argument("--auth-events", type=int, default=Assumptions.auth_events_per_day,
                   help="login/register/feedback writes per day")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = p.parse_args()

    a = Assumptions(
        compute_size_cu=args.compute_size,
        cron_runs_per_day=args.cron_runs,
        web_requests_per_day=args.web_requests,
        auth_events_per_day=args.auth_events,
    )
    r = report(a)
    if args.json:
        print(json.dumps(r, indent=2))
    else:
        print_report(r, a)


if __name__ == "__main__":
    main()
