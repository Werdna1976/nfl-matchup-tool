"use strict";

// Spread + total combo: one spread bet and one game-total bet from the same game, bought together
// as a 2-leg parlay paying at least 3x (total back per $1). Shared by the NFL and NBA pages: a
// callout on each game's Bets tab, and one line per game on the Best bets view.
//
// The chance that both legs hit comes from a model fitted and backtested on past games
// (scripts/combo_fit.py, data in combodata.js):
//   NFL  past games with a similar spread and total (since 2006), shifted onto this game's lines.
//        Their real final margins and totals carry the key numbers (3, 7, 10) and whatever link
//        there is between the favorite covering and the total going over. On 2015-2026 games it
//        never saw, it beat the page's plain bell curves, mostly on alternate lines near key numbers.
//   NBA  two bell curves (margin 12.5 points wide, total 18), unrelated. Nothing fitted on 7,500
//        past games did better: NBA margins have no key numbers, and covering and the total going
//        over are almost unrelated (correlation about 0.01).
// Both are centered on the sportsbook line, not the page's team model: on 2022-2025 NFL games,
// the line alone predicted covers and totals better than the 80/20 line + model blend.
//
// Picking, per game:
//   - every pair of a Polymarket spread leg and total leg that takes $20 near the ask (the same
//     filters as the page's other bets), whose two prices multiplied pay 3x to 5x (over 5x only
//     when nothing pays 3x-5x: past that it's a long shot, not a likely outcome)
//   - each leg's adjusted chance is the model's chance blended 50/50 with Polymarket's midpoint (as
//     in vet.js), times the model's small same-game lift; the combo's return is judged on that
//   - shown: the likeliest combo priced at or above fair, then the best-priced one, then the
//     likeliest from another storyline (favorite/underdog x over/under). If nothing is priced in
//     your favor, the closest to fair is shown and labeled that way, not dressed up as a pick
//   - a leg off the main line (the one Polymarket prices nearest 50/50) is marked "alt line"
// Without Polymarket prices (blocked, not posted, or too early), a preview: the likeliest combo
// on half-point lines near the sportsbook's whose fair payout still clears 3x after a typical
// 2¢-per-leg markup.

