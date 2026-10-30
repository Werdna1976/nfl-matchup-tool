"use strict";

// Scores for games that are over or under way, shared by the NFL and NBA pages.
// The data file marks finished games (g.final, g.home_score, g.away_score); when the browser
// can reach ESPN, g.live = {state: "pre" | "in" | "post", detail, home, away} is newer.

const RESULT = (() => {
  const state = (g) => g.live?.state || (g.final ? "post" : "pre");
  const scores = (g) => g.live && g.live.state !== "pre" ? [g.live.away, g.live.home] : [g.away_score, g.home_score];

  // ESPN scoreboard event -> g.live
  function fromEspn(ev) {
    const c = ev.competitions?.[0]; if (!c) return null;
    const st = c.status?.type || ev.status?.type || {};
    const side = {}; for (const t of c.competitors || []) side[t.homeAway] = Number(t.score);
    return { state: st.state || "pre", detail: st.shortDetail || st.detail || "", home: side.home, away: side.away };
  }

  // the "CAR 19 @ GB 27" line, winner (or leader) in bold
  function teams(g) {
    if (state(g) === "pre") return `${g.away} @ ${g.home}`;
    const [a, h] = scores(g);
    const side = (ab, s, other) => `<span class="${s > other ? "win" : ""}">${ab} <span class="score">${s}</span></span>`;
    return `${side(g.away, a, h)} @ ${side(g.home, h, a)}`;
  }

  function badge(g) {
    const s = state(g);
    if (s === "post") return `<span class="badge final">${/^final/i.test(g.live?.detail || "") ? g.live.detail : "Final"}</span>`;
    if (s === "in") return `<span class="badge live">Live · ${g.live.detail}</span>`;
    return null;
  }

  // How the game settled against the spread and total, e.g. "GB covered -3.5 · Under 47.5 (46)"
  function settled(g) {
    const [a, h] = scores(g);
    const out = [];
    if (g.spread != null) {
      const ats = h - a - g.spread;   // spread > 0 means the home team was favored
      const fav = g.spread >= 0 ? g.home : g.away, cover = ats > 0 ? g.home : g.away;
      const line = (team) => g.spread === 0 ? "pk" : `${team === fav ? "-" : "+"}${Math.abs(g.spread)}`;
      out.push(ats === 0 ? `Push ${fav} ${line(fav)}` : `${cover} covered ${line(cover)}`);
    }
    if (g.total != null) {
      const t = a + h;
      out.push(`${t > g.total ? "Over" : t < g.total ? "Under" : "Push"} ${g.total} (${t})`);
    }
    return out.join(" · ") || `Total points ${a + h}`;
  }

  // middle of the game header: the real score once there is one, the projection underneath
  function mid(g, proj) {
    if (state(g) === "pre") return `<div class="pts">${proj}</div>projected score`;
    const [a, h] = scores(g);
    return `<div class="pts">${a} – ${h}</div>${badge(g)}<div>projected ${proj}</div>`;
  }

  return { state, scores, fromEspn, teams, badge, settled, mid };
})();
