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

  // Recent ESPN headlines, indexed by the player names they're tagged with
  let NEWS = {};
  async function news(sport) {
    const j = await espn(sport, "news?limit=100");
    const out = {}, cutoff = Date.now() - 4 * 864e5;
    for (const a of j.articles || []) {
      const when = new Date(a.published || a.lastModified || 0).getTime();
      if (when < cutoff) continue;
      const item = { headline: a.headline || a.title, text: a.description || "", when, href: a.links?.web?.href || null };
      for (const c of a.categories || []) {
        if (c.type === "athlete" && c.description) (out[norm(c.description)] ||= []).push(item);
      }
    }
    NEWS = out;
    return Object.keys(out).length;
  }
  const newsFor = (name) => NEWS[norm(name)] || [];

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
      <div class="panel-head"><h2>Player notes</h2><span class="muted small">▲ good spot · ▼ tough spot · ! injury or minutes risk. Built from the model, recent games, ESPN's injury report and headlines.</span></div>
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

  return { injuries, news, newsFor, without, panel, chip, norm, autoRefresh };
})();
