"""Should games a player left early (injury, ejection, blowout rest) count in his form?

A game where a regular played far fewer snaps than usual (Ja'Marr Chase's 20% in 2026 week 4,
when he left hurt) drags down both his recent stat average and his last-4 snap share, and the
snap-trend rule then cuts his projection again. This script replays past weeks and compares
the model's projections made with those games kept (today's model) against versions that drop
them, for every stat the page projects.

A "partial game" is one where his share of the offensive snaps fell below RATIO times his
median share over his last 12 games (that game included), for a player whose median is at
least 50% (so part-timers and rotational backs aren't flagged for normal swings).

Usage: python scripts/partial_study.py 2023 2024 2025 2026
Prints MAE (vs. today's model) and log-score gain per variant, for player-games with a partial game in
the last 4 (not the latest) and with the latest game partial. Variants: snap = drop them from the snap
trend only; both = also from the stat averages; keeplast = both, but never drop his latest game.
Result (2023-26): no variant beat today's model overall; see the README.
"""
import json
import math
import sys
import os

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import build_data as B  # noqa: E402
from model import cdf  # noqa: E402

RATIOS = [0.4, 0.5, 0.6]


def flags_for(snaps, ratio):
    """{(season, pid): set of weeks flagged partial} from {season: {pid: {week: share}}}."""
    out = {}
    pids = set().union(*[set(s) for s in snaps.values()])
    seasons = sorted(snaps)
    for pid in pids:
        seq = [(s, w, v) for s in seasons for w, v in sorted(snaps[s].get(pid, {}).items())]
        for i, (s, w, v) in enumerate(seq):
            win = [x[2] for x in seq[max(0, i - 11): i + 1]]
            if len(win) < 4:
                continue
            med = sorted(win)[len(win) // 2]
            if med >= 0.5 and v < ratio * med:
                out.setdefault((s, pid), set()).add(w)
    return out


def snap_series_ex(snaps, pid, season, before_week, flags):
    """B.snap_series without the flagged games."""
    prev, cur = snaps.get(season - 1, {}), snaps.get(season, {})
    fp, fc = flags.get((season - 1, pid), set()), flags.get((season, pid), set())
    old = [v for w, v in sorted(prev.get(pid, {}).items()) if w not in fp]
    new = [v for w, v in sorted(cur.get(pid, {}).items()) if w < before_week and w not in fc]
    return old + new


def score(a, p):
    """Log of the chance the projection gave the result (whole-number bins)."""
    return math.log(max(cdf(a + 0.5, p) - cdf(a - 0.5, p), 1e-4))


def run(season, snaps, flagsets):
    stats, team_stats, sched = B.load(season)[:3]
    prev = B.prev_summary(B.load_prev(season))
    pair = snaps.get(season, {}), snaps.get(season - 1, {})
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
                    if pos not in B.POSITION_STATS:
                        continue
                    pv = prev.get(pid)
                    args = (pos, opp, teams, lg, gs, cvs, rates)
                    projs = {"base": B.project_player(hist, *args, prev=pv,
                                                      snap_t=B.snap_trend(B.snap_series(pair, pid, season, W)))}
                    touched = {}
                    for r, fl in flagsets.items():
                        fw = {w for w in fl.get((season, pid), set()) if w < W}
                        fprev = fl.get((season - 1, pid), set())
                        st = B.snap_trend(snap_series_ex(snaps, pid, season, W, fl))
                        last = int(hist.week.max())
                        h2 = hist[~hist.week.isin(fw)] if fw and len(hist) > len(fw) else hist
                        fw_keep = fw - {last}
                        h3 = hist[~hist.week.isin(fw_keep)] if fw_keep and len(hist) > len(fw_keep) else hist
                        projs[f"snap{r}"] = B.project_player(hist, *args, prev=pv, snap_t=st)
                        projs[f"both{r}"] = B.project_player(h2, *args, prev=pv, snap_t=st)
                        projs[f"keeplast{r}"] = B.project_player(h3, *args, prev=pv, snap_t=st)
                        last4 = set(hist.week.tail(4))
                        touched[r] = len(fw & last4) + (2 if last in fw else 0)   # 0 none, 1 in last 4, 2-3 his last game
                    sn = snaps.get(season, {}).get(pid, {}).get(W)
                    for col, _ in B.POSITION_STATS[pos]:
                        a = float(actual[col].fillna(0).iloc[0])
                        row = {"season": season, "W": W, "pid": pid, "pos": pos, "stat": col, "a": a,
                               "snap_now": sn}
                        for r in RATIOS:
                            row[f"t{r}"] = touched[r]
                        for k, p in projs.items():
                            row[f"e_{k}"] = abs(a - p[col]["mean"])
                            row[f"l_{k}"] = score(a, p[col])
                            row[f"m_{k}"] = p[col]["mean"]
                        rows.append(row)
    return rows


def main():
    seasons = [int(s) for s in sys.argv[1:]] or [2024, 2025]
    snaps = {s: B.load_snaps(s) for s in range(min(seasons) - 1, max(seasons) + 1)}
    flagsets = {r: flags_for(snaps, r) for r in RATIOS}
    for r, fl in flagsets.items():
        print(f"ratio {r}: {sum(len(v) for v in fl.values())} partial games flagged")
    rows = []
    for s in seasons:
        rr = run(s, snaps, flagsets)
        print(f"{s}: {len(rr)} rows")
        rows += rr
    df = pd.DataFrame(rows)
    df.to_csv(os.environ.get("PARTIAL_ROWS", "partial_rows.csv"), index=False)
    keys = [c[2:] for c in df.columns if c.startswith("e_")]
    out = {}
    for r in RATIOS:
        for scope, d in (("all", df), ("in last 4, not last", df[df[f"t{r}"] == 1]), ("last game", df[df[f"t{r}"] >= 2])):
            res = {"n": int(len(d))}
            for k in keys:
                if k != "base" and not k.endswith(str(r)):
                    continue
                res[k] = {"mae_vs_base": round(float(d[f"e_{k}"].sum() / d["e_base"].sum()), 4),
                          "logscore_gain": round(float((d[f"l_{k}"] - d["l_base"]).mean()), 4)}
            out[f"{r}|{scope}"] = res
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
