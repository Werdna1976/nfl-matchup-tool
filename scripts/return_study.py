"""When a player comes back from missing games, how much of his old role does he get back, and
how much do the teammates who filled in lose?

For every return in the given seasons (a back or receiver with a real role who missed 2+ of his
team's games, listed Out/IR/inactive in that stretch, then played again) this compares shares of
the team's volume (carries for backs, targets for everyone) in his first three games back with:
  - his own share before he got hurt
  - each fill-in's share while he was out, and when they played together before
The fill-in's model projection rides his recent games, so it carries his "starter" volume into
the return game unless something takes it away; this measures how much to take.

Usage: python scripts/return_study.py 2020 2021 2022 2023 2024 2025 2026   (about a minute)
Prints the fitted numbers that build_data.py uses (RET_MU, RET_SHARE, RET_THETA) and the misses with and
without them, leaving one season out at a time. Last run (2020-2026): see the RET_* comment in build_data.py.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import build_data as B  # noqa: E402
from model import ewma  # noqa: E402

GROUP = {"RB": ("RB",), "WR": ("WR", "TE"), "TE": ("WR", "TE")}
VOL = {"RB": ("carries", "targets"), "WR": ("targets",), "TE": ("targets",)}
MIN_SHARE = {"carries": 0.25, "targets": 0.12}   # a real role before he got hurt


def load(season):
    stats, team, sched, inj = B.load(season)
    try:
        ros = B.read_csv(f"{B.NFLVERSE}/weekly_rosters/roster_weekly_{season}.csv")
        ros = ros[ros.game_type == "REG"]
    except Exception:
        ros = pd.DataFrame(columns=["gsis_id", "week", "status"])
    return stats, team, inj, ros


def events(season):
    stats, team, inj, ros = load(season)
    stats = stats[stats.position.isin(GROUP)]
    out_wk = set()
    if len(inj):
        for r in inj[inj.report_status.isin(["Out", "Doubtful"])].itertuples():
            out_wk.add((r.gsis_id, int(r.week)))
    for r in ros[ros.status.isin(["RES", "INA"])].itertuples():
        out_wk.add((r.gsis_id, int(r.week)))
    rows = []
    for tm, ts in team.groupby("team"):
        ts = ts.set_index("week").sort_index()
        wks = list(ts.index)
        s = stats[stats.team == tm]
        share, cnt = {}, {}
        for r in s.itertuples():
            for v in ("carries", "targets"):
                x = getattr(r, v)
                x = 0.0 if pd.isna(x) else float(x)
                cnt[(r.player_id, r.week, v)] = x
                tot = ts.at[r.week, v]
                if tot > 0:
                    share[(r.player_id, r.week, v)] = x / tot
        played = s.groupby("player_id").week.apply(set).to_dict()
        pos = s.groupby("player_id").position.last().to_dict()
        for pid, pw in played.items():
            if pos[pid] not in GROUP:
                continue
            for i, w in enumerate(wks):
                if w not in pw or i < 4:
                    continue
                gap = []
                j = i - 1
                while j >= 0 and wks[j] not in pw:
                    gap.append(wks[j]); j -= 1
                pre = [x for x in wks[:j + 1] if x in pw][-4:]
                if len(gap) < 2 or len(pre) < 2 or not any((pid, g) in out_wk for g in gap):
                    continue
                gap = sorted(gap)
                for k in range(3):
                    if i + k >= len(wks) or wks[i + k] not in pw or any(wks[i + x] not in pw for x in range(k)):
                        break
                    wk = wks[i + k]
                    for v in VOL[pos[pid]]:
                        r_pre = np.mean([share.get((pid, x, v), 0) for x in pre])
                        if r_pre < MIN_SHARE[v]:
                            continue
                        mates = []
                        for m, mw in played.items():
                            if m == pid or pos[m] not in GROUP[pos[pid]]:
                                continue
                            g_on = [x for x in gap if x in mw][-4:]
                            if len(g_on) < 2:
                                continue
                            wo = np.mean([share.get((m, x, v), 0) for x in g_on])
                            both = [x for x in pre if x in mw]
                            wi = np.mean([share.get((m, x, v), 0) for x in both]) if both else None
                            act = share.get((m, wk, v), 0) if wk in mw else None
                            if act is None or wo < 0.05:
                                continue
                            mates.append({"m": m, "wo": wo, "wi": wi, "act": act, "cnt": cnt.get((m, wk, v), 0),
                                          "ew": ewma([cnt.get((m, x, v), 0) for x in sorted(mw) if x < wk])})
                        rows.append({"season": season, "tm": tm, "pid": pid, "pos": pos[pid], "w": wk, "k": k, "v": v,
                                     "gap": len(gap), "pre": r_pre, "act": share.get((pid, wk, v), 0), "mates": mates,
                                     "cnt": cnt.get((pid, wk, v), 0), "ew": ewma([cnt.get((pid, x, v), 0) for x in sorted(pw) if x < wk])})
    return rows


def mate_cuts(e, mu):
    """How much of each fill-in's volume the returning player takes back, as a fraction of the
    fill-in's share while he was out (before the fitted strength theta). The returning player's
    share back (mu x his old share) is split by what each fill-in gained while he was out (or by
    their shares, when they never played together)."""
    ms = e["mates"]
    gains = [max(0.0, m["wo"] - m["wi"]) if m["wi"] is not None else None for m in ms]
    if ms and all(g is not None for g in gains) and sum(gains) > 0:
        wts = [g / sum(gains) for g in gains]
    else:
        tot = sum(m["wo"] for m in ms) or 1
        wts = [m["wo"] / tot for m in ms]
    return [min(1.0, mu * e["pre"] * wt / m["wo"]) for m, wt in zip(ms, wts)]


def main():
    seasons = [int(a) for a in sys.argv[1:]] or [2022, 2023, 2024, 2025]
    ev = []
    for s in seasons:
        got = events(s)
        print(f"{s}: {len(got)} return games")
        ev += got
    df = pd.DataFrame(ev)
    print("Leave one season out: fit on the other seasons, test on the one left out, pooled.")
    print("Misses are average errors in carries or targets per game against the recency-weighted average")
    print("the model starts from (before matchup and team scaling).")
    for v in ("carries", "targets"):
        for k in range(3):
            base_r, adj_r, base_m, adj_m, fits = [], [], [], [], []
            for hold in seasons:
                tr = df[(df.k == k) & (df.v == v) & (df.season != hold)].to_dict("records")
                te = df[(df.k == k) & (df.v == v) & (df.season == hold)].to_dict("records")
                if not tr or not te:
                    continue
                mu_share, mu, theta = fit_one(tr)
                fits.append((mu_share, mu, theta))
                for e in te:
                    base_r.append(abs(e["ew"] - e["cnt"])); adj_r.append(abs(mu * e["ew"] - e["cnt"]))
                    for c, m in zip(mate_cuts(e, mu_share), e["mates"]):
                        base_m.append(abs(m["ew"] - m["cnt"])); adj_m.append(abs(m["ew"] * (1 - theta * c) - m["cnt"]))
            mu_share, mu, theta = fit_one(df[(df.k == k) & (df.v == v)].to_dict("records"))
            print(f"  {v:7s} game {k + 1} back: all seasons mu_share={mu_share:.2f} mu={mu:.2f} theta={theta:.2f} "
                  f"(per-fold theta {min(f[2] for f in fits):.2f}-{max(f[2] for f in fits):.2f}) | "
                  f"returner n={len(base_r)} miss {np.mean(base_r):.2f} -> {np.mean(adj_r):.2f} | "
                  f"fill-ins n={len(base_m)} miss {np.mean(base_m):.2f} -> {np.mean(adj_m):.2f}")


def fit_one(tr):
    mu_share = sum(e["act"] for e in tr) / sum(e["pre"] for e in tr)
    mu = sum(e["cnt"] for e in tr) / max(sum(e["ew"] for e in tr), 1e-9)
    best = None
    for theta in np.arange(0, 1.51, 0.05):
        err = [abs(m["ew"] * (1 - theta * c) - m["cnt"]) for e in tr for c, m in zip(mate_cuts(e, mu_share), e["mates"])]
        if err and (best is None or np.mean(err) < best[1]):
            best = (round(float(theta), 2), np.mean(err))
    return mu_share, mu, best[0] if best else 0.0

if __name__ == "__main__":
    main()
