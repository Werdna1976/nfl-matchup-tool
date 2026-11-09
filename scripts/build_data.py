"""Download this season's NFL data and write site/data/data.json for the web page.

Sources (all free, no keys):
  nflverse  - weekly player stats, team stats, schedule with betting lines, injuries
  ESPN      - fresher spread / total when reachable (optional)

Run:  python scripts/build_data.py            (current season)
      python scripts/build_data.py --season 2026
"""
import argparse
import datetime as dt
import io
import json
import math
import os
import sys
import urllib.request

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from model import (POSITION_STATS, COUNT_KINDS, TOTAL_SD, MARGIN_SD, PARAMS,  # noqa: E402
                   ewma, shrink, clip)

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
UA = {"User-Agent": "nfl-matchup-tool (github pages)"}

TEAM_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LA": "Los Angeles Rams", "LAC": "Los Angeles Chargers",
    "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}
ESPN_TO_NFLVERSE = {"WSH": "WAS", "LAR": "LA"}

# Short keys keep data.json small. The site maps them back to labels.
STAT_KEYS = {
    "attempts": "att", "completions": "cmp", "passing_yards": "pyd", "passing_tds": "ptd",
    "passing_interceptions": "int", "carries": "car", "rushing_yards": "ryd",
    "rushing_tds": "rtd", "targets": "tgt", "receptions": "rec",
    "receiving_yards": "yds", "receiving_tds": "td", "scrimmage_yards": "rry",
}
# extra game-log columns for the "Last 10" panel only (not modeled)
LOG_EXTRA = {
    "sacks_suffered": "sk", "passing_first_downs": "pfd", "passing_20": "p20", "passing_air_yards": "pay",
    "rushing_first_downs": "rfd", "rushing_10": "r10", "receiving_air_yards": "ray",
    "receiving_yards_after_catch": "yac", "receiving_first_downs": "cfd", "receiving_20": "c20",
    "fumbles_lost_total": "fl",
}


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def read_csv(url):
    return pd.read_csv(io.BytesIO(fetch(url)), low_memory=False)


def add_combos(stats):
    """Combined stats books offer as one prop: rushing + receiving yards. Also files fullbacks
    with the backs and two-way players listed on defense (Travis Hunter) with the receivers, so
    their catches and carries are projected instead of falling to "other players"."""
    if len(stats):
        stats.loc[stats.position == "FB", "position"] = "RB"
        tgts = stats.groupby("player_id").targets.sum()
        two_way = stats.player_id.isin(tgts[tgts >= 5].index) & ~stats.position.isin(["QB", "RB", "WR", "TE"])
        stats.loc[two_way, "position"] = "WR"
        stats["scrimmage_yards"] = stats.rushing_yards.fillna(0) + stats.receiving_yards.fillna(0)
    return stats


def load(season):
    stats = read_csv(f"{NFLVERSE}/stats_player/stats_player_week_{season}.csv")
    team = read_csv(f"{NFLVERSE}/stats_team/stats_team_week_{season}.csv")
    sched = read_csv(f"{NFLVERSE}/schedules/games.csv")
    try:
        inj = read_csv(f"{NFLVERSE}/injuries/injuries_{season}.csv")
    except Exception as e:  # injuries file can be missing early in a season
        print("injuries unavailable:", e)
        inj = pd.DataFrame()
    stats = add_combos(stats[stats.season_type == "REG"].copy())
    team = team[team.season_type == "REG"]
    sched = sched[(sched.season == season) & (sched.game_type == "REG")].copy()
    return stats, team, sched, inj


_IDS = None


def player_ids():
    """gsis_id -> {"pfr": ..., "espn": ...} from nflverse's player table ({} if the download fails).
    Snap counts are keyed by Pro Football Reference ids and ESPN news by ESPN ids."""
    global _IDS
    if _IDS is None:
        try:
            t = read_csv(f"{NFLVERSE}/players/players.csv")
            _IDS = {r.gsis_id: {"pfr": r.pfr_id if isinstance(r.pfr_id, str) else None,
                                "espn": str(int(r.espn_id)) if not pd.isna(r.espn_id) else None}
                    for r in t.itertuples() if isinstance(r.gsis_id, str)}
        except Exception as e:
            print("player id table unavailable:", e)
            _IDS = {}
    return _IDS


def load_snaps(season):
    """{gsis_id: {week: share of the team's offensive snaps}} for one regular season ({} on failure)."""
    try:
        s = read_csv(f"{NFLVERSE}/snap_counts/snap_counts_{season}.csv")
    except Exception as e:
        print(f"snap counts {season} unavailable:", e)
        return {}
    s = s[(s.game_type == "REG") & (s.offense_snaps > 0)]
    by_pfr = {}
    for r in s.itertuples():
        by_pfr.setdefault(r.pfr_player_id, {})[int(r.week)] = float(r.offense_pct)
    return {gid: by_pfr[x["pfr"]] for gid, x in player_ids().items() if x["pfr"] in by_pfr}


def snap_series(snaps, pid, season, before_week):
    """His offensive snap shares, oldest first: last season, then this season before `before_week`.
    snaps: (this season, last season) from load_snaps."""
    cur, prev = snaps
    old = [v for _, v in sorted(prev.get(pid, {}).items())]
    new = [v for w, v in sorted(cur.get(pid, {}).items()) if w < before_week]
    return old + new


def load_prev(season):
    """Last season's regular-season player stats (empty if the download fails)."""
    try:
        prev = read_csv(f"{NFLVERSE}/stats_player/stats_player_week_{season - 1}.csv")
        return add_combos(prev[prev.season_type == "REG"].copy())
    except Exception as e:
        print("last season's stats unavailable:", e)
        return pd.DataFrame()


# ---------------------------------------------------------------- context

