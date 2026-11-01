"""Fit the player model's weights on past seasons and write scripts/model_params.json.

Not part of the hourly build. Run it once a season (needs scipy):

    python scripts/fit_model.py                    # fit on 2022-2024, test on 2025 + this season
    python scripts/fit_model.py --train 2022 2023 2024 2025 --test 2026

For every player-game in the training seasons it rebuilds what the model knew before kickoff
(recent form, last season, matchup), then picks the weights that make the real results most
likely. Yardage and volume stats use a two-curve gamma mix ("normal game" + "dud game");
touchdowns and interceptions use Poisson. It prints how often held-out results landed above
each of the model's percentiles, which is what alt lines and long shots depend on.
"""
import argparse
import datetime as dt
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import gammainc, gammaln

sys.path.insert(0, os.path.dirname(__file__))
import build_data as B  # noqa: E402
from model import POSITION_STATS, COUNT_KINDS, ewma, clip  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "model_params.json")


# ---------------------------------------------------------------- features

def season_rows(season):
    stats, team_stats, sched, _ = B.load(season)
    prev = B.prev_summary(B.load_prev(season))
    rows = []
    for W in range(2, int(stats.week.max()) + 1):
        teams, lg = B.team_context(stats, team_stats, sched, W)
        rates = B.prior_rates(stats, W)
        for g in sched[sched.week == W].itertuples():
            gm = B.game_model(g.home_team, g.away_team, teams, lg, g.spread_line, g.total_line)
            for tm, opp, sign in ((g.home_team, g.away_team, 1), (g.away_team, g.home_team, -1)):
                if tm not in teams or opp not in teams:
                    continue
                gs = B.game_script(tm, opp, teams, lg, sign * gm["margin"]["mean"],
                                   gm["home_pts"] if sign == 1 else gm["away_pts"])
                for pid in B.eligible_players(stats, tm, W):
                    hist = stats[(stats.player_id == pid) & (stats.week < W)].sort_values("week")
                    act = stats[(stats.player_id == pid) & (stats.week == W)]
                    if act.empty or hist.empty:
                        continue
                    pos = hist.position.iloc[-1]
                    share = B.rush_share(hist)
                    raw = {}
                    for col, kind in POSITION_STATS[pos]:
                        vals = [float(v) for v in hist[col].fillna(0)]
                        n, ew = len(vals), ewma(vals)
                        f = clip(B.stat_factor(col, kind, pos, opp, teams, lg, gs, share), 0.6, 1.5)
                        raw[col] = max(ew * f, 0.0)
                        m = sum(vals) / n
                        sd = (sum((v - m) ** 2 for v in vals) / (n - 1)) ** 0.5 if n > 1 else np.nan
                        pn, pm = prev.get(pid, {}).get(col, (0, np.nan))
                        target = (rates.get((pos, col), 0.0) * raw.get(B.TD_OPP[col], 0.0)) if kind in COUNT_KINDS else np.nan
                        rows.append((season, W, pos, col, kind, n, ew, m, sd, f, pn, pm, target,
                                     float(act[col].fillna(0).iloc[0])))
    print(f"{season}: {len(rows)} player-stat-games", flush=True)
    return pd.DataFrame(rows, columns=["season", "week", "pos", "stat", "kind", "n", "ew", "mean", "sd", "f",
                                       "prev_n", "prev_mean", "target", "actual"])


# ---------------------------------------------------------------- the same math as build_data.project_player

def blend(th, d, target):
    k_prev, k0 = th[0], th[1]
    kp = np.where(d.prev_n.values >= 4, abs(k_prev) * np.minimum(d.prev_n.values, 17) / 17, 0.0)
    n = d.n.values
    return (n * d.ew.values + kp * np.nan_to_num(d.prev_mean.values) + abs(k0) * target) / (n + kp + abs(k0))


def mean_sd(th, d):
    k_prev, k0, mu, c, g, a, p, k_own = th[:8]
    m = np.maximum(c * blend(th, d, abs(mu)) * d.f.values ** g, 0.05)
    curve = abs(a) * m ** (-p)
    ok = (d.n.values > 1) & (d["mean"].values > 0)
    own = np.where(ok, np.nan_to_num(d["sd"].values) / np.maximum(d["mean"].values, 1e-9), curve)
    w = np.maximum(d.n.values - 1, 0)
    cv = np.clip(np.sqrt((w * own ** 2 + abs(k_own) * curve ** 2) / (w + abs(k_own))), 0.12, 2.0)
    return m, np.maximum(cv * m, 0.5)


def gcdf(x, m, sd):
    shape, scale = (m / sd) ** 2, sd ** 2 / m
    return np.where(x <= 0, 0.0, gammainc(shape, np.maximum(x, 0) / scale))


def mix(th):
    return 1 / (1 + np.exp(-th[8])), np.exp(th[9]), np.exp(th[10])


def mix_cdf(x, m, s, th):
    w, r, k = mix(th)
    mb = m / (1 - w + w * r)
    sb = s * mb / m
    return (1 - w) * gcdf(x, mb, sb) + w * gcdf(x, mb * r, sb * k)