const COMBO = (() => {
  const MIN_PAY = 3;            // total back per $1, stake included
  const MAX_PAY = 5;            // above this it's a long shot, not a likely outcome (used if anything fits)
  const W_MODEL = 0.5;          // model vs. Polymarket midpoint in the adjusted chance (as vet.js)
  const MARKUP = 0.02;          // a typical Polymarket ask over fair, per leg, for the preview
  const SHOWN = 3;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const xs = (m) => `${m.toFixed(m >= 10 ? 0 : 1)}x`;
  const signPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}%`;
  const sgn = (v) => (v > 0 ? `+${v}` : v === 0 ? "pk" : `${v}`);
  const totTxt = (side, line) => (Math.abs(line % 1 - 0.5) < 1e-9 ? (side === "over" ? `${Math.ceil(line)}+` : `${Math.floor(line)} or fewer`) : `${side} ${line}`);

  function Phi(z) {
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + (z < 0 ? -y : y));
  }

  // ------------------------------------------------------------ the model

  // where the game is centered: the sportsbook line, or the page's model when there is no line yet
  function center(g) {
    const book = g.spread != null && g.total != null;
    const s = book ? g.spread : g.model.margin.mean, L = book ? g.total : g.model.total.mean;
    return { fav: s >= 0 ? g.home : g.away, dog: s >= 0 ? g.away : g.home, S: Math.abs(s), L, book };
  }

  // NFL: past games weighted by how close their spread and total were to this game's, each one's
  // final margin and total shifted by the difference in lines
  let HIST = null;
  const KCACHE = new Map();
  function kernelFor(S, L) {
    const key = `${S}|${L}`;
    if (KCACHE.has(key)) return KCACHE.get(key);
    if (!HIST) {
      const r = COMBO_DATA.nfl.rows, n = r.length / 4;
      HIST = { n, S: new Float64Array(n), L: new Float64Array(n), M: new Float64Array(n), T: new Float64Array(n) };
      for (let i = 0; i < n; i++) { HIST.S[i] = r[4 * i] / 2; HIST.L[i] = r[4 * i + 1] / 2; HIST.M[i] = r[4 * i + 2]; HIST.T[i] = r[4 * i + 3]; }
    }
    const [hS, hL] = COMBO_DATA.nfl.kernel, H = HIST;
    const w = new Float64Array(H.n), M = new Float64Array(H.n), T = new Float64Array(H.n);
    let tot = 0;
    for (let i = 0; i < H.n; i++) {
      const a = (H.S[i] - S) / hS, b = (H.L[i] - L) / hL;
      w[i] = Math.exp(-0.5 * (a * a + b * b)); tot += w[i];
      M[i] = H.M[i] + S - H.S[i]; T[i] = H.T[i] + L - H.L[i];
    }
    for (let i = 0; i < H.n; i++) w[i] /= tot;
    const k = { w, M, T };
    KCACHE.set(key, k);
    return k;
  }

  // chance a spread leg ({side: team, line: that team's line}) covers, a total leg ({side, line})
  // hits, and both. Polymarket has no pushes; a whole-number line counts a push as a loss.
  function chance(A, g, sp, tot) {
    const c = center(g);
    const isFav = sp.side === c.fav;
    if (A.league === "nfl" && typeof COMBO_DATA !== "undefined") {
      const { w, M, T } = kernelFor(c.S, c.L);
      let ps = 0, pt = 0, pj = 0;
      for (let i = 0; i < w.length; i++) {
        const cov = isFav ? M[i] + sp.line > 0 : -M[i] + sp.line > 0;
        const hit = tot.side === "over" ? T[i] > tot.line : T[i] < tot.line;
        if (cov) ps += w[i];
        if (hit) pt += w[i];
        if (cov && hit) pj += w[i];
      }
      return { ps, pt, pj, lift: ps * pt > 0 ? pj / (ps * pt) : 1 };
    }
    const [sM, sT] = (typeof COMBO_DATA !== "undefined" && COMBO_DATA.nba?.normal) || [g.model.margin.sd, g.model.total.sd];
    // the side's own margin is +M for the favorite, -M for the underdog; it covers if margin + line > 0
    const ps = isFav ? 1 - Phi((-sp.line - c.S) / sM) : Phi((sp.line - c.S) / sM);
    const under = Phi((tot.line - c.L) / sT);
    const pt = tot.side === "over" ? 1 - under : under;
    return { ps, pt, pj: ps * pt, lift: 1 };
  }

  const story = (c, sp, tot) => `${sp.side === c.fav ? "fav" : "dog"}|${tot.side}`;
  const storyTxt = (A, c, sp, tot) => `${A.shortName(sp.side)} ${sp.side === c.fav ? (sp.line < 0 ? "win by more than " + -sp.line : "keep it close") : sp.line > 0 ? "stay within " + sp.line : "win by more than " + -sp.line}, ${tot.side === "over" ? "points come easy" : "a low-scoring game"}`;

  // ------------------------------------------------------------ with Polymarket prices

  // the main line of a ladder: the market Polymarket prices nearest 50/50
  function mainLines(markets) {
    const mid = (m) => { const q = m.quotes?.[0]; return q && q.ask != null && q.bid != null ? (q.ask + q.bid) / 2 : m.shown?.[0]; };
    const best = (kind) => {
      let b = null, d = Infinity;
      for (const m of markets) if (m.kind === kind) { const x = mid(m); if (x != null && Math.abs(x - 0.5) < d) { d = Math.abs(x - 0.5); b = m; } }
      return b;
    };
    const s = best("spread"), t = best("total");
    return { spread: s ? Math.abs(s.lines[0]) : null, total: t ? t.line : null };
  }

  function priced(A, g, rec) {
    const legs = BASKETS.legsFromMarkets(A, g, rec.markets);
    const sps = legs.filter((l) => l.kind === "spread"), tts = legs.filter((l) => l.kind === "total");
    if (!sps.length || !tts.length) return null;
    const c = center(g), main = mainLines(rec.markets);
    const mid = (l) => (l.bid != null ? (l.bid + l.ask) / 2 : l.ask);
    const out = [];
    for (const s of sps) for (const t of tts) {
      const price = s.price * t.price, pay = 1 / price;
      if (pay < MIN_PAY) continue;
      const ch = chance(A, g, s, t);
      const as = W_MODEL * ch.ps + (1 - W_MODEL) * mid(s), at = W_MODEL * ch.pt + (1 - W_MODEL) * mid(t);
      const pa = Math.min(as, at, as * at * ch.lift);
      out.push({
        s: { ...s, alt: main.spread != null && Math.abs(Math.abs(s.line) - main.spread) > 0.01, pm: ch.ps, pa: as },
        t: { ...t, alt: main.total != null && Math.abs(t.line - main.total) > 0.01, pm: ch.pt, pa: at },
        ...ch, pa, price, pay, ev: pa * pay - 1, evModel: ch.pj * pay - 1, story: story(c, s, t), storyTxt: storyTxt(A, c, s, t),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ without prices: a preview

  function preview(A, g) {
    const c = center(g);
    const half = (x) => Math.floor(x) + 0.5;
    const sLines = [], tLines = [];
    // a whole-number sportsbook line (3) sits between two half-point ones (2.5 and 3.5): both count as main
    const mains = (v) => (v % 1 === 0 ? [v - 0.5, v + 0.5] : [half(v)]);
    const mainS = mains(c.S), mainT = mains(c.L);
    for (let k = -6; k <= 6; k++) sLines.push(half(c.S) + k);
    for (let k = -10; k <= 10; k++) tLines.push(half(c.L) + k);
    const out = [];
    for (const x of sLines) {
      if (x <= 0) continue;
      for (const sp of [{ side: c.fav, line: -x }, { side: c.dog, line: x }]) for (const y of tLines) for (const side of ["over", "under"]) {
        const tot = { side, line: y };
        const ch = chance(A, g, sp, tot);
        if (ch.ps < 0.2 || ch.pt < 0.2) continue;
        const est = Math.min(0.99, ch.ps + MARKUP) * Math.min(0.99, ch.pt + MARKUP);
        if (1 / est < MIN_PAY) continue;
        out.push({
          s: { ...sp, kind: "spread", label: `${A.shortName(sp.side)} ${sgn(sp.line)}`, alt: !mainS.includes(x), pm: ch.ps },
          t: { ...tot, kind: "total", label: `Game total ${totTxt(side, y)} points`, alt: !mainT.includes(y), pm: ch.pt },
          ...ch, pa: ch.pj, fair: 1 / ch.pj, est: 1 / est, story: story(c, sp, tot), storyTxt: storyTxt(A, c, sp, tot),
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ choosing

  function choose(cands, hasPrices) {
    if (!cands?.length) return { picks: [], fair: false };
    // likely outcomes: keep to 5x or less when anything fits
    const near = cands.filter((c) => (c.pay ?? c.est) <= MAX_PAY);
    if (near.length) cands = near;
    const byP = [...cands].sort((a, b) => b.pa - a.pa);
    if (!hasPrices) {
      // the likeliest that still pays 3x after the markup, then the likeliest of two other storylines
      const picks = [];
      for (const c of byP) if (picks.length < SHOWN && !picks.some((p) => p.story === c.story)) picks.push({ ...c, role: picks.length ? "Another storyline" : "Likeliest at 3x" });
      return { picks, fair: true };
    }
    const good = byP.filter((c) => c.ev >= 0);
    if (!good.length) {
      const best = [...cands].sort((a, b) => b.ev - a.ev)[0];
      return { picks: [{ ...best, role: "Closest to fair" }], fair: false };
    }
    const picks = [{ ...good[0], role: "Likeliest at a fair price" }];
    const val = [...good].sort((a, b) => b.ev - a.ev)[0];
    if (val !== good[0]) picks.push({ ...val, role: "Best price" });
    for (const c of good) if (picks.length < SHOWN && !picks.some((p) => p.story === c.story)) picks.push({ ...c, role: "Another storyline" });
    return { picks, fair: true };
  }

  // one game: its picks, priced if Polymarket has spread and total markets, else a preview
  function pick(A, g, rec) {
    const live = rec && rec.src !== "blocked" ? priced(A, g, rec) : null;
    if (live && live.length) return { ...choose(live, true), priced: true, src: rec.src, t: rec.t };
    const why = !rec ? "prices not pulled yet" : rec.src === "blocked" ? "Polymarket unreachable"
      : live === null ? "no spread and total markets on Polymarket yet" : "no spread + total pair on Polymarket pays 3x";
    return { ...choose(preview(A, g), false), priced: false, why };
  }

  // ------------------------------------------------------------ drawing

  const legTxt = (l) => `${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l.label)}${l.alt ? ` <span class="badge alt" title="Not the main line: Polymarket's alternate line">alt line</span>` : ""}${(l.flags || []).map((f) => ` <span class="badge q">${esc(f)}</span>`).join("")}`;

  function row(c, i, isPriced, game = "") {
    const liftTxt = Math.abs(c.lift - 1) >= 0.02 ? ` · together ${c.lift > 1 ? "+" : "−"}${Math.abs(Math.round((c.lift - 1) * 100))}% vs. unrelated` : "";
    return `<tr class="${isPriced && c.ev < 0 ? "combo-neg" : ""}"><td class="lt-leg"><div class="muted small">${esc(c.role)}</div>${legTxt(c.s)}<br>${legTxt(c.t)}<div class="muted small">${esc(c.storyTxt)}</div></td>${game}
      <td><b>${pct(c.pa)}</b><div class="muted small" title="Each leg's chance in the model">${pct(c.s.pm)} × ${pct(c.t.pm)}${liftTxt}</div></td>
      ${isPriced
        ? `<td>${cents(c.s.price)} + ${cents(c.t.price)}<div class="muted small">pays <b>${xs(c.pay)}</b></div></td><td class="${c.ev >= 0 ? "edge-good" : "edge-bad"}">${signPct(c.ev)}<div class="muted small" title="Return on the model's chance alone">model ${signPct(c.evModel)}</div></td>`
        : `<td>fair ${xs(c.fair)}<div class="muted small">≈ ${xs(c.est)} at Polymarket's usual markup</div></td><td class="muted small">bet if it pays ${xs(1 / c.pa)}+</td>`}</tr>`;
  }

  function table(res, gameCol = null) {
    const isPriced = res.priced;
    return `<div class="table-wrap"><table class="lotto-t combo-t"><thead><tr><th class="lt-leg">Combo</th>${gameCol ? `<th class="ap-game">Game</th>` : ""}
      <th title="Chance both legs hit: each leg's model chance blended 50/50 with Polymarket's midpoint, times the model's same-game lift">Both hit</th>
      ${isPriced ? `<th title="What $20 costs per share on each leg now, and what the two together pay back per $1">Polymarket</th><th title="Expected profit per $1 at that chance">Return</th>` : `<th title="The payout that matches the model's chance">Payout</th><th></th>`}</tr></thead>
      <tbody>${res.picks.map((c, i) => row(c, i, isPriced, gameCol ? gameCol(c) : "")).join("")}</tbody></table></div>`;
  }

  function testedTxt() {
    const B = typeof COMBO_DATA !== "undefined" ? COMBO_DATA.backtest : null;
    if (!B) return "";
    const z = (m) => { const zz = m?.zone || []; return `combos it gave ${zz.map((x) => pct(x.pred)).join(", ")} hit ${zz.map((x) => pct(x.hit)).join(", ")} of the time`; };
    const nfl = B.nfl, nba = B.nba;
    return `<b>How the model was tested.</b> Fitted on past seasons and scored on later ones it never saw, on every alternate line around each game.
      ${nfl ? `<br><b>NFL</b> (${nfl.games.toLocaleString()} games, ${nfl.tests[0]}-${nfl.tests.at(-1)}): past games with similar lines beat the plain bell curves, mostly around key numbers (3, 7); ${z(nfl.models.kernel)}. "Favorite covers" and "over" are only loosely linked (correlation ${nfl.corr}).` : ""}
      ${nba ? `<br><b>NBA</b> (${nba.games.toLocaleString()} games with lines, ${nba.tests.length} seasons): plain bell curves (margin ${COMBO_DATA.nba.normal[0]} points wide, total ${COMBO_DATA.nba.normal[1]}) were as good as anything fitted; ${z(nba.models.normal).replace("it gave", "they gave")}. Covering and the total are unrelated (correlation ${nba.corr}).` : ""}
      <br><b>Against sportsbooks</b>, picking the model's favorite combo every NFL game at closing odds (2010-2025) lost about 8%: the sportsbook line already knows what the model knows. Any edge here comes from Polymarket's price drifting from the sportsbook line, which is what the Return column measures.`;
  }

  const HOW = `A spread bet and a game-total bet from this game, bought together, paying ${MIN_PAY}x to ${MAX_PAY}x back per $1 (more only when nothing fits). Each leg must take a $${typeof BASKETS !== "undefined" ? BASKETS.STAKE : 20} bet near the ask. "Both hit" blends the model with Polymarket's own price (50/50, as the pressure test does), so a big disagreement is treated with suspicion. Shown: the likeliest combo priced at or above fair, the best-priced one, and the likeliest from a different storyline. When no combo is priced in your favor, the closest one is shown and marked in red; skipping is the right call then. Legs off Polymarket's main line are marked <b>alt line</b>: they're how a combo gets to 3x when the main lines pay less (or how it stays likely when they pay more).`;

  function html(A, g, rec) {
    const res = pick(A, g, rec);
    const head = `<h3>Spread + total combo <span class="muted small">pays ${MIN_PAY}x or more</span></h3>`;
    if (!res.picks.length) return `<div class="lotto first combo">${head}<div class="empty">No spread + total combo for this game (no line to build one on).</div></div>`;
    const note = res.priced
      ? (res.fair ? `<div class="muted small">A spread and a total from this game as one 2-leg parlay. Priced from Polymarket now; the return is on a cautious chance (model and Polymarket blended).</div>`
        : `<div class="muted small combo-warn">No spread + total pair paying ${MIN_PAY}x is priced in your favor right now. The closest is below; it's a pass unless the price improves.</div>`)
      : `<div class="muted small">Preview from the model (${esc(res.why)}): the likeliest combos whose fair payout clears ${MIN_PAY}x even after Polymarket's usual markup. Once prices are up, bet one only if it pays at least the "bet if" number.</div>`;
    return `<div class="lotto first combo">${head}${note}${table(res)}${BASKETS.how(`${HOW}<br><br>${testedTxt()}`, "How these are picked and tested")}</div>`;
  }

  return { chance, pick, html, table, testedTxt, HOW, MIN_PAY, MAX_PAY, center };
})();
