"use strict";

// Lock of the week (NFL) / Lock of the day (NBA): a few small parlays across one day's games that
// pay 2.5x to 5x, where the price beats a cautious estimate of the chance. Shared by both pages and
// drawn on the Best bets view (allprops.js).
//
// A "lock" here doesn't mean a sure thing. It means the likeliest kind of parlay worth betting:
// short, built from legs that already pass the pressure test (vet.js), and paying more than a
// careful read of the odds says it should. Two sources of edge:
//   1. single legs priced below their adjusted chance (Verified or Caution in the pressure test), and
//   2. legs from the same game that tell one story (a favorite covers and its lead back goes over),
//      which hit together more often than their prices multiplied. Polymarket prices each leg on
//      its own, so that lift is free value. Only half of the simulated lift is counted, since
//      how strongly legs move together hasn't been tested on past games.
// Legs from different games are treated as unrelated.
//
// Steps, per day:
//   - every game that hasn't started and has Polymarket props: legs priced 35-92¢ that the model
//     likes, each pressure-tested; legs that fail a check or whose adjusted chance is under the
//     price are dropped
//   - per game, "blocks" of 1-3 legs that all fit one storyline that happens in at least 1 game
//     in 5, with no two legs pulling against each other
//   - combos of blocks from 2+ games, 2-5 legs, paying 2.5x-5x, with an expected return of +2% or
//     better on the adjusted chances. Caution legs are fine (Andrew, 2026-11-01: Verified edges are
//     rare, and a lock list with no choices is no use); Skips never are
//   - ranked by return for the risk taken, and the top few that share no player or game result shown

