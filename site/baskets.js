"use strict";

// Storyline baskets, shared by the NFL and NBA pages.
//
// 1. Pull Polymarket's prop and game markets for a game, but only when they are worth reading:
//    on game day for the NBA, from the day before for the NFL. Prices are the real order book:
//    a leg costs what you'd pay to buy it now (the ask), not the midpoint.
// 2. Simulate the game a few thousand times so legs that move together really do move
//    together: a slow, low-scoring night drags every scorer down at once, a blowout sends
//    starters to the bench early, and a QB's yards and his top receiver's yards rise together.
// 3. For each storyline (a defense shuts a team down, a scorer and a playmaker both go off,
//    a shootout, and so on), pick the 2-4 legs with the best expected return whose combined
//    payout is more than 4x net, and show what the model thinks of the price.
//
// Each page passes an adapter with its sport's rules (see makeAdapter in app.js and nba.js).

const BASKETS = (() => {
  const GAMMA = "https://gamma-api.polymarket.com";
  const CLOB = "https://clob.polymarket.com";
  const MIN_NET = 4;                 // only baskets that pay more than 4x profit (5x back per $1)
  const N = 6000;                    // simulated games per matchup
  const WIDE = 0.05;                 // bid-ask gap (in dollars per share) that counts as wide
  // Andrew bets $10-20 a basket, so every leg must take $20 without paying more than 2¢ over
  // the best ask; anything thinner is left out, not just flagged. Without the order book, a
  // market needs $1,000 of liquidity to count.
  const STAKE = 20, MAX_SLIP = 0.02, MIN_LIQ = 1000;
  const CACHE_MS = 90 * 1000;        // reuse a pull for 90 seconds while clicking around
  const SHOWN = 6;                   // baskets per game: both "runs away" stories plus the best four others
  const MIN_LEG_P = 0.4, MIN_PRICE = 0.3;   // no longshot legs: the model and the market both give it a real chance
  const MIN_JOINT = 0.12;            // and no basket the model gives less than a 12% chance (about 1 in 8)
  const SAVE_KEY = "pmBasketQuotes", SAVE_MAX_MS = 6 * 3600 * 1000;

  // ---------------------------------------------------------------- small helpers

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const xs = (m) => `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}x`;
  const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const niceDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const squash = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameKey = (s) => squash(String(s || "").replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, ""));
  const arr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || "[]"); } catch (e) { return []; } };
  const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

  async function getJson(url, opts = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // ---------------------------------------------------------------- when to pull

  // NBA prices only firm up on game day and NFL prices the day before, so nothing is pulled
  // earlier than that.
  function pullWindow(A, g) {
    const day = A.gameDay(g), first = addDays(day, -A.daysBefore), today = etDay(Date.now());
    if (A.isPost(g)) return { open: false, why: "This game is over, so there's nothing left to bet." };
    if (today < first) return { open: false, why: `Polymarket prices are pulled ${A.daysBefore ? "from the day before kickoff" : "on game day"}, starting ${niceDay(first)}.` };
    return { open: true };
  }

  // ---------------------------------------------------------------- finding the game on Polymarket

  // Game events have slugs like nba-por-uta-2026-10-31 (away, home, date). Team codes differ a
  // little between sites, so a couple of spellings are tried. A list of the league's open events
  // catches anything named differently, such as a separate "player props" event.
  const LISTS = {};
  async function leagueEvents(A) {
    const c = LISTS[A.league];
    if (c && Date.now() - c.t < CACHE_MS) return c.events;
    const since = addDays(etDay(Date.now()), -14);
    const events = await getJson(`${GAMMA}/events?tag_slug=${A.league}&closed=false&limit=500&start_date_min=${since}T00:00:00Z`);
    LISTS[A.league] = { t: Date.now(), events: Array.isArray(events) ? events : [] };
    return LISTS[A.league].events;
  }

  function eventMatches(A, g, e) {
    const day = A.gameDay(g), slug = String(e.slug || "").toLowerCase(), parts = slug.split("-");
    const when = [e.startTime, e.eventDate, ...(e.markets || []).slice(0, 3).map((m) => m.gameStartTime)]
      .map((t) => (t ? Date.parse(String(t).replace(" ", "T")) : NaN)).filter((t) => !isNaN(t));
    const dayOk = slug.includes(day) || when.some((t) => Math.abs(t - A.kickoff(g)) < 30 * 3600 * 1000);
    const title = squash(`${e.title || ""} ${e.ticker || ""}`);
    const teamOk = (tm) => A.nicknames(tm).some((n) => title.includes(n)) || A.codes(tm).some((c) => parts.includes(c));
    return dayOk && teamOk(g.away) && teamOk(g.home);
  }

  async function findEvents(A, g) {
    const day = A.gameDay(g), found = new Map();
    let reached = false;
    outer: for (const a of A.codes(g.away)) for (const h of A.codes(g.home)) {
      try {
        const j = await getJson(`${GAMMA}/events?slug=${A.league}-${a}-${h}-${day}`);
        reached = true;
        for (const e of j || []) found.set(String(e.id), e);
        if (found.size) break outer;
      } catch (e) { /* try the next spelling */ }
    }
    try {
      for (const e of await leagueEvents(A)) if (eventMatches(A, g, e)) found.set(String(e.id), e);
      reached = true;
    } catch (e) { /* the slug lookup may still have worked */ }
    // some list responses leave out the markets; fetch those events whole
    for (const [id, e] of found) {
      if (!Array.isArray(e.markets)) { try { found.set(id, await getJson(`${GAMMA}/events/${id}`)); } catch (err) { found.delete(id); } }
    }
    return { events: [...found.values()], reached };
  }

  // ---------------------------------------------------------------- reading the markets

  // One Polymarket market -> {kind: player | total | spread, ...} with its two outcomes
  function parseMarket(A, g, m, roster) {
    if (m.closed || m.active === false || m.acceptingOrders === false || m.archived) return null;
    const outcomes = arr(m.outcomes), tokens = arr(m.clobTokenIds);
    if (outcomes.length !== 2) return null;
    const type = squash(m.sportsMarketType), q = String(m.question || m.groupItemTitle || "");
    let line = num(m.line);
    const base = {
      id: String(m.id), q, tokens, outcomes, bestBid: num(m.bestBid), bestAsk: num(m.bestAsk),
      liq: num(m.liquidityNum ?? m.liquidity) || 0, vol: num(m.volumeNum ?? m.volume) || 0,
      fee: m.feesEnabled ? (num(m.feeSchedule?.rate) ?? (num(m.takerBaseFee) || 0) / 10000) : 0,
    };
    const ouSide = (o) => (/^(over|yes)$/i.test(o) ? "over" : /^(under|no)$/i.test(o) ? "under" : null);

    // game total
    if (/total/.test(type) && !q.includes(":") || /^(totals?|gametotal)$/.test(type)) {
      if (line == null) { const mm = /(\d+(?:\.\d+)?)/.exec(q); line = mm ? Number(mm[1]) : null; }
      const sides = outcomes.map(ouSide);
      if (line == null || !sides[0] || !sides[1]) return null;
      return { ...base, kind: "total", line, sides };
    }
    const teamOf = (s) => [g.away, g.home].find((tm) => A.nicknames(tm).some((n) => squash(s).includes(n)) || A.codes(tm).includes(squash(s)));
    // spread: "Spread: Lakers (-5.5)", outcomes are the two teams
    if (/spread/.test(type)) {
      const sides = outcomes.map(teamOf);
      if (!sides[0] || !sides[1] || sides[0] === sides[1]) return null;
      const mm = /\(([+-]?\d+(?:\.\d+)?)\)/.exec(q);
      let lineTeam = mm ? teamOf(q.slice(0, mm.index)) || sides[0] : sides[0];
      let L = mm ? Number(mm[1]) : line;
      if (L == null) return null;
      // store each side's own line: covering means its margin + its line > 0
      const lines = sides.map((tm) => (tm === lineTeam ? L : -L));
      return { ...base, kind: "spread", sides, lines };
    }
    if (/moneyline|^ml$|winner/.test(type)) {
      const sides = outcomes.map(teamOf);
      if (!sides[0] || !sides[1] || sides[0] === sides[1]) return null;
      return { ...base, kind: "ml", sides };
    }

    // player props: "LeBron James: Points O/U 24.5", or "Will X record 25+ points?"
    let name = null, statText = "";
    let mm = /^\s*will\s+(.+?)\s+(?:record|have|score|get|throw|catch|rush for|make)\s+(?:at least\s+)?(\d+(?:\.\d+)?)\+?\s+(.+?)\??\s*$/i.exec(q);
    if (mm) { name = mm[1]; if (line == null) line = Number(mm[2]) - 0.5; statText = mm[3]; }
    else if ((mm = /^\s*will\s+(.+?)\s+score\s+(?:a|an anytime)\s+(?:rushing or receiving\s+)?touchdown/i.exec(q))) { name = mm[1]; statText = "anytime touchdown"; }
    else if (q.includes(":")) {
      name = q.slice(0, q.indexOf(":"));
      statText = q.slice(q.indexOf(":") + 1);
      if (line == null) { const l = /(?:o\/u|over\/under|over|under)?\s*(\d+(?:\.\d+)?)/i.exec(statText); line = l ? Number(l[1]) : null; }
    }
    if (!name) return null;
    const key = A.statKey(type, squash(statText.replace(/o\/u|over\/under/ig, "").replace(/\d+(\.\d+)?\+?/g, "")));
    if (!key) return null;
    if (line == null) line = key === "anytd" ? 0.5 : null;
    if (line == null) return null;
    const pl = roster.get(nameKey(name)) || roster.get(`${nameKey(name.split(" ")[0]).slice(0, 1)}|${nameKey(name.split(" ").slice(1).join(" "))}`);
    if (!pl) return null;
    let sides = outcomes.map(ouSide);
    if (!sides[0] || !sides[1]) sides = ["over", "under"];
    return { ...base, kind: "player", pid: pl.pid, team: pl.team, key, line, sides };
  }

  // Best price you can buy each outcome at right now, and how much is for sale there.
  // The order book says it exactly; without it, the market summary's best bid and ask for the
  // first outcome stand in (buying the second outcome costs 1 - the first's bid).
  async function priceBooks(markets) {
    const ids = [...new Set(markets.flatMap((m) => m.tokens))].filter(Boolean);
    const books = {};
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const j = await getJson(`${CLOB}/books`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids.slice(i, i + 100).map((t) => ({ token_id: t }))) });
        for (const b of j || []) books[String(b.asset_id)] = b;
      } catch (e) { break; }   // fall back to the market summaries
    }
    for (const m of markets) {
      m.quotes = m.tokens.map((tok, i) => {
        const b = books[String(tok)];
        if (b) {
          const asks = (b.asks || []).map((l) => ({ p: Number(l.price), s: Number(l.size) })).filter((l) => l.p > 0 && l.s > 0).sort((x, y) => x.p - y.p);
          const bids = (b.bids || []).map((l) => ({ p: Number(l.price), s: Number(l.size) })).filter((l) => l.p > 0 && l.s > 0).sort((x, y) => y.p - x.p);
          if (!asks.length) return null;
          // average price paid for $STAKE, walking up the book
          let left = STAKE, shares = 0;
          for (const l of asks) { if (left <= 0 || l.p > asks[0].p + MAX_SLIP) break; const take = Math.min(left, l.p * l.s); shares += take / l.p; left -= take; }
          const usd = asks.filter((l) => l.p <= asks[0].p + MAX_SLIP).reduce((a, l) => a + l.p * l.s, 0);
          return { ask: asks[0].p, bid: bids[0]?.p ?? null, usd, fill: left <= 1e-9 ? STAKE / shares : null, book: true };
        }
        if (m.bestAsk == null || m.bestBid == null) return null;
        return i === 0 ? { ask: m.bestAsk, bid: m.bestBid, usd: null, book: false }
          : { ask: 1 - m.bestBid, bid: 1 - m.bestAsk, usd: null, book: false };
      });
    }
    return Object.keys(books).length > 0;
  }

  // ---------------------------------------------------------------- pulling (with a short cache and a saved copy)

  const CACHE = {};
  function clear() { for (const k of Object.keys(CACHE)) delete CACHE[k]; for (const k of Object.keys(LISTS)) delete LISTS[k]; }

  function loadSaved() { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "{}"); } catch (e) { return {}; } }
  function save(gid, rec) {
    const all = loadSaved(); all[gid] = rec;
    for (const [k, v] of Object.entries(all)) if (Date.now() - v.t > SAVE_MAX_MS) delete all[k];
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(all)); } catch (e) { /* private mode or full */ }
  }

  async function pull(A, g) {
    const c = CACHE[g.id];
    if (c && Date.now() - c.t < CACHE_MS) return c;
    const roster = new Map();
    for (const pl of A.roster(g)) {
      roster.set(nameKey(pl.name), pl);
      const parts = pl.name.split(" ");
      roster.set(`${nameKey(parts[0]).slice(0, 1)}|${nameKey(parts.slice(1).join(" "))}`, pl);
    }
    let rec;
    try {
      const { events, reached } = await findEvents(A, g);
      if (!reached) throw new Error("unreachable");
      const raw = events.flatMap((e) => (e.markets || []).map((m) => ({ ...m, _slug: e.slug })));
      const markets = raw.map((m) => { const x = parseMarket(A, g, m, roster); if (x) x.url = `https://polymarket.com/event/${m._slug}`; return x; }).filter(Boolean);
      const book = markets.length ? await priceBooks(markets) : false;
      rec = { t: Date.now(), src: "live", events: events.length, rawCount: raw.length, markets, book };
      if (markets.length) save(g.id, rec);
    } catch (e) {
      const s = loadSaved()[g.id];
      rec = s && Date.now() - s.t < SAVE_MAX_MS ? { ...s, src: "saved" } : { t: Date.now(), src: "blocked", markets: [] };
    }
    CACHE[g.id] = rec;
    return rec;
  }

  // ---------------------------------------------------------------- legs

  // A leg is one outcome you could buy: its label, model chance, price, and warning flags
  function legsFromMarkets(A, g, markets) {
    const legs = [];
    for (const m of markets) {
      m.sides.forEach((side, i) => {
        const qt = m.quotes?.[i];
        if (!qt || !(qt.ask > 0.01 && qt.ask < 0.99)) return;
        const leg = modelLeg(A, g, m.kind, { pid: m.pid, key: m.key, line: m.kind === "spread" ? m.lines[i] : m.line, side });
        if (!leg) return;
        // too thin to take a $20 bet near the ask: leave it out
        if (qt.book ? qt.fill == null : m.liq < MIN_LIQ) return;
        const pay = qt.book ? qt.fill : qt.ask;
        const price = Math.min(0.995, pay + m.fee * Math.min(pay, 1 - pay));
        const flags = [];
        if (qt.book && pay - qt.ask >= 0.005) flags.push(`$${STAKE} fills at ${Math.round(pay * 100)}¢`);
        if (qt.bid == null) flags.push("no bids");
        else if (qt.ask - qt.bid >= WIDE) flags.push(`wide ${Math.round(qt.bid * 100)}/${Math.round(qt.ask * 100)}¢`);
        legs.push({ ...leg, grp: group(leg), price, ask: qt.ask, bid: qt.bid, usd: qt.usd, flags, url: m.url, edge: leg.p - price });
      });
    }
    return legs;
  }

  // The same leg built from the model alone, when Polymarket has nothing for this game
  function legsFromModel(A, g) {
    const legs = [];
    for (const pl of A.roster(g)) {
      if (pl.skip || !pl.core) continue;
      for (const key of A.storyKeys(pl)) {
        const line = A.mainLine(pl, key);
        if (line == null) continue;
        for (const side of key === "anytd" ? ["over"] : ["over", "under"]) {
          const leg = modelLeg(A, g, "player", { pid: pl.pid, key, line, side });
          if (leg && leg.p >= MIN_LEG_P && leg.p < 0.85) legs.push({ ...leg, grp: group(leg) });
        }
      }
    }
    const m = g.model;
    if (g.total != null || m.total?.mean) {
      const L = g.total ?? Math.round(m.total.mean) + 0.5;
      for (const side of ["over", "under"]) legs.push(modelLeg(A, g, "total", { line: L, side }));
    }
    // g.spread > 0 means the home team is favored by that much; with no line yet, the model's margin stands in
    const sp = g.spread ?? Math.floor(m.margin.mean) + 0.5;
    legs.push(modelLeg(A, g, "spread", { side: g.home, line: -sp }), modelLeg(A, g, "spread", { side: g.away, line: sp }));
    legs.push(modelLeg(A, g, "ml", { side: g.home }), modelLeg(A, g, "ml", { side: g.away }));
    return legs.map((l) => ({ ...l, grp: group(l) })).filter((l) => l.kind === "player" || l.p >= 0.1);
  }

  // Legs that can't sit in the same basket: all of one player's props, every spread and
  // moneyline (they're all bets on who wins and by how much), and every total line.
  const group = (l) => (l.kind === "player" ? `p${l.pid}` : l.kind === "total" ? "total" : "outcome");
  const isGame = (l) => l.kind !== "player";

  // Polymarket's wording: over 7.5 is "8+", under 7.5 is "7 or fewer"
  const lineTxt = (side, line) => (Math.abs(line % 1 - 0.5) < 1e-9
    ? (side === "over" ? `${Math.ceil(line)}+` : `${Math.floor(line)} or fewer`)
    : `${side} ${line}`);
  const sgn = (v) => (v > 0 ? `+${v}` : v === 0 ? "pk" : `${v}`);
  function modelLeg(A, g, kind, { pid, key, line, side }) {
    const m = g.model;
    if (kind === "total") {
      const z = (line - m.total.mean) / m.total.sd, under = Phi(z);
      return { kind, line, side, p: side === "over" ? 1 - under : under, label: `Game total ${lineTxt(side, line)} points` };
    }
    if (kind === "spread") {
      // side's margin = +margin for home, -margin for away; covers if margin + line > 0
      const mean = side === g.home ? m.margin.mean : -m.margin.mean;
      const p = 1 - Phi((-line - mean) / m.margin.sd);
      return { kind, line, side, team: side, p, label: `${A.shortName(side)} ${sgn(line)}` };
    }
    if (kind === "ml") {
      const mean = side === g.home ? m.margin.mean : -m.margin.mean;
      return { kind, side, team: side, p: 1 - Phi(-mean / m.margin.sd), label: `${A.shortName(side)} win` };
    }
    const pl = A.player(pid);
    if (!pl || pl.skip) return null;   // ruled out or doubtful: never a leg
    const pr = A.prob(pl, key, line);
    if (!pr) return null;
    const p = side === "over" ? pr.over : pr.under;
    return {
      kind, pid, key, line, side, p, team: pl.team, core: pl.core, story: A.storyKeys(pl).includes(key), tags: A.tags(pl, key), name: pl.name, q: pl.q,
      label: key === "anytd" && side === "over" && line < 1 ? `${pl.name} anytime TD` : `${pl.name} ${lineTxt(side, line)} ${A.statLabel(key)}`,
    };
  }

  // ---------------------------------------------------------------- simulation

  function rng(seedStr) {
    let a = 0; for (const ch of String(seedStr)) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function Phi(z) {
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + (z < 0 ? -y : y));
  }

  // Each simulated game draws a total and a margin (the same ones the page's total and spread
  // tools use). A team's scoring follows from those. Every player's stat line then depends on:
  // his team's scoring (b), whether his team is ahead (m: lead backs run more when ahead, QBs
  // throw more when behind), a team passing-game swing shared by its QB and receivers (pass),
  // and how lopsided the game is (w: NBA starters sit in blowouts). The rest is his own luck.
  // Each leg's own chance is kept exactly as the model has it; only how legs move together
  // comes from here.
  function simulate(A, g, legs) {
    const r = rng(g.id), norm = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const m = g.model, sT = m.total.sd, sM = m.margin.sd, S = Math.hypot(sT, sM);
    const T = new Float64Array(N), M = new Float64Array(N), zH = new Float64Array(N), zA = new Float64Array(N);
    const zM = new Float64Array(N), blow = new Float64Array(N), passH = new Float64Array(N), passA = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = norm(), b = norm();
      T[i] = m.total.mean + sT * a; M[i] = m.margin.mean + sM * b; zM[i] = b;
      zH[i] = (sT * a + sM * b) / S; zA[i] = (sT * a - sM * b) / S;
      blow[i] = (Math.abs(M[i]) - 0.8 * sM) / (0.6 * sM);
      passH[i] = norm(); passA[i] = norm();
    }
    const own = new Map(), latent = new Map();
    const playerZ = (pid) => { if (!own.has(pid)) { const z = new Float64Array(N); for (let i = 0; i < N; i++) z[i] = norm(); own.set(pid, z); } return own.get(pid); };
    for (const leg of legs) {
      const hit = new Uint8Array(N);
      if (leg.kind === "total") for (let i = 0; i < N; i++) hit[i] = leg.side === "over" ? T[i] > leg.line : T[i] < leg.line;
      else if (leg.kind === "spread" || leg.kind === "ml") { const s = leg.side === g.home ? 1 : -1, L = leg.kind === "ml" ? 0 : leg.line; for (let i = 0; i < N; i++) hit[i] = s * M[i] + L > 0; }
      else {
        const id = `${leg.pid}|${leg.key}`;
        if (!latent.has(id)) {
          const home = leg.team === g.home, L = A.load(A.player(leg.pid), leg.key);
          const rest = Math.sqrt(Math.max(0.05, 1 - L.b ** 2 - L.m ** 2 - L.pass ** 2 - L.w ** 2));
          const zp = playerZ(leg.pid), x = new Float64Array(N);
          for (let i = 0; i < N; i++) {
            x[i] = L.b * (home ? zH[i] : zA[i]) + L.m * (home ? zM[i] : -zM[i]) + L.pass * (home ? passH[i] : passA[i])
              + L.w * blow[i] + rest * (0.55 * zp[i] + 0.835 * norm());
          }
          latent.set(id, { x, sorted: Float64Array.from(x).sort() });
        }
        const { x, sorted } = latent.get(id);
        const cut = (q) => sorted[Math.min(N - 1, Math.max(0, Math.floor(q * N)))];
        if (leg.side === "over") { const c = cut(1 - leg.p); for (let i = 0; i < N; i++) hit[i] = x[i] > c; }
        else { const c = cut(leg.p); for (let i = 0; i < N; i++) hit[i] = x[i] < c; }
      }
      leg.hit = hit;
    }
  }

  function joint(legs) {
    let n = 0;
    outer: for (let i = 0; i < N; i++) { for (const l of legs) if (!l.hit[i]) continue outer; n++; }
    return n / N;
  }

  // ---------------------------------------------------------------- storylines

  // tm = the team the story is about, opp = the other one. "need" = how many legs must fit.
  // Every basket also needs at least one game leg (moneyline, spread, or total).
  function stories(A, g) {
    const both = [[g.away, g.home], [g.home, g.away]], out = [];
    const nick = (tm) => A.shortName(tm);
    const poss = (tm) => (/s$/.test(nick(tm)) ? `${nick(tm)}'` : `${nick(tm)}'s`);
    const main = (l) => A.scoreTags.some((t) => l.tags.includes(t));
    const isOver = (l) => l.kind === "player" && l.side === "over";
    const isUnder = (l) => l.kind === "player" && l.side === "under";
    const wins = (tm) => (l) => (l.kind === "spread" || l.kind === "ml") && l.side === tm;
    // running away means winning outright or covering while giving points, never taking them
    const dominates = (tm) => (l) => l.side === tm && (l.kind === "ml" || (l.kind === "spread" && l.line < 0));
    const total = (side) => (l) => l.kind === "total" && l.side === side;
    const dog = g.model.margin.mean >= 0 ? g.away : g.home;
    const dogCover = (l) => l.kind === "spread" && l.side === dog && l.line > 0;
    for (const [tm, opp] of both) {
      out.push({
        id: `run-${tm}`, base: true, title: `${nick(tm)} run away with it`,
        blurb: `${nick(tm)} win comfortably, their key players feast, and ${poss(opp)} go quiet.${A.blowoutNote}`,
        pool: (l) => dominates(tm)(l) || (isOver(l) && l.team === tm && l.core && A.runTags.some((t) => l.tags.includes(t))) || (isUnder(l) && l.team === opp && l.core && main(l)),
        need: [[dominates(tm), 1], [(l) => isOver(l) && l.team === tm, 1]], max: 4,
        // the underdog winning is a real scenario, so its moneyline may go down to about 1 in 4
        // for a big underdog that's the whole point, so in the looser pass it may go lower still
        floor: (l, loose) => (dominates(tm)(l) ? (loose ? 0.1 : 0.25) : null),
      });
      out.push({
        id: `shut-${tm}`, title: `${nick(opp)} defense shuts down ${nick(tm)}`,
        blurb: `${poss(tm)} main options come in under, and ${nick(opp)} take care of business.`,
        pool: (l) => (isUnder(l) && l.team === tm && l.core && main(l)) || total("under")(l) || wins(opp)(l),
        need: [[(l) => isUnder(l) && l.team === tm, 2]], max: 4,
      });
      out.push({
        id: `duo-${tm}`, title: A.duo.title(nick(tm)), blurb: A.duo.blurb(nick(tm)),
        pool: (l) => (isOver(l) && l.team === tm && (l.tags.includes(A.duo.a) || l.tags.includes(A.duo.b))) || wins(tm)(l) || total("over")(l),
        need: [[(l) => isOver(l) && l.tags.includes(A.duo.a), 1], [(l) => isOver(l) && l.tags.includes(A.duo.b) && !l.tags.includes(A.duo.a), 1]], max: 4,
      });
      out.push({
        id: `carry-${tm}`, title: A.carry.title(nick(tm)), blurb: A.carry.blurb(nick(tm)),
        pool: (l) => (isOver(l) && l.team === tm && l.core && l.tags.includes(A.carry.tag)) || wins(tm)(l) || total("over")(l),
        need: [[(l) => isOver(l) && l.tags.includes(A.carry.tag), 2]], max: 4,
      });
    }
    out.push({
      id: "close", title: "Close game, starters play it out",
      blurb: `${nick(dog)} keep it within the number, so both teams' stars play the whole fourth quarter.`,
      pool: (l) => dogCover(l) || (isOver(l) && l.core) || total("over")(l),
      need: [[dogCover, 1], [(l) => isOver(l) && l.team === g.home, 1], [(l) => isOver(l) && l.team === g.away, 1]], max: 4,
    });
    out.push({
      id: "shootout", title: "Shootout", blurb: "Lots of possessions and points: the total goes over and scorers on both sides cash.",
      pool: (l) => total("over")(l) || (isOver(l) && l.core && main(l)),
      need: [[total("over"), 1], [isOver, 1]], max: 4,
    });
    out.push({
      id: "grind", title: "Low-scoring grind", blurb: "A slow, ugly game: the total goes under and the main options on both sides fall short.",
      pool: (l) => total("under")(l) || (isUnder(l) && l.core && main(l)),
      need: [[total("under"), 1], [isUnder, 1]], max: 4,
    });
    out.push({
      id: "value", title: "Scooping up the inefficiencies", priced: true,
      blurb: "No story, just the legs where the model's chance is furthest above Polymarket's price.",
      pool: (l) => l.edge >= 0.03 || (isGame(l) && l.edge >= 0), need: [], max: 4,
    });
    return out;
  }

  // Best 2-4 leg basket for a story: one leg per player, one bet on who wins, one total, at
  // least one game leg, no longshots, and a payout above 4x net. With prices it maximizes the
  // expected return; without them, how much the story's correlation lifts the chance above the
  // legs' plain product. `loose` widens the longshot limits a little when a game is short of stories.
  function best(story, legs, priced, loose) {
    const legMin = loose ? MIN_LEG_P - 0.05 : MIN_LEG_P, priceMin = loose ? MIN_PRICE - 0.05 : MIN_PRICE;
    // the two "runs away" stories always show, even for a big underdog, so their floor drops furthest
    const jointMin = loose ? (story.base ? 0.04 : MIN_JOINT * 0.75) : MIN_JOINT;
    const ok = legs.filter((l) => {
      // story legs use stats the player is known for (a playmaker's assists, not a center's)
      if (!story.pool(l) || (l.kind === "player" && !l.story && !story.priced)) return false;
      const f = story.floor?.(l, loose);
      return f != null ? l.p >= f && (!priced || l.price >= f - 0.05) : l.p >= legMin && (!priced || l.price >= priceMin);
    });
    const rank = (a, b) => (priced ? b.edge - a.edge : b.p - a.p);
    // the best few legs for each thing the story needs, then the best of the rest
    const sorted = ok.sort(rank);
    const pool = [...new Set([...story.need.flatMap(([f]) => sorted.filter(f).slice(0, 4)), ...sorted.filter(isGame).slice(0, 3), ...sorted.filter((l) => !isGame(l)).slice(0, 5)])];
    let top = null;
    const pick = [];
    const okNeed = () => pick.some(isGame) && story.need.every(([f, n]) => pick.filter(f).length >= n);
    const visit = (start) => {
      if (pick.length >= 2 && okNeed()) {
        const prod = pick.reduce((a, l) => a * l.p, 1), pj = joint(pick);
        const pay = priced ? 1 / pick.reduce((a, l) => a * l.price, 1) : (pj > 0 ? 1 / pj : Infinity);
        if (pay - 1 > MIN_NET && pj >= jointMin) {
          const score = priced ? pj * pay - 1 : pj / prod;
          if (!top || score > top.score) top = { legs: [...pick], pj, prod, pay, score, ev: priced ? pj * pay - 1 : null };
        }
      }
      if (pick.length >= story.max) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (pick.some((p) => p.grp === l.grp)) continue;
        pick.push(l); visit(i + 1); pick.pop();
      }
    };
    visit(0);
    return top && { ...story, ...top };
  }

  // Six per game: both "runs away" baskets, then the best of the rest, skipping any that mostly
  // repeat one already shown. If that leaves the game short, try again with slightly looser limits.
  function pickSix(A, g, legs, priced) {
    const all = stories(A, g).filter((s) => priced || !s.priced);
    const firstOf = (list) => { for (const loose of [false, true]) { const b = list.map((s) => best(s, legs, priced, loose)).filter(Boolean); if (b.length) return b; } return []; };
    // the two "runs away" baskets come first, at looser limits only if they must
    // if Polymarket has no market deep enough to build one, it still gets a card that says so
    const shown = all.filter((s) => s.base).map((s) => firstOf([s])[0] || { ...s, empty: true, legs: [] });
    const repeats = (b) => shown.some((o) => b.legs.filter((l) => o.legs.includes(l)).length >= Math.min(3, b.legs.length));
    for (const loose of [false, true]) {
      const got = all.filter((s) => !s.base && !shown.some((b) => b.id === s.id)).map((s) => best(s, legs, priced, loose)).filter(Boolean);
      for (const b of got.sort((x, y) => y.score - x.score)) {
        if (shown.length >= SHOWN) break;
        if (!repeats(b)) shown.push(b);
      }
      if (shown.length >= SHOWN) break;
    }
    return shown;
  }
  const realCount = (bs) => bs.filter((b) => !b.empty).length;

  // ---------------------------------------------------------------- panel

  async function render(el, g, A) {
    const token = (el._basketToken = {});
    const win = pullWindow(A, g);
    el.innerHTML = head(win.open ? "Checking Polymarket…" : esc(win.why)) + `<div class="empty">${win.open ? "Pulling Polymarket prices for this game…" : "Building model-only baskets…"}</div>`;
    let rec = null;
    if (win.open) rec = await pull(A, g);
    if (el._basketToken !== token) return;   // a newer render took over

    const priced = !!(rec && rec.markets.some((m) => m.kind === "player"));
    let legs = priced ? legsFromMarkets(A, g, rec.markets) : legsFromModel(A, g);
    let status;
    if (!win.open) status = `${esc(win.why)} Until then these use the model's own lines, so compare each basket's break-even payout with Polymarket's price.`;
    else if (rec.src === "blocked") status = "Couldn't reach Polymarket from this computer (it may be blocked on this network). These use the model's own lines instead.";
    else if (!priced) status = `Polymarket isn't listing player props for this game yet${rec.events ? ` (found ${rec.events} event${rec.events > 1 ? "s" : ""}, but no player markets)` : ""}, checked ${new Date(rec.t).toLocaleTimeString()}. These use the model's own lines instead.`;
    else status = `${rec.src === "saved" ? `<b>Saved</b> Polymarket prices from ${new Date(rec.t).toLocaleTimeString()} (couldn't refresh, prices may have moved)` : `Live Polymarket prices as of ${new Date(rec.t).toLocaleTimeString()}`} · ${rec.markets.filter((m) => m.kind === "player").length} player markets${rec.book ? " · order book depth" : " · summary quotes (order book unavailable)"}`;

    simulate(A, g, legs);
    const baskets = pickSix(A, g, legs, priced);
    el.innerHTML = head(status) + (baskets.length
      ? `<div class="baskets">${baskets.map((b) => card(b, priced)).join("")}</div>`
      : "") + (realCount(baskets) < SHOWN ? `<div class="note">Only ${realCount(baskets)} of 6 storylines could be built here without longshot legs, stacked bets${priced ? ", or markets too thin for a $" + STAKE + " bet" : ""} while still paying more than 4x net.</div>` : "") + foot(priced);
  }

  function head(status) {
    return `<div class="panel-head"><h2>Storyline baskets</h2><span class="muted small">${status}</span></div>`;
  }

  function card(b, priced) {
    if (b.empty) return `
      <div class="basket">
        <div class="basket-head"><b>${esc(b.title)}</b></div>
        <div class="muted small">Can't build this one right now: Polymarket has no market on this team winning (moneyline, or covering while giving points) that is deep enough for a $${STAKE} bet, or none that combines with its players' props to pay more than 4x without longshots.</div>
      </div>`;
    const lift = b.pj / b.prod;
    const legRows = b.legs.map((l) => `
      <tr>
        <td>${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>` : esc(l.label)}${l.q ? ` <span class="badge q" title="On the injury report">${esc(l.q)}</span>` : ""}${priced && l.flags.length ? `<div>${l.flags.map((f) => `<span class="badge q">${esc(f)}</span>`).join(" ")}</div>` : ""}</td>
        <td><b>${pct(l.p)}</b></td>
        ${priced ? `<td><b>${cents(l.price)}</b>${l.bid != null ? `<div class="muted small">bid ${cents(l.bid)}</div>` : ""}</td>
        <td class="${l.edge >= 0 ? "edge-good" : "edge-bad"}">${l.edge >= 0 ? "+" : "−"}${Math.abs(Math.round(l.edge * 100))}</td>` : `<td class="muted">${l.kind === "player" ? "model main line" : "market line"}</td>`}
      </tr>`).join("");
    const summary = priced
      ? `Pays <b>${xs(b.pay)}</b> per $1 (net <b>+${xs(b.pay - 1)}</b>) at $20 fill prices · model chance <b>${pct(b.pj)}</b>${Math.abs(lift - 1) > 0.05 ? ` <span class="muted">(${pct(b.prod)} if the legs were unrelated)</span>` : ""}
         · expected return <b class="${b.ev >= 0 ? "edge-good" : "edge-bad"}">${b.ev >= 0 ? "+" : "−"}${Math.abs(Math.round(b.ev * 100))}%</b>`
      : `Model chance <b>${pct(b.pj)}</b>${Math.abs(lift - 1) > 0.05 ? ` <span class="muted">(${pct(b.prod)} if unrelated)</span>` : ""} · break-even payout <b>${xs(1 / b.pj)}</b>: worth it only if Polymarket pays more than that`;
    const warn = priced && b.legs.some((l) => l.flags.length) ? `<div class="note">Some legs have a wide bid/ask gap or need to climb the order book a little to fill $20; the price shown is what $20 would really cost.</div>` : "";
    return `
      <div class="basket ${priced ? (b.ev >= 0 ? "good" : "bad") : ""}">
        <div class="basket-head"><b>${esc(b.title)}</b>${priced && b.ev < 0 ? ` <span class="badge out">Overpriced</span>` : ""}${b.pj < MIN_JOINT ? ` <span class="badge q" title="Shown because both 'runs away' stories always appear, but this team is a big underdog">Long shot</span>` : ""}</div>
        <div class="muted small">${esc(b.blurb)}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Leg</th><th>Model</th>${priced ? `<th title="What you'd pay now (the ask)">Price</th><th title="Model chance minus price, in cents">Edge</th>` : `<th>Line</th>`}</tr></thead>
          <tbody>${legRows}</tbody>
        </table></div>
        <div class="basket-sum">${summary}</div>${warn}
      </div>`;
  }

  function foot(priced) {
    return `<div class="note">${priced ? "Every leg can take a $20 bet within 2¢ of its best price (thinner markets are left out), and payout uses what $20 would really cost; if Polymarket's parlay builder quotes a different price for the combo, use that. " : ""}Baskets paying 5x back or more hit 20% of the time or less, even when they're good bets: size them small.
      The legs here are chosen to move together, which is the point of a storyline, but how strongly they move together is the model's estimate, not something it has been tested on yet.
      Every basket includes at least one bet on the game itself, uses one leg per player, one bet on the winner (spread or moneyline), and one total, and skips legs the model or the market gives under about a 40% chance. Players ruled Out or Doubtful are never used; Questionable ones are marked.</div>`;
  }

  return { render, clear, pickSix, pullWindow, parseMarket, simulate, joint, best, stories, legsFromModel, legsFromMarkets, priceBooks, eventMatches, N };
})();
