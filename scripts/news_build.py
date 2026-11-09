"""Collect recent player news for both sports and write site/data/news.json.

Runs after build_data.py and nba_build.py on every scheduled refresh. Every source is free and
needs no key; any that fails is skipped (and named in the file), so the site never breaks on it:

  ESPN news API     league feed plus one feed per team (player-tagged, the most reliable match)
  RotoWire RSS      short player updates: practice reports, illness, role, rest
  CBS Sports, Yahoo league headlines
  ProFootballTalk   NFL rumors, discipline, contract and locker-room stories
(HoopsHype's NBA rumor feed answers "402 Payment Required" to automated readers, so it's left out.)

Each story is matched to the players on the site (by ESPN id where ESPN tags it, otherwise by
full name in the headline or summary), tagged by what it is about (injury, illness, rest, role,
trade, morale, return), and kept for 7 days. Feeds only hold a day or two of stories, so each run
merges with the previous news.json (the workflow downloads the published copy first).

Team stories about morale or trades (a coach calling out his players, a losing team shopping a
star) are kept under the team when no single player is named.

The tags are keyword rules, not a reading of the story: "frustrated" in a headline gets the
morale tag whether the player is frustrated or his coach is. They point at stories worth
reading, and they can't be backtested (no archive of old feeds).

NFL stories also get role signals (see ROLE_PATTERNS): returning, ruled out, starter, snap count,
benched. build_data.py reads them to decide whether a player who has been out is back this week
and how much of his old role he gets, so this step runs before the NFL build.

Run:  python scripts/news_build.py [--prev site/data/news.json]   (before build_data.py)
"""
import argparse
import datetime as dt
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(__file__))

SITE_DATA = os.path.join(os.path.dirname(__file__), "..", "site", "data")
UA = {"User-Agent": "Mozilla/5.0 (compatible; nfl-matchup-tool; +https://github.com/Werdna1976/nfl-matchup-tool)"}
KEEP_DAYS = 7
PER_PLAYER = 8

ESPN = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl",
        "nba": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"}
RSS = {
    "nfl": [("RotoWire", "https://www.rotowire.com/rss/news.php?sport=NFL"),
            ("ProFootballTalk", "https://www.nbcsports.com/profootballtalk.rss"),
            ("ProFootballTalk", "https://profootballtalk.nbcsports.com/feed/"),
            ("CBS Sports", "https://www.cbssports.com/rss/headlines/nfl/"),
            ("Yahoo", "https://sports.yahoo.com/nfl/rss/")],
    "nba": [("RotoWire", "https://www.rotowire.com/rss/news.php?sport=NBA"),
            ("CBS Sports", "https://www.cbssports.com/rss/headlines/nba/"),
            ("Yahoo", "https://sports.yahoo.com/nba/rss/")],
}

