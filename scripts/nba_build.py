"""Download NBA box scores and write site/data/nba.json (and nba_backtest.json) for the NBA page.

Sources (all free, no keys):
  sportsdataverse - every NBA box score this season and last (ESPN data, refreshed daily on GitHub)
  ESPN            - current spread and total, the injury report, and box scores from the
                    last day or two that the daily file hasn't picked up yet (optional)

Run:  python scripts/nba_build.py                 (current season)
      python scripts/nba_build.py --no-backtest   (faster; skips the range tuning)
"""
import argparse
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import sys
import urllib.request
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from model import ewma, shrink, clip  # noqa: E402

SDV = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
UA = {"User-Agent": "nfl-matchup-tool (github pages)"}
ET = ZoneInfo("America/New_York")
SITE_DATA = os.path.join(os.path.dirname(__file__), "..", "site", "data")

# box-score column -> short key used in nba.json
BASE = {"min": "minutes", "pts": "points", "reb": "rebounds", "ast": "assists",
        "fg3": "three_point_field_goals_made", "stl": "steals", "blk": "blocks", "tov": "turnovers"}
COMBOS = {"pra": ("pts", "reb", "ast"), "pr": ("pts", "reb"), "pa": ("pts", "ast"),
          "ra": ("reb", "ast"), "sb": ("stl", "blk")}
RATE_STATS = ["pts", "reb", "ast", "fg3", "stl", "blk", "tov"]
PROPS = ["pts", "reb", "ast", "fg3", "pra", "pr", "pa", "ra", "stl", "blk", "sb", "tov"]
DISCRETE = {"reb", "ast", "fg3", "stl", "blk", "tov", "ra", "sb"}   # small counts: negative binomial
LABELS = {"min": "Minutes", "pts": "Points", "reb": "Rebounds", "ast": "Assists", "fg3": "3-pointers made",
          "pra": "Pts + Reb + Ast", "pr": "Pts + Reb", "pa": "Pts + Ast", "ra": "Reb + Ast",
          "stl": "Steals", "blk": "Blocks", "sb": "Steals + Blocks", "tov": "Turnovers"}

TOTAL_SD = 18.0    # NBA totals land within about +/-18 points of the closing line 2/3 of the time
MARGIN_SD = 12.5   # same idea for the final margin
HOME_EDGE = 2.4    # home-court points


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def season_for(day):
    """sportsdataverse names a season by the year it ends: 2026-27 is 2027."""
    return day.year + 1 if day.month >= 9 else day.year


def season_label(season):
    return f"{season - 1}-{str(season)[2:]}"


# ---------------------------------------------------------------- loading

def _ids(col):
    """Ids arrive as ints in some seasons' files and floats in others; make them plain strings."""
    return pd.to_numeric(col, errors="coerce").astype("Int64").astype(str)


def _norm_box(df):
    df = df[df.season_type.isin([2, 3, 5])]   # regular season, playoffs, play-in
    out = pd.DataFrame({
        "gid": _ids(df.game_id), "date": df.game_date.astype(str), "season": df.season.astype(int),
        "pid": _ids(df.athlete_id), "name": df.athlete_display_name, "pos": df.athlete_position_abbreviation,
        "img": df.athlete_headshot_href, "tm": df.team_abbreviation, "opp": df.opponent_team_abbreviation,
        "home": df.home_away == "home",
        "fga": df.field_goals_attempted, "fta": df.free_throws_attempted, "oreb": df.offensive_rebounds,
        "fg3a": df.three_point_field_goals_attempted,
    })
    for k, col in BASE.items():
        out[k] = pd.to_numeric(df[col], errors="coerce")
    num = ["fga", "fta", "oreb", "fg3a", *BASE]
    out[num] = out[num].fillna(0).astype(float)
    out["played"] = (out["min"] > 0) & ~df.did_not_play.fillna(False).astype(bool)
    return out


def load_box(season):
    try:
        df = pd.read_parquet(io.BytesIO(fetch(f"{SDV}/espn_nba_player_boxscores/player_box_{season}.parquet")))
    except Exception as e:   # before opening night the new season's file may not exist yet
        print(f"box scores {season} unavailable:", e)
        return _norm_box(pd.DataFrame(columns=["game_id", "game_date", "season", "season_type", "athlete_id",
                                               "athlete_display_name", "athlete_position_abbreviation",
                                               "athlete_headshot_href", "team_abbreviation",
                                               "opponent_team_abbreviation", "home_away", "did_not_play",
                                               "field_goals_attempted", "free_throws_attempted",
                                               "offensive_rebounds", "three_point_field_goals_attempted",
                                               *BASE.values()]))
    return _norm_box(df)


