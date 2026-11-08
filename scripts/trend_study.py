"""Does a player's recent form (last 4 games vs. last 12) predict how he does against the model?

The model already leans on recent games (a recency-weighted average with a 4-game half-life,
pulled toward last season and a baseline), so a hot or cold streak is partly priced in. This
script measures what's left: for every past player-game it compares the result with the model
projection made before that game, grouped by the player's last-4 vs. last-12 trend in the stat
itself and in his snap share. If the hot group beats its projection and the cold group falls
short, the model under-reacts and the trend is worth showing as a signal (and folding in).

Usage: python scripts/trend_study.py 2024 2025 2026     (NFL, a few minutes a season)
       python scripts/trend_study.py --nba 2025 2026  (NBA seasons, named by the year they end)
Prints the tables; the README and the site quote the results.
"""
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import build_data as B  # noqa: E402
from model import cdf  # noqa: E402

STUDY = {"QB": ["attempts", "passing_yards", "carries", "rushing_yards"],
         "RB": ["carries", "rushing_yards", "targets", "receptions", "receiving_yards"],
         "WR": ["targets", "receptions", "receiving_yards"],
         "TE": ["targets", "receptions", "receiving_yards"]}
# a trend needs some volume to mean anything (a 2-yard to 4-yard "doubling" is noise)
FLOOR = {"attempts": 15, "passing_yards": 120, "carries": 4, "rushing_yards": 20, "targets": 3,
         "receptions": 2, "receiving_yards": 20}
BINS = [(-9, -0.25, "down 25%+"), (-0.25, -0.1, "down 10-25%"), (-0.1, 0.1, "steady"),
        (0.1, 0.25, "up 10-25%"), (0.25, 9, "up 25%+")]


def trend(vals, n_short=4, n_long=12, floor=0.0):
    """(last-4 average / last-12 average) - 1, or None without 8 games or enough volume."""
    if len(vals) < 8:
        return None
    long = sum(vals[-n_long:]) / len(vals[-n_long:])
    if long < floor or long <= 0:
        return None
    return sum(vals[-n_short:]) / n_short / long - 1


def run(season):
    stats, team_stats, sched = B.load(season)[:3]
    prev_raw = B.load_prev(season)
    prev = B.prev_summary(prev_raw)
    snaps = B.load_snaps(season), B.load_snaps(season - 1)
    rows = []
    for W in range(4, int(stats.week.max()) + 1):
        teams, lg = B.team_context(stats, team_stats, sched, W)
        cvs, rates = B.prior_cvs(stats, W), B.prior_rates(stats, W)
        for g in sched[(sched.week == W) & sched.home_score.notna()].itertuples():
            gm = B.game_model(g.home_team, g.away_team, teams, lg, g.spread_line, g.total_line)
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
                    if pos not in STUDY:
                        continue
                    older = prev_raw[prev_raw.player_id == pid].sort_values("week") if len(prev_raw) else hist.iloc[:0]
                    snap_t = B.snap_trend(B.snap_series(snaps, pid, season, W))
                    # TREND_NO_SNAP=1 measures the model without its snap-trend adjustment
                    proj = B.project_player(hist, pos, opp, teams, lg, gs, cvs, rates, prev=prev.get(pid),
                                            snap_t=None if os.environ.get("TREND_NO_SNAP") else snap_t)
                    for col in STUDY[pos]:
                        vals = [float(v) for v in pd.concat([older[col], hist[col]]).fillna(0)]
                        t = trend(vals, floor=FLOOR[col])
                        if t is None:
                            continue
                        a, p = float(actual[col].fillna(0).iloc[0]), proj[col]
                        u = (cdf(a - 0.5, p) + cdf(a + 0.5, p)) / 2   # where the result landed in the model's range
                        rows.append({"season": season, "pos": pos, "stat": col, "t": t, "snap_t": snap_t,
                                     "u": u, "ratio": a / max(p["mean"], 0.1), "err": abs(a - p["mean"])})
    return rows


def table(df, key):
    out = []
    for lo, hi, label in BINS:
        d = df[(df[key] > lo) & (df[key] <= hi)]
        if len(d) < 30:
            continue
        out.append({"bin": label, "n": int(len(d)), "over_median": round(float((d.u > 0.5).mean()), 3),
                    "avg_vs_proj": round(float(d.ratio.clip(upper=4).mean()), 3)})
    return out


def run_nba(seasons):
    import numpy as np
    import nba_build as N
    boxes = {s: N.load_box(s) for s in sorted({s - 1 for s in seasons} | set(seasons))}
    pri = {s: N.fit_priors(boxes[s - 1] if not boxes[s - 1].empty else boxes[s])
           for s in seasons}
    df = N.backtest(boxes, seasons, pri, every=2)
    df = df[df.stat.isin(["min", "pts", "reb", "ast", "fg3", "pra"])].copy()
    hi = N.cdf_vec(df.actual, df["mean"], df.sd, df.discrete)
    lo = np.where(df.discrete, N.cdf_vec(df.actual - 1, df["mean"], df.sd, df.discrete), hi)
    df["u"] = (hi + lo) / 2
    df["ratio"] = df.actual / df["mean"].clip(lower=0.1)
    return df.rename(columns={"trend": "t", "min_trend": "snap_t"})


def main():
    args = sys.argv[1:]
    nba = "--nba" in args
    seasons = [int(s) for s in args if s != "--nba"] or ([2025, 2026] if nba else [2024, 2025])
    if nba:
        df = run_nba(seasons)
    else:
        rows = []
        for s in seasons:
            r = run(s)
            print(f"{s}: {len(r)} player-stat results")
            rows += r
        df = pd.DataFrame(rows)
    if os.environ.get("TREND_ROWS"):   # keep the raw rows to pool seasons run separately
        df.to_csv(os.environ["TREND_ROWS"], index=False)
    res = {"seasons": seasons, "n": int(len(df)), "stat_trend": table(df, "t"),
           "snap_trend": table(df.dropna(subset=["snap_t"]), "snap_t"), "by_stat": {}}
    for col, d in df.groupby("stat"):
        res["by_stat"][col] = table(d, "t")
    # does the trend carry information the model hasn't used? slope of "landed above the
    # model's median" on the trend, per 100% of trend (a well-used signal has slope ~0)
    for key in ("t", "snap_t"):
        d = df.dropna(subset=[key])
        x, y = d[key].clip(-0.6, 0.6), (d.u > 0.5).astype(float)
        res[f"slope_{key}"] = round(float(((x - x.mean()) * (y - y.mean())).sum() / ((x - x.mean()) ** 2).sum()), 4)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