# What a story is about. A story can carry several tags. Order matters only for display.
TAGS = [
    ("illness", r"illness|\bill\b|sick|flu\b|virus|stomach|migraine|non-injury|personal (?:reasons|matter)|bereavement|family matter"),
    ("injury", r"injur|hamstring|ankle|knee|groin|calf|quad|achilles|\bacl\b|\bmcl\b|concussion|shoulder|wrist|\bhand\b|foot|toe\b|hip\b|ribs?\b|oblique|"
               r"back (?:injury|spasms?|tightness)|sprain|strain|fractur|torn|\btear\b|\bmri\b|x-rays?|surgery|ruled out|\bout for\b|questionable|"
               r"doubtful|game-time decision|limited (?:in )?practice|did not practice|\bdnp\b|injured reserve|day-to-day|week-to-week|sidelined|"
               r"tweak|aggravat|\bsore|banged up|carted|exited|left (?:the )?game"),
    ("rest", r"load management|maintenance|minutes (?:limit|restriction|cap)|snap (?:count|limit)|pitch count|workload|\bresting\b|"
             r"will rest|to rest\b|rest (?:day|night)|back-to-back|second night"),
    ("role", r"bench(?:ed)?\b|demot|promot|depth chart|named (?:the )?starter|will start|to start\b|starting (?:lineup|role|job|nod)|"
             r"first-team|second-team|lose (?:his|the) (?:job|role|spot)|rotation|coming off the bench|move(?:d|s)? to the bench|"
             r"expanded role|bigger role|larger role|reduced role|committee|split (?:carries|work)|snap share|usage"),
    ("trade", r"trade|traded|dealt\b|deadline|rumou?r|shopping|on the (?:trading )?block|wants out|request(?:ed|s)? (?:a )?trade|"
              r"acquir|waive[ds]?\b|released|cut by|buyout|free agen|sign(?:s|ed|ing) with|extension|contract (?:talks|dispute|year)"),
    ("morale", r"suspen|\bfined?\b|arrest|charged|discipline|frustrat|unhappy|upset (?:with|about|over|by)|disgruntl|hold ?out|hold-in|critici|called out|"
               r"calls out|blast(?:s|ed)|rips?\b|ripped|sound(?:s|ed)? off|lash(?:es|ed)? out|feud|rift|beef|locker room|chemistry|"
               r"effort|attitude|not happy|\btension|sulk|apologi|benched for|ultimatum|tanking|morale|motivat|checked out|"
               r"quit on|\bquit\b|confront|walk(?:ed|s)? out|no-show|ejected|controversy"),
    ("return", r"return(?:s|ing|ed)? (?:to|from|vs\.?|for|tonight|sunday|monday|thursday)|cleared|activated|full practice|"
               r"off the injury report|back (?:in|at) practice|good to go|will play|expected to play|set to play|upgraded"),
]
TAG_RE = [(t, re.compile(p, re.I)) for t, p in TAGS]

# Role signals: what a story says will happen to one player's playing time. Unlike the tags these
# feed the NFL projections (build_data.py), so each phrase is pinned to the player it is about:
# the nearest name before it in the same sentence part (or after it, if none is before).
#   out    he won't play (blocks a "returning" call)        ret    he is back / will play
#   start  starter, lead back, full workload                lim    snap count, eased back, committee
#   down   benched, demoted, losing work
# Phrases like "over", "cut into", "at the expense of" mark the NEXT name as losing work
# ("Hall to start over Allen": Hall start, Allen down). Matched on normalized text (see norm).
ROLE_PATTERNS = [
    ("out", r"ruled out|will not play|wont play|will miss|to miss|expected to miss|not expected to play|"
            r"(?:placed|lands|landed|goes|going|headed|moved) (?:on|to) (?:ir|injured reserve)|"
            r"out for (?:the )?(?:season|year|game|week|weeks|sunday|monday|thursday)|season[ -]ending|\binactive\b|sidelined (?:for|again|until)"),
    ("ret", r"activated|designated to return|(?:returns?|returning|returned) (?:to (?:practice|action|the lineup|the field|play)|from|vs|against|for|this|sunday|monday|thursday|saturday)|"
            r"(?:will|expected to|set to|on track to|in line to|poised to|plans to|likely to|slated to) (?:play|return|suit up|make (?:his|the) return)|"
            r"\bcleared\b|good to go|full practice|practic(?:e|es|ed|ing) fully|full participant|off the injury report|no injury designation|"
            r"back (?:at|in) practice|back in the lineup|is back\b|back from (?:injury|ir|injured reserve|(?:a |his )?\w+ injury)|upgraded|\breturns\b|\breturning\b|makes? (?:his|the) return"),
    ("start", r"named (?:the )?starter|(?:will|to|set to|expected to|slated to|poised to|in line to) start\b|"
              r"(?:gets|get|earns|earn|draws|wins|regains?|reclaims?) (?:the )?(?:start|starting (?:job|role|nod)|job|lead role)|"
              r"starting (?:role|job|nod)|(?:is|as|remains|will be) the starter|(?:lead|starting|top) (?:back|running back|rb)|\brb1\b|\bwr1\b|bell ?cow|workhorse|feature back|lead role|featured role|"
              r"top (?:back|option)|full workload|no (?:snap|pitch) count|no (?:limitations|restrictions)|without restrictions|"
              r"(?:expanded|bigger|larger|increased) role|more (?:carries|touches|snaps|work|targets)|promot"),
    ("lim", r"snap count|pitch count|limited (?:snaps|role|workload|reps|work)|eas(?:e|ed|ing) (?:him )?(?:back|in)|"
            r"workload (?:limit|restriction|management|will be managed)|wont (?:have|get|see) a full|not (?:have |get )?a full workload|"
            r"part[ -]time|rotational role|split (?:carries|work|time|reps|snaps)|committee|timeshare|share (?:the )?(?:backfield|carries|work|load)"),
    ("down", r"bench(?:ed)?\b|demot|backup role|los(?:e|es|ing) (?:his|the) (?:starting )?(?:job|role|spot)|lost (?:his|the) (?:starting )?(?:job|role|spot)|"
             r"(?:reduced|smaller|diminished|lesser) role|fewer (?:carries|touches|snaps|targets)|"
             r"(?:moves?|moved|drops?|dropped|slides?|slid|falls?|fell) (?:down|to (?:second|third|the bench)|behind)|second[ -]team|"
             r"healthy scratch|out of the rotation"),
]
ROLE_RE = [(k, re.compile(p)) for k, p in ROLE_PATTERNS]
# the name AFTER these loses work: "start over Allen", "cut into Allen's carries"
TAKES_FROM = re.compile(r"\b(?:over|ahead of|in place of|instead of|replac(?:es|ing)|cut(?:s|ting)? into|eat(?:s|ing)? into|"
                        r"(?:take|takes|taking|steal|steals) (?:carries|work|snaps|touches|targets) (?:from|away from)|at the expense of|supplants?|unseats?)\b")