def load_schedule(season):
    try:
        s = pd.read_parquet(io.BytesIO(fetch(f"{SDV}/espn_nba_schedules/nba_schedule_{season}.parquet")))
    except Exception as e:
        print("schedule unavailable:", e)
        return pd.DataFrame(columns=["gid", "date", "t", "home", "away", "done"])
    s = s[s.season_type.isin([2, 3, 5])]
    return pd.DataFrame({"gid": _ids(s.game_id), "date": s.game_date.astype(str), "t": s.date.astype(str),
                         "home": s.home_abbreviation, "away": s.away_abbreviation,
                         "done": s.status_type_completed.astype(bool)})


# ---------------------------------------------------------------- ESPN (optional, live)

ESPN_HOSTS = [ESPN, ESPN.replace("site.api.espn.com", "site.web.api.espn.com")]


def espn_json(path, timeout=20):
    """ESPN JSON, trying ESPN's second host if the first fails or answers with something other than JSON."""
    err = None
    for base in ESPN_HOSTS:
        raw = b""
        try:
            raw = fetch(f"{base}/{path}", timeout)
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            return json.loads(raw)
        except Exception as e:
            err = e
            print(f"  {base}/{path}: {e}" + (f"; got {raw[:120]!r}" if raw else ""))
    raise err


def espn_box(gid):
    """One finished game's player box score from ESPN, in the same shape as load_box()."""
    j = espn_json(f"summary?event={gid}")
    comp = j["header"]["competitions"][0]
    when = dt.datetime.fromisoformat(comp["date"].replace("Z", "+00:00")).astimezone(ET).date().isoformat()
    sides = {c["team"]["abbreviation"]: c["homeAway"] for c in comp["competitors"]}
    season = int(j.get("header", {}).get("season", {}).get("year") or season_for(dt.date.fromisoformat(when)))
    rows = []
    for team in j["boxscore"]["players"]:
        tm = team["team"]["abbreviation"]
        opp = next(a for a in sides if a != tm)
        st = team["statistics"][0]
        keys = st["keys"]
        for a in st["athletes"]:
            ath = a["athlete"]
            vals = dict(zip(keys, a.get("stats") or []))

            def num(k, part=None):
                v = vals.get(k, "0") or "0"
                if part is not None:
                    v = v.split("-")[part] if "-" in v else "0"
                try:
                    return float(v.replace("+", ""))
                except ValueError:
                    return 0.0
            r = {"gid": str(gid), "date": when, "season": season, "pid": str(ath["id"]), "name": ath.get("displayName"),
                 "pos": (ath.get("position") or {}).get("abbreviation"), "img": (ath.get("headshot") or {}).get("href"),
                 "tm": tm, "opp": opp, "home": sides[tm] == "home",
                 "min": num("minutes"), "pts": num("points"), "reb": num("rebounds"), "ast": num("assists"),
                 "fg3": num("threePointFieldGoalsMade-threePointFieldGoalsAttempted", 0),
                 "fg3a": num("threePointFieldGoalsMade-threePointFieldGoalsAttempted", 1),
                 "stl": num("steals"), "blk": num("blocks"), "tov": num("turnovers"),
                 "fga": num("fieldGoalsMade-fieldGoalsAttempted", 1), "fta": num("freeThrowsMade-freeThrowsAttempted", 1),
                 "oreb": num("offensiveRebounds")}
            r["played"] = r["min"] > 0 and not a.get("didNotPlay", False)
            rows.append(r)
    return rows


def parse_odds(comp):
    """(home margin, total, provider, home ML, away ML) from an ESPN competition, or None.
    Margin uses the same sign as the NFL page: positive = home team favored."""
    odds = (comp.get("odds") or [None])[0]
    if not odds or odds.get("overUnder") is None:
        return None
    teams = {c["homeAway"]: c["team"]["abbreviation"] for c in comp["competitors"]}
    margin = None
    m = re.match(r"^\s*([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)\s*$", odds.get("details") or "")
    if m:   # "BOS -13.5": the named team is favored by 13.5
        margin = abs(float(m.group(2))) * (1 if m.group(1) == teams["home"] else -1)
    elif (odds.get("details") or "").upper() in ("EVEN", "PK", "PICK"):
        margin = 0.0
    elif odds.get("spread") is not None:   # ESPN's `spread` is the home team's line
        margin = -float(odds["spread"])
    if margin is None:
        return None
    ml = lambda side: (odds.get(f"{side}TeamOdds") or {}).get("moneyLine")  # noqa: E731
    return margin, float(odds["overUnder"]), (odds.get("provider") or {}).get("name", "ESPN"), ml("home"), ml("away")


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def espn_scoreboard(day, dated=True):
    """{gid: {...}} for one ET calendar day."""
    j = espn_json(f"scoreboard?dates={day.strftime('%Y%m%d')}&limit=100" if dated else "scoreboard")
    out = {}
    for ev in j.get("events", []):
        comp = ev["competitions"][0]
        teams = {c["homeAway"]: c["team"]["abbreviation"] for c in comp["competitors"]}
        score = {c["homeAway"]: _int(c.get("score")) for c in comp["competitors"]}
        out[str(ev["id"])] = {"done": bool(comp.get("status", ev.get("status", {})).get("type", {}).get("completed")),
                              "home": teams["home"], "away": teams["away"], "t": comp.get("date") or ev.get("date"),
                              "date": day.isoformat(), "odds": parse_odds(comp),
                              "home_score": score.get("home"), "away_score": score.get("away")}
    return out


