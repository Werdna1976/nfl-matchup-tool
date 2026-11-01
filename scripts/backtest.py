"""Check the model against weeks already played.

For each past week W, rebuild every projection using only games before W, then
compare with what happened. A well-calibrated model has ~80% of results inside
its 80% range, ~50% inside its 50% range, and ~10% / ~5% above its 90th / 95th percentile
(the long-shot overs).

Writes site/data/backtest.json, which the site shows on its "How good is the model?" panel.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import build_data as B  # noqa: E402
from model import POSITION_STATS, cdf, ewma  # noqa: E402

LABELS = {"attempts": "QB pass attempts", "completions": "QB completions", "passing_yards": "QB passing yards",
          "passing_tds": "QB passing TDs", "passing_interceptions": "QB interceptions",
          "carries": "Rush attempts", "rushing_yards": "Rushing yards", "rushing_tds": "Rushing TDs",
          "targets": "Targets", "receptions": "Receptions", "receiving_yards": "Receiving yards",
          "receiving_tds": "Receiving TDs"}


def run(season, first_week=4, data=None, prev=None):
    stats, team_stats, sched = data or B.load(season)[:3]
    prev = B.prev_summary(B.load_prev(season)) if prev is None else prev
    last = int(stats.week.max())
    rows = []
    for W in range(first_week, last + 1):
        teams, lg = B.team_context(stats, team_stats, sched, W)
        cvs, rates = B.prior_cvs(stats, W), B.prior_rates(stats, W)
        for g in sched[(sched.week == W) & sched.home_score.notna()].itertuples():
            gm = B.game_model(g.home_team, g.away_team, teams, lg, g.spread_line, g.total_line)
            rows.append({"stat": "game_total", "pos": "GAME", "week": W, "actual": g.home_score + g.away_score,
                         "cdf": cdf(g.home_score + g.away_score, gm["total"]),
                         "cdf_lo": cdf(g.home_score + g.away_score - 1e-9, gm["total"]),
                         "pred": gm["total"]["mean"], "base": g.total_line})
            for tm, opp, sign in ((g.home_team, g.away_team, 1), (g.away_team, g.home_team, -1)):
                if tm not in teams or opp not in teams:
                    continue
                gs = B.game_script(tm, opp, teams, lg, sign * gm["margin"]["mean"],
                                   gm["home_pts"] if sign == 1 else gm["away_pts"])
                for pid in B.eligible_players(stats, tm, W):
                    hist = stats[(stats.player_id == pid) & (stats.week < W)].sort_values("week")
                    actual = stats[(stats.player_id == pid) & (stats.week == W)]
                    if actual.empty or hist.empty:
                        continue
                    pos = hist.position.iloc[-1]
                    proj = B.project_player(hist, pos, opp, teams, lg, gs, cvs, rates, prev=prev.get(pid))
                    for col, kind in POSITION_STATS[pos]:
                        a = float(actual[col].fillna(0).iloc[0])
                        p = proj[col]
                        rows.append({"stat": col, "pos": pos, "actual": a, "pred": p["mean"], "proj": p, "week": W,
                                     "cdf": cdf(a + 0.5, p), "cdf_lo": cdf(a - 0.5, p),
                                     "base": hist[col].fillna(0).mean(), "ewma": ewma(list(hist[col].fillna(0)))})
    return rows


def _overlap(a, b, lo, hi):
    """Share of the probability slice [a, b] (one whole-number result) inside [lo, hi]."""
    if b - a < 1e-9:
        return float(lo <= b <= hi)
    return max(0.0, min(b, hi) - max(a, lo)) / (b - a)


def summarize(rows):
    by = {}
    for r in rows:
        key = "Game total points" if r["stat"] == "game_total" else LABELS[r["stat"]]
        by.setdefault(key, []).append(r)
    out = []
    for key, rs in by.items():
        n = len(rs)
        # for whole-number stats, count a result on the edge of the range as half in
        def inside(lo, hi):
            return sum(_overlap(r["cdf_lo"], r["cdf"], lo, hi) for r in rs) / n
        mae = sum(abs(r["actual"] - r["pred"]) for r in rs) / n
        mae_base = sum(abs(r["actual"] - r["base"]) for r in rs) / n
        out.append({"stat": key, "n": n, "in80": round(inside(0.1, 0.9), 3), "in50": round(inside(0.25, 0.75), 3),
                    "above90": round(inside(0.9, 1.0), 3), "above95": round(inside(0.95, 1.0), 3),
                    "mae": round(mae, 2), "mae_season_avg": round(mae_base, 2)})
    order = list(LABELS.values()) + ["Game total points"]
    return sorted(out, key=lambda o: order.index(o["stat"]))


if __name__ == "__main__":
    import datetime as dt
    season = int(sys.argv[1]) if len(sys.argv) > 1 else dt.date.today().year
    rows = run(season)
    summary = summarize(rows)
    for s in summary:
        print(f"{s['stat']:20s} n={s['n']:4d}  in80={s['in80']:.2f}  in50={s['in50']:.2f}  "
              f"above90={s['above90']:.3f}  above95={s['above95']:.3f}  "
              f"MAE={s['mae']:7.2f}  (season-avg MAE {s['mae_season_avg']:7.2f})")
    out = os.path.join(os.path.dirname(__file__), "..", "site", "data", "backtest.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump({"season": season, "summary": summary,
                   "note": "Projections rebuilt each week using only earlier games."}, f)