# sentence breaks: a phrase only looks ahead for its player within one part
CLAUSE = re.compile(r"[;:!?|,()]|\s[-–—]\s|\.\s")
NOT_RETURN = re.compile(r"(?:kick|kickoff|punt) returns?")


def role_text(s):
    """Lowercase story text with punctuation kept (for sentence breaks) and A.J.-style periods and
    apostrophes dropped, so names line up with norm()."""
    s = html.unescape(str(s or "")).lower()
    s = re.sub(r"(?<=\b[a-z])\.(?=[a-z]\.)|(?<=\b[a-z]\.[a-z])\.", "", s)   # a.j. -> aj
    s = re.sub(r"\b([a-z])\.([a-z])\b", r"\1\2", s)
    s = re.sub(r"[’'`]", "", s)
    s = re.sub(r"\bst\.", "st", s)
    return NOT_RETURN.sub("special teams", s)


def role_signals(text, names):
    """{pid: set of role signals} for the players named in `text` (from role_text()).
    names: {pid: [full name, last name if only one player in this story has it]} (normalized).
    A phrase belongs to the nearest name before it; with none before, to the first name after it
    in the same sentence part. A name after "over" / "cut into" / ... loses work ("down")."""
    spots = []   # (start, end, pid)
    for pid, ns in names.items():
        for n in ns:
            rx = r"\b" + r"[\s\-]+".join(re.escape(w) for w in n.split()) + r"s?\b"   # Allen's -> allens
            spots += [(m.start(), m.end(), pid) for m in re.finditer(rx, text)]
    if not spots:
        return {}
    spots.sort()
    breaks = [m.start() for m in CLAUSE.finditer(text)]
    part = lambda pos: sum(1 for b in breaks if b < pos)
    out, taken = {}, set()
    for kind, rx in ROLE_RE:
        for m in rx.finditer(text):
            before = [sp for sp in spots if sp[1] <= m.start()]
            after = [sp for sp in spots if sp[0] >= m.end() and part(sp[0]) == part(m.start())]
            who = before[-1][2] if before else after[0][2] if after else None
            if who:
                out.setdefault(who, set()).add(kind)
    for m in TAKES_FROM.finditer(text):
        after = [sp for sp in spots if sp[0] >= m.end() and part(sp[0]) == part(m.start())]
        before = [sp for sp in spots if sp[1] <= m.start()]
        if after and (not before or before[-1][2] != after[0][2]):
            out.setdefault(after[0][2], set()).add("down")
            taken.add(after[0][2])
    for pid in taken:   # "Hall starts over Allen, the Jets' RB1 for a month": Allen isn't the starter
        out[pid] -= {"start", "ret"}
    return {pid: k for pid, k in out.items() if k}


