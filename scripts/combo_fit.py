"""Fit and backtest the spread + total combo model, and write site/combodata.js.

Not part of the hourly build. Run it once a season (needs scipy):

    python scripts/combo_fit.py                       # NFL + NBA (NBA pulls ~8,000 game files, ~5 min)
    python scripts/combo_fit.py --nba-cache lines.csv # reuse NBA lines saved by an earlier run

The combo callout prices a spread bet and a total bet together, so it needs the chance that both
hit, not just each one. Three ways to get that were tested on seasons the fit never saw:

  normal       the page's existing model: margin and total are two unrelated bell curves around
               the sportsbook line (NFL 13 / 13.5 points wide, NBA 12.5 / 18)
  bvn          the same with widths and a margin-total correlation fitted to past games
  kernel       past games with a similar spread and total, shifted onto this game's lines: their
               real final margins and totals, so NFL key numbers (3, 7, 10) and any link between
               a favorite covering and the total going over come along as they happened

Scored on every alternate line around each game (fav -0.5 to -19.5 style spreads, totals +/-12),
by log loss on which of the four outcomes (fav or dog covers x over or under) happened.

Findings (2026-11-12):
  NFL  the kernel wins (2015-2025 held out, 2,900 games): it fixes the normal's misses around key
       numbers. Where the two differ by 2+ points, the kernel was right: it said 22.9% and 38.3%,
       the normal said 25.6% and 35.5%, the results were 23.3% and 38.2%.
  NBA  nothing beats the plain normal (7,500 games with lines, 2018-19 to 2022-23 and 2025-27):
       margins have no key numbers and the margin-total correlation is about 0.01.
  Both the correlation between "favorite covers" and "over" is small (NFL 0.02-0.06 by era, NBA
       0.01), so a same-game spread + total combo is close to two separate bets. The model's value
       is pricing alternate lines right, not a hidden correlation.
  Vs. sportsbooks: betting the model's favorite combo every NFL game at closing odds (2010-2025)
       lost 8%, and the combos it rated +EV returned +3% +/- 6%: no edge against closing lines.
       Any edge has to come from Polymarket's price differing from the sportsbook consensus.
"""
import argparse
import io
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from scipy.stats import norm

OUT = os.path.join(os.path.dirname(__file__), "..", "site", "combodata.js")
NFL_GAMES = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"
SDV = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
UA = {"User-Agent": "nfl-matchup-tool (github pages)"}
NBA_SEASONS = range(2019, 2028)   # sportsdataverse season = year the season ends; 2024-25 have no lines
KERNEL = {"nfl": (3.0, 7.0)}      # bandwidths (spread, total) in points, picked by the backtest
NORMAL = {"nfl": (13.0, 13.5), "nba": (12.5, 18.0)}


