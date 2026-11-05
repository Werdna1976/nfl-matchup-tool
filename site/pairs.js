"use strict";

// Negative correlation multipliers, shared by the NFL and NBA pages. Replaces the storyline baskets.
//
// Two props from one game rarely land independently. The simulation in baskets.js (with its
// weights fitted to past seasons) says how often both hit. These pairs hit together LESS often
// than their chances multiplied: a lead back's carries and his QB's attempts, two backs who split
// carries, the two teams' lead backs. A parlay builder that adjusts for that link should pay MORE
// than straight multiplication, and that bump is the "multiplier" worth chasing.
//
// Only pairs worth taking are listed (Andrew, 2026-11-05): both legs priced at or below their
// careful fair price (+1¢ slack), and both hitting together at least 1 game in 8. Pairs that move
// together were dropped, since a correlation-aware builder pays them less than straight.
// Every pair shows its break-even payout next to what straight multiplication of the two prices
// pays, and how much more than straight the builder has to quote to make it a fair bet.

const PAIRS = (() => {
  const MIN_JOINT = 0.12;      // "feasible": both hit in at least 1 simulated game in 8
  const MIN_LEG = 0.25, MAX_LEG = 0.85;
  const NEG = -0.1;            // correlation (phi) that counts as pulling apart
  const FAIR_TOL = 0.01;       // a leg counts as fairly priced up to 1¢ over its careful fair price
  const SHOWN = 10;
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

  // a leg priced at or below its careful fair price (the pressure test's adjusted chance)
  const fairLeg = (l) => l.price <= (l.pa ?? l.p) + FAIR_TOL;

  // every pair of fairly priced legs from different players (or a player and a game line) that pulls apart
  function find(legs, priced) {
    if (!priced) return [];
    const L = pickLegs(legs, priced).filter((l) => l.bits && fairLeg(l));
    const out = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j];
      if (a.grp === b.grp) continue;                       // same player, or two bets on the result, or two totals
      const pa = a.hit ? hitRate(a) : a.p, pb = b.hit ? hitRate(b) : b.p;
      const pj = BASKETS.popcount(BASKETS.and(a.bits, b.bits)) / BASKETS.N;
      if (pj < MIN_JOINT * 0.8) continue;
      const phi = (pj - pa * pb) / Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
      if (phi > NEG) continue;
      const lift = pj / (pa * pb);
      // the careful chance: each leg's adjusted chance (pressure test) with part of the lift
      const ca = a.pa ?? a.p, cb = b.pa ?? b.p;
      const pAdj = Math.min(Math.min(ca, cb), ca * cb * (1 + TRUST * (lift - 1)));
      if (pAdj < MIN_JOINT) continue;
      const straight = priced ? 1 / (a.price * b.price) : null;
      out.push({ a, b, pj, pa, pb, phi, lift, pAdj, fair: 1 / pAdj, straight, ev: priced ? pAdj * straight - 1 : null });
    }
    // best first: the closest to fair at straight multiplication (so the smallest bump is needed),
    // then the stronger the pull apart and the likelier the pair
    const score = (x) => x.ev + 0.5 * (1 - x.lift) + 0.5 * x.pAdj;
    return spread(out.sort((x, y) => score(y) - score(x)));
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
      <span class="muted small">fair ${cents(l.pa ?? l.p)}${priced ? ` · price ${cents(l.price)}` : ""}</span></div>`;
  }

  function table(rows) {
    if (!rows.length) return `<div class="empty">No pair here pulls apart strongly, lands together at least 1 game in 8, and has both legs priced at or below fair right now.</div>`;
    return `<div class="table-wrap"><table class="pairs-t">
      <thead><tr><th>#</th><th class="lt-leg">Pair</th><th title="How the two move together, from -1 (never both) to +1 (always both); 0 = unrelated">Link</th>
        <th title="Chance both hit (careful estimate) vs. their chances multiplied">Both hit</th>
        <th title="The two Polymarket prices multiplied: what a parlay that ignores the link pays (total back per $1)">Straight</th>
        <th title="What the pair has to pay (total back per $1) to be a fair bet on the careful chance">Break-even</th>
        <th title="How much more than straight multiplication the parlay builder has to pay to reach break-even">Multiplier needed</th></tr></thead>
      <tbody>${rows.map((x, i) => `<tr><td class="muted">${i + 1}</td>
        <td class="lt-leg">${legCell(x.a, true)}${legCell(x.b, true)}</td>
        <td><b class="edge-bad">−${Math.abs(x.phi).toFixed(2)}</b></td>
        <td><b>${pct(x.pAdj)}</b><div class="muted small">${pct((x.a.pa ?? x.a.p) * (x.b.pa ?? x.b.p))} if unrelated</div></td>
        <td>${xs(x.straight)}</td>
        <td><b>${xs(x.fair)}</b></td>
        <td class="${x.fair <= x.straight ? "edge-good" : ""}">${x.fair <= x.straight ? "none: fair at straight" : `${(x.fair / x.straight).toFixed(2)}x straight`}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function html(legs, priced) {
    const intro = `<div class="muted small">Pairs that land together <b>less</b> often than their chances multiplied, but still at least 1 game in 8, with <b>both legs priced at or below fair</b>. A parlay builder that adjusts for the link should pay more than straight multiplication. Take the pair when Polymarket's quote reaches the <b>Break-even</b> column.</div>`;
    const body = priced ? table(find(legs, priced)) : `<div class="empty">Shows once Polymarket posts player prices for this game, since every leg has to be priced at or below fair.</div>`;
    return `<div class="lotto"><h3>Negative correlation multipliers</h3>${intro}${body}${BASKETS.how(HOW)}</div>`;
  }

  const HOW = `Every leg is a real Polymarket line, the best-priced one per player stat, priced at or below its careful fair price (the pressure test's adjusted chance, plus 1¢ of slack). The game is simulated ${(6000).toLocaleString()} times with weights fitted to past seasons, so props that share a cause move together: a team's scoring, which side is ahead, how much of the game each team has the ball, how pass-friendly the game is, and pools that teammates split (two backs' carries, receivers' targets, NBA regulars' shots). <b>Link</b> is the correlation of the two hits; only pairs at −0.10 or below are listed. <b>Both hit</b> uses each leg's careful chance (the pressure test's adjusted chance) and three quarters of the simulated link. Pairs from one player are left out (the simulation doesn't model a player's own stats against each other well enough), as are two bets on the same game result or two totals. Pairs that move together are left out: a builder that adjusts for the link pays them less than straight. Measured on past games (NFL 2024-2026, NBA 2024-25 and 2025-26): a QB's passing yards and his top receiver's yards +0.41, opposing lead backs' carries -0.29, a lead back's carries and his own QB's attempts -0.11, two NBA starters' points -0.02, a starter's points and a blowout -0.13.`;

  return { find, html };
})();