def team_context(stats, team, sched, upto_week):
    """Per-team offense and defense averages from games before `upto_week`."""
    t = team[team.week < upto_week].copy()
    t["pass_plays"] = t.attempts + t.sacks_suffered
    t["plays"] = t.pass_plays + t.carries
    played = sched[(sched.week < upto_week) & sched.home_score.notna()]
    pts = pd.concat([
        played[["week", "home_team", "home_score", "away_score"]].set_axis(["week", "team", "pf", "pa"], axis=1),
        played[["week", "away_team", "away_score", "home_score"]].set_axis(["week", "team", "pf", "pa"], axis=1),
    ])
    t = t.merge(pts, on=["week", "team"], how="left")

    cols = ["plays", "pass_plays", "attempts", "completions", "carries", "passing_yards",
            "rushing_yards", "passing_tds", "rushing_tds", "passing_interceptions",
            "sacks_suffered", "passing_epa", "rushing_epa", "pf"]
    off = t.groupby("team")[cols].mean()
    off["games"] = t.groupby("team").size()
    # what each defense allowed = the offense rows of its opponents
    dfn = t.groupby("opponent_team")[cols].mean()
    dfn["games"] = t.groupby("opponent_team").size()
    margin = t.assign(m=t.pf - t.pa).groupby("team").m.mean()

    # yards allowed to each receiving position, per game
    s = stats[(stats.week < upto_week) & stats.position.isin(["RB", "WR", "TE"])]
    pos = (s.groupby(["opponent_team", "week", "position"])[["targets", "receptions", "receiving_yards", "receiving_tds"]]
           .sum().groupby(["opponent_team", "position"]).mean())

    league = off[cols].mean()
    league_pos = pos.groupby("position").mean()

    def per(row, a, b):
        return row[a] / row[b] if row[b] else 0.0

    lg = {
        "pass_rate": league.pass_plays / league.plays,
        "ypp": league.passing_yards / league.pass_plays,
        "ypc": league.rushing_yards / league.carries,
        "ptd_rate": league.passing_tds / league.pass_plays,
        "int_rate": league.passing_interceptions / league.attempts,
        "cmp_rate": league.completions / league.attempts,
        "pass_epa": league.passing_epa / league.pass_plays,
        "rush_epa": league.rushing_epa / league.carries,
        "ppg": league.pf,
        "plays": league.plays,
    }

    teams = {}
    for ab in TEAM_NAMES:
        if ab not in off.index:
            continue
        o, d = off.loc[ab], dfn.loc[ab] if ab in dfn.index else off.loc[ab]
        n = int(o.games)
        entry = {
            "games": n,
            "off": {
                "plays": o.plays, "pass_rate": per(o, "pass_plays", "plays"),
                "pass_ypg": o.passing_yards, "rush_ypg": o.rushing_yards,
                "ypp": per(o, "passing_yards", "pass_plays"), "ypc": per(o, "rushing_yards", "carries"),
                "pass_epa": per(o, "passing_epa", "pass_plays"), "rush_epa": per(o, "rushing_epa", "carries"),
                "att": o.attempts, "car": o.carries, "ppg": o.pf, "margin": float(margin.get(ab, 0.0)),
            },
            "def": {
                "plays": d.plays, "pass_rate": per(d, "pass_plays", "plays"),
                "pass_ypg": d.passing_yards, "rush_ypg": d.rushing_yards,
                "ypp": per(d, "passing_yards", "pass_plays"), "ypc": per(d, "rushing_yards", "carries"),
                "pass_epa": per(d, "passing_epa", "pass_plays"), "rush_epa": per(d, "rushing_epa", "carries"),
                "ptd_rate": per(d, "passing_tds", "pass_plays"),
                "int_rate": per(d, "passing_interceptions", "attempts"),
                "cmp_rate": per(d, "completions", "attempts"),
                "sacks": d.sacks_suffered, "ppg": d.pf, "games": int(d.games),
            },
            "pos_allowed": {},
        }
        for p in ["RB", "WR", "TE"]:
            if (ab, p) in pos.index:
                r = pos.loc[(ab, p)]
                lp = league_pos.loc[p]
                entry["pos_allowed"][p] = {
                    "ypt": r.receiving_yards / r.targets if r.targets else lp.receiving_yards / lp.targets,
                    "cr": r.receptions / r.targets if r.targets else lp.receptions / lp.targets,
                    "ypg": r.receiving_yards, "tgt": r.targets,
                }
        teams[ab] = entry
    for p in ["RB", "WR", "TE"]:
        lp = league_pos.loc[p]
        lg[f"ypt_{p}"] = lp.receiving_yards / lp.targets
        lg[f"cr_{p}"] = lp.receptions / lp.targets
        lg[f"ypg_{p}"] = lp.receiving_yards

    # matchup ratings: z-scores of EPA per play (offense high = good; defense low allowed = good)
    for side, key in [("off", "pass_epa"), ("off", "rush_epa"), ("def", "pass_epa"), ("def", "rush_epa")]:
        vals = [teams[a][side][key] for a in teams]
        mu = sum(vals) / len(vals)
        sd = (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5 or 1
        for a in teams:
            z = (teams[a][side][key] - mu) / sd
            teams[a].setdefault("rating", {})[f"{side}_{key.split('_')[0]}"] = round(z if side == "off" else -z, 2)
    return teams, lg


def prior_cvs(stats, upto_week):
    """Typical game-to-game spread (sd / mean) for each position and stat across the league."""
    s = stats[stats.week < upto_week]
    out = {}
    for pos, items in POSITION_STATS.items():
        ps = s[s.position == pos]
        for col, kind in items:
            if kind in COUNT_KINDS:
                continue
            g = ps.groupby("player_id")[col].agg(["mean", "std", "count"])
            g = g[(g["count"] >= 3) & (g["mean"] > {"QB": 5, "RB": 3, "WR": 2, "TE": 1.5}[pos])]
            cv = (g["std"] / g["mean"]).dropna()
            out[(pos, col)] = float(cv.median()) if len(cv) >= 5 else 0.5
    return out


TD_OPP = {"passing_tds": "attempts", "passing_interceptions": "attempts",
          "rushing_tds": "carries", "receiving_tds": "targets"}


def prior_rates(stats, upto_week):
    """League touchdown / interception rate per opportunity, by position."""
    s = stats[stats.week < upto_week]
    out = {}
    for pos, items in POSITION_STATS.items():
        ps = s[s.position == pos]
        for col, kind in items:
            if col in TD_OPP:
                opp = ps[TD_OPP[col]].sum()
                out[(pos, col)] = float(ps[col].sum() / opp) if opp else 0.0
    return out


def team_records(sched):
    """Win-loss record for every team from finished regular-season games (ties count as T).

    {team: {"w", "l", "t", "home": [w, l, t], "away": [w, l, t], "div": [w, l, t], "streak": "W3", "last5": "WLWWL"}}
    """
    out = {ab: {"w": 0, "l": 0, "t": 0, "home": [0, 0, 0], "away": [0, 0, 0], "div": [0, 0, 0], "res": []}
           for ab in TEAM_NAMES}
    played = sched[sched.home_score.notna() & sched.away_score.notna()].sort_values(["week", "gameday"])
    for r in played.itertuples():
        div = bool(getattr(r, "div_game", 0) == 1)
        for tm, mine, theirs, where in ((r.home_team, r.home_score, r.away_score, "home"),
                                        (r.away_team, r.away_score, r.home_score, "away")):
            if tm not in out:
                continue
            res = "W" if mine > theirs else "L" if mine < theirs else "T"
            i = "WLT".index(res)
            rec = out[tm]
            rec["wlt"[i]] += 1
            rec[where][i] += 1
            if div:
                rec["div"][i] += 1
            rec["res"].append(res)
    for rec in out.values():
        res = rec.pop("res")
        n = 0
        while n < len(res) and res[-1 - n] == res[-1]:
            n += 1
        rec["streak"] = f"{res[-1]}{n}" if res else ""
        rec["last5"] = "".join(res[-5:])
    return out


# ---------------------------------------------------------------- projection

def game_script(team, opp, teams, lg, team_margin, implied_pts):
    """Volume and scoring multipliers for `team` against `opp` in this game."""
    T, O = teams[team], teams[opp]
    plays_team = T["off"]["plays"]
    plays_proj = 0.5 * (plays_team + O["def"]["plays"])
    pr_team = T["off"]["pass_rate"]
    # opponents that force passing (good run D / high-scoring) raise pass rate; trailing teams pass more
    pr_proj = (pr_team + 0.5 * (O["def"]["pass_rate"] - lg["pass_rate"])
               - 0.007 * (team_margin - shrink(T["off"]["margin"], T["games"], 0.0, 4)))
    pr_proj = clip(pr_proj, 0.4, 0.75)
    pass_vol = clip(plays_proj * pr_proj / (plays_team * pr_team), 0.8, 1.25)
    rush_vol = clip(plays_proj * (1 - pr_proj) / (plays_team * (1 - pr_team)), 0.75, 1.3)
    avg_pts = shrink(T["off"]["ppg"], T["games"], lg["ppg"], 3)
    pts_factor = clip(implied_pts / avg_pts, 0.6, 1.5) if avg_pts else 1.0
    return {"pass_vol": pass_vol, "rush_vol": rush_vol, "pts": pts_factor,
            "pass_rate": pr_proj, "plays": plays_proj}


def rush_share(games):
    """Share of a player's scrimmage yards that come on the ground (0.7 with no yards yet)."""
    r, y = games.rushing_yards.fillna(0).clip(lower=0).sum(), games.receiving_yards.fillna(0).clip(lower=0).sum()
    return float(r / (r + y)) if r + y > 0 else 0.7


def stat_factor(col, kind, pos, opp, teams, lg, gs, share=0.7):
    if kind == "yards_scrim":
        return (share * stat_factor("rushing_yards", "yards_rush", pos, opp, teams, lg, gs)
                + (1 - share) * stat_factor("receiving_yards", "yards_rec", pos, opp, teams, lg, gs))
    D = teams[opp]["def"]
    n = D.get("games", teams[opp]["games"])
    if kind == "volume_pass":
        f = gs["pass_vol"]
        if col == "receptions":
            cr_d = teams[opp]["pos_allowed"].get(pos, {}).get("cr", lg.get(f"cr_{pos}", lg["cmp_rate"])) if pos != "QB" else D["cmp_rate"]
            cr_l = lg.get(f"cr_{pos}", lg["cmp_rate"])
            f *= shrink(cr_d / cr_l, n, 1, 6)
        if col == "completions":
            f *= shrink(D["cmp_rate"] / lg["cmp_rate"], n, 1, 6)
        return f
    if kind == "volume_rush":
        return gs["rush_vol"]
    if kind == "yards_pass":
        return gs["pass_vol"] * shrink(D["ypp"] / lg["ypp"], n, 1, 4)
    if kind == "yards_rush":
        return gs["rush_vol"] * shrink(D["ypc"] / lg["ypc"], n, 1, 4)
    if kind == "yards_rec":
        pa = teams[opp]["pos_allowed"].get(pos)
        eff = shrink(pa["ypt"] / lg[f"ypt_{pos}"], n, 1, 5) if pa else 1.0
        return gs["pass_vol"] * eff
    if kind in ("td_pass", "td_rush", "td_rec"):
        return gs["pts"]
    if kind == "int":
        return gs["pass_vol"] * shrink(D["int_rate"] / lg["int_rate"], n, 1, 8)
    return 1.0


def prev_summary(prev_stats):
    """Last season per player: {player_id: {stat: (games, per-game average)}}."""
    out = {}
    if prev_stats is None or not len(prev_stats):
        return out
    cols = [c for items in POSITION_STATS.values() for c, _ in items]
    cols = list(dict.fromkeys(cols))
    g = prev_stats.groupby("player_id")
    n, m = g.size(), g[cols].apply(lambda d: d.fillna(0).mean())
    for pid in n.index:
        out[pid] = {c: (int(n[pid]), float(m.loc[pid, c])) for c in cols}
    return out


def _blend(n, ew, prev, k_prev, k0, target):
    """Recent form, pulled toward last season (if he played 4+ games) and a baseline."""
    pn, pm = prev if prev else (0, 0.0)
    kp = abs(k_prev) * min(pn, 17) / 17 if pn >= 4 else 0.0
    den = n + kp + abs(k0)
    return (n * ew + kp * pm + abs(k0) * target) / den if den > 0 else target


# Snap-share trend: a player whose share of offensive snaps over his last 4 games is up (or down)
# on his last 12 keeps moving that way, and the stats-only average misses it. In 2024-26 backtests
# (scripts/trend_study.py, 17,000 results) players down 25%+ landed above the model's median 40%
# of the time and averaged 16% under it; players up 25%+ landed above it 57% and averaged 7% over.
# Fitted on 2024-25 (a drop carries further than a rise): each 10% of snap trend moves the
# projection 3.5% down or 2% up, capped at -14% / +8%.
SNAP_DOWN, SNAP_UP, SNAP_CAP = 0.35, 0.2, 0.4


def snap_trend(series):
    """(last-4 average / last-12 average) - 1 of his snap shares, or None (under 8 games or a
    last-12 share under 20%: special-teamers and rare fill-ins swing too much to read)."""
    s = series[-12:]
    if len(s) < 8:
        return None
    long = sum(s) / len(s)
    if long < 0.2:
        return None
    return sum(s[-4:]) / 4 / long - 1


# A partial game: a regular (median share of snaps 50%+ over his last 12 games) who played under
# half his usual share, e.g. Ja'Marr Chase's 20% in 2026 week 4 when he left hurt. These games
# stay in the averages and the snap trend: scripts/partial_study.py replayed 2023-26 and dropping
# them didn't make projections more accurate (MAE and log score unchanged overall). Players with
# one in their last 4 (not the latest) did beat the model by about 5%, but dropping it overshot.
# A player whose latest game was partial and who plays the next one averaged 14% under the model,
# though it swung by season (+15% in 2026), so that is shown as a note, not modeled.
PARTIAL_RATIO, PARTIAL_MIN = 0.5, 0.5


def partial_games(snaps, pid):
    """{(season offset, week): (share, his median)} for his partial games. Offset 0 is this season,
    -1 last season. snaps: (this season, last season) from load_snaps."""
    seq = [(o, w, v) for o, d in ((-1, snaps[1]), (0, snaps[0])) for w, v in sorted(d.get(pid, {}).items())]
    out = {}
    for i, (o, w, v) in enumerate(seq):
        win = sorted(x[2] for x in seq[max(0, i - 11): i + 1])
        if len(win) < 4:
            continue
        med = win[len(win) // 2]
        if med >= PARTIAL_MIN and v < PARTIAL_RATIO * med:
            out[(o, w)] = (v, med)
    return out


def project_player(games, pos, opp, teams, lg, gs, cvs, rates, calib=None, prev=None, depth=False, snap_t=None):
    """games: the player's per-game rows (oldest first). prev: his line from prev_summary().
    depth: a depth player (below the regular cutoffs). The fitted baseline is the average for
    regulars, so pulling him toward it would hand him a starter's share; his own recent games
    (and last season) are the baseline instead.

    Returns {stat: projection}. The average blends recent form, last season, and a baseline,
    then applies the matchup; the spread depends on how big the average is (bigger roles are
    steadier) and the shape mixes normal games with occasional dud games. All of these weights
    come from model_params.json (fitted on past seasons by fit_model.py).
    """
    out, raw = {}, {}
    n = len(games)
    prev = prev or {}
    share = rush_share(games)
    sf = 1.0 if snap_t is None else 1 + clip(snap_t, -SNAP_CAP, SNAP_CAP) * (SNAP_UP if snap_t > 0 else SNAP_DOWN)
    for col, kind in POSITION_STATS[pos]:
        vals = [float(v) for v in games[col].fillna(0)]
        base = ewma(vals)
        f = clip(stat_factor(col, kind, pos, opp, teams, lg, gs, share), 0.6, 1.5)
        raw[col] = max(base * f, 0.0)
        P = PARAMS.get("stats", {}).get(f"{pos}|{col}")
        if P is None:
            out[col] = _project_old(vals, col, kind, pos, f, out, cvs, rates, calib)
            continue
        if kind in COUNT_KINDS:
            target = rates.get((pos, col), 0.0) * raw.get(TD_OPP[col], 0.0)   # 0 for WR/TE rushing TDs
            b = _blend(n, base, prev.get(col), P["k_prev"], P["k0"], target)
            mean = max(abs(P["c"]) * b * f ** P["g"] * sf, 0.005)
            out[col] = {"mean": round(mean, 3), "sd": round(math.sqrt(mean), 3), "dist": "poisson", "f": round(f, 3)}
            continue
        b = _blend(n, base, prev.get(col), P["k_prev"], P["k0"], base if depth else abs(P["mu"]))
        mean = max(P["c"] * b * f ** P["g"] * sf, 0.05)
        curve = abs(P["a"]) * mean ** (-P["p"])
        m = sum(vals) / n if n else 0.0
        own = ((sum((v - m) ** 2 for v in vals) / (n - 1)) ** 0.5 / m) if n > 1 and m > 0 else curve
        w, k = max(n - 1, 0), abs(P["k_own"])
        # a fitted k_own of 0 means "trust his own spread"; with one game there is none, so use the curve
        cv = math.sqrt((w * own ** 2 + k * curve ** 2) / (w + k)) if w + k > 0 else curve
        cv = clip(cv * (calib or {}).get(col, 1.0), 0.12, 2.0)
        out[col] = {"mean": round(mean, 2), "sd": round(max(cv * mean, 0.5), 2), "dist": "gmix",
                    "w": round(P["w"], 3), "r": round(P["r"], 3), "k": round(P["k"], 3), "f": round(f, 3)}
    # a catch needs a target: small samples (or a stat-feed quirk) can put catches above targets
    rec, tgt = out.get("receptions"), out.get("targets")
    if rec and tgt and rec["mean"] > 0.95 * tgt["mean"]:
        r = 0.95 * tgt["mean"] / rec["mean"]
        rec["mean"], rec["sd"] = round(rec["mean"] * r, 2), round(max(rec["sd"] * r, 0.5), 2)
    return out


def _project_old(vals, col, kind, pos, f, out, cvs, rates, calib):
    """The original hand-set model, used only if model_params.json has no entry for a stat."""
    n = len(vals)
    mean = max(ewma(vals) * f, 0.0)
    if kind in COUNT_KINDS:
        vol = out.get(TD_OPP[col], {}).get("mean", 0.0)
        prior = rates.get((pos, col), 0.0) * vol * f
        mean = (n * mean + 4 * prior) / (n + 4)
        return {"mean": round(mean, 3), "sd": round(math.sqrt(mean), 3), "dist": "poisson", "f": round(f, 3)}
    prior = cvs.get((pos, col), 0.5)
    m = sum(vals) / n if n else 0
    cv_s = (sum((v - m) ** 2 for v in vals) / (n - 1)) ** 0.5 / m if n > 1 and m > 0 else prior
    k = 4
    cv = math.sqrt(((n - 1) * cv_s ** 2 + k * prior ** 2) / (n - 1 + k)) if n > 1 else prior
    cv *= math.sqrt(1 + 1 / max(n, 1))
    cv = clip(cv * (calib or {}).get(col, 1.0), 0.12, 2.0)
    return {"mean": round(mean, 2), "sd": round(max(cv * mean, 0.5), 2), "dist": "gamma", "f": round(f, 3)}


# Offensive touchdowns per point scored, 2024-2026 regular seasons (the rest is field goals,
# extra points, and defensive or return scores)
TD_PER_PT = 0.107
# Teams' targets run about 4.5% below pass attempts (throwaways, spikes, batted balls)
TGT_PER_ATT = 0.955


def team_projection(tm, opp, teams, lg, gs, implied):
    """The team's own line for this game, from team stats alone: pass attempts, completions,
    passing yards, carries, rushing yards, and offensive touchdowns.

    The page blends this with the sum of the player projections (50/50) and scales players so
    their stats add up to the blend. In 2024-2026 backtests the team-level numbers were closer to
    real team totals than summed player lines, and scaling receivers and runners to the blend
    made their own projections a little more accurate too.
    """
    T, O = teams[tm], teams[opp]
    nd = O["def"].get("games", O["games"])
    att = T["off"]["att"] * gs["pass_vol"]
    return {
        "att": att,
        "cmp": att * lg["cmp_rate"] * shrink(O["def"]["cmp_rate"] / lg["cmp_rate"], nd, 1, 6),
        "pyd": T["off"]["pass_ypg"] * gs["pass_vol"] * shrink(O["def"]["ypp"] / lg["ypp"], nd, 1, 4),
        "car": T["off"]["car"] * gs["rush_vol"],
        "ryd": T["off"]["rush_ypg"] * gs["rush_vol"] * shrink(O["def"]["ypc"] / lg["ypc"], nd, 1, 4),
        "tds": implied * TD_PER_PT,
        "pts": implied,
    }


def listed_share(stats, team_stats, tm, pids, upto_week, n_games=3):
    """Share of the team's recent totals (its last `n_games` games, the
    same window that decides who is listed) that the listed players produced.

    The rest belongs to players too small to list (practice-squad call-ups, linemen on trick plays,
    fullbacks), so the listed players add up to the team total times this share and an "other
    players" line on the page carries the rest. Recent games keep players who have left the team
    (cut, traded, on injured reserve) from counting as "other". Touchdowns are too rare to measure
    over three games, so they follow the matching volume share.
    """
    weeks = sorted(team_stats[(team_stats.team == tm) & (team_stats.week < upto_week)].week.unique())[-n_games:]
    s = stats[(stats.team == tm) & stats.week.isin(weeks)]
    t = team_stats[(team_stats.team == tm) & team_stats.week.isin(weeks)]
    mine = s[s.player_id.isin(pids)]
    out = {}
    for col, short, group in (("carries", "car", None), ("rushing_yards", "ryd", None),
                              ("targets", "tgt", "rec"), ("receptions", "rec", "rec"),
                              ("receiving_yards", "yds", "rec")):
        tot = float(t[col].sum())
        rows = mine[mine.position != "QB"] if group else mine
        out[short] = clip(float(rows[col].fillna(0).sum()) / tot, 0.85, 1.0) if tot > 0 else 0.98
    out["rtd"], out["td"] = out["car"], out["tgt"]
    return out


def game_model(home, away, teams, lg, spread_line, total_line):
    """Model points for each side, blended with the betting market (market weighted 80%)."""
    H, A = teams[home], teams[away]

    def pts(o, d):
        off = shrink(o["off"]["ppg"], o["games"], lg["ppg"], 3)
        dfa = shrink(d["def"]["ppg"], d["games"], lg["ppg"], 3)
        return off + dfa - lg["ppg"]

    h_raw, a_raw = pts(H, A) + 0.8, pts(A, H) - 0.8   # ~1.5 pt home edge
    model_total, model_margin = h_raw + a_raw, h_raw - a_raw
    if total_line is None or (isinstance(total_line, float) and math.isnan(total_line)):
        total, margin = model_total, model_margin
    else:
        total = 0.8 * total_line + 0.2 * model_total
        margin = 0.8 * spread_line + 0.2 * model_margin
    return {
        "model_total": round(model_total, 1), "model_margin": round(model_margin, 1),
        "total": {"mean": round(total, 2), "sd": TOTAL_SD, "dist": "normal"},
        "margin": {"mean": round(margin, 2), "sd": MARGIN_SD, "dist": "normal"},
        "home_pts": round((total + margin) / 2, 1), "away_pts": round((total - margin) / 2, 1),
    }


# ---------------------------------------------------------------- optional live sources

def espn_lines(season, week):
    """{(away, home): (spread_line, total_line, provider)} using nflverse's sign (home favored > 0)."""
    url = (f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
           f"?seasontype=2&week={week}&dates={season}")
    out = {}
    try:
        data = json.loads(fetch(url, 20))
    except Exception as e:
        print("ESPN unavailable:", e)
        return out
    for ev in data.get("events", []):
        try:
            comp = ev["competitions"][0]
            teams = {c["homeAway"]: ESPN_TO_NFLVERSE.get(c["team"]["abbreviation"], c["team"]["abbreviation"])
                     for c in comp["competitors"]}
            odds = (comp.get("odds") or [None])[0]
            if not odds or odds.get("overUnder") is None or odds.get("spread") is None:
                continue
            # ESPN's `spread` is the home team's line: -3.5 means home favored by 3.5
            out[(teams["away"], teams["home"])] = (-float(odds["spread"]), float(odds["overUnder"]),
                                                   (odds.get("provider") or {}).get("name", "ESPN"))
        except Exception:
            continue
    print(f"ESPN lines for {len(out)} games")
    return out


# ---------------------------------------------------------------- assemble

def current_week(sched):
    upcoming = sched[sched.home_score.isna()]
    return int(upcoming.week.min()) if len(upcoming) else int(sched.week.max())


def eligible_players(stats, team, upto_week, depth=False):
    """Skill players with a recent role on `team`. With depth=True (the page), depth backs and
    receivers stay in so the team's catches and carries add up; at those cutoffs the listed
    players took about 99% of their team's recent targets and carries (91-92% without them).
    Backtests and the model fit keep the regular cutoffs."""
    rb_min, rec_min = (1, 0.5) if depth else (3, 2)
    s = stats[(stats.week < upto_week) & stats.position.isin(POSITION_STATS)]
    team_weeks = sorted(s[s.team == team].week.unique())[-3:]
    recent = s[(s.team == team) & s.week.isin(team_weeks)]
    keep = []
    for pid, g in recent.groupby("player_id"):
        pos = g.position.iloc[0]
        allg = s[s.player_id == pid].sort_values("week")
        if pos == "QB" and g.attempts.max() < 10:
            continue
        if pos == "RB" and ewma(list((allg.carries + allg.targets).fillna(0))) < rb_min:
            continue
        if pos in ("WR", "TE") and ewma(list(allg.targets.fillna(0))) < rec_min:
            continue
        keep.append(pid)
    return keep


# ---------------------------------------------------------------- depth chart

# Listing players by their recent stats alone leaves holes: a backup QB who hasn't thrown in three
# games (the Vikings' Carson Wentz behind Kyler Murray) and a receiver who just joined or hasn't
# been targeted (Odell Beckham Jr.) never show up, so when the starter is out there is nobody to
# hand his volume to. The team's current depth chart (nflverse, refreshed daily from ESPN) fills
# those spots: at each position the page lists players down the chart until this many of them are
# healthy. Out, Doubtful and Questionable players don't count toward it, so the next man up is
# always there. Injured-reserve players are skipped.
DEPTH_KEEP = {"QB": 2, "RB": 3, "WR": 5, "TE": 3}
DEPTH_POS = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE"}
HURT = ("Out", "Doubtful", "Questionable")


def load_depth_charts(season):
    """{team: [{"pid", "name", "pos", "rank"}]} offensive skill players from each team's latest
    nflverse depth chart, in chart order within each position. {} if the download fails."""
    try:
        d = read_csv(f"{NFLVERSE}/depth_charts/depth_charts_{season}.csv")
    except Exception as e:
        print("depth charts unavailable:", e)
        return {}
    if not {"dt", "team", "gsis_id", "pos_abb", "pos_rank", "pos_grp"} <= set(d.columns):
        print("depth charts: unexpected columns, skipped")
        return {}
    d = d[d.dt == d.groupby("team").dt.transform("max")]
    d = d[d.pos_abb.isin(DEPTH_POS) & d.gsis_id.notna() & ~d.pos_grp.str.contains("Special|D$", na=False)]
    out = {}
    for tm, g in d.sort_values(["pos_rank", "pos_slot"]).groupby("team"):
        seen, rows = set(), []
        for x in g.itertuples():
            if x.gsis_id in seen:
                continue
            seen.add(x.gsis_id)
            rows.append({"pid": x.gsis_id, "name": x.player_name, "pos": DEPTH_POS[x.pos_abb], "rank": int(x.pos_rank)})
        out[ESPN_TO_NFLVERSE.get(tm, tm)] = rows
    return out


def depth_adds(chart, hurt, on_ir):
    """Players from one team's depth chart to list: down each position until DEPTH_KEEP of them
    are healthy. hurt(pid) / on_ir(pid) say whether he is on the injury report / injured reserve."""
    healthy, picks = {}, []
    for e in chart:
        pos = e["pos"]
        if healthy.get(pos, 0) >= DEPTH_KEEP[pos] or on_ir(e["pid"]):
            continue
        picks.append(e)
        if not hurt(e["pid"]):
            healthy[pos] = healthy.get(pos, 0) + 1
    return picks


# ---------------------------------------------------------------- players coming back

# A back or receiver who missed 2+ games hurt drops off the page (only players from the team's last
# three games are listed), and the fill-ins' projections ride the games they started. When he is
# back, both are wrong: the Jets' week-9 page had no Breece Hall and gave Braelon Allen his
# five-game starter's workload. scripts/return_study.py measured 600+ returns (2020-2026, leave
# one season out):
#   - his first game back he gets about 0.85 of his old carries and 0.83 of his old targets
#     (then all of it)
#   - the fill-ins give back part of what they gained while he was out: theta x their share of
#     his returning volume. Fill-in backs' misses on carries drop from 4.25 to 3.47 a game in his
#     first game back (3.7 vs 4.4 in games 2-3, while their averages still carry the old role);
#     receivers' targets improve a little (2.07 -> 1.99)
RET_MU = {"carries": 0.85, "targets": 0.83}
RET_SHARE = {"carries": (0.83, 0.94, 0.99), "targets": (0.83, 0.93, 0.99)}   # his share back, games 1-3
RET_THETA = {"carries": (0.65, 0.55, 0.55), "targets": (0.55, 0.30, 0.35)}
RET_MIN = {"carries": 0.25, "targets": 0.12}   # his share before he got hurt, to count as a role
RET_GROUP = {"RB": ("RB",), "WR": ("WR", "TE"), "TE": ("WR", "TE")}
RET_VOL = {"RB": ("carries", "targets"), "WR": ("targets",), "TE": ("targets",)}
# News about his role (scripts/news_build.py role signals) can't be backtested: there is no
# archive of old feeds. These are set by hand and kept modest; the page shows each one with its story.
NEWS_MU = {"start": 1.0, "lim": 0.6}   # returning player named the starter / on a snap count
NEWS_UP, NEWS_DOWN = 1.15, 0.85        # anyone else named the starter / benched or losing work
RIDES = {"carries": ("carries", "rushing_yards", "rushing_tds"),
         "targets": ("targets", "receptions", "receiving_yards", "receiving_tds")}
VOL_KEY = {"carries": "car", "targets": "tgt"}


def load_rosters(season, info=None):
    """{gsis_id: {week: roster status}} from nflverse weekly rosters (ACT, RES = injured reserve,
    INA = inactive, DEV = practice squad, ...). {} if the download fails. If `info` is a dict, it is
    filled with each player's latest row: {gsis_id: {"name", "team", "pos", "img", "status"}}."""
    try:
        r = read_csv(f"{NFLVERSE}/weekly_rosters/roster_weekly_{season}.csv")
    except Exception as e:
        print("weekly rosters unavailable:", e)
        return {}
    out = {}
    for x in r[r.game_type == "REG"].sort_values("week").itertuples():
        if isinstance(x.gsis_id, str):
            out.setdefault(x.gsis_id, {})[int(x.week)] = x.status
            if info is not None:
                info[x.gsis_id] = {"name": x.full_name, "team": x.team, "pos": x.position, "status": x.status,
                                   "img": x.headshot_url if isinstance(x.headshot_url, str) else None,
                                   "espn": str(int(x.espn_id)) if not pd.isna(x.espn_id) else None}
    return out


def load_news(path=None):
    """NFL player stories from site/data/news.json, filed by gsis id ({} without the file)."""
    path = path or os.path.join(os.path.dirname(__file__), "..", "site", "data", "news.json")
    try:
        with open(path) as f:
            return json.load(f).get("nfl", {}).get("players", {})
    except (OSError, ValueError):
        return {}


def news_roles(items, since):
    """{signal: newest story with it} among stories since `since` (unix time). A newer "out"
    cancels an older "ret" and the other way around."""
    out = {}
    for it in sorted(items or [], key=lambda i: i.get("t", 0)):
        if it.get("t", 0) < since:
            continue
        for k in it.get("r", []):
            out[k] = it
    if "out" in out and "ret" in out:
        out.pop("ret" if out["out"]["t"] >= out["ret"]["t"] else "out")
    return out


def _story(it):
    return {k: it[k] for k in ("h", "s", "u", "t") if it.get(k) is not None}


def scale_proj(proj, vol, r):
    """Scale a player's volume (carries or targets) and the stats that ride on it by r, keeping
    each stat's shape; rushing + receiving yards follow the two parts."""
    if not proj or abs(r - 1) < 1e-9:
        return
    before = {c: proj[c]["mean"] for c in ("rushing_yards", "receiving_yards") if c in proj}
    for c in RIDES[vol]:
        d = proj.get(c)
        if not d:
            continue
        d["mean"] = round(d["mean"] * r, 3)
        d["sd"] = round(math.sqrt(d["mean"]), 3) if d.get("dist") == "poisson" else round(max(d["sd"] * r, 0.5), 2)
    sc = proj.get("scrimmage_yards")
    if sc and before:
        old = sum(before.values())
        new = sum(proj[c]["mean"] for c in before)
        if old > 0:
            sc["mean"] = round(sc["mean"] * new / old, 2)
            sc["sd"] = round(max(sc["sd"] * new / old, 0.5), 2)


def team_shares(stats, team_stats, tm, upto_week):
    """({(pid, week, vol): share of the team's carries/targets}, team weeks before upto_week)."""
    t = team_stats[(team_stats.team == tm) & (team_stats.week < upto_week)].set_index("week")
    s = stats[(stats.team == tm) & (stats.week < upto_week)]
    out = {}
    for r in s.itertuples():
        for v in ("carries", "targets"):
            tot = t.at[r.week, v] if r.week in t.index else 0
            x = getattr(r, v)
            if tot and tot > 0:
                out[(r.player_id, int(r.week), v)] = (0.0 if pd.isna(x) else float(x)) / float(tot)
    return out, sorted(int(w) for w in t.index)


def find_returns(stats, tm, w, wks, shares, inj, rosters, news, since):
    """Players back (or coming back) from 2+ missed games, for team `tm`'s game in week `w`.
    [{pid, pos, k (games played since), gap, pre {vol: share before}, why, news}]

    k = 0 (hasn't played yet) needs a sign he plays this week: on this week's injury report
    without Out/Doubtful (Breece Hall: full practice, no status), or a news story saying he's back;
    and no sign he doesn't (Out/Doubtful, IR or inactive this week, a newer "ruled out" story).
    The missed games need a sign he was hurt (Out/Doubtful, IR, or inactive), not benched."""
    s = stats[(stats.team == tm) & (stats.week < w) & stats.position.isin(list(RET_GROUP))]
    inj_by = {}
    if len(inj):
        for r in inj[inj.team == tm].itertuples():
            inj_by[(r.gsis_id, int(r.week))] = r
    out = []
    for pid, g in s.groupby("player_id"):
        pos = g.position.iloc[-1]
        pw = set(int(x) for x in g.week)
        k = 0
        while k < len(wks) and wks[-1 - k] in pw:
            k += 1
        if k > 2:
            continue
        gap = []
        for x in reversed(wks[:len(wks) - k]):
            if x in pw:
                break
            gap.append(x)
        pre = [x for x in wks[:len(wks) - k - len(gap)] if x in pw][-4:]
        if len(gap) < 2 or len(pre) < 2:
            continue
        hurt = any(getattr(inj_by.get((pid, x)), "report_status", None) in ("Out", "Doubtful")
                   or rosters.get(pid, {}).get(x) in ("RES", "INA") for x in gap)
        if not hurt:
            continue
        pre_sh = {v: sum(shares.get((pid, x, v), 0) for x in pre) / len(pre) for v in RET_VOL[pos]}
        if not any(pre_sh[v] >= RET_MIN[v] for v in pre_sh):
            continue
        sig = news_roles(news.get(pid), since)
        why = []
        if k == 0:
            r = inj_by.get((pid, w)) or inj_by.get((pid, w - 1))   # next week's report isn't out yet
            status = getattr(r, "report_status", None) if r is not None else None
            status = status if isinstance(status, str) else None
            practice = getattr(r, "practice_status", None) if r is not None else None
            if status in ("Out", "Doubtful") or rosters.get(pid, {}).get(w) in ("RES", "INA") or "out" in sig:
                continue
            if r is not None:
                why.append(f"week {r.week} injury report: {status or 'no game status'}"
                           + (f", {practice.lower()}" if isinstance(practice, str) else ""))
            if r is None and "ret" not in sig:
                continue
        out.append({"pid": pid, "pos": pos, "k": k, "gap": len(gap), "pre": pre_sh, "why": why, "news": sig,
                    "pre_wks": pre, "gap_wks": gap})
    return out


def apply_returns(rets, tm, gid, listed, players, shares, project):
    """Add the returning players to the game and take back the volume the fill-ins gained.
    project(pid) -> his projection from his own games. Records each change in players[pid]["adj"]."""
    touched = set()
    for R in rets:
        pid, k = R["pid"], R["k"]
        name = players[pid]["name"]
        if k == 0:
            if pid not in listed:
                listed.append(pid)
                players[pid]["proj"][gid] = project(pid)
            vols = RET_VOL[R["pos"]]
            usual = " and ".join(f"{round(100 * RET_MU[v])}% of his usual {v}" for v in vols)
            mu, back, note = {v: RET_MU[v] for v in vols}, None, f"Back after missing {R['gap']} games: first game back gets {usual} (how 600+ returns went in 2020-26)"
            st = R["news"]
            if "start" in st and "lim" not in st:
                mu, back = {v: NEWS_MU["start"] for v in vols}, 1.0
                note = f"Back after missing {R['gap']} games and named the starter in the news: his full usual role"
            elif "lim" in st and "start" not in st:
                mu, back = {v: NEWS_MU["lim"] for v in vols}, NEWS_MU["lim"]
                note = f"Back after missing {R['gap']} games, eased back in per the news: {round(100 * NEWS_MU['lim'])}% of his usual role"
            R["back"] = back
            fm = players[pid].get("form") or {}
            fm.pop("sf", None), fm.pop("st", None)   # his snap trend spans the injury: not used, not shown
            proj = players[pid]["proj"][gid]
            chg = {}
            for v in vols:
                a = proj[v]["mean"]
                scale_proj(proj, v, mu[v])
                chg[VOL_KEY[v]] = [round(a, 2), round(proj[v]["mean"], 2)]
            players[pid].setdefault("adj", {}).setdefault(gid, []).append({
                "kind": "return", "txt": note, "f": {VOL_KEY[v]: mu[v] for v in vols}, "chg": chg,
                "why": R["why"], "news": list({it["h"]: _story(it) for kk, it in R["news"].items() if kk in ("ret", "start", "lim")}.values())[:2]})
            touched.add(pid)
        # the fill-ins: same position group, played at least 2 of the games he missed
        for v in RET_VOL[R["pos"]]:
            ms = []
            for m in listed:
                if m == pid or players[m]["pos"] not in RET_GROUP[R["pos"]] or gid not in players[m]["proj"]:
                    continue
                on = [x for x in R["gap_wks"] if (m, x, v) in shares][:4]
                if len(on) < 2:
                    continue
                wo = sum(shares[(m, x, v)] for x in on) / len(on)
                both = [x for x in R["pre_wks"] if (m, x, v) in shares]
                wi = sum(shares[(m, x, v)] for x in both) / len(both) if both else None
                if wo >= 0.05:
                    ms.append((m, wo, wi))
            if not ms or R["pre"].get(v, 0) <= 0:
                continue
            gains = [max(0.0, wo - wi) if wi is not None else None for _, wo, wi in ms]
            if all(gg is not None for gg in gains) and sum(gains) > 0:
                wts = [gg / sum(gains) for gg in gains]
            else:
                wts = [wo / sum(x[1] for x in ms) for _, wo, _ in ms]
            for (m, wo, wi), wt in zip(ms, wts):
                # named the starter: he takes all of his old share back (eased in: less)
                c = min(1.0, (R.get("back") or RET_SHARE[v][k]) * R["pre"][v] * wt / wo)
                r = 1 - RET_THETA[v][k] * c
                if r > 0.98:
                    continue
                a = players[m]["proj"][gid][v]["mean"]
                scale_proj(players[m]["proj"][gid], v, r)
                back = "is back" if k == 0 else f"is {k} game{'s' if k > 1 else ''} back"
                had = f"{round(100 * wo)}% of the team's {v} while he was out" + (f", {round(100 * wi)}% with him" if wi is not None else "")
                players[m].setdefault("adj", {}).setdefault(gid, []).append({
                    "kind": "fill", "by": pid, "f": {VOL_KEY[v]: round(r, 3)},
                    "chg": {VOL_KEY[v]: [round(a, 2), round(players[m]["proj"][gid][v]["mean"], 2)]},
                    "txt": f"{name} {back}: {v} {round(100 * (r - 1))}% ({had})"})
                touched.add(m)
    return touched


def apply_news(listed, gid, players, news, since, touched):
    """Nudge players whose role news says up or down (not the ones the return math already moved)."""
    for pid in listed:
        p = players[pid]
        if pid in touched or p["pos"] not in RET_VOL or gid not in p["proj"]:
            continue
        sig = news_roles(news.get(pid), since)
        up, down = "start" in sig, "down" in sig or "lim" in sig
        if up == down:
            continue
        r = NEWS_UP if up else NEWS_DOWN
        it = sig["start"] if up else sig.get("down") or sig["lim"]
        chg = {}
        for v in RET_VOL[p["pos"]]:
            a = p["proj"][gid][v]["mean"]
            scale_proj(p["proj"][gid], v, r)
            chg[VOL_KEY[v]] = [round(a, 2), round(p["proj"][gid][v]["mean"], 2)]
        p.setdefault("adj", {}).setdefault(gid, []).append({
            "kind": "news", "f": {VOL_KEY[v]: r for v in RET_VOL[p["pos"]]}, "news": [_story(it)], "chg": chg,
            "txt": f"{'Bigger' if up else 'Smaller'} role in the news: {'+' if up else '-'}{round(abs(r - 1) * 100)}% on his volume (a set nudge, not backtested)"})


def form_line(pid, games, prev_raw, snaps, season, week, pos):
    """Last 4 vs. last 12 games (across seasons) for his main stats and snap share, for the page's
    form notes. Only the snap-share trend moves the projection (see SNAP_DOWN); streaks in the
    stats themselves are already in the recency-weighted average and backtest as noise."""
    if pos not in POSITION_STATS:
        return None
    old = prev_raw[prev_raw.player_id == pid].sort_values("week") if len(prev_raw) else games.iloc[:0]
    both = pd.concat([old, games]).tail(12)
    if len(both) < 6:
        return None
    out = {"n": int(len(both)), "l4": {}, "l12": {}}
    for col, _ in POSITION_STATS[pos]:
        v = both[col].fillna(0)
        out["l4"][STAT_KEYS[col]] = round(float(v.tail(4).mean()), 2)
        out["l12"][STAT_KEYS[col]] = round(float(v.mean()), 2)
    sn = snap_series(snaps, pid, season, week + 1)[-12:]
    if len(sn) >= 6:
        out["snp4"], out["snp12"] = round(100 * sum(sn[-4:]) / 4, 1), round(100 * sum(sn) / len(sn), 1)
        # partial games (left early, ejected, rested) among his last 4 snap games, for the notes
        cur = [(0, w) for w in sorted(snaps[0].get(pid, {})) if w <= week]
        last4 = ([(-1, w) for w in sorted(snaps[1].get(pid, {}))] + cur)[-4:]
        part = partial_games(snaps, pid)
        p4 = [k for k in last4 if k in part]
        if p4:
            full = [snaps[0 if o == 0 else 1][pid][w] for o, w in last4 if (o, w) not in part]
            out["part"] = [{"w": w, "ly": o == -1, "snp": round(100 * part[(o, w)][0]),
                            "med": round(100 * part[(o, w)][1])} for o, w in p4]
            if full:
                out["snp4x"] = round(100 * sum(full) / len(full), 1)   # last 4 without them
            out["part_last"] = last4[-1] in part
        st = snap_trend(sn)
        if st is not None:
            out["st"] = round(st, 3)
            out["sf"] = round(1 + clip(st, -SNAP_CAP, SNAP_CAP) * (SNAP_UP if st > 0 else SNAP_DOWN), 3)
    return out


def rest_days(sched, team, day):
    """Days since the team's previous game this season (None in week 1)."""
    s = sched[((sched.home_team == team) | (sched.away_team == team)) & (sched.gameday < day)]
    if s.empty:
        return None
    return int((pd.Timestamp(day) - pd.Timestamp(s.gameday.max())).days)


def build(season):
    stats, team_stats, sched, inj = load(season)
    week = current_week(sched)
    weeks = [w for w in (week, week + 1) if w in set(sched.week)]
    teams, lg = team_context(stats, team_stats, sched, week)
    for ab, rec in team_records(sched).items():
        if ab in teams:
            teams[ab]["record"] = rec
    cvs = prior_cvs(stats, week)
    rates = prior_rates(stats, week)
    prev_raw = load_prev(season)
    prev = prev_summary(prev_raw)
    snaps = load_snaps(season), load_snaps(season - 1)
    roster_info = {}
    rosters, news = load_rosters(season, roster_info), load_news()
    charts = load_depth_charts(season)
    calib = None   # spreads come from model_params.json, fitted on past seasons

    inj_latest = {}
    if len(inj):
        ii = inj[inj.week <= week].sort_values("week")
        for r in ii.itertuples():
            inj_latest[r.gsis_id] = {"wk": int(r.week), "status": r.report_status if isinstance(r.report_status, str) else None,
                                     "injury": r.report_primary_injury if isinstance(r.report_primary_injury, str) else None,
                                     "practice": r.practice_status if isinstance(r.practice_status, str) else None}

    players = {}
    for pid, g in stats[stats.position.isin(POSITION_STATS)].groupby("player_id"):
        g = g.sort_values("week")
        last = g.iloc[-1]
        log = []
        part = partial_games(snaps, pid)
        for r in g.itertuples():
            row = {"w": int(r.week), "opp": r.opponent_team, "tm": r.team}
            for col, short in STAT_KEYS.items():
                v = getattr(r, col)
                row[short] = 0 if pd.isna(v) else int(v)
            for col, short in LOG_EXTRA.items():
                v = getattr(r, col, None)
                if v is not None and not pd.isna(v):
                    row[short] = int(v)
            ts = getattr(r, "target_share", None)
            if ts is not None and not pd.isna(ts):
                row["tsh"] = int(round(ts * 100))   # share of the team's targets, in percent
            sp = snaps[0].get(pid, {}).get(int(r.week))
            if sp is not None:
                row["snp"] = int(round(sp * 100))   # share of the team's offensive snaps, in percent
                if (0, int(r.week)) in part:
                    row["part"] = round(100 * part[(0, int(r.week))][1])   # partial game: his usual share
            log.append(row)
        players[pid] = {"name": last.player_display_name, "pos": last.position, "team": last.team,
                        "img": last.headshot_url if isinstance(last.headshot_url, str) else None,
                        "log": log, "proj": {}, "form": form_line(pid, g, prev_raw, snaps, season, week, last.position)}
        if pid in inj_latest and inj_latest[pid]["wk"] >= week - 1:
            players[pid]["inj"] = inj_latest[pid]

    # the depth chart: who is on each team now (traded players move), plus players who have no
    # stats yet this season (a backup QB who hasn't thrown, a receiver just signed)
    on_chart = {}
    for tm, rows in charts.items():
        for e in rows:
            on_chart.setdefault(e["pid"], []).append((tm, e))
    for pid, where in on_chart.items():
        if len(where) != 1:
            continue
        tm, e = where[0]
        if pid not in players:
            ri = roster_info.get(pid, {})
            players[pid] = {"name": ri.get("name") or e["name"], "pos": e["pos"], "team": tm, "img": ri.get("img"),
                            "log": [], "proj": {}, "form": None}
            if pid in inj_latest and inj_latest[pid]["wk"] >= week - 1:
                players[pid]["inj"] = inj_latest[pid]
        players[pid]["team"] = tm
        players[pid]["dc"] = e["rank"]   # depth-chart rank at his position (1 = starter)

    def hurt(pid):
        return (players.get(pid, {}).get("inj") or {}).get("status") in HURT

    def on_ir(pid):
        return roster_info.get(pid, {}).get("status") == "RES"

    espn = {}
    games = []
    for w in weeks:
        espn.update(espn_lines(season, w))
        for r in sched[sched.week == w].sort_values(["gameday", "gametime"]).itertuples():
            home, away = r.home_team, r.away_team
            spread, total, src = r.spread_line, r.total_line, "nflverse (consensus)"
            if (away, home) in espn:
                spread, total, src = espn[(away, home)]
            spread = None if pd.isna(spread) else float(spread)
            total = None if pd.isna(total) else float(total)
            gm = game_model(home, away, teams, lg, spread or 0.0, total)
            rest = {tm: rest_days(sched, tm, r.gameday) for tm in (home, away)}
            game = {
                "id": r.game_id, "week": int(w), "day": r.gameday, "time": r.gametime,
                "home": home, "away": away, "spread": spread, "total": total, "line_src": src,
                "home_ml": None if pd.isna(r.home_moneyline) else int(r.home_moneyline),
                "away_ml": None if pd.isna(r.away_moneyline) else int(r.away_moneyline),
                "roof": r.roof, "wind": None if pd.isna(r.wind) else int(r.wind),
                "temp": None if pd.isna(r.temp) else int(r.temp),
                "model": gm, "script": {}, "team_model": {}, "share": {}, "rest": rest,
                "players": {home: [], away: []},
            }
            if not pd.isna(r.home_score) and not pd.isna(r.away_score):
                game.update(final=True, home_score=int(r.home_score), away_score=int(r.away_score))
            for tm, opp, sign in ((home, away, 1), (away, home, -1)):
                margin = sign * gm["margin"]["mean"]
                implied = gm["home_pts"] if sign == 1 else gm["away_pts"]
                gs = game_script(tm, opp, teams, lg, margin, implied)
                game["script"][tm] = {k: round(v, 3) for k, v in gs.items()}
                game["team_model"][tm] = {k: round(v, 2) for k, v in team_projection(tm, opp, teams, lg, gs, implied).items()}
                listed = [pid for pid in eligible_players(stats, tm, week, depth=True) if players[pid]["team"] == tm]
                listed += [e["pid"] for e in depth_adds(charts.get(tm, []), hurt, on_ir)
                           if e["pid"] not in listed and players.get(e["pid"], {}).get("team") == tm]
                regular = set(eligible_players(stats, tm, week))
                game["share"][tm] = {k: round(v, 3) for k, v in listed_share(stats, team_stats, tm, listed, week).items()}
                for pid in listed:
                    pg = stats[(stats.player_id == pid) & (stats.week < w)].sort_values("week")
                    st = snap_trend(snap_series(snaps, pid, season, w))
                    players[pid]["proj"][r.game_id] = project_player(pg, players[pid]["pos"], opp, teams, lg, gs, cvs, rates, calib,
                                                                     prev.get(pid), depth=pid not in regular, snap_t=st)
                # players back from injury, and the news about roles since the team's last game
                if not game.get("final"):
                    try:
                        shares, wks = team_shares(stats, team_stats, tm, w)
                        rets = None
                    except Exception as e:
                        print(f"team shares unavailable for {tm}: {e}")
                        shares, wks, rets = {}, [], []
                    played = sched[((sched.home_team == tm) | (sched.away_team == tm)) & sched.home_score.notna()]
                    since = (pd.Timestamp(played.gameday.max()) + pd.Timedelta(hours=18)).timestamp() if len(played) else 0
                    if rets is None:
                        try:
                            rets = [R for R in find_returns(stats, tm, w, wks, shares, inj, rosters, news, since)
                                    if players.get(R["pid"], {}).get("team") == tm]
                        except Exception as e:
                            print(f"return check skipped for {tm}: {type(e).__name__}: {e}")
                            rets = []

                    def project(pid, opp=opp, gs=gs):
                        pg = stats[(stats.player_id == pid) & (stats.week < w)].sort_values("week")
                        return project_player(pg, players[pid]["pos"], opp, teams, lg, gs, cvs, rates, calib, prev.get(pid))
                    try:
                        touched = apply_returns(rets, tm, r.game_id, listed, players, shares, project)
                        apply_news(listed, r.game_id, players, news, since, touched)
                    except Exception as e:   # never let the news side stop a refresh
                        print(f"return/news adjustment skipped for {tm} {r.game_id}: {type(e).__name__}: {e}")
                game["players"][tm].extend(listed)
            games.append(game)

    used = {pid for g in games for side in g["players"].values() for pid in side}
    # ESPN id: the page matches ESPN's live injury report and headlines on it, not on the name
    # (two Justin Jeffersons: the Vikings WR and a Browns LB who is out)
    ids = player_ids()
    for pid in used:
        e = (ids.get(pid) or {}).get("espn") or roster_info.get(pid, {}).get("espn")
        if e:
            players[pid]["espn"] = e
    for pid in used:
        players[pid]["proj"] = {k: {STAT_KEYS[c]: v for c, v in p.items()} for k, p in players[pid]["proj"].items()}
    players = {pid: p for pid, p in players.items() if pid in used}

    def rnd(o):
        if isinstance(o, float):
            return None if math.isnan(o) or math.isinf(o) else round(o, 4)
        if isinstance(o, dict):
            return {k: rnd(v) for k, v in o.items()}
        if isinstance(o, list):
            return [rnd(v) for v in o]
        return o

    out = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "season": season, "week": week, "stats_through": int(stats.week.max()),
        "weeks": weeks, "league": lg, "calibration": calib or {}, "team_names": TEAM_NAMES,
        "teams": teams, "games": games, "players": players,
    }
    return rnd(out)


def main():
    ap = argparse.ArgumentParser()
    today = dt.date.today()
    ap.add_argument("--season", type=int, default=today.year if today.month >= 8 else today.year - 1)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "site", "data", "data.json"))
    args = ap.parse_args()
    data = build(args.season)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"), allow_nan=False, default=lambda o: None if pd.isna(o) else str(o))
    print(f"wrote {args.out}: week {data['week']}, {len(data['games'])} games, {len(data['players'])} players")


if __name__ == "__main__":
    main()
