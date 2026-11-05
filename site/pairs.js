"use strict";

// Correlated pairs, shared by the NFL and NBA pages. Replaces the storyline baskets.
//
// Two props from one game rarely land independently. The simulation in baskets.js (with its
// weights fitted to past seasons) says how often both hit:
//   - "Pull apart" pairs hit together LESS often than their chances multiplied. A lead back's
//     carries and his QB's attempts, two backs who split carries, a scorer's points and his
//     teammate's. A parlay that prices legs as unrelated (straight multiplication) overpays you
//     for nothing here, but a builder that adjusts for correlation pays MORE than straight
//     multiplication, and these are the pairs where that bump is worth chasing. Only pairs that
//     still land together often enough to be a real outcome (1 game in 8 or more) are listed.
//   - "Move together" pairs hit together MORE often than multiplied (a QB's yards and his top
//     receiver's, a back's yards and his team covering). Straight multiplication underpays the
//     risk here, so they can be value as a straight parlay; a correlation-aware builder will
//     usually trim the payout.
// Every pair shows its break-even payout (what it has to pay to be a fair bet on the careful
// chance) next to what straight multiplication of the two prices pays.

const PAIRS = (() => {
  const MIN_JOINT = 0.12;      // "feasible": both hit in at least 1 simulated game in 8
  const MIN_LEG = 0.25, MAX_LEG = 0.85;
  const NEG = -0.1, POS = 0.12;  // correlation (phi) that counts as pulling apart / moving together
  const SHOWN = 8;
  const TRUST = 0.75;          // share of the simulated lift counted (fitted to data, but still an estimate)

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${p < 0.1 ? (p * 100).toFixed(1) : Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const xs = (m) => `${m >= 10 ? m.toFixed(0) : m.toFixed(2)}x`;

  // One leg per ladder: the best-priced line (priced) or the main line (model only), so a list
  // isn't ten versions of one pair
  function pickLegs(legs, priced) {
    const by = new Map();
    for (const l of legs) {
      if (l.lotto || l.p < MIN_LEG || l.p > MAX_LEG) continue;
      if (priced && !(l.price >= 0.2 && l.price <= 0.85)) continue;
      const k = l.kind === "player" ? `${l.pid}|${l.key}|${l.side}` : `${l.kind}|${l.side}`;
      const cur = by.get(k), score = priced ? (l.pa ?? l.p) - l.price : -Math.abs(l.p - 0.55);
      if (!cur || score > cur.score) by.set(k, { l, score });
    }
    return [...by.values()].map((x) => x.l);
  }

  // every pair of legs from different players (or a player and a game line), with how they move together
  function find(legs, priced) {
    const L = pickLegs(legs, priced).filter((l) => l.bits);
    const out = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j];
      if (a.grp === b.grp) continue;                       // same player, or two bets on the result, or two totals
      const pa = a.hit ? hitRate(a) : a.p, pb = b.hit ? hitRate(b) : b.p;
      const pj = BASKETS.popcount(BASKETS.and(a.bits, b.bits)) / BASKETS.N;
      if (pj < MIN_JOINT * 0.8) continue;
      const phi = (pj - pa * pb) / Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
      if (phi > NEG && phi < POS) continue;
      const lift = pj / (pa * pb);
      // the careful chance: each leg's adjusted chance (pressure test) with part of the lift
      const ca = a.pa ?? a.p, cb = b.pa ?? b.p;
      const pAdj = Math.min(Math.min(ca, cb), ca * cb * (1 + TRUST * (lift - 1)));
      if (pAdj < MIN_JOINT) continue;
      const straight = priced ? 1 / (a.price * b.price) : null;
      out.push({ a, b, pj, pa, pb, phi, lift, pAdj, fair: 1 / pAdj, straight, ev: priced ? pAdj * straight - 1 : null });
    }
    const neg = out.filter((x) => x.phi <= NEG), pos = out.filter((x) => x.phi >= POS);
    // pulling apart: biggest "bump" a correlation-aware builder should give first, among the more likely ones
    const negScore = (x) => (priced ? x.ev : 0) + 0.5 * (1 - x.lift) + 0.5 * x.pAdj;
    // moving together: best value as a straight parlay first
    const posScore = (x) => (priced ? x.ev : 0) + 0.5 * (x.lift - 1) * x.pAdj;
    return { neg: spread(neg.sort((x, y) => negScore(y) - negScore(x))), pos: spread(pos.sort((x, y) => posScore(y) - posScore(x))) };
  }
  const hitRate = (l) => { let n = 0; for (let i = 0; i < l.hit.length; i++) n += l.hit[i]; return n / l.hit.length; };

  // no player in more than two pairs, so the list covers the game
  function spread(list) {
    const used = new Map(), out = [];
    for (const x of list) {
      if (out.length >= SHOWN) break;
      const ka = x.a.grp, kb = x.b.grp;
      if ((used.get(ka) || 0) >= 2 || (used.get(kb) || 0) >= 2) continue;
      out.push(x); used.set(ka, (used.get(ka) || 0) + 1); used.set(kb, (used.get(kb) || 0) + 1);
    }
    return out;
  }

  function legCell(l, priced) {
    return `<div class="pr-leg">${TREND.link(l)}${l.q ? ` <span class="badge q">${esc(l.q)}</span>` : ""}
      <span class="muted small">${pct(l.pa ?? l.p)}${priced ? ` · ${cents(l.price)}` : ""}</span></div>`;
  }

  function table(rows, priced, kind) {
    if (!rows.length) return `<div class="empty">${kind === "neg" ? "No pair here pulls apart strongly and still lands together at least 1 game in 8." : "No pair here moves together strongly enough to list."}</div>`;
    return `<div class="table-wrap"><table class="pairs-t">
      <thead><tr><th>#</th><th class="lt-leg">Pair</th><th title="How the two move together, from -1 (never both) to +1 (always both); 0 = unrelated">Link</th>
        <th title="Chance both hit (careful estimate) vs. their chances multiplied">Both hit</th>
        <th title="What the pair has to pay (total back per $1) to be a fair bet on the careful chance">Break-even</th>
        ${priced ? `<th title="The two Polymarket prices multiplied, which is what a parlay that ignores the link pays">Straight</th><th title="Expected return if the parlay pays straight multiplication">Return</th>` : ""}</tr></thead>
      <tbody>${rows.map((x, i) => `<tr><td class="muted">${i + 1}</td>
        <td class="lt-leg">${legCell(x.a, priced)}${legCell(x.b, priced)}</td>
        <td><b class="${x.phi < 0 ? "edge-bad" : "edge-good"}">${x.phi >= 0 ? "+" : "−"}${Math.abs(x.phi).toFixed(2)}</b></td>
        <td><b>${pct(x.pAdj)}</b><div class="muted small">${pct((x.a.pa ?? x.a.p) * (x.b.pa ?? x.b.p))} if unrelated</div></td>
        <td><b>${xs(x.fair)}</b></td>
        ${priced ? `<td>${xs(x.straight)}</td><td class="${x.ev >= 0 ? "edge-good" : "edge-bad"}">${x.ev >= 0 ? "+" : "−"}${Math.abs(Math.round(x.ev * 100))}%</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  }

  function html(legs, priced) {
    const { neg, pos } = find(legs, priced);
    return `<div class="lotto"><h3>Pairs that pull apart</h3>
      <div class="muted small">Two props that land together <b>less</b> often than their chances multiplied, but still at least 1 game in 8. If Polymarket's parlay builder adjusts for the link, it should pay more than straight multiplication; take the pair only when its quote beats the <b>Break-even</b> column.</div>
      ${table(neg, priced, "neg")}
      <h3 style="margin-top:14px">Pairs that move together</h3>
      <div class="muted small">Two props that land together <b>more</b> often than multiplied. A parlay paying straight multiplication underprices these, so a positive <b>Return</b> is real value; a builder that adjusts for the link will usually quote less than Straight.</div>
      ${table(pos, priced, "pos")}
      ${BASKETS.how(HOW)}</div>`;
  }

  const HOW = `Every leg is a real Polymarket line (or, before prices are posted, the model's main line), one line per player stat. The game is simulated ${(6000).toLocaleString()} times with weights fitted to past seasons, so props that share a cause move together: a team's scoring, which side is ahead, how much of the game each team has the ball, how pass-friendly the game is, and pools that teammates split (two backs' carries, receivers' targets, NBA regulars' shots). <b>Link</b> is the correlation of the two hits. <b>Both hit</b> uses each leg's careful chance (the pressure test's adjusted chance) and three quarters of the simulated link. Pairs from one player are left out (the simulation doesn't model a player's own stats against each other well enough), as are two bets on the same game result or two totals. Measured on past games (NFL 2024-2026, NBA 2024-25 and 2025-26): a QB's passing yards and his top receiver's yards +0.41, opposing lead backs' carries -0.29, a lead back's carries and his own QB's attempts -0.11, two NBA starters' points -0.02, a starter's points and a blowout -0.13.`;

  return { find, html };
})();
