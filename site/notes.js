"use strict";

// Player notes, shared by the NFL and NBA pages: ESPN injury report and headlines (read live
// in the browser), how a player did in past games without an injured teammate, and the
// little panel that lists each game's notes. Each page supplies its own sport-specific rules.

const NOTES = (() => {
  const hosts = (sport) => [`https://site.api.espn.com/apis/site/v2/sports/${sport}`,
    `https://site.web.api.espn.com/apis/site/v2/sports/${sport}`];

  async function espn(sport, path) {
    let err;
    for (const base of hosts(sport)) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`${base}/${path}`, { signal: ctl.signal, cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        return await r.json();
      } catch (e) { err = e; } finally { clearTimeout(t); }
    }
    throw err;
  }

  const norm = (s) => String(s || "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();

  // {byId, byName} from ESPN's league injury report
  async function injuries(sport) {
    const j = await espn(sport, "injuries");
    const byId = {}, byName = {};
    for (const team of j.injuries || []) for (const it of team.injuries || []) {
      const a = it.athlete || {};
      let id = a.id ? String(a.id) : null;
      if (!id) for (const l of a.links || []) { const m = /\/id\/(\d+)/.exec(l.href || ""); if (m) { id = m[1]; break; } }
      const d = it.details || {};
      const e = {
        status: it.status || null,
        injury: [d.side && d.side !== "Not Specified" ? d.side : null, d.type].filter(Boolean).join(" ") || null,
        note: it.shortComment || null, date: (it.date || "").slice(0, 10) || null, ret: d.returnDate || null,
      };
      if (!e.status) continue;
      if (id) byId[id] = e;
      if (a.displayName) byName[norm(a.displayName)] = e;
    }
    return { byId, byName, count: Object.keys(byName).length };
  }

  // What a story is about, by keyword (the same rules as scripts/news_build.py). Keyword rules, not
  // a reading of the story: they point at what's worth reading, and none of it is in the projections.
  const TAGS = [
    ["illness", /illness|\bill\b|sick|flu\b|virus|stomach|migraine|non-injury|personal (?:reasons|matter)|bereavement|family matter/i],
    ["injury", /injur|hamstring|ankle|knee|groin|calf|quad|achilles|\bacl\b|\bmcl\b|concussion|shoulder|wrist|\bhand\b|foot|toe\b|hip\b|ribs?\b|oblique|back (?:injury|spasms?|tightness)|sprain|strain|fractur|torn|\btear\b|\bmri\b|x-rays?|surgery|ruled out|\bout for\b|questionable|doubtful|game-time decision|limited (?:in )?practice|did not practice|\bdnp\b|injured reserve|day-to-day|week-to-week|sidelined|tweak|aggravat|\bsore|banged up|carted|exited|left (?:the )?game/i],
    ["rest", /load management|maintenance|minutes (?:limit|restriction|cap)|snap (?:count|limit)|pitch count|workload|\bresting\b|will rest|to rest\b|rest (?:day|night)|back-to-back|second night/i],
    ["role", /bench(?:ed)?\b|demot|promot|depth chart|named (?:the )?starter|will start|to start\b|starting (?:lineup|role|job|nod)|first-team|second-team|lose (?:his|the) (?:job|role|spot)|rotation|coming off the bench|move(?:d|s)? to the bench|expanded role|bigger role|larger role|reduced role|committee|split (?:carries|work)|snap share|usage/i],
    ["trade", /trade|traded|dealt\b|deadline|rumou?r|shopping|on the (?:trading )?block|wants out|request(?:ed|s)? (?:a )?trade|acquir|waive[ds]?\b|released|cut by|buyout|free agen|sign(?:s|ed|ing) with|extension|contract (?:talks|dispute|year)/i],
    ["morale", /suspen|\bfined?\b|arrest|charged|discipline|frustrat|unhappy|upset (?:with|about|over|by)|disgruntl|hold ?out|hold-in|critici|called out|calls out|blast(?:s|ed)|rips?\b|ripped|sound(?:s|ed)? off|lash(?:es|ed)? out|feud|rift|beef|locker room|chemistry|effort|attitude|not happy|\btension|sulk|apologi|benched for|ultimatum|tanking|morale|motivat|checked out|quit on|\bquit\b|confront|walk(?:ed|s)? out|no-show|ejected|controversy/i],
    ["return", /return(?:s|ing|ed)? (?:to|from|vs\.?|for|tonight|sunday|monday|thursday)|cleared|activated|full practice|off the injury report|back (?:in|at) practice|good to go|will play|expected to play|set to play|upgraded/i],
  ];
  const TAG_LABEL = { illness: "Illness", injury: "Injury", rest: "Rest", role: "Role", trade: "Trade/contract", morale: "Morale/discipline", return: "Returning" };
  // tags that can mean he plays less or worse; "role" and "return" can cut either way
  const RISKY = new Set(["illness", "injury", "rest", "trade", "morale"]);
  // health facts can come from the summary; morale, trade, and role only from the headline
  const FROM_SUMMARY = new Set(["illness", "injury", "rest", "return"]);
  const tagsFor = (head, summary = "") => (summary = /\b\d{2,3}-\d{2,3}\b/.test(head) ? "" : summary, TAGS.filter(([t, r]) => r.test(head) || (FROM_SUMMARY.has(t) && r.test(summary))).map(([t]) => t));
  const NOISE = /how to watch|where to watch|highlights|prediction|\bpicks?\b|\bodds\b|best bets|prop bets|fantasy|start(?:\/| or | 'em)sit|pickups|waiver|rankings|mock draft|what to know|takeaways|grades|winners and losers|stephen a\.|father-son|by the numbers|top performances|\bquiz\b|podcast/i;

  // Live ESPN headlines (read by the browser), indexed by the player names they're tagged with
  let NEWS = {};
  async function news(sport) {
    const j = await espn(sport, "news?limit=100");
    const out = {}, cutoff = Date.now() - 4 * 864e5;
    for (const a of j.articles || []) {
      const when = new Date(a.published || a.lastModified || 0).getTime();
      const athletes = (a.categories || []).filter((c) => c.type === "athlete");
      if (when < cutoff || a.type === "Media" || athletes.length > 3 || NOISE.test(a.headline || a.title || "")) continue;
      const item = { headline: a.headline || a.title, text: a.description || "", when, href: a.links?.web?.href || null, src: "ESPN" };
      item.tags = tagsFor(item.headline, item.text);
      for (const c of a.categories || []) {
        if (c.type === "athlete" && c.description) (out[norm(c.description)] ||= []).push(item);
      }
    }
    NEWS = out;
    return Object.keys(out).length;
  }

  // Stories gathered on each scheduled refresh (scripts/news_build.py): ESPN team feeds, RotoWire,
  // CBS, Yahoo, ProFootballTalk. Filed by player id, plus team stories about morale
  // and trades. 7 days kept.
  let FILE = { players: {}, teams: {} }, FILE_INFO = null;
  async function stories(key) {
    const r = await fetch(`data/news.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    FILE = j[key] || { players: {}, teams: {} };
    FILE_INFO = { updated: j.updated, sources: j.sources || {} };
    return Object.keys(FILE.players || {}).length;
  }
  const fromFile = (it) => ({ headline: it.h, text: it.x || "", when: (it.t || 0) * 1000, href: it.u || null, src: it.s || "", tags: it.g || tagsFor(it.h, it.x || "") });
  function dedupe(items) {
    const seen = new Set();
    return items.sort((a, b) => b.when - a.when).filter((n) => { const k = norm(n.headline).slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Everything about one player, newest first: the refresh's stories plus live ESPN headlines.
  // pid is optional (older callers pass just a name).
  function newsFor(name, pid) {
    const file = pid != null ? (FILE.players?.[pid] || []).map(fromFile) : [];
    return dedupe([...file, ...(NEWS[norm(name)] || [])]);
  }
  const teamNews = (ab) => dedupe((FILE.teams?.[ab] || []).map(fromFile));

  const ago = (when) => { const h = (Date.now() - when) / 36e5; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
  const tagText = (n) => (n.tags?.length ? n.tags.map((t) => TAG_LABEL[t]).join(", ") : "News");
  // Note chips for a player's (or team's) recent stories: up to `max`, from the last `days` days
  function newsChips(items, max = 3, days = 4) {
    const cutoff = Date.now() - days * 864e5;
    return items.filter((n) => n.when >= cutoff).slice(0, max).map((n) => ({
      kind: n.tags?.some((t) => RISKY.has(t)) ? "warn" : "info",
      text: `${tagText(n)}: ${n.headline} (${ago(n.when)}${n.src ? `, ${n.src}` : ""})`,
    }));
  }
  // The news block in the side panel: every story kept, with tags, source, age, and a link
  function newsList(items) {
    if (!items.length) return `<div class="muted small">No stories about him in the last 7 days from ESPN, RotoWire, CBS, Yahoo${FILE_INFO ? "" : " (the news file hasn't loaded)"}.</div>`;
    return `<ul class="news-list">${items.slice(0, 10).map((n) => `<li>
      <div>${(n.tags || []).map((t) => `<span class="tag ${RISKY.has(t) ? "warn" : ""}">${TAG_LABEL[t]}</span>`).join("")}${/^https?:\/\//i.test(n.href || "") ? `<a href="${esc(n.href)}" target="_blank" rel="noopener">${esc(n.headline)}</a>` : esc(n.headline)}</div>
      <div class="muted small">${esc(n.src || "")} · ${ago(n.when)}${n.text ? ` · ${esc(n.text.slice(0, 220))}` : ""}</div></li>`).join("")}</ul>`;
  }

  // Average of `stat` in the player's games where `mate` sat, vs. games they both played.
  // gameKey: field identifying the game in each log row (date for NBA, week for NFL).
  function without(p, mate, stat, gameKey) {
    const keys = mate.log.filter((r) => r.tm === p.team).map((r) => r[gameKey]);
    if (!keys.length) return null;
    const mateGames = new Set(keys);
    const first = keys.reduce((a, b) => (b < a ? b : a));   // only count games since they were teammates
    const rows = p.log.filter((r) => r.tm === p.team && r[gameKey] >= first);
    const wo = rows.filter((r) => !mateGames.has(r[gameKey])), wi = rows.filter((r) => mateGames.has(r[gameKey]));
    if (wo.length < 2 || wi.length < 2) return null;
    const avg = (a) => a.reduce((s, r) => s + stat(r), 0) / a.length;
    return { without: avg(wo), n: wo.length, with: avg(wi), m: wi.length };
  }

  const ICON = { good: "▲", bad: "▼", warn: "!", info: "•" };
  const chip = (n) => `<span class="note-chip ${n.kind}">${ICON[n.kind]} ${esc(n.text)}</span>`;

  // The per-game panel: players with notes, strongest signals first
  function panel(el, rows, links) {
    const score = (ns) => ns.reduce((s, n) => s + (n.kind === "good" || n.kind === "bad" ? 2 : n.kind === "warn" ? 1.5 : 0.5), 0);
    // team-wide notes stay on top, then players with the strongest signals
    rows = rows.filter((r) => r.notes.length).sort((a, b) => (b.tag === "team") - (a.tag === "team") || score(b.notes) - score(a.notes));
    el.innerHTML = `
      <div class="panel-head"><h2>Player notes</h2><span class="muted small">▲ good spot · ▼ tough spot · ! injury or minutes risk. Built from the model, recent games, ESPN's injury report, and player news (ESPN, RotoWire, CBS, Yahoo, ProFootballTalk) tagged by topic. News tags are keyword-based and not in the projections: read the story.</span></div>
      ${rows.length ? `<div class="notes-list">${rows.map((r) => `
        <div class="note-row${r.pid ? "" : " team"}" data-pid="${r.pid || ""}">
          <div class="note-who"><span class="pname">${esc(r.name)}</span><span class="pos-tag">${esc(r.tag)}</span></div>
          <div class="note-chips">${r.notes.map(chip).join("")}</div>
        </div>`).join("")}</div>` : `<div class="empty">Nothing stands out for this game yet.</div>`}
      <div class="note">Message-board picks aren't included: Reddit and similar sites block automated reading without a paid key. Quick links for a manual check: ${links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join(" · ")}</div>`;
  }

  // Re-check lines, injuries, and headlines every 10 minutes while the page is open and visible
  function autoRefresh(fn) {
    let last = Date.now();
    setInterval(() => { if (!document.hidden && Date.now() - last > 9.5 * 60e3) { last = Date.now(); fn(); } }, 60e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - last > 9.5 * 60e3) { last = Date.now(); fn(); } });
  }

  return { injuries, news, stories, newsFor, teamNews, newsChips, newsList, tagsFor, RISKY, TAG_LABEL, ago, without, panel, chip, norm, autoRefresh };
})();