def espn_injuries():
    """{athlete id or lowercased name: {status, injury, note, date}} from ESPN's league injury report."""
    j = espn_json("injuries")
    out = {}
    for team in j.get("injuries", []):
        for it in team.get("injuries", []):
            ath = it.get("athlete") or {}
            pid = str(ath.get("id") or "")
            if not pid:
                for link in ath.get("links") or []:
                    m = re.search(r"/id/(\d+)", link.get("href", ""))
                    if m:
                        pid = m.group(1)
                        break
            det = it.get("details") or {}
            entry = {"status": it.get("status") or (it.get("type") or {}).get("description", "").title() or None,
                     "injury": " ".join(x for x in (det.get("side") if det.get("side") not in (None, "Not Specified") else None,
                                                     det.get("type")) if x) or None,
                     "note": it.get("shortComment"), "date": (it.get("date") or "")[:10] or None,
                     "ret": det.get("returnDate")}
            if pid:
                out[pid] = entry
            if ath.get("displayName"):
                out[ath["displayName"].lower()] = entry
    return out


# ---------------------------------------------------------------- probability (counts)

def negbin_cdf(k, mean, sd):
    """P(X <= k) for a negative binomial with this mean and sd (falls back to Poisson)."""
    k = math.floor(k)
    if k < 0:
        return 0.0
    var = sd * sd
    if var <= mean * 1.0001:
        term = math.exp(-mean)
        total = term
        for i in range(1, k + 1):
            term *= mean / i
            total += term
        return min(1.0, total)
    p = mean / var
    r = mean * mean / (var - mean)
    term = p ** r
    total = term
    for i in range(k):
        term *= (i + r) / (i + 1) * (1 - p)
        total += term
    return min(1.0, total)


def cdf_vec(x, mean, sd, discrete):
    """Vectorized P(X <= x) over numpy arrays (scipy), used by the backtest."""
    from scipy import stats
    x, mean, sd = np.asarray(x, float), np.asarray(mean, float), np.maximum(np.asarray(sd, float), 1e-6)
    out = np.empty_like(x)
    d = np.asarray(discrete, bool)
    g = ~d
    mg = np.maximum(mean[g], 1e-6)
    out[g] = np.where(mean[g] > 1e-6, stats.gamma.cdf(x[g], a=(mg / sd[g]) ** 2, scale=sd[g] ** 2 / mg), (x[g] >= 0) * 1.0)
    if d.any():
        m, v, xx = np.maximum(mean[d], 1e-6), sd[d] ** 2, np.floor(x[d])
        over = v > m * 1.0001
        res = stats.poisson.cdf(xx, m)
        p = m[over] / v[over]
        r = m[over] ** 2 / (v[over] - m[over])
        res[over] = stats.nbinom.cdf(xx[over], r, p)
        out[d] = res
    return out


# ---------------------------------------------------------------- team context

def team_games(box):
    """One row per team per game with possessions and what the opponent did."""
    if box.empty:
        return pd.DataFrame(columns=["gid", "date", "tm", "opp", "poss", "pts", "reb", "ast", "fg3",
                                     "o_poss", "o_pts", "o_reb", "o_ast", "o_fg3"])
    t = box.groupby(["gid", "date", "tm", "opp"], as_index=False)[["pts", "reb", "ast", "fg3", "fga", "fta", "oreb", "tov"]].sum()
    t["poss"] = t.fga - t.oreb + t.tov + 0.44 * t.fta
    o = t[["gid", "tm", "poss", "pts", "reb", "ast", "fg3"]].rename(
        columns={"tm": "opp", "poss": "o_poss", "pts": "o_pts", "reb": "o_reb", "ast": "o_ast", "fg3": "o_fg3"})
    return t.merge(o, on=["gid", "opp"], how="inner")