# Facts about health and availability can sit in a story's summary; judgment calls (morale, trade,
# role) count only from the headline, since previews and recaps mention "streak" or "trade" in passing.
# RotoWire's summary is the news itself, so all of it counts there.
FROM_SUMMARY = {"illness", "injury", "rest", "return"}
# Previews, recaps, highlights, betting and fantasy roundups: name lots of players, say little about one
NOISE = re.compile(r"how to watch|where to watch|highlights|prediction|\bpicks?\b|\bodds\b|best bets|prop bets|fantasy|"
                   r"start(?:/| or | 'em)sit|pickups|waiver|rankings|mock draft|what to know|takeaways|grades|winners and losers|"
                   r"\bvs\.? .*: (?:preview|recap)|stephen a\.|father-son|by the numbers|top performances|\bquiz\b|podcast", re.I)
SUFFIX = re.compile(r"\s+(jr|sr|ii|iii|iv|v)$")


def norm(s):
    s = html.unescape(str(s or "")).lower()
    s = re.sub(r"[.'’`]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return SUFFIX.sub("", s.strip())


SCORE = re.compile(r"\b\d{2,3}-\d{2,3}\b")


def tags_for(headline, summary="", source=""):
    if SCORE.search(headline):   # a game recap: its summary is about the game, not one player's health
        summary = ""
    out = []
    for t, r in TAG_RE:
        if r.search(headline) or ((t in FROM_SUMMARY or source == "RotoWire") and summary and r.search(summary)):
            out.append(t)
    return out


def strip_html(s):
    s = re.sub(r"<[^>]+>", " ", html.unescape(s or ""))
    return re.sub(r"\s+", " ", s).strip()


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- sources

def parse_rss(raw, source):
    """Items from an RSS 2.0 or Atom feed: [{h, x, t, s, u}]."""
    root = ET.fromstring(raw)
    out = []
    atom = "{http://www.w3.org/2005/Atom}"
    items = root.iter("item")
    entries = list(root.iter(f"{atom}entry"))
    for it in list(items) or entries:
        def get(*names):
            for n in names:
                e = it.find(n)
                if e is not None and (e.text or e.get("href")):
                    return e.text or e.get("href")
            return None
        title = strip_html(get("title", f"{atom}title"))
        if not title:
            continue
        desc = strip_html(get("description", f"{atom}summary", f"{atom}content"))
        when = get("pubDate", f"{atom}published", f"{atom}updated", "{http://purl.org/dc/elements/1.1/}date")
        t = None
        if when:
            try:
                t = email.utils.parsedate_to_datetime(when).timestamp()
            except (TypeError, ValueError):
                try:
                    t = dt.datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp()
                except ValueError:
                    t = None
        link = get("link", f"{atom}link")
        out.append({"h": title, "x": desc[:300], "t": int(t or time.time()), "s": source, "u": link})
    return out


def parse_espn(j, source="ESPN"):
    """Items from ESPN's news API, with the ESPN athlete ids it is tagged with."""
    out = []
    for a in j.get("articles", []):
        title = a.get("headline") or a.get("title")
        if not title or a.get("type") == "Media":   # video clips and highlights
            continue
        when = a.get("published") or a.get("lastModified")
        try:
            t = dt.datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() if when else time.time()
        except ValueError:
            t = time.time()
        ids = []
        for c in a.get("categories", []):
            if c.get("type") == "athlete":
                aid = c.get("athleteId") or (c.get("athlete") or {}).get("id")
                if aid:
                    ids.append(str(aid))
        out.append({"h": strip_html(title), "x": strip_html(a.get("description"))[:300], "t": int(t), "s": source,
                    "u": ((a.get("links") or {}).get("web") or {}).get("href"), "ids": ids})
    return out


def espn_team_ids(sport):
    j = json.loads(fetch(f"{ESPN[sport]}/teams"))
    out = []
    for lg in j.get("sports", [{}])[0].get("leagues", []):
        for t in lg.get("teams", []):
            out.append(t["team"]["id"])
    return out


def collect(sport, status):
    items = []

    def add(name, fn):
        try:
            got = fn()
            items.extend(got)
            status[f"{sport} {name}"] = status.get(f"{sport} {name}", 0) + len(got)
        except Exception as e:  # any feed can be down, renamed, or blocked: skip it
            status.setdefault(f"{sport} {name}", f"failed: {type(e).__name__}: {str(e)[:80]}")

    add("ESPN", lambda: parse_espn(json.loads(fetch(f"{ESPN[sport]}/news?limit=100"))))
    try:
        ids = espn_team_ids(sport)
    except Exception as e:
        ids = []
        status[f"{sport} ESPN teams"] = f"failed: {type(e).__name__}"
    for tid in ids:
        add("ESPN team feeds", lambda tid=tid: parse_espn(json.loads(fetch(f"{ESPN[sport]}/news?team={tid}&limit=25"))))
    for name, url in RSS[sport]:
        if isinstance(status.get(f"{sport} {name}"), int) and status[f"{sport} {name}"] > 0:
            continue   # an earlier URL for this source already worked
        status.pop(f"{sport} {name}", None)
        add(name, lambda url=url, name=name: parse_rss(fetch(url), name))
    return items


# ---------------------------------------------------------------- matching

def nfl_roster():
    """[(gsis id, name, team, espn id)] for every back, receiver, and QB with a stat this season, from
    nflverse (not data.json): the news step runs before the NFL build, and a player coming back from
    injury isn't on the page until the build has read his news."""
    import build_data as B
    today = dt.date.today()
    season = today.year if today.month >= 8 else today.year - 1
    st = B.read_csv(f"{B.NFLVERSE}/stats_player/stats_player_week_{season}.csv")
    st = st[st.position.isin(["QB", "RB", "FB", "WR", "TE"])].sort_values("week").groupby("player_id").last()
    ids = {gid: x.get("espn") for gid, x in B.player_ids().items()}
    return [(pid, r.player_display_name, r.team, ids.get(pid)) for pid, r in st.iterrows()], dict(B.TEAM_NAMES)


def roster(sport):
    """[(pid, name, team, espn_id)] for the players on the site, read from the data files."""
    if sport == "nfl":
        try:
            return nfl_roster()
        except Exception as e:
            print("nflverse roster unavailable, using data.json:", e)
    path = os.path.join(SITE_DATA, "data.json" if sport == "nfl" else "nba.json")
    try:
        d = json.load(open(path))
    except (OSError, ValueError):
        return [], {}
    out = []
    ids = {}
    if sport == "nfl":
        try:
            import build_data as B
            ids = {gid: x.get("espn") for gid, x in B.player_ids().items()}
        except Exception as e:
            print("player id table unavailable:", e)
    for pid, p in d.get("players", {}).items():
        out.append((pid, p.get("name", ""), p.get("team"), str(pid) if sport == "nba" else ids.get(pid)))
    return out, d.get("team_names", {})


def match(items, players, team_names, want_roles=False):
    by_espn = {e: pid for pid, _, _, e in players if e}
    full_name = {pid: name for pid, name, _, _ in players}
    espn_of = {pid: e for pid, _, _, e in players if e}
    names = {}
    for pid, name, _, _ in players:
        n = norm(name)
        if len(n.split()) >= 2:
            names.setdefault(n, []).append(pid)
    # one regex over every name, longest first, so "jaylen brown" isn't read as "jay brown"
    # (an "s" may follow: apostrophes are stripped, so "Allen's" reads "allens")
    pat = re.compile(r"\b(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r")s?\b") if names else None
    nick = {}
    for ab, full in team_names.items():
        parts = full.split()
        nick[ab] = re.compile(r"\b(" + re.escape(full) + "|" + re.escape(parts[-1]) + r")\b", re.I)
    out_p, out_t = {}, {}
    for it in items:
        if NOISE.search(it["h"]):
            continue
        it["g"] = tags_for(it["h"], it.get("x", ""), it.get("s", ""))
        ids = it.get("ids", [])
        hit = {by_espn[i] for i in ids if i in by_espn} if len(ids) <= 3 else set()   # roundups tag many
        if pat:
            # a name in the headline counts; in the summary only if ESPN tagged nobody
            found = set(pat.findall(norm(it["h"])))
            if not hit and len(ids) <= 3:
                found |= set(pat.findall(norm(it.get("x", ""))))
            for n in found:
                if len(names[n]) != 1:   # two site players with one name: can't tell which
                    continue
                pid = names[n][0]
                # ESPN tagged the story's players: a name match whose ESPN id isn't among them is
                # someone else with that name (the Browns LB Justin Jefferson, not the Vikings WR)
                if ids and espn_of.get(pid) and espn_of[pid] not in ids:
                    continue
                hit.add(pid)
        rec = {k: it[k] for k in ("h", "x", "t", "s", "u", "g") if it.get(k) is not None}
        sig = {}
        if hit and want_roles:
            # last names count only when one player in this story has that last name
            lasts = {}
            for pid in hit:
                lasts.setdefault(norm(full_name[pid]).split()[-1], []).append(pid)
            nm = {pid: [norm(full_name[pid])] + [ln for ln, ps in lasts.items() if ps == [pid] and len(ln) > 2] for pid in hit}
            sig = role_signals(role_text(it["h"]), nm)
            # a summary is the news itself for RotoWire and for ESPN stories about one player
            if it.get("x") and (it.get("s") == "RotoWire" or len(ids) == 1):
                for pid, k in role_signals(role_text(it["x"]), nm).items():
                    sig.setdefault(pid, set()).update(k)
        for pid in hit:
            r = dict(rec)
            if sig.get(pid):
                r["r"] = sorted(sig[pid])
            out_p.setdefault(pid, []).append(r)
        if not hit and ({"morale", "trade"} & set(it["g"])):
            for ab, r in nick.items():
                if r.search(it["h"]):
                    out_t.setdefault(ab, []).append(rec)
    return out_p, out_t


def merge(new, old, cutoff, cap):
    """Union of two {key: [items]} maps, newest first, deduplicated by headline, recent only."""
    out = {}
    for src in (new, old):
        for k, items in (src or {}).items():
            for it in items:
                if it.get("t", 0) >= cutoff:
                    out.setdefault(k, []).append(it)
    for k, items in out.items():
        seen, keep = set(), []
        for it in sorted(items, key=lambda i: -i["t"]):
            key = norm(it["h"])[:80]
            if key not in seen:
                seen.add(key)
                keep.append(it)
        out[k] = keep[:cap]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", default=os.path.join(SITE_DATA, "news.json"))
    ap.add_argument("--out", default=os.path.join(SITE_DATA, "news.json"))
    args = ap.parse_args()
    try:
        prev = json.load(open(args.prev))
    except (OSError, ValueError):
        prev = {}
    cutoff = time.time() - KEEP_DAYS * 86400
    status, out = {}, {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "keep_days": KEEP_DAYS}
    for sport in ("nfl", "nba"):
        players, team_names = roster(sport)
        items = collect(sport, status)
        by_p, by_t = match(items, players, team_names, want_roles=sport == "nfl")
        old = prev.get(sport, {})
        out[sport] = {"players": merge(by_p, old.get("players"), cutoff, PER_PLAYER),
                      "teams": merge(by_t, old.get("teams"), cutoff, PER_PLAYER)}
        n = sum(len(v) for v in out[sport]["players"].values())
        print(f"{sport}: {len(items)} stories read, {len(by_p)} players matched now, {n} player stories kept")
    out["sources"] = status
    for k, v in sorted(status.items()):
        print(f"  {k}: {v}")
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
