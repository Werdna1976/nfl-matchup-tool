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
from model import (POSITION_STATS, COUNT_KINDS, TOTAL_SD, MARGIN_SD,  # noqa: E402
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
    "receiving_yards": "yds", "receiving_tds": "td",
}


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def read_csv(url):
    return pd.read_csv(io.BytesIO(fetch(url)), low_memory=False)


def load(season):
    stats = read_csv(f"{NFLVERSE}/stats_player/stats_player_week_{season}.csv")
    team = read_csv(f"{NFLVERSE}/stats_team/stats_team_week_{season}.csv")
    sched = read_csv(f"{NFLVERSE}/schedules/games.csv")
    try:
        inj = read_csv(f"{NFLVERSE}/injuries/injuries_{season}.csv")
    except Exception as e:  # injuries file can be missing early in a season
        print("injuries unavailable:", e)
        inj = pd.DataFrame()
    stats = stats[stats.season_type == "REG"]
    team = team[team.season_type == "REG"]
    sched = sched[(sched.season == season) & (sched.game_type == "REG")].copy()
    return stats, team, sched, inj


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


def stat_factor(col, kind, pos, opp, teams, lg, gs):
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


def project_player(games, pos, opp, teams, lg, gs, cvs, rates, calib=None):
    """games: the player's per-game rows (oldest first). Returns {stat: projection}."""
    out = {}
    n = len(games)
    for col, kind in POSITION_STATS[pos]:
        vals = [float(v) for v in games[col].fillna(0)]
        base = ewma(vals)
        f = clip(stat_factor(col, kind, pos, opp, teams, lg, gs), 0.6, 1.5)
        mean = max(base * f, 0.0)
        if kind in COUNT_KINDS:
            # few games of TDs is mostly luck: blend with the league rate for this much volume
            vol = out.get(TD_OPP[col], {}).get("mean", 0.0)
            prior = rates.get((pos, col), 0.0) * vol * f
            mean = (n * mean + 4 * prior) / (n + 4)
            out[col] = {"mean": round(mean, 3), "sd": round(math.sqrt(mean), 3), "dist": "poisson", "f": round(f, 3)}
            continue
        prior = cvs.get((pos, col), 0.5)
        m = sum(vals) / n if n else 0
        cv_s = (sum((v - m) ** 2 for v in vals) / (n - 1)) ** 0.5 / m if n > 1 and m > 0 else prior
        k = 4
        cv = math.sqrt(((n - 1) * cv_s ** 2 + k * prior ** 2) / (n - 1 + k)) if n > 1 else prior
        cv *= math.sqrt(1 + 1 / max(n, 1))   # we are also unsure of the true average
        cv = clip(cv * (calib or {}).get(col, 1.0), 0.12, 2.0)
        out[col] = {"mean": round(mean, 2), "sd": round(max(cv * mean, 0.5), 2), "dist": "gamma", "f": round(f, 3)}
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


def eligible_players(stats, team, upto_week):
    """Skill players with a recent role on `team`."""
    s = stats[(stats.week < upto_week) & stats.position.isin(POSITION_STATS)]
    team_weeks = sorted(s[s.team == team].week.unique())[-3:]
    recent = s[(s.team == team) & s.week.isin(team_weeks)]
    keep = []
    for pid, g in recent.groupby("player_id"):
        pos = g.position.iloc[0]
        allg = s[s.player_id == pid].sort_values("week")
        if pos == "QB" and g.attempts.max() < 10:
            continue
        if pos == "RB" and ewma(list((allg.carries + allg.targets).fillna(0))) < 3:
            continue
        if pos in ("WR", "TE") and ewma(list(allg.targets.fillna(0))) < 2:
            continue
        keep.append(pid)
    return keep


def build(season):
    stats, team_stats, sched, inj = load(season)
    week = current_week(sched)
    weeks = [w for w in (week, week + 1) if w in set(sched.week)]
    teams, lg = team_context(stats, team_stats, sched, week)
    cvs = prior_cvs(stats, week)
    rates = prior_rates(stats, week)
    import backtest  # widen ranges by how well they covered past weeks
    calib = backtest.calibrate(backtest.run(season, data=(stats, team_stats, sched)))
    print("range multipliers:", calib)

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
        for r in g.itertuples():
            row = {"w": int(r.week), "opp": r.opponent_team, "tm": r.team}
            for col, short in STAT_KEYS.items():
                v = getattr(r, col)
                row[short] = 0 if pd.isna(v) else int(v)
            log.append(row)
        players[pid] = {"name": last.player_display_name, "pos": last.position, "team": last.team,
                        "img": last.headshot_url if isinstance(last.headshot_url, str) else None,
                        "log": log, "proj": {}}
        if pid in inj_latest and inj_latest[pid]["wk"] >= week - 1:
            players[pid]["inj"] = inj_latest[pid]

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
            game = {
                "id": r.game_id, "week": int(w), "day": r.gameday, "time": r.gametime,
                "home": home, "away": away, "spread": spread, "total": total, "line_src": src,
                "home_ml": None if pd.isna(r.home_moneyline) else int(r.home_moneyline),
                "away_ml": None if pd.isna(r.away_moneyline) else int(r.away_moneyline),
                "roof": r.roof, "wind": None if pd.isna(r.wind) else int(r.wind),
                "temp": None if pd.isna(r.temp) else int(r.temp),
                "model": gm, "script": {},
                "players": {home: [], away: []},
            }
            for tm, opp, sign in ((home, away, 1), (away, home, -1)):
                margin = sign * gm["margin"]["mean"]
                implied = gm["home_pts"] if sign == 1 else gm["away_pts"]
                gs = game_script(tm, opp, teams, lg, margin, implied)
                game["script"][tm] = {k: round(v, 3) for k, v in gs.items()}
                for pid in eligible_players(stats, tm, week):
                    if players[pid]["team"] != tm:
                        continue
                    pg = stats[(stats.player_id == pid)].sort_values("week")
                    players[pid]["proj"][r.game_id] = project_player(pg, players[pid]["pos"], opp, teams, lg, gs, cvs, rates, calib)
                    game["players"][tm].append(pid)
            games.append(game)

    used = {pid for g in games for side in g["players"].values() for pid in side}
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
        "weeks": weeks, "league": lg, "calibration": calib, "team_names": TEAM_NAMES,
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