def team_context(tg, prior=None):
    """Per-team pace, offense, defense, and what each defense allows, shrunk toward a prior.

    prior: last season's context. Early in a season each team's numbers lean on last season
    (pulled halfway to league average), then on this season's games as they pile up.
    """
    if tg.empty and prior:
        return prior
    lg_poss = (tg.poss.sum() + tg.o_poss.sum()) / (2 * len(tg))
    lg = {"pace": lg_poss, "rtg": 100 * tg.pts.sum() / tg.poss.sum(),
          "reb100": 100 * tg.reb.sum() / tg.poss.sum(), "ast100": 100 * tg.ast.sum() / tg.poss.sum(),
          "fg3100": 100 * tg.fg3.sum() / tg.poss.sum(), "ppg": tg.pts.mean()}
    if prior:   # blend league levels too, so a handful of opening-week games can't skew them
        n = len(tg) / 30
        lg = {k: shrink(v, n, prior["league"][k], 3) for k, v in lg.items()}
    teams = {}
    for ab, g in tg.groupby("tm"):
        n = len(g)
        pace = ((g.poss + g.o_poss) / 2).mean()
        raw = {"pace": pace, "ortg": 100 * g.pts.sum() / g.poss.sum(), "drtg": 100 * g.o_pts.sum() / g.o_poss.sum(),
               "reb100": 100 * g.reb.sum() / g.poss.sum(), "fg3100": 100 * g.fg3.sum() / g.poss.sum(),
               "o_reb100": 100 * g.o_reb.sum() / g.o_poss.sum(), "o_ast100": 100 * g.o_ast.sum() / g.o_poss.sum(),
               "o_fg3100": 100 * g.o_fg3.sum() / g.o_poss.sum()}
        base = {"pace": lg["pace"], "ortg": lg["rtg"], "drtg": lg["rtg"], "reb100": lg["reb100"], "fg3100": lg["fg3100"],
                "o_reb100": lg["reb100"], "o_ast100": lg["ast100"], "o_fg3100": lg["fg3100"]}
        if prior and ab in prior["teams"]:
            base = {k: 0.5 * (base[k] + prior["teams"][ab][k]) for k in base}
        e = {k: shrink(raw[k], n, base[k], 10) for k in raw}
        e.update({"games": n, "ppg": g.pts.mean(), "opp_ppg": g.o_pts.mean(),
                  "record": f"{int((g.pts > g.o_pts).sum())}-{int((g.pts < g.o_pts).sum())}"})
        teams[ab] = e
    if prior:   # teams with no games yet this season
        for ab, e in prior["teams"].items():
            if ab not in teams:
                teams[ab] = {**e, "games": 0, "record": "0-0"}
    # matchup factors and z-score ratings for the page
    for ab, e in teams.items():
        e["f_reb"] = e["o_reb100"] / lg["reb100"]
        e["f_ast"] = e["o_ast100"] / lg["ast100"]
        e["f_fg3"] = e["o_fg3100"] / lg["fg3100"]
    for key, sign in [("ortg", 1), ("drtg", -1), ("pace", 1), ("fg3100", 1), ("o_fg3100", -1), ("reb100", 1), ("o_reb100", -1)]:
        vals = [teams[a][key] for a in teams]
        mu = sum(vals) / len(vals)
        sd = (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5 or 1
        for a in teams:
            teams[a].setdefault("rating", {})[key] = round(sign * (teams[a][key] - mu) / sd, 2)
    return {"league": lg, "teams": teams}


def game_model(home, away, ctx, spread=None, total=None):
    """Possessions x efficiency for each side, then blended with the market (market weighted 80%)."""
    lg, H, A = ctx["league"], ctx["teams"][home], ctx["teams"][away]
    pace = H["pace"] * A["pace"] / lg["pace"]
    h = pace * H["ortg"] * A["drtg"] / lg["rtg"] / 100 + HOME_EDGE / 2
    a = pace * A["ortg"] * H["drtg"] / lg["rtg"] / 100 - HOME_EDGE / 2
    mt, mm = h + a, h - a
    if total is None or spread is None:
        t, m = mt, mm
    else:
        t, m = 0.8 * total + 0.2 * mt, 0.8 * spread + 0.2 * mm
    return {"model_total": round(mt, 1), "model_margin": round(mm, 1), "pace": round(pace, 1),
            "total": {"mean": round(t, 2), "sd": TOTAL_SD, "dist": "normal"},
            "margin": {"mean": round(m, 2), "sd": MARGIN_SD, "dist": "normal"},
            "home_pts": round((t + m) / 2, 1), "away_pts": round((t - m) / 2, 1)}


def game_script(tm, opp, ctx, gm, is_home):
    """How this game should shift a team's volume (pace) and scoring vs. its usual."""
    T = ctx["teams"][tm]
    base_pts = T["pace"] * T["ortg"] / 100
    implied = gm["home_pts"] if is_home else gm["away_pts"]
    return {"pace_f": clip(gm["pace"] / T["pace"], 0.9, 1.1), "pts_f": clip(implied / base_pts, 0.85, 1.15),
            "implied": implied, "margin": gm["margin"]["mean"] * (1 if is_home else -1)}


# ---------------------------------------------------------------- player projection

def fit_priors(box):
    """Typical game-to-game spread (sd / mean) for each stat, as a power curve in the mean.

    Bench players swing more (relative to their average) than stars. Fit on regular rotation
    players from the given season(s).
    """
    p = box[box.played].copy()
    for k, parts in COMBOS.items():
        p[k] = sum(p[c] for c in parts)
    g = p.groupby("pid")
    keep = (g.size() >= 20) & (g["min"].mean() >= 15)
    out = {}
    for k in ["min", *PROPS]:
        m, s = g[k].mean()[keep], g[k].std()[keep]
        ok = (m > 0.3) & (s > 0)
        if ok.sum() < 30:
            out[k] = (0.5, 0.0)
            continue
        b, loga = np.polyfit(np.log(m[ok]), np.log(s[ok] / m[ok]), 1)
        out[k] = (float(math.exp(loga)), float(b))
    return out


def project_player(cur, prev, f_opp, gs, priors, calib=None):
    """cur / prev: this season's and last season's played games (dicts, oldest first).

    Minutes x per-minute rate x matchup. Rates lean on last season early and on this season
    as games pile up. Returns {stat: {mean, sd, dist, f}}.
    """
    prev = prev[-30:]
    n = len(cur)

    def blend(c, p, k):
        if c is None:
            return p
        if p is None:
            return c
        w = n / (n + k)
        return w * c + (1 - w) * p

    mins_c = [g["min"] for g in cur]
    m_cur = ewma(mins_c, 5) if cur else None
    m_prev = sum(g["min"] for g in prev[-20:]) / len(prev[-20:]) if prev else None
    minutes = blend(m_cur, m_prev, 4) or 0.0
    if abs(gs["margin"]) > 9 and minutes >= 26:   # likely blowout: starters sit late
        minutes *= max(0.93, 1 - 0.005 * (abs(gs["margin"]) - 9))

    factor = {"pts": gs["pts_f"], "reb": gs["pace_f"] * f_opp["f_reb"], "ast": gs["pace_f"] * f_opp["f_ast"],
              "fg3": gs["pace_f"] * f_opp["f_fg3"], "stl": gs["pace_f"], "blk": gs["pace_f"], "tov": gs["pace_f"]}
    means, fs = {"min": minutes}, {"min": 1.0}
    for k in RATE_STATS:
        r_cur = None
        if cur and sum(mins_c) > 0:
            r_cur = ewma([g[k] for g in cur], 5) / max(ewma(mins_c, 5), 1e-6)
        r_prev = None
        pm = sum(g["min"] for g in prev)
        if prev and pm > 0:
            r_prev = sum(g[k] for g in prev) / pm
        rate = blend(r_cur, r_prev, 8) or 0.0
        f = clip(factor[k], 0.85, 1.15)
        means[k], fs[k] = minutes * rate * f, f
    for k, parts in COMBOS.items():
        means[k] = sum(means[c] for c in parts)
        fs[k] = sum(means[c] * fs[c] for c in parts) / means[k] if means[k] > 0 else 1.0

    recent = (prev + cur)[-25:]
    out = {}
    for k in ["min", *PROPS]:
        mean = max(means[k], 0.0)
        vals = [g[k] if k in g else sum(g[c] for c in COMBOS[k]) for g in recent]
        ns = len(vals)
        a, b = priors.get(k, (0.5, 0.0))
        cv_p = clip(a * max(mean, 0.3) ** b, 0.08, 3.0)
        mu = sum(vals) / ns if ns else 0
        cv_s = (sum((v - mu) ** 2 for v in vals) / (ns - 1)) ** 0.5 / mu if ns > 1 and mu > 0 else cv_p
        kk = 6
        cv = math.sqrt(((ns - 1) * cv_s ** 2 + kk * cv_p ** 2) / (ns - 1 + kk)) if ns > 1 else cv_p
        cv *= math.sqrt(1 + 1 / (n + 0.3 * len(prev) + 1))   # we are also unsure of the true average
        cv = clip(cv * (calib or {}).get(k, 1.0), 0.06, 3.0)
        sd = max(cv * mean, 0.3)
        if k in DISCRETE:
            dist = "negbin" if sd * sd > mean * 1.0001 else "poisson"
            if dist == "poisson":
                sd = math.sqrt(mean)
        else:
            dist = "gamma"
        out[k] = {"mean": round(mean, 2), "sd": round(sd, 2), "dist": dist, "f": round(fs[k], 3)}
    return out


def player_index(box):
    """{pid: [game dicts oldest first]} for played games."""
    cols = ["gid", "date", "season", "tm", "opp", "home", *BASE]
    p = box[box.played].sort_values(["date", "gid"])
    return {pid: g[cols].to_dict("records") for pid, g in p.groupby("pid")}


def eligible(team_dates, idx_cur, tm, before):
    """Players who got minutes for `tm` in any of its last five games before `before`."""
    dates = [d for d in team_dates.get(tm, []) if d < before][-5:]
    if not dates:
        return []
    out = []
    for pid, games in idx_cur.items():
        g = [x for x in games if x["date"] < before]
        if not g or g[-1]["tm"] != tm:
            continue
        if any(x["date"] in dates and x["tm"] == tm for x in g[-5:]):
            out.append(pid)
    return out


# ---------------------------------------------------------------- backtest

def backtest(box_by_season, seasons, priors_by_season, every=3, min_day=14):
    """Replay past game days: project with only earlier games, then compare with what happened.

    Returns a DataFrame with one row per player-stat. Lines from the betting market are not
    used here (no history of them), so game-script factors come from the stats-only model.
    """
    rows = []
    for S in seasons:
        box = box_by_season.get(S)
        if box is None or box.empty:
            continue
        prev_box = box_by_season.get(S - 1)
        prior_ctx = team_context(team_games(prev_box)) if prev_box is not None and not prev_box.empty else None
        idx_prev = player_index(prev_box) if prev_box is not None else {}
        tg_all = team_games(box)
        days = sorted(box.date.unique())
        idx_all = player_index(box)
        team_dates = {t: sorted(g.date.unique()) for t, g in box.groupby("tm")}
        games = box.drop_duplicates(["gid", "tm"])[["gid", "date", "tm", "opp", "home"]]
        for D in days[min_day::every]:
            ctx = team_context(tg_all[tg_all.date < D], prior_ctx)
            idx_cur = {pid: [g for g in gl if g["date"] < D] for pid, gl in idx_all.items()}
            idx_cur = {pid: gl for pid, gl in idx_cur.items() if gl}
            actual = {(r["pid"]): r for r in box[(box.date == D) & box.played].to_dict("records")}
            for g in games[(games.date == D) & games.home].itertuples():
                if g.tm not in ctx["teams"] or g.opp not in ctx["teams"]:
                    continue
                gm = game_model(g.tm, g.opp, ctx)
                for tm, opp, is_home in ((g.tm, g.opp, True), (g.opp, g.tm, False)):
                    gs = game_script(tm, opp, ctx, gm, is_home)
                    for pid in eligible(team_dates, idx_cur, tm, D):
                        a = actual.get(pid)
                        if a is None:
                            continue
                        proj = project_player(idx_cur[pid], idx_prev.get(pid, []), ctx["teams"][opp], gs, priors_by_season[S])
                        hist = idx_cur[pid]
                        for k, p in proj.items():
                            act = a[k] if k in a else sum(a[c] for c in COMBOS[k])
                            base = [x[k] if k in x else sum(x[c] for c in COMBOS[k]) for x in hist]
                            rows.append((S, D, k, act, p["mean"], p["sd"], p["dist"] != "gamma",
                                         sum(base) / len(base)))
    return pd.DataFrame(rows, columns=["season", "date", "stat", "actual", "mean", "sd", "discrete", "season_avg"])


def _inside(df, mult, lo, hi):
    """Share of results inside the [lo, hi] slice of each projection; a whole-number result on
    the edge of the range counts partly in."""
    sd = df["sd"].to_numpy() * mult
    a = cdf_vec(df.actual.to_numpy() - 0.5, df["mean"].to_numpy(), sd, df.discrete.to_numpy())
    a = np.where(df.discrete.to_numpy(), cdf_vec(df.actual.to_numpy() - 1, df["mean"].to_numpy(), sd, True), a)
    b = cdf_vec(df.actual.to_numpy() + 0.5, df["mean"].to_numpy(), sd, df.discrete.to_numpy())
    width = np.maximum(b - a, 1e-12)
    ov = np.clip(np.minimum(b, hi) - np.maximum(a, lo), 0, None) / width
    ov = np.where(b - a < 1e-9, ((lo <= b) & (b <= hi)).astype(float), ov)
    return float(ov.mean())


def calibrate(df):
    """Widen or narrow each stat's ranges until 80% of past results land inside its 80% range."""
    out = {}
    for k, g in df.groupby("stat"):
        if len(g) < 200:
            continue
        g = g.sample(min(len(g), 6000), random_state=1)
        grid = [0.7 + 0.03 * i for i in range(31)]
        errs = [abs(_inside(g, m, 0.1, 0.9) - 0.8) for m in grid]
        out[k] = round(grid[int(np.argmin(errs))], 2)
    return out


def summarize(df, calib):
    out = []
    for k in ["min", *PROPS]:
        g = df[df.stat == k]
        if g.empty:
            continue
        m = calib.get(k, 1.0)
        out.append({"stat": LABELS[k], "key": k, "n": int(len(g)), "in80": round(_inside(g, m, 0.1, 0.9), 3),
                    "in50": round(_inside(g, m, 0.25, 0.75), 3), "mae": round(float((g.actual - g["mean"]).abs().mean()), 2),
                    "mae_season_avg": round(float((g.actual - g.season_avg).abs().mean()), 2)})
    return out


# ---------------------------------------------------------------- assemble

def build(today, run_backtest=True):
    season = season_for(today)
    box = load_box(season)
    prev_box = load_box(season - 1)
    sched = load_schedule(season)

    # ESPN: fresher box scores, lines, injuries. All optional.
    lines, extra, sb_games = {}, [], {}
    for off in range(-3, 4):
        day = today + dt.timedelta(days=off)
        try:
            sb_games.update(espn_scoreboard(day))
        except Exception as e:
            print(f"ESPN scoreboard {day} unavailable:", e)
            if off == 0:   # the undated scoreboard is ESPN's "today" page; worth one more try
                try:
                    sb_games.update(espn_scoreboard(day, dated=False))
                except Exception as e2:
                    print("ESPN scoreboard (today) unavailable:", e2)
    have = set(box.gid)
    for gid, g in sb_games.items():
        if g["done"] and gid not in have and g["date"] <= today.isoformat():
            try:
                extra += espn_box(gid)
            except Exception as e:
                print(f"ESPN box {gid} unavailable:", e)
        if g["odds"]:
            lines[gid] = g["odds"]
    if extra:
        box = pd.concat([box, pd.DataFrame(extra)], ignore_index=True)
        print(f"added {len({r['gid'] for r in extra})} games from ESPN")
    print(f"ESPN lines for {len(lines)} games")
    try:
        injuries = espn_injuries()
        print(f"injury report: {len(injuries)} entries")
    except Exception as e:
        print("ESPN injuries unavailable:", e)
        injuries = {}

    # today's and later games: schedule plus anything ESPN knows about that the schedule doesn't.
    # Games already played today stay on the list, marked final with their score.
    played = set(box.gid)
    up = sched[sched.date >= today.isoformat()]
    up = {r.gid: {"date": r.date, "t": r.t, "home": r.home, "away": r.away} for r in up.itertuples()}
    for gid, g in sb_games.items():
        if g["date"] >= today.isoformat():
            up.setdefault(gid, {"date": g["date"], "t": g["t"], "home": g["home"], "away": g["away"]})
    # final scores: ESPN's scoreboard, else team totals from the box scores
    pts = box.groupby(["gid", "tm"]).pts.sum()
    final = {}
    for gid in up:
        sb = sb_games.get(gid, {})
        if sb.get("done") and sb.get("home_score") is not None:
            final[gid] = (sb["home_score"], sb["away_score"])
        elif gid in played:
            g = up[gid]
            final[gid] = (int(pts.get((gid, g["home"]), 0)), int(pts.get((gid, g["away"]), 0)))
    up = {k: v for k, v in up.items() if v["home"] in TEAM_NAMES and v["away"] in TEAM_NAMES}
    dates = sorted({g["date"] for g in up.values()})[:3]

    # model inputs
    prior_ctx = team_context(team_games(prev_box)) if not prev_box.empty else None
    ctx = team_context(team_games(box), prior_ctx)
    both = pd.concat([prev_box, box])
    priors = fit_priors(both if len(box[box.played]) > 3000 else prev_box if not prev_box.empty else box)

    calib, bt = {}, None
    if run_backtest:
        older = load_box(season - 2)
        by_season = {season - 2: older, season - 1: prev_box, season: box}
        pri = {season - 1: fit_priors(older if not older.empty else prev_box), season: priors}
        df = backtest(by_season, [season - 1, season], pri)
        if len(df):
            # report on games the calibration never saw: fit on the first half, score the second
            cut = sorted(df.date.unique())[len(df.date.unique()) // 2]
            fit_half = calibrate(df[df.date < cut])
            summary = summarize(df[df.date >= cut], fit_half)
            calib = calibrate(df)
            bt = {"seasons": [season_label(season - 1), season_label(season)], "summary": summary,
                  "note": "Projections rebuilt for past game days using only earlier games; ranges tuned on the "
                          "first half of those days and scored on the second half."}
            print("range multipliers:", calib)
            for s in summary:
                print(f"  {s['stat']:18s} n={s['n']:6d} in80={s['in80']:.2f} in50={s['in50']:.2f} "
                      f"MAE={s['mae']:5.2f} (season avg {s['mae_season_avg']:5.2f})")

    idx_cur = player_index(box)
    idx_prev = player_index(prev_box)
    team_dates = {t: sorted(g.date.unique()) for t, g in box.groupby("tm")}
    info = (pd.concat([prev_box, box]).sort_values("date").groupby("pid").last()[["name", "pos", "img", "tm"]])

    games, used, proj = [], set(), {}
    for gid, g in sorted(up.items(), key=lambda kv: (kv[1]["date"], kv[1]["t"], kv[0])):
        if g["date"] not in dates:
            continue
        home, away = g["home"], g["away"]
        spread = total = None
        src, hml, aml = "stats model (no line yet)", None, None
        if gid in lines:
            spread, total, src, hml, aml = lines[gid]
        gm = game_model(home, away, ctx, spread, total)
        game = {"id": gid, "date": g["date"], "t": g["t"], "home": home, "away": away, "spread": spread,
                "total": total, "line_src": src, "home_ml": hml, "away_ml": aml, "model": gm, "script": {},
                "players": {home: [], away: []}}
        if gid in final:
            game["final"] = True
            game["home_score"], game["away_score"] = final[gid]
        for tm, opp, is_home in ((home, away, True), (away, home, False)):
            gs = game_script(tm, opp, ctx, gm, is_home)
            game["script"][tm] = {k: round(v, 3) for k, v in gs.items()}
            for pid in eligible(team_dates, idx_cur, tm, g["date"]):
                cur = [x for x in idx_cur[pid] if x["date"] < g["date"]]   # a finished game can't inform its own projection
                p = project_player(cur, idx_prev.get(pid, []), ctx["teams"][opp], gs, priors, calib)
                if p["min"]["mean"] < 8:
                    continue
                proj.setdefault(pid, {})[gid] = p
                game["players"][tm].append(pid)
                used.add(pid)
        games.append(game)

    players = {}
    for pid in used:
        r = info.loc[pid]
        log = []
        for season_games, ly in ((idx_prev.get(pid, []), 1), (idx_cur.get(pid, []), 0)):
            for x in season_games:
                row = {"d": x["date"], "opp": x["opp"], "tm": x["tm"], "h": int(bool(x["home"]))}
                row.update({k: int(round(x[k])) for k in BASE})
                if ly:
                    row["ly"] = 1
                log.append(row)
        players[pid] = {"name": r["name"], "pos": r["pos"] if isinstance(r["pos"], str) else "",
                        "team": idx_cur[pid][-1]["tm"], "img": r["img"] if isinstance(r["img"], str) else None,
                        "log": log[-25:], "proj": proj[pid]}
        inj = injuries.get(pid) or injuries.get(str(r["name"]).lower())
        if inj and inj.get("status"):
            players[pid]["inj"] = inj

    def rnd(o):
        if isinstance(o, (float, np.floating)):
            o = float(o)
            return None if math.isnan(o) or math.isinf(o) else round(o, 4)
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, dict):
            return {k: rnd(v) for k, v in o.items()}
        if isinstance(o, list):
            return [rnd(v) for v in o]
        return o

    out = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "season": season_label(season), "season_year": season, "today": today.isoformat(),
        "stats_through": max(box.date) if len(box) else None, "dates": dates,
        "league": ctx["league"], "calibration": calib, "team_names": TEAM_NAMES,
        "teams": ctx["teams"], "games": games, "players": players,
    }
    return rnd(out), bt