const LOCKS = (() => {
  const MIN_PAY = 2.5, MAX_PAY = 5;          // total back per $1, stake included
  const MIN_LEGS = 2, MAX_LEGS = 5, MAX_BLOCK = 3, MAX_BLOCKS = 4, MIN_GAMES = 2;
  const PRICE_LO = 0.35, PRICE_HI = 0.92;    // no long shots, and no 95¢ legs that add risk but no payout
  const MIN_P = 0.5;                         // the model has to like the leg
  const FAIR = -0.01;                        // a same-game story leg may sit a cent under fair; it's there for the story
  const MIN_EV = 0.02;
  const LIFT_TRUST = 0.5;                    // share of the simulated same-game lift that is counted
  const PER_GAME = 24, BLOCKS_PER_GAME = 8, SHOWN = 5;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const xs = (m) => `${m.toFixed(m >= 10 ? 0 : 1)}x`;
  const signPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}%`;
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const niceDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  // ------------------------------------------------------------ one game: legs, stories, blocks

  // a leg passes if no check failed outright and the adjusted chance is about the price or better;
  // "edged" legs are the ones the pressure test grades Verified or Caution (not Skip)
  const passes = (l) => l.vet && !l.vet.reasons.some((r) => r.lvl === "bad") && l.vet.adj >= FAIR;
  const edged = (l) => passes(l) && l.vet.level !== "skip";

  function gameBlocks(info) {
    const { g, A, legs } = info;
    const B = BASKETS;
    // the model has to like it and the price has to be in range; the checks come next
    let cand = legs.filter((l) => l.price >= PRICE_LO && l.price <= PRICE_HI && l.p >= MIN_P && l.edge > 0)
      .map((l) => VET.grade(l, { A, g, legs })).filter(passes);
    // two lines per ladder at most (say 60+ and 70+ yards), best adjusted edge first
    const perLadder = new Map();
    cand = cand.sort((a, b) => b.vet.adj - a.vet.adj).filter((l) => {
      const k = l.kind === "player" ? `${l.pid}|${l.key}|${l.side}` : `${l.kind}|${l.side}`;
      const n = perLadder.get(k) || 0; perLadder.set(k, n + 1); return n < 2;
    }).slice(0, PER_GAME);
    if (!cand.length) return { cand, blocks: [] };
    B.simulate(A, g, cand);
    const N = B.N, rate = (bits) => B.popcount(bits) / N;
    for (const l of cand) { l.ps = rate(l.bits); l.gi = info; }
    // storylines that happen in at least 1 game in 5, minus the story-free "inefficiencies" one
    const stories = B.themed(B.stories(A, g).filter((s) => !s.priced), cand.sim).filter((s) => s.pt != null && s.pt >= B.MIN_THEME);

    const blocks = [];
    const pairOk = (a, b) => rate(B.and(a.bits, b.bits)) >= 0.98 * a.ps * b.ps;   // no pulling against each other
    const consider = (legs2) => {
      if (new Set(legs2.map((l) => l.grp)).size < legs2.length) return;
      if (!legs2.some(edged)) return;   // a fair-price leg rides along only beside a real edge
      for (let i = 0; i < legs2.length; i++) for (let j = i + 1; j < legs2.length; j++) if (!pairOk(legs2[i], legs2[j])) return;
      const fits = stories.filter((s) => legs2.every((l) => s.pool(l)));
      if (!fits.length) return;
      const bits = legs2.map((l) => l.bits).reduce(B.and), ps = rate(bits);
      if (!ps) return;
      // the storyline these legs tell best: the one that most often played out when they all hit
      const story = fits.map((s) => ({ s, given: rate(B.and(bits, s.tbits)) / ps })).sort((a, b) => b.given - a.given)[0];
      const lift = ps / legs2.reduce((m, l) => m * l.ps, 1);
      const used = 1 + LIFT_TRUST * (lift - 1);
      const pAdj = Math.min(Math.min(...legs2.map((l) => l.vet.pAdj)), legs2.reduce((m, l) => m * l.vet.pAdj, 1) * used);
      const price = legs2.reduce((m, l) => m * l.price, 1);
      if (pAdj / price < 1) return;   // the block on its own has to be worth its price
      blocks.push({ g, info, legs: legs2, pAdj, pModel: ps, price, lift, story: story.s, given: story.given, ver: legs2.filter((l) => l.vet.level === "verified").length });
    };
    const n = cand.length;
    for (let i = 0; i < n; i++) {
      consider([cand[i]]);
      for (let j = i + 1; j < n; j++) {
        consider([cand[i], cand[j]]);
        if (MAX_BLOCK >= 3) for (let k = j + 1; k < n; k++) consider([cand[i], cand[j], cand[k]]);
      }
    }
    // keep each game's best few, by value for the price, with every block size represented
    blocks.sort((a, b) => b.pAdj / b.price - a.pAdj / a.price);
    const keep = [];
    for (const size of [1, 2, 3]) keep.push(...blocks.filter((b) => b.legs.length === size).slice(0, 3));
    for (const b of blocks) if (keep.length < BLOCKS_PER_GAME && !keep.includes(b)) keep.push(b);
    return { cand, blocks: keep };
  }

  // ------------------------------------------------------------ combining games

  // Return for the risk: expected profit per $1 over its standard deviation. It favors combos
  // that hit often over long ones with the same expected return, which is what a lock should be.
  const sharpe = (P, pay) => (P * pay - 1) / (pay * Math.sqrt(P * (1 - P)));

  function combos(blocks) {
    const out = [];
    const walk = (start, pick, P, price, nLegs) => {
      const pay = 1 / price;
      if (pick.length >= 2 && nLegs >= MIN_LEGS && pay >= MIN_PAY && pay <= MAX_PAY) {
        const ver = pick.reduce((a, b) => a + b.ver, 0), ev = P * pay - 1;
        if (ev >= MIN_EV) out.push({ blocks: pick, P, price, pay, ev, ver, score: sharpe(P, pay) });
      }
      if (pick.length >= MAX_BLOCKS) return;
      for (let i = start; i < blocks.length; i++) {
        const b = blocks[i];
        if (pick.some((x) => x.g === b.g) || nLegs + b.legs.length > MAX_LEGS) continue;
        if (1 / (price * b.price) > MAX_PAY) continue;   // too long already
        walk(i + 1, [...pick, b], P * b.pAdj, price * b.price, nLegs + b.legs.length);
      }
    };
    walk(0, [], 1, 1, 0);
    return out.sort((a, b) => b.score - a.score);
  }

  // the best few that share no leg, player, or game result with one already picked, and with no
  // game in more than two of them, so one strange game can't sink every lock at once
  const PER_GAME_LOCKS = 3;
  const agree = (xs, ys) => xs.every((a) => ys.every((b) => BASKETS.popcount(BASKETS.and(a.bits, b.bits)) / BASKETS.N >= 0.98 * a.ps * b.ps));
  function pickTop(list, n = SHOWN) {
    const used = new Set(), games = new Map(), out = [];
    const keys = (c) => c.blocks.flatMap((b) => b.legs.map((l) => `${b.g.id}|${l.grp}`));
    for (const c of list) {
      if (out.length >= n) break;
      const ks = keys(c);
      if (c.blocks.length < MIN_GAMES || ks.some((k) => used.has(k)) || c.blocks.some((b) => (games.get(b.g.id) || 0) >= PER_GAME_LOCKS)) continue;
      // two locks sharing a game have to tell the same kind of story about it, not opposite ones
      if (c.blocks.some((b) => out.some((o) => o.blocks.some((ob) => ob.g === b.g && !agree(b.legs, ob.legs))))) continue;
      out.push(c); ks.forEach((k) => used.add(k));
      for (const b of c.blocks) games.set(b.g.id, (games.get(b.g.id) || 0) + 1);
    }
    return out;
  }

  // Build a day's locks. infos: one per game on that day ({g, A, legs, ok}).
  // The price-history check (network) runs on the legs of the leading combos only, then the pick is redone.
  async function build(infos) {
    const games = infos.filter((i) => i.ok && i.legs?.length);
    const per = games.map((i) => ({ info: i, ...gameBlocks(i) }));
    const blocks = per.flatMap((p) => p.blocks);
    let list = combos(blocks);
    const lead = list.slice(0, 25), legs = [...new Set(lead.flatMap((c) => c.blocks.flatMap((b) => b.legs)))];
    if (legs.length) {
      await VET.drift(legs);
      const bad = new Set(legs.filter((l) => !passes(l)));
      if (bad.size) list = list.filter((c) => !c.blocks.some((b) => b.legs.some((l) => bad.has(l))));
    }
    return { picks: pickTop(list), games: games.length, candidates: per.reduce((a, p) => a + p.cand.length, 0), blocks: blocks.length, combos: list.length };
  }

  // ------------------------------------------------------------ display

  function legRow(l) {
    const v = l.vet;
    return `<tr><td class="lk-leg">${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l.label)}${l.q ? ` <span class="badge q">${esc(l.q)}</span>` : ""}</td>
      <td><span class="vet-badge vet-${v.level === "verified" ? "verified" : "caution"}" title="${esc([v.adjNote, ...v.reasons.map((r) => r.text)].filter(Boolean).join(" · "))}">${v.level === "verified" ? "Verified" : v.level === "caution" ? "Caution" : "Fair price"}</span></td>
      <td><b>${pct(v.pAdj)}</b><div class="muted small">model ${pct(l.p)}</div></td><td>${cents(l.price)}</td></tr>`;
  }

  function card(c, i) {
    const be = 1 / c.P;
    const games = c.blocks.map((b) => `
      <tr class="lk-game"><td colspan="4"><button type="button" class="linkish" data-open="${esc(b.g.id)}"><b>${esc(b.info.match)}</b></button>
        <span class="muted small">${esc(clock(b.info.when))}${b.legs.length > 1 ? ` · Story: <b>${esc(b.story.title)}</b> (${pct(b.story.pt)} of games)${b.lift > 1.03 ? `, these legs hit together ${pct(b.pModel)} vs ${pct(b.legs.reduce((m, l) => m * l.ps, 1))} if unrelated` : ""}` : ""}</span></td></tr>
      ${b.legs.map(legRow).join("")}`).join("");
    return `<div class="lock">
      <div class="lock-head"><span class="lock-n">Lock ${i + 1}</span><span class="lock-pay">pays <b>${xs(c.pay)}</b></span><span class="muted small">$20 returns $${Math.round(20 * c.pay)}</span></div>
      <div class="lock-stats"><span title="Each leg's adjusted chance, with half the boost from same-game legs moving together">Careful chance <b>${pct(c.P)}</b></span><span>Market says ${pct(c.price)}</span><span>Expected return <b class="edge-good">${signPct(c.ev)}</b></span></div>
      <div class="table-wrap"><table class="lock-t"><thead><tr><th>Leg</th><th>Check</th><th title="The chance after the pressure test: the model corrected by its track record, blended with Polymarket's own price">Chance</th><th title="What a $20 bet costs per share">Price</th></tr></thead>
      <tbody>${games}</tbody></table></div>
      <div class="muted small">Still worth it if the parlay pays at least <b>${xs(be * (1 + MIN_EV))}</b>. ${c.ver ? `${c.ver} of ${c.blocks.reduce((a, b) => a + b.legs.length, 0)} legs Verified.` : "No Verified legs: read the Caution notes (hover the tag) before betting."}</div>
    </div>`;
  }

  const HOW = `A lock here is the likeliest kind of parlay worth betting, not a sure thing: 2 to 5 legs across at least two of the day's games, paying ${MIN_PAY}x to ${MAX_PAY}x. Every leg is a real Polymarket line priced ${Math.round(PRICE_LO * 100)}–${Math.round(PRICE_HI * 100)}¢ that can take a $${BASKETS.STAKE} bet, passes the same pressure test as Underpriced props, and passes the pressure test as Verified or Caution (never Skip). A leg that's only there to complete a same-game story may sit up to a cent under its fair price. Verified legs aren't required, since real Verified misprices are rare; hover a Caution tag to read why. Legs from the same game must fit one storyline that happens in at least 1 game in 5 and never pull against each other; when they move together, only half of the simulated boost is counted. Each lock has to show at least +${Math.round(MIN_EV * 100)}% expected return on those cautious chances, and the ones shown give the most return for the risk, share no player or game result, and use no game in more than three locks (and two locks on one game tell the same story about it). "Chance" is the adjusted chance (model corrected by its track record, blended with Polymarket's price), not the raw model. If Polymarket's parlay builder quotes a lower payout than shown, check it against the "still worth it" number.`;

  // the Lock section: title, day picker, cards. days: [{day, n, open}] for the day picker.
  function html({ sport, day, days, res, waiting }) {
    const title = sport === "NFL" ? "Lock of the week" : "Lock of the day";
    const chips = days.length > 1 ? `<div class="tabs lk-days">${days.map((d) => `<button type="button" class="chip" data-lock-day="${d.day}" aria-pressed="${d.day === day}">${esc(niceDay(d.day).split(",")[0])} · ${d.n} game${d.n > 1 ? "s" : ""}</button>`).join("")}</div>` : "";
    let body;
    if (waiting) body = `<div class="empty">${esc(waiting)}</div>`;
    else if (res.games < MIN_GAMES) body = `<div class="empty">A lock needs at least ${MIN_GAMES} games with props on the same day, and only ${res.games} ${res.games === 1 ? "has" : "have"} them here.</div>`;
    else if (!res.picks.length) body = `<div class="empty">No lock today: nothing across ${res.games} game${res.games === 1 ? "" : "s"} with props passes the checks while paying ${MIN_PAY}x–${MAX_PAY}x with +${Math.round(MIN_EV * 100)}% expected return. That happens when prices are tight; skipping is the right call.</div>`;
    else body = `<div class="locks">${res.picks.map(card).join("")}</div>`;
    return `<section class="lock-sec"><div class="panel-head"><h2>🔒 ${title} <span class="muted lk-day">${esc(niceDay(day))}</span></h2></div>
      ${chips}<div class="muted small">Short parlays across ${esc(niceDay(day).split(",")[0])}'s games that pay ${MIN_PAY}x–${MAX_PAY}x, built from pressure-tested legs and same-game storylines. ${res && !waiting ? `Built from ${res.games} game${res.games === 1 ? " that hasn't" : "s that haven't"} started.` : ""}</div>
      ${body}${BASKETS.how(HOW, "What makes a lock")}</section>`;
  }

  return { build, html, gameBlocks, combos, pickTop, MIN_PAY, MAX_PAY };
})();