def fetch(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- data

def orient(df):
    """Turn home-based rows (s = home favored by, m = home margin) into favorite-based ones."""
    flip = df.s < 0
    out = df.copy()
    out["S"] = np.where(flip, -df.s, df.s)
    out["M"] = np.where(flip, -df.m, df.m)
    return out


def nfl_games():
    g = pd.read_csv(io.BytesIO(fetch(NFL_GAMES)))
    g = g[g.result.notna() & g.spread_line.notna() & g.total_line.notna()]
    return orient(pd.DataFrame({"season": g.season, "s": g.spread_line, "m": g.result, "L": g.total_line, "T": g.total}))


def nba_lines(cache=None):
    """Closing spread and total for past NBA games, from the ESPN game files sportsdataverse keeps."""
    if cache and os.path.exists(cache):
        return pd.read_csv(cache)

    def one(r):
        try:
            j = json.loads(fetch(r["game_json_url"]))
        except Exception:
            return None
        for p in j.get("pickcenter") or []:
            mm = re.match(r"^\s*([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)\s*$", str(p.get("details") or ""))
            if p.get("overUnder") is None or not mm:
                continue
            tm, v = mm.group(1), float(mm.group(2))
            s = -v if tm == r["home_abbreviation"] else v if tm == r["away_abbreviation"] else None
            if s is None:
                continue
            return {"season": r["season"], "s": s, "m": r["home_score"] - r["away_score"],
                    "L": float(p["overUnder"]), "T": r["home_score"] + r["away_score"]}
        return None

    rows = []
    for season in NBA_SEASONS:
        try:
            d = pd.read_parquet(io.BytesIO(fetch(f"{SDV}/espn_nba_schedules/nba_schedule_{season}.parquet")))
        except Exception as e:
            print(f"NBA {season}: schedule unavailable ({e})")
            continue
        d = d[(d.status_type_completed == True) & d.season_type.isin([2, 3])]  # noqa: E712
        with ThreadPoolExecutor(32) as ex:
            got = [x for x in ex.map(one, d.to_dict("records")) if x]
        print(f"NBA {season}: {len(d)} games, {len(got)} with lines")
        rows += got
    out = pd.DataFrame(rows)
    if cache:
        out.to_csv(cache, index=False)
    return out


# ---------------------------------------------------------------- the models

Z = np.linspace(-6, 6, 601)
PHI = norm.pdf(Z) * (Z[1] - Z[0])


def bvn(S, L, xs, ys, sM, sT, rho=0.0):
    """P(fav margin > x and total > y) on a grid, plus the two single chances."""
    condT = 1 - norm.cdf((ys[None, :] - (L + rho * sT * Z[:, None])) / (sT * np.sqrt(1 - rho ** 2)))
    J = (((S + sM * Z)[:, None] > xs[None, :]) * PHI[:, None]).T @ condT
    return J, 1 - norm.cdf((xs - S) / sM), 1 - norm.cdf((ys - L) / sT)


def kernel(S, L, xs, ys, tr, hS, hL):
    """Past games weighted by how close their spread and total were, shifted onto this game's lines."""
    w = np.exp(-0.5 * ((tr.S.values - S) / hS) ** 2 - 0.5 * ((tr.L.values - L) / hL) ** 2)
    w /= w.sum()
    M = tr.M.values + (S - tr.S.values)
    T = tr["T"].values + (L - tr.L.values)
    A = (M[:, None] > xs[None, :]).astype(float)
    B = (T[:, None] > ys[None, :]).astype(float)
    return (A * w[:, None]).T @ B, w @ A, w @ B


def grid(S, L, sport):
    if sport == "nfl":
        return np.floor(S) + 0.5 + np.arange(-10, 10), np.floor(L) + 0.5 + np.arange(-12, 13, 2)
    return np.floor(S) + 0.5 + np.arange(-14, 15, 2), np.floor(L) + 0.5 + np.arange(-20, 21, 3)


# ---------------------------------------------------------------- backtest

def backtest(df, sport, tests):
    r_fit = {}
    models = {"normal": lambda S, L, xs, ys, tr, f: bvn(S, L, xs, ys, *NORMAL[sport]),
              "bvn": lambda S, L, xs, ys, tr, f: bvn(S, L, xs, ys, f["sM"], f["sT"], f["rho"])}
    if sport in KERNEL:
        models["kernel"] = lambda S, L, xs, ys, tr, f: kernel(S, L, xs, ys, tr, *KERNEL[sport])
    per = {k: [] for k in models}
    cal = {k: np.zeros((20, 3)) for k in models}
    for ts in tests:
        tr, te = df[df.season < ts], df[df.season == ts]
        if tr.empty or te.empty:
            continue
        rm, rt = tr.M - tr.S, tr["T"] - tr.L
        f = {"sM": rm.std(), "sT": rt.std(), "rho": np.corrcoef(rm, rt)[0, 1]}
        r_fit[int(ts)] = {k: round(float(v), 3) for k, v in f.items()}
        for g in te.itertuples():
            xs, ys = grid(g.S, g.L, sport)
            idx = (g.M > xs)[:, None].astype(int) * 2 + (g.T > ys)[None, :].astype(int)
            for name, fn in models.items():
                J, pm, pt = fn(g.S, g.L, xs, ys, tr, f)
                Q = np.clip(np.stack([1 - pm[:, None] - pt[None, :] + J, pt[None, :] - J, pm[:, None] - J, J]), 1e-4, 1)
                per[name].append(-np.log(np.take_along_axis(Q, idx[None], 0)[0]).mean())
                for k in range(4):
                    b = np.minimum((Q[k] * 20).astype(int), 19)
                    np.add.at(cal[name], (b, 0), 1)
                    np.add.at(cal[name], (b, 1), Q[k])
                    np.add.at(cal[name], (b, 2), idx == k)
    base = np.array(per["normal"])
    out = {"games": len(base), "tests": [int(t) for t in tests], "models": {}}
    for name, v in per.items():
        d = np.array(v) - base
        c = cal[name]
        # the 3x zone: combos the model gives a 20-40% chance
        zone = [{"pred": round(float(c[b, 1] / c[b, 0]), 4), "hit": round(float(c[b, 2] / c[b, 0]), 4)}
                for b in range(4, 8) if c[b, 0]]
        out["models"][name] = {"logloss": round(float(np.mean(v)), 5), "vs_normal": round(float(d.mean()), 5),
                               "se": round(float(d.std() / np.sqrt(len(d))), 5), "zone": zone}
        print(f"  {name:7s} log loss {np.mean(v):.5f}  vs normal {d.mean() * 1000:+.2f} +/- {d.std() / np.sqrt(len(d)) * 1000:.2f} (x1e-3)  "
              + "  ".join(f"{z['pred']:.3f}->{z['hit']:.3f}" for z in zone))
    rm, rt = df.M - df.S, df["T"] - df.L
    out["corr"] = round(float(np.corrcoef(rm, rt)[0, 1]), 3)
    out["sd"] = [round(float(rm.std()), 2), round(float(rt.std()), 2)]
    return out


# ---------------------------------------------------------------- output

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nba-cache", default=None, help="CSV of NBA lines to reuse (written on the first run)")
    ap.add_argument("--no-nba", action="store_true")
    args = ap.parse_args()

    nfl = nfl_games()
    print(f"NFL: {len(nfl)} games with lines, {nfl.season.min()}-{nfl.season.max()}")
    res = {"nfl": backtest(nfl, "nfl", range(2015, int(nfl.season.max()) + 1))}
    if not args.no_nba:
        nba = orient(nba_lines(args.nba_cache))
        print(f"NBA: {len(nba)} games with lines")
        res["nba"] = backtest(nba, "nba", sorted(nba.season.unique())[1:])

    # the page's copy of the NFL history: every game since 2006 (the modern scoring era), as
    # [fav spread x2, total line x2, fav margin, total] small integers
    h = nfl[nfl.season >= 2006]
    rows = np.stack([np.round(h.S * 2), np.round(h.L * 2), h.M, h["T"]], 1).astype(int).ravel().tolist()
    data = {"nfl": {"kernel": KERNEL["nfl"], "since": 2006, "n": len(h), "rows": rows},
            "nba": {"normal": NORMAL["nba"]}, "backtest": res,
            "fitted": pd.Timestamp.now().strftime("%Y-%m-%d")}
    with open(OUT, "w") as f:
        f.write("// Written by scripts/combo_fit.py: past NFL games for the spread + total combo model, and its backtest.\n")
        f.write("const COMBO_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n")
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