TEAM_NAMES = {
    "ATL": "Atlanta Hawks", "BKN": "Brooklyn Nets", "BOS": "Boston Celtics", "CHA": "Charlotte Hornets",
    "CHI": "Chicago Bulls", "CLE": "Cleveland Cavaliers", "DAL": "Dallas Mavericks", "DEN": "Denver Nuggets",
    "DET": "Detroit Pistons", "GS": "Golden State Warriors", "HOU": "Houston Rockets", "IND": "Indiana Pacers",
    "LAC": "LA Clippers", "LAL": "Los Angeles Lakers", "MEM": "Memphis Grizzlies", "MIA": "Miami Heat",
    "MIL": "Milwaukee Bucks", "MIN": "Minnesota Timberwolves", "NO": "New Orleans Pelicans", "NY": "New York Knicks",
    "OKC": "Oklahoma City Thunder", "ORL": "Orlando Magic", "PHI": "Philadelphia 76ers", "PHX": "Phoenix Suns",
    "POR": "Portland Trail Blazers", "SA": "San Antonio Spurs", "SAC": "Sacramento Kings", "TOR": "Toronto Raptors",
    "UTAH": "Utah Jazz", "WSH": "Washington Wizards",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="pretend today is this date (YYYY-MM-DD, US Eastern)")
    ap.add_argument("--no-backtest", action="store_true")
    args = ap.parse_args()
    today = dt.date.fromisoformat(args.date) if args.date else dt.datetime.now(ET).date()
    data, bt = build(today, not args.no_backtest)
    os.makedirs(SITE_DATA, exist_ok=True)
    with open(os.path.join(SITE_DATA, "nba.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"), allow_nan=False)
    if bt:
        with open(os.path.join(SITE_DATA, "nba_backtest.json"), "w") as f:
            json.dump(bt, f, separators=(",", ":"))
    print(f"wrote nba.json: {len(data['games'])} games on {data['dates']}, {len(data['players'])} players")


if __name__ == "__main__":
    main()