def nll_mix(th, d):
    m, s = mean_sd(th, d)
    a = d.actual.values
    return -np.mean(np.log(np.maximum(mix_cdf(a + 0.5, m, s, th) - mix_cdf(a - 0.5, m, s, th), 1e-6)))


def td_mean(th, d):
    return np.maximum(abs(th[2]) * blend(th, d, np.nan_to_num(d.target.values)) * d.f.values ** th[3], 0.005)


def nll_td(th, d):
    m, a = td_mean(th, d), d.actual.values
    return -np.mean(a * np.log(m) - m - gammaln(a + 1))


def above_share(F, a, qs):
    lo, hi = F(a - 0.5), F(a + 0.5)
    w = np.maximum(hi - lo, 1e-12)
    return [float(np.mean(1 - np.clip((q - lo) / w, 0, 1))) for q in qs]


# ---------------------------------------------------------------- fit

def fit(df, train, test, only=None):
    if only:
        df = df[(df.pos + "|" + df.stat).isin(only)]
    tr_all, te_all = df[df.season.isin(train)], df[df.season.isin(test)]
    stats, checks = {}, {}
    qs = (0.25, 0.5, 0.75, 0.9, 0.95, 0.98, 0.99)
    for (pos, col), tr in tr_all.groupby(["pos", "stat"]):
        te = te_all[(te_all.pos == pos) & (te_all.stat == col)]
        if tr.kind.iloc[0] in COUNT_KINDS:
            r = minimize(nll_td, [4.0, 4.0, 1.0, 1.0], args=(tr,), method="Nelder-Mead", options={"maxiter": 4000})
            th = r.x
            stats[f"{pos}|{col}"] = {"k_prev": th[0], "k0": th[1], "c": th[2], "g": th[3]}
            if len(te):
                p1, hit = 1 - np.exp(-td_mean(th, te)), te.actual.values >= 1
                checks[f"{pos}|{col}"] = {"n": int(len(te)), "pred_1plus": float(p1.mean()), "actual_1plus": float(hit.mean())}
        else:
            mu0 = tr.actual.mean()
            th0 = np.array([4.0, 2.0, mu0, 1.0, 0.5, 0.7 * mu0 ** 0.3, 0.3, 30.0, -2.0, np.log(0.25), np.log(0.4)])
            th = th0
            for _ in range(2):   # restart once; Nelder-Mead stalls in 11 dimensions
                th = minimize(nll_mix, th, args=(tr,), method="Nelder-Mead",
                              options={"maxiter": 8000, "xatol": 1e-4, "fatol": 1e-7}).x
            w, rr, k = mix(th)
            stats[f"{pos}|{col}"] = {"k_prev": th[0], "k0": th[1], "mu": th[2], "c": th[3], "g": th[4],
                                     "a": th[5], "p": th[6], "k_own": min(abs(th[7]), 1e6),
                                     "w": float(w), "r": float(rr), "k": float(k)}
            if len(te):
                m, s = mean_sd(th, te)
                big = m >= np.quantile(m, 2 / 3)
                checks[f"{pos}|{col}"] = {
                    "n": int(len(te)), "logloss": round(float(nll_mix(th, te)), 4),
                    "share_above": dict(zip(map(str, qs), [round(v, 3) for v in above_share(lambda x: mix_cdf(x, m, s, th), te.actual.values, qs)])),
                    "share_above_top_third": dict(zip(map(str, qs), [round(v, 3) for v in above_share(
                        lambda x: mix_cdf(x, m[big], s[big], th), te.actual.values[big], qs)])),
                }
        print(pos, col, {k: round(float(v), 3) for k, v in stats[f"{pos}|{col}"].items()}, flush=True)
    clean = {k: {kk: round(float(vv), 5) for kk, vv in v.items()} for k, v in stats.items()}
    return clean, checks


def main():
    this = dt.date.today().year if dt.date.today().month >= 8 else dt.date.today().year - 1
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, nargs="+", default=[2022, 2023, 2024])
    ap.add_argument("--test", type=int, nargs="+", default=[2025, this])
    ap.add_argument("--only", nargs="+", help='refit just these, e.g. RB|receiving_tds; keep the rest of model_params.json')
    args = ap.parse_args()
    seasons = sorted(set(args.train) | set(args.test))
    with ProcessPoolExecutor() as ex:
        df = pd.concat(list(ex.map(season_rows, seasons)))
    stats, checks = fit(df, args.train, args.test, args.only)
    out = {"fitted_on": args.train, "tested_on": args.test, "fitted": dt.date.today().isoformat(), "stats": {}, "test": {}}
    if args.only:
        with open(OUT) as f:
            out = json.load(f)
        out.setdefault("refit", {}).update({k: dt.date.today().isoformat() for k in args.only})
    out["stats"].update(stats)
    out["test"].update(checks)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", OUT)
    print("\nHeld-out share of results above the model's percentile (ideal: .75 .5 .25 .1 .05 .02 .01)")
    for k, c in checks.items():
        if "share_above" in c:
            print(f"  {k:24s} all {list(c['share_above'].values())}  top third {list(c['share_above_top_third'].values())}")
        else:
            print(f"  {k:24s} anytime: model {c['pred_1plus']:.3f}  actual {c['actual_1plus']:.3f}")


if __name__ == "__main__":
    main()
