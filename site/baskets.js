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
  // A real, tradeable price: bid and ask no more than 10¢ apart, within 5¢ of the price Polymarket
  // shows on its site, and under 95¢ (dearer legs add almost nothing to a basket's payout).
  // Empty markets sit at a 1¢ bid and a 97-99¢ ask, which are placeholders, not prices.
  const MAX_GAP = 0.1, MAX_OFF_SHOWN = 0.05, MAX_PRICE = 0.95;
  const REPRICE_MS = 2 * 60 * 1000;   // re-pull prices every 2 minutes while the page is open
  const CACHE_MS = 90 * 1000;        // reuse a pull for 90 seconds while clicking around
  const SHOWN = 6;                   // baskets per game: both "runs away" stories plus the best four others
  const MIN_LEG_P = 0.4, MIN_PRICE = 0.3;   // no longshot legs: the model and the market both give it a real chance
  // A storyline must be at least a 1-in-5 scenario in the simulation (the two "runs away" ones always
  // show, flagged when they fall short). The basket built on it can be a long one, down to 1 in 40,
  // as long as the price pays more than the model's odds say it should.
  const MIN_THEME = 0.2, MIN_BASKET = 0.025;
  // Without prices there's no edge to find, so model-only baskets aim for a bigger payout (10x or
  // more at their own odds) and pick the one that hits most often when the storyline happens.
  const MODEL_PAY = 10;
  const MAX_LEGS = 10, BEAM = 60;
  const LOTTO_MIN = 0.04, LOTTO_MAX = 0.3, LOTTO_SHOWN = 10;   // lottery-ticket legs: 4-30¢
  const SAVE_KEY = "pmBasketQuotes", SAVE_MAX_MS = 15 * 60 * 1000;   // prices move fast: an older saved copy is useless

  // ---------------------------------------------------------------- small helpers

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${p < 0.1 ? (p * 100).toFixed(1) : Math.round(p * 100)}%`;
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
    if (A.isLive(g)) return { open: false, why: "This game is under way. Polymarket's prices now move with the score, and the model is pre-game, so prices aren't pulled." };
    // open on game day (NBA) or the day before (NFL), or any time the game starts within 24 hours
    const soon = A.kickoff(g) - Date.now() < 24 * 3600 * 1000;
    if (today < first && !soon) return { open: false, why: `Polymarket prices are pulled ${A.daysBefore ? "from the day before kickoff" : "on game day"} or within 24 hours of the start, starting ${niceDay(first)}.` };
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
    // a dated slug must carry this game's date (teams can meet on back-to-back nights);
    // otherwise the start time must be within 6 hours of tip-off or kickoff
    const dayOk = /\d{4}-\d{2}-\d{2}/.test(slug) ? slug.includes(day) : when.some((t) => Math.abs(t - A.kickoff(g)) < 6 * 3600 * 1000);
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
      id: String(m.id), q, tokens, outcomes, shown: arr(m.outcomePrices).map(num), bestBid: num(m.bestBid), bestAsk: num(m.bestAsk),
      liq: num(m.liquidityNum ?? m.liquidity) || 0, vol: num(m.volumeNum ?? m.volume) || 0,
      fee: m.feesEnabled ? (num(m.feeSchedule?.rate) ?? (num(m.takerBaseFee) || 0) / 10000) : 0,
    };
    // Polymarket's game markets for the full game are exactly these three types. First-half,
    // quarter, race-to-points and similar markets are left out so they can't pass for them.
    const GAME_TYPES = { totals: "total", spreads: "spread", moneyline: "ml" };
    if (!GAME_TYPES[type] && /spread|total|moneyline|half|quarter|race|overtime|oddeven|first|period/.test(type)) return null;
    const ouSide = (o) => (/^(over|yes)$/i.test(o) ? "over" : /^(under|no)$/i.test(o) ? "under" : null);

    // game total
    if (type === "totals") {
      if (line == null) { const mm = /(\d+(?:\.\d+)?)/.exec(q); line = mm ? Number(mm[1]) : null; }
      const sides = outcomes.map(ouSide);
      if (line == null || !sides[0] || !sides[1]) return null;
      return { ...base, kind: "total", line, sides };
    }
    const teamOf = (s) => [g.away, g.home].find((tm) => A.nicknames(tm).some((n) => squash(s).includes(n)) || A.codes(tm).includes(squash(s)));
    // spread: "Spread: Lakers (-5.5)", outcomes are the two teams
    if (type === "spreads") {
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
    if (type === "moneyline") {
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
        // Polymarket's own summary of the best prices, the numbers its site shows
        const sum = m.bestAsk == null || m.bestBid == null ? null
          : i === 0 ? { ask: m.bestAsk, bid: m.bestBid } : { ask: 1 - m.bestBid, bid: 1 - m.bestAsk };
        const q = fromBook(b);
        if (q && sum) {
          // the order book and the summary should agree; if they don't, don't trust either
          q.check = Math.abs(q.ask - sum.ask) <= 0.02 ? "ok" : "mismatch";
          q.sumAsk = sum.ask;
          return q;
        }
        if (q) return q;
        return sum ? { ...sum, usd: null, book: false, check: "summary" } : null;
      });
    }
    return Object.keys(books).length > 0;
  }

  // best ask and bid from one token's order book, plus the average price a $STAKE bet would pay
  function fromBook(b) {
    if (!b) return null;
    const asks = (b.asks || []).map((l) => ({ p: Number(l.price), s: Number(l.size) })).filter((l) => l.p > 0 && l.s > 0).sort((x, y) => x.p - y.p);
    const bids = (b.bids || []).map((l) => ({ p: Number(l.price), s: Number(l.size) })).filter((l) => l.p > 0 && l.s > 0).sort((x, y) => y.p - x.p);
    if (!asks.length) return null;
    let left = STAKE, shares = 0;
    for (const l of asks) { if (left <= 0 || l.p > asks[0].p + MAX_SLIP) break; const take = Math.min(left, l.p * l.s); shares += take / l.p; left -= take; }
    const usd = asks.filter((l) => l.p <= asks[0].p + MAX_SLIP).reduce((a, l) => a + l.p * l.s, 0);
    return { ask: asks[0].p, bid: bids[0]?.p ?? null, usd, fill: left <= 1e-9 ? STAKE / shares : null, book: true };
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
      const markets = raw.map((m) => { const x = parseMarket(A, g, m, roster); if (x) x.url = `https://polymarket.com/event/${m._slug}${m.slug && m.slug !== m._slug ? `/${m.slug}` : ""}`; return x; }).filter(Boolean);
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
        if (qt.check === "mismatch") return;   // the order book and Polymarket's summary disagree: skip it
        if (qt.bid == null || qt.ask - qt.bid > MAX_GAP || qt.ask > MAX_PRICE) return;   // no real market here
        const shown = m.shown?.[i];
        if (shown != null && Math.abs(qt.ask - shown) > MAX_OFF_SHOWN) return;   // not what Polymarket's site shows
        const leg = modelLeg(A, g, m.kind, { pid: m.pid, key: m.key, line: m.kind === "spread" ? m.lines[i] : m.line, side });
        if (!leg) return;
        // too thin to take a $20 bet near the ask: leave it out
        if (qt.book ? qt.fill == null : m.liq < MIN_LIQ) return;
        const pay = qt.book ? qt.fill : qt.ask;
        const price = Math.min(0.995, pay + m.fee * Math.min(pay, 1 - pay));
        const flags = [];
        if (qt.book && pay - qt.ask >= 0.005) flags.push(`$${STAKE} fills at ${Math.round(pay * 100)}¢`);
        if (qt.ask - qt.bid >= WIDE) flags.push(`wide ${Math.round(qt.bid * 100)}/${Math.round(qt.ask * 100)}¢`);
        const src = `Polymarket market: "${m.q}" · buying "${m.outcomes[i]}" · best ask ${Math.round(qt.ask * 100)}¢${qt.bid != null ? `, best bid ${Math.round(qt.bid * 100)}¢` : ""} · ${qt.book ? "from the order book" : "from Polymarket's summary"}`;
        legs.push({ ...leg, grp: group(leg), price, ask: qt.ask, bid: qt.bid, usd: qt.usd, flags, url: m.url, src, token: m.tokens[i], edge: leg.p - price });
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
        // the usual line each way, plus a big-night line (about 12%) for the lottery tickets.
        // No made-up "safer" alternate lines: Polymarket may not list them, so a basket built on
        // them couldn't be placed. With prices, the real alternate lines come from Polymarket.
        const tries = [[A.mainLine(pl, key), "over"], [A.mainLine(pl, key), "under"]];
        for (const [line, side] of tries) {
          if (line == null || line <= 0 || (key === "anytd" && side === "under")) continue;
          const leg = modelLeg(A, g, "player", { pid: pl.pid, key, line, side });
          if (leg && leg.p >= MIN_LEG_P && leg.p <= 0.93 && !legs.some((l) => l.label === leg.label)) legs.push({ ...leg, grp: group(leg) });
        }
        const big = A.lineAt(pl, key, 0.88);
        const leg = big != null && modelLeg(A, g, "player", { pid: pl.pid, key, line: big, side: "over" });
        if (leg && leg.p >= LOTTO_MIN && leg.p <= LOTTO_MAX) legs.push({ ...leg, grp: group(leg), lotto: true });
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
    const who = `${pl.name} [${pl.team}]`;
    return {
      kind, pid, key, line, side, p, team: pl.team, core: pl.core, story: A.storyKeys(pl).includes(key), tags: A.tags(pl, key), name: pl.name, q: pl.q,
      // the player's team in brackets, like "Desmond Bane [ORL] 4+ 3-pointers made"
      label: key === "anytd" && line < 1 ? (side === "over" ? `${who} anytime TD` : `${who} no touchdown`) : `${who} ${lineTxt(side, line)} ${A.statLabel(key)}`,
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
      leg.bits = pack(hit);
    }
    // the simulated games themselves, so each storyline's own chance can be measured
    legs.sim = { T, M, zH, zA, sT, sM, mT: m.total.mean };
  }

  // hits packed 32 to a word, so checking a 10-leg basket is fast
  const W = Math.ceil(N / 32);
  function pack(hit) { const b = new Uint32Array(W); for (let i = 0; i < N; i++) if (hit[i]) b[i >> 5] |= 1 << (i & 31); return b; }
  function popcount(b) { let n = 0; for (let w of b) { w -= (w >>> 1) & 0x55555555; w = (w & 0x33333333) + ((w >>> 2) & 0x33333333); n += (((w + (w >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; } return n; }
  function and(a, b) { const c = new Uint32Array(W); for (let i = 0; i < W; i++) c[i] = a[i] & b[i]; return c; }
  function joint(legs) { return popcount(legs.map((l) => l.bits).reduce(and)) / N; }

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
      const sgn = tm === g.home ? 1 : -1, z = (S, i) => (tm === g.home ? S.zH[i] : S.zA[i]);
      out.push({
        id: `run-${tm}`, base: true, title: `${nick(tm)} run away with it`,
        themeTxt: `${nick(tm)} win by ${A.runMargin}+`, theme: (S, i) => sgn * S.M[i] >= A.runMargin,
        blurb: `${nick(tm)} win comfortably, their key players feast, and ${poss(opp)} go quiet.${A.blowoutNote}`,
        pool: (l) => dominates(tm)(l) || (isOver(l) && l.team === tm && l.core && A.runTags.some((t) => l.tags.includes(t))) || (isUnder(l) && l.team === opp && l.core && main(l)),
        need: [[dominates(tm), 1], [(l) => isOver(l) && l.team === tm, 1]], max: MAX_LEGS,
        // the underdog winning is a real scenario, so its moneyline may go down to about 1 in 4
        // for a big underdog that's the whole point, so in the looser pass it may go lower still
        floor: (l, loose) => (dominates(tm)(l) ? (loose ? 0.1 : 0.25) : null),
      });
      out.push({
        id: `shut-${tm}`, title: `${nick(opp)} defense shuts down ${nick(tm)}`,
        themeTxt: `${nick(tm)} score well under their usual (bottom quarter of their range)`, theme: (S, i) => z(S, i) < -0.67,
        blurb: `${poss(tm)} main options come in under, and ${nick(opp)} take care of business.`,
        pool: (l) => (isUnder(l) && l.team === tm && l.core && main(l)) || total("under")(l) || wins(opp)(l),
        need: [[(l) => isUnder(l) && l.team === tm, 2]], max: MAX_LEGS,
      });
      out.push({
        id: `duo-${tm}`, title: A.duo.title(nick(tm)), blurb: A.duo.blurb(nick(tm)),
        themeTxt: `${nick(tm)} have one of their better scoring nights (top third)`, theme: (S, i) => z(S, i) > 0.43,
        pool: (l) => (isOver(l) && l.team === tm && (l.tags.includes(A.duo.a) || l.tags.includes(A.duo.b))) || wins(tm)(l) || total("over")(l),
        need: [[(l) => isOver(l) && l.tags.includes(A.duo.a), 1], [(l) => isOver(l) && l.tags.includes(A.duo.b) && !l.tags.includes(A.duo.a), 1]], max: MAX_LEGS,
      });
      out.push({
        id: `carry-${tm}`, title: A.carry.title(nick(tm)), blurb: A.carry.blurb(nick(tm)),
        themeTxt: `${nick(tm)} have one of their better scoring nights (top third)`, theme: (S, i) => z(S, i) > 0.43,
        pool: (l) => (isOver(l) && l.team === tm && l.core && l.tags.includes(A.carry.tag)) || wins(tm)(l) || total("over")(l),
        need: [[(l) => isOver(l) && l.tags.includes(A.carry.tag), 2]], max: MAX_LEGS,
      });
    }
    out.push({
      id: "close", title: "Close game, starters play it out",
      themeTxt: `Final margin ${A.closeMargin} or fewer`, theme: (S, i) => Math.abs(S.M[i]) <= A.closeMargin,
      blurb: `${nick(dog)} keep it within the number, so both teams' stars play the whole fourth quarter.`,
      pool: (l) => dogCover(l) || (isOver(l) && l.core) || total("over")(l),
      need: [[dogCover, 1], [(l) => isOver(l) && l.team === g.home, 1], [(l) => isOver(l) && l.team === g.away, 1]], max: MAX_LEGS,
    });
    out.push({
      id: "shootout", title: "Shootout", themeTxt: "Total points in the top third of the expected range", theme: (S, i) => S.T[i] > S.mT + 0.43 * S.sT, blurb: "Lots of possessions and points: the total goes over and scorers on both sides cash.",
      pool: (l) => total("over")(l) || (isOver(l) && l.core && main(l)),
      need: [[total("over"), 1], [isOver, 1]], max: MAX_LEGS,
    });
    out.push({
      id: "grind", title: "Low-scoring grind", themeTxt: "Total points in the bottom third of the expected range", theme: (S, i) => S.T[i] < S.mT - 0.43 * S.sT, blurb: "A slow, ugly game: the total goes under and the main options on both sides fall short.",
      pool: (l) => total("under")(l) || (isUnder(l) && l.core && main(l)),
      need: [[total("under"), 1], [isUnder, 1]], max: MAX_LEGS,
    });
    out.push({
      id: "value", title: "Scooping up the inefficiencies", priced: true,
      blurb: "No story, just the legs where the model's chance is furthest above Polymarket's price.",
      pool: (l) => l.edge >= 0.03 || (isGame(l) && l.edge >= 0), need: [], max: MAX_LEGS,
    });
    return out;
  }

  // Best basket of up to 10 legs for a story: one leg per player, one bet on who wins, one total, at
  // least one game leg, no longshot legs, a payout above 4x net, and a chance of at least 1 in 40.
  // With prices it maximizes the expected return; without them, it pays 10x+ at its own odds and
  // hits as often as possible when the storyline happens. `loose` widens the leg limits a little.
  function best(story, legs, priced, loose) {
    const legMin = loose ? MIN_LEG_P - 0.05 : MIN_LEG_P, priceMin = loose ? MIN_PRICE - 0.05 : MIN_PRICE;
    // the storyline itself has to be plausible (checked before this); the basket can be a long one
    const jointMin = MIN_BASKET;
    const ok = legs.filter((l) => {
      // story legs use stats the player is known for (a playmaker's assists, not a center's)
      if (l.lotto || !story.pool(l) || (l.kind === "player" && !l.story && !story.priced)) return false;
      const f = story.floor?.(l, loose);
      return f != null ? l.p >= f && (!priced || l.price >= f - 0.05) : l.p >= legMin && (!priced || l.price >= priceMin);
    });
    const rank = (a, b) => (priced ? b.edge - a.edge : b.p - a.p);
    // the best few legs for each thing the story needs, then the best of the rest
    // at most two lines per player, so the pool covers enough different players to reach 10 legs
    const per = new Map(), sorted = ok.sort(rank).filter((l) => { const n = per.get(l.grp) || 0; per.set(l.grp, n + 1); return isGame(l) || n < 2; });
    const pick = [...new Set([...story.need.flatMap(([f]) => sorted.filter(f).slice(0, 4)), ...sorted.filter(isGame).slice(0, 4), ...sorted.filter((l) => !isGame(l)).slice(0, 28)])];
    // game legs go first: every basket starts from one, so the search can't prune them away
    const pool = [...pick.filter(isGame), ...pick.filter((l) => !isGame(l))];
    const needsMet = (legs2) => story.need.filter(([f, n]) => legs2.filter(f).length >= n).length;
    // Build baskets one leg at a time (up to 10), keeping the 60 most promising at each size.
    // A basket's chance only falls as legs are added, so anything under the floor is dropped early.
    const okNeed = (pick) => pick.some(isGame) && story.need.every(([f, n]) => pick.filter(f).length >= n);
    const idx = new Map(pool.map((l, i) => [l, i])), tN = story.tbits ? Math.max(1, popcount(story.tbits)) : 1;
    let top = null, beam = pool.filter(isGame).map((l) => ({ legs: [l], bits: l.bits, prod: l.p, cost: priced ? l.price : 1 }));
    for (let depth = 1; depth < Math.min(story.max, MAX_LEGS) && beam.length; depth++) {
      const next = [];
      for (const c of beam) {
        const last = c.legs.length ? idx.get(c.legs.at(-1)) : -1;
        for (let i = last + 1; i < pool.length; i++) {
          const l = pool[i];
          if (c.legs.some((p) => p.grp === l.grp)) continue;
          const bits = c.bits ? and(c.bits, l.bits) : l.bits, pj = popcount(bits) / N;
          if (pj < jointMin) continue;
          const legs2 = [...c.legs, l], prod = c.prod * l.p, cost = c.cost * (priced ? l.price : 1);
          const pay = priced ? 1 / cost : 1 / pj;
          // without prices there's no edge to chase, so pick the basket that hits most often when the
          // storyline happens: a bet on the story itself rather than on unrelated legs
          const fit = story.tbits ? popcount(and(bits, story.tbits)) / tN : pj / prod;
          if (legs2.length >= 2 && pay - 1 > MIN_NET && (priced || pay >= MODEL_PAY) && okNeed(legs2)) {
            const score = priced ? pj * pay - 1 : fit;
            if (!top || score > top.score) top = { legs: legs2, bits, pj, prod, pay, score, ev: priced ? pj * pay - 1 : null };
          }
          // how promising: expected payout per $1 with prices, correlation lift without
          // and a nudge toward baskets that already have what the story needs
          next.push({ legs: legs2, bits, prod, cost, rank: (priced ? pj / cost : fit) * 1.5 ** needsMet(legs2) });
        }
      }
      // keep the most promising, plus a few of the longest ones so bigger baskets still get looked at
      next.sort((x, y) => y.rank - x.rank);
      const low = next.slice(BEAM * 0.7).sort((x, y) => x.prod - y.prod).slice(0, BEAM * 0.3);
      beam = [...next.slice(0, BEAM * 0.7), ...low];
    }
    if (!top) return null;
    // how often the basket hits when the storyline does happen
    const given = story.tbits ? popcount(and(top.bits, story.tbits)) / Math.max(1, popcount(story.tbits)) : null;
    return { ...story, ...top, given };
  }

  // each storyline's own chance, measured on the same simulated games as the legs
  function themed(all, sim) {
    return all.map((st) => {
      if (!st.theme || !sim) return { ...st, pt: null };
      const hit = new Uint8Array(N);
      for (let i = 0; i < N; i++) hit[i] = st.theme(sim, i) ? 1 : 0;
      const tbits = pack(hit);
      return { ...st, tbits, pt: popcount(tbits) / N };
    });
  }

  // Six per game: both "runs away" baskets, then the best of the rest, skipping any that mostly
  // repeat one already shown. If that leaves the game short, try again with slightly looser limits.
  function pickSix(A, g, legs, priced) {
    // only storylines that happen in at least 1 game in 5 (the two "runs away" ones always show)
    const all = themed(stories(A, g).filter((s) => priced || !s.priced), legs.sim).filter((s) => s.base || s.pt == null || s.pt >= MIN_THEME);
    const firstOf = (list) => { for (const loose of [false, true]) { const b = list.map((s) => best(s, legs, priced, loose)).filter(Boolean); if (b.length) return b; } return []; };
    // the two "runs away" baskets come first, at looser limits only if they must
    // if Polymarket has no market deep enough to build one, it still gets a card that says so
    const shown = all.filter((s) => s.base).map((s) => firstOf([s])[0] || { ...s, empty: true, legs: [] });
    // with up to 10 legs some overlap is natural, so "repeats" means sharing half or more of the smaller basket
    const repeats = (b) => shown.some((o) => b.legs.filter((l) => o.legs.includes(l)).length >= Math.max(Math.min(3, b.legs.length), Math.ceil(Math.min(b.legs.length, o.legs.length || 99) / 2)));
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
    // on a re-pull for the same game, keep showing the last prices until the new ones arrive
    if (el.dataset.gid !== g.id) el.innerHTML = head(win.open ? "Checking Polymarket…" : esc(win.why)) + `<div class="empty">${win.open ? "Pulling Polymarket prices for this game…" : "Building model-only baskets…"}</div>`;
    el.dataset.gid = g.id;
    let rec = null;
    if (win.open) rec = await pull(A, g);
    if (el._basketToken !== token) return;   // a newer render took over

    const priced = !!(rec && rec.markets.some((m) => m.kind === "player"));
    let legs = priced ? legsFromMarkets(A, g, rec.markets) : legsFromModel(A, g);
    let status;
    if (!win.open) status = `${esc(win.why)} Until then these use the model's own lines, so compare each basket's break-even payout with Polymarket's price.`;
    else if (rec.src === "blocked") status = "Couldn't reach Polymarket from this computer (it may be blocked on this network). These use the model's own lines instead.";
    else if (!priced) status = `Polymarket isn't listing player props for this game yet${rec.events ? ` (found ${rec.events} event${rec.events > 1 ? "s" : ""}, but no player markets)` : ""}, checked ${new Date(rec.t).toLocaleTimeString()}. These use the model's own lines instead.`;
    else status = `${rec.src === "saved" ? `<b>Saved</b> Polymarket prices from ${new Date(rec.t).toLocaleTimeString()} (couldn't refresh, prices may have moved)` : `Polymarket prices as of <b>${new Date(rec.t).toLocaleTimeString()}</b> (updates every 2 minutes)`} · ${rec.markets.filter((m) => m.kind === "player").length} player markets${rec.book ? " · checked against the order book" : " · summary quotes (order book unavailable)"} · hover a leg to see the exact market`;

    // the underpriced singles, each pressure-tested (vet.js); the price-history check needs the network
    const under = priced ? underpriced(legs, (r) => VET.grade(r, { A, g, legs })) : [];
    if (under.length) { await VET.drift(under); if (el._basketToken !== token) return; }
    simulate(A, g, legs);
    const baskets = pickSix(A, g, legs, priced);
    const lotto = underpricedHtml(under, priced) + lotteryHtml(lottery(legs, priced), priced);
    el.innerHTML = head(status, win.open) + (baskets.length
      ? `<div class="baskets">${baskets.map((b) => card(b, priced)).join("")}</div>`
      : "") + (realCount(baskets) < SHOWN ? `<div class="note">Only ${realCount(baskets)} of 6 storylines could be built here: the rest happen in fewer than 1 game in 5, or couldn't be built without longshot legs, stacked bets${priced ? ", or markets too thin for a $" + STAKE + " bet" : ""} while paying more than 4x net.</div>` : "") + lotto + foot(priced);
    el.querySelectorAll("[data-lotto-g]").forEach((btn) => (btn.onclick = () => {
      el.querySelectorAll(`.lotto [data-g="${btn.dataset.lottoG}"]`).forEach((c) => c.classList.toggle("off"));
    }));
    const rb = el.querySelector("[data-pm-refresh]");
    const reprice = () => { delete CACHE[g.id]; delete LISTS[A.league]; render(el, g, A); };
    if (rb) rb.onclick = reprice;
    clearTimeout(el._repriceTimer);
    if (win.open) el._repriceTimer = setTimeout(() => { if (el.isConnected && el._basketToken === token) reprice(); }, REPRICE_MS);
  }

  // ---------------------------------------------------------------- lottery tickets

  // Long shots: with prices, real Polymarket markets at 4-30¢ priced at or below the model's chance
  // (a 13% shot is only worth buying around 13¢ or less). Without prices, each regular's big-night
  // line on Polymarket's own ladder (25+, 30+ points; 8+, 10+ rebounds), as a preview.
  // Then up to 7 small groups (A-G) of them that tend to hit on the same night.
  function lottery(legs, priced) {
    const cand = legs.filter((l) => (priced ? l.kind === "player" && l.price >= LOTTO_MIN && l.price <= LOTTO_MAX && l.price <= l.p + 0.01 : l.lotto))
      .sort((a, b) => (priced ? b.p / b.price - a.p / a.price : b.p - a.p));
    const list = [];
    for (const l of cand) if (list.length < LOTTO_SHOWN && !list.some((o) => o.grp === l.grp)) list.push(l);
    // try every set of 2 to 6 from the list (under 1,000 sets) and keep the ones whose combined
    // chance clearly beats the chances multiplied
    const groups = [];
    for (let mask = 3; mask < 1 << list.length; mask++) {
      const ix = list.map((_, i) => i).filter((i) => mask & (1 << i));
      if (ix.length < 2 || ix.length > 6) continue;
      const gl = ix.map((i) => list[i]), hits = popcount(gl.reduce((acc, l) => (acc ? and(acc, l.bits) : l.bits), null));
      if (hits < 18) continue;   // under 3 in 1,000 simulated games is too rare to judge how they move together
      const pj = hits / N, prod = gl.reduce((m, l) => m * l.p, 1), lift = pj / prod;
      if (lift < 1.1 + 0.1 * ix.length) continue;
      const pay = priced ? 1 / gl.reduce((m, l) => m * l.price, 1) : 1 / pj;
      // lift per added leg, so a strong pair and a strong six-leg set compete fairly
      groups.push({ ix, pj, prod, lift, pay, ev: priced ? pj * pay - 1 : null, score: lift ** (1 / (ix.length - 1)) });
    }
    groups.sort((x, y) => y.score - x.score);
    // the best group of each size first (2 up to 6, where the math allows it), then the next best,
    // skipping any that mostly repeat one already picked
    const picked = [], fresh = (gr) => picked.every((o) => o.ix.filter((i) => gr.ix.includes(i)).length <= Math.max(1, Math.floor(Math.min(o.ix.length, gr.ix.length) / 2)));
    for (let k = 2; k <= 6; k++) { const gr = groups.find((x) => x.ix.length === k && fresh(x)); if (gr) picked.push(gr); }
    for (const gr of groups) if (picked.length < 7 && !picked.includes(gr) && fresh(gr)) picked.push(gr);
    picked.sort((x, y) => x.ix.length - y.ix.length || y.score - x.score);
    return { list, groups: picked };
  }

  // Single bets, no combining: every Polymarket market (props and game lines) whose price is below
  // the model's chance, biggest edge first. Same filters as the baskets: real listed lines, $20 of
  // depth near the ask, no placeholder quotes. Long shots are left to the lottery section.
  const UNDER_SHOWN = 15, UNDER_MIN_EDGE = 0.03;
  // One row per ladder (all of a team's spreads, one side of the total, one side of a player's
  // stat): its best line, plus the range of lines on that ladder that are also underpriced.
  // Then a mix: one row per player, one per side of the game result (spread or moneyline), one per
  // total, and at most two of any one kind of bet (say, assists unders).
  // With a vet function (VET.grade, bound to the game), every ladder's row is checked first and the
  // mix is built from the rows that pass, best adjusted edge first; rows that fail come after.
  function underpriced(legs, vet = null) {
    const cheap = legs.filter((l) => l.price > LOTTO_MAX && l.edge >= UNDER_MIN_EDGE);
    const ladders = new Map();
    for (const l of cheap) {
      const k = l.kind === "player" ? `${l.pid}|${l.key}|${l.side}` : `${l.kind}|${l.side}`;
      if (!ladders.has(k)) ladders.set(k, []);
      ladders.get(k).push(l);
    }
    const short = (l) => (l.kind === "spread" ? sgn(l.line) : l.kind === "ml" ? "win" : lineTxt(l.side, l.line));
    let rows = [...ladders.values()].map((ls) => {
      const top = ls.reduce((a, b) => (b.edge > a.edge ? b : a));
      const byLine = [...ls].sort((a, b) => a.line - b.line);
      const range = ls.length > 1 ? `Also cheap: ${short(byLine[0])} to ${short(byLine.at(-1))} (${ls.length} lines, +${Math.round(Math.min(...ls.map((l) => l.edge)) * 100)} to +${Math.round(top.edge * 100)})` : "";
      return { ...top, range };
    }).sort((a, b) => b.edge - a.edge);
    let failed = [];
    if (vet) {
      rows = VET.sort(rows.map(vet));
      failed = rows.filter((r) => r.vet.level === "skip");
      rows = rows.filter((r) => r.vet.level !== "skip");
    }
    const kindOf = (l) => (l.kind === "player" ? `${l.key}|${l.side}` : l.kind === "total" ? "total" : `result|${l.side}`);
    const used = new Map(), seen = new Set(), out = [];
    for (const r of rows) {
      if (out.length >= UNDER_SHOWN) break;
      const who = r.kind === "player" ? r.grp : kindOf(r), n = used.get(kindOf(r)) || 0;
      if (seen.has(who) || n >= 2) continue;   // one row per player / result side / total, two of any kind
      out.push(r); seen.add(who); used.set(kindOf(r), n + 1);
    }
    return vet ? [...out, ...failed.slice(0, UNDER_SHOWN)] : out.sort((a, b) => b.edge - a.edge);
  }

  // One row of the underpriced table (also used by the Best props page, with a Game column)
  function underRow(l, i, game = "") {
    return `<tr class="${l.vet ? `vet-row-${l.vet.level}` : ""}"><td class="muted">${i + 1}</td>
      <td class="lt-leg">${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l.label)}${l.q || l.flags.length ? `<div class="tags">${[l.q, ...l.flags].filter(Boolean).map((f) => `<span class="badge q">${esc(f)}</span>`).join(" ")}</div>` : ""}${l.range ? `<div class="muted small">${esc(l.range)}</div>` : ""}${VET.why(l)}</td>${game}
      <td><b>${pct(l.p)}</b></td><td>${cents(l.price)}${l.bid != null ? `<div class="muted small">bid ${cents(l.bid)}</div>` : ""}</td>
      <td class="edge-good">+${Math.round(l.edge * 100)}<div class="muted small">+${Math.round((l.p / l.price - 1) * 100)}%</div></td>${VET.cell(l)}</tr>`;
  }
  function underTable(rows, gameCol = null) {
    return `<div class="table-wrap"><table class="lotto-t under-t${gameCol ? " ap-t" : ""}">
      <thead><tr><th>#</th><th class="lt-leg">Bet</th>${gameCol ? `<th class="ap-game">Game</th>` : ""}<th>Model</th><th>Price</th><th title="Model chance minus price, in cents; below it, the expected profit per $1 if the model is right">Edge</th><th title="Pressure test: Verified, Caution or Skip, and the edge left after the checks">Check</th></tr></thead>
      <tbody>${rows.map((l, i) => underRow(l, i, gameCol ? gameCol(l) : "")).join("")}</tbody></table></div>`;
  }
  // checked rows: the ones that pass first (by the edge left after checks), the Skips folded away below
  function underLists(rows, gameCol = null) {
    const sorted = VET.sort(rows), keep = sorted.filter((l) => l.vet?.level !== "skip"), skip = sorted.filter((l) => l.vet?.level === "skip");
    return (keep.length ? underTable(keep, gameCol) : `<div class="empty">Nothing passed the checks right now.</div>`)
      + (skip.length ? `<details class="vet-skipped"><summary>${skip.length} more failed the checks (likely news or model error, not a mispricing)</summary>${underTable(skip, gameCol)}</details>` : "");
  }

  function underpricedHtml(list, priced) {
    const box = (body) => `<div class="lotto"><h3>Underpriced props</h3>${body}</div>`;
    if (!priced) return box(`<div class="empty">Single bets priced below the model's chance show here once Polymarket has player props for this game (game day for the NBA, the day before for the NFL, or within 24 hours of the start).</div>`);
    return box(`<div class="muted small">Single bets, no parlay needed: Polymarket's ask is below the model's chance by at least ${Math.round(UNDER_MIN_EDGE * 100)}¢. Each line ladder (a spread, a total, one player's stat) is one row: its best-priced line, with the range of lines that are also cheap. Each can take a $${STAKE} bet near the price shown. Long shots under ${Math.round(LOTTO_MAX * 100)}¢ are in Lottery tickets below.</div>
      <div class="muted small vet-rules">${VET.RULES}</div>${list.length ? underLists(list) : `<div class="empty">Nothing underpriced right now.</div>`}`);
  }

  // One compact table: the long shots on the left, and a column per group (A-G) on the right with
  // a dot on each leg in it. Clicking a group's letter folds that column away.
  function lotteryHtml({ list, groups }, priced) {
    if (!list.length) return `<div class="lotto"><h3>Lottery tickets</h3><div class="empty">${priced ? "No long shots on Polymarket for this game priced at or below the model's chance with enough depth for $20." : "No long shots to list for this game."}</div></div>`;
    const pct1 = (p) => `${p < 0.01 ? String(+(p * 100).toPrecision(1)) : p < 0.1 ? (p * 100).toFixed(1) : Math.round(p * 100)}%`;
    const L = "ABCDEFG";
    const gh = groups.map((gr, j) => `<th class="lg" data-g="${j}"><button type="button" class="lg-btn" data-lotto-g="${j}" title="Hide or show group ${L[j]}">${L[j]}</button></th>`).join("");
    const rows = list.map((l, i) => `<tr><td class="muted">${i + 1}</td>
      <td class="lt-leg">${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l.label)}${l.q ? ` <span class="badge q">${esc(l.q)}</span>` : ""}</td>
      <td><b>${pct1(l.p)}</b></td>
      ${priced ? `<td>${cents(l.price)}</td><td>${xs(1 / l.price)}</td>` : `<td>${xs(1 / l.p)}</td>`}
      ${groups.length ? `<td class="lg-gap"></td>` : ""}${groups.map((gr, j) => `<td class="lg" data-g="${j}">${gr.ix.includes(i) ? `<span class="lg-dot g${j}">●</span>` : ""}</td>`).join("")}</tr>`).join("");
    const span = priced ? 5 : 4;
    const foot = groups.length ? [
      ["Legs", (gr) => gr.ix.length],
      ["All hit", (gr) => `<span title="${pct1(gr.prod)} if they were unrelated">${pct1(gr.pj)}</span>`],
      [priced ? "Pays" : "Break-even", (gr) => xs(gr.pay)],
      ...(priced ? [["Return", (gr) => `<span class="${gr.ev >= 0 ? "edge-good" : "edge-bad"}">${gr.ev >= 0 ? "+" : "−"}${Math.abs(Math.round(gr.ev * 100))}%</span>`]] : []),
    ].map(([name, f]) => `<tr class="lg-foot"><td colspan="${span}" class="muted small" style="text-align:right">${name}</td><td class="lg-gap"></td>${groups.map((gr, j) => `<td class="lg small" data-g="${j}"><span>${f(gr)}</span></td>`).join("")}</tr>`).join("") : "";
    return `
      <div class="lotto">
        <h3>Lottery tickets</h3>
        <div class="muted small">${priced
          ? "Polymarket long shots at 4–30¢, only ones priced at or below the model's chance (a 13% shot at about 13¢ or less), best value first. Most of these lose; bet small."
          : "Preview: each regular's big-night line on Polymarket's own ladder. Prices come in on game day (NBA) or the day before (NFL); only buy one priced at or below its chance here."}</div>
        <div class="table-wrap"><table class="lotto-t">
          <thead><tr><th>#</th><th class="lt-leg">Leg</th><th>Model</th>${priced ? "<th>Price</th><th>Pays</th>" : "<th>Break-even</th>"}${groups.length ? `<th class="lg-gap"></th>` : ""}${gh}</tr></thead>
          <tbody>${rows}${foot}</tbody>
        </table></div>
        ${groups.length ? `<div class="small muted">Each is a long shot on its own. Lettered columns are small groups that tend to hit on the same night, so a group hits more often than its chances multiplied; bet a group as its own parlay, not all ten together. Click a letter to fold that column away.</div>` : `<div class="small muted">None of these move together strongly enough to suggest a group.</div>`}
      </div>`;
  }

  function head(status, canRefresh) {
    return `<div class="panel-head"><h2>Storyline baskets</h2><span class="muted small">${status}</span>${canRefresh ? `<button type="button" class="btn" data-pm-refresh>Refresh prices</button>` : ""}</div>`;
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
        <td>${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l.label)}${l.q ? ` <span class="badge q" title="On the injury report">${esc(l.q)}</span>` : ""}${priced && l.flags.length ? `<div>${l.flags.map((f) => `<span class="badge q">${esc(f)}</span>`).join(" ")}</div>` : ""}</td>
        <td><b>${pct(l.p)}</b></td>
        ${priced ? `<td><b>${cents(l.price)}</b>${l.bid != null ? `<div class="muted small">bid ${cents(l.bid)}</div>` : ""}</td>
        <td class="${l.edge >= 0 ? "edge-good" : "edge-bad"}">${l.edge >= 0 ? "+" : "−"}${Math.abs(Math.round(l.edge * 100))}</td>` : `<td class="muted">${l.kind === "player" ? "model line" : "market line"}</td>`}
      </tr>`).join("");
    const summary = priced
      ? `Pays <b>${xs(b.pay)}</b> per $1 (net <b>+${xs(b.pay - 1)}</b>) at $20 fill prices · model chance <b>${pct(b.pj)}</b>${Math.abs(lift - 1) > 0.05 ? ` <span class="muted">(${pct(b.prod)} if the legs were unrelated)</span>` : ""}
         · expected return <b class="${b.ev >= 0 ? "edge-good" : "edge-bad"}">${b.ev >= 0 ? "+" : "−"}${Math.abs(Math.round(b.ev * 100))}%</b>`
      : `Model chance <b>${pct(b.pj)}</b>${Math.abs(lift - 1) > 0.05 ? ` <span class="muted">(${pct(b.prod)} if unrelated)</span>` : ""} · break-even payout <b>${xs(1 / b.pj)}</b>: worth it only if Polymarket pays more than that`;
    const warn = priced && b.legs.some((l) => l.flags.length) ? `<div class="note">Some legs have a wide bid/ask gap or need to climb the order book a little to fill $20; the price shown is what $20 would really cost.</div>` : "";
    return `
      <div class="basket ${priced ? (b.ev >= 0 ? "good" : "bad") : ""}">
        <div class="basket-head"><b>${esc(b.title)}</b>${priced && b.ev < 0 ? ` <span class="badge out">Overpriced</span>` : ""}${b.pt != null && b.pt < MIN_THEME ? ` <span class="badge q" title="Shown because both 'runs away' stories always appear, but it happens in fewer than 1 game in 5">Long shot</span>` : ""}</div>
        <div class="muted small">${esc(b.blurb)}</div>
        ${b.pt != null ? `<div class="small theme">Storyline: <b>${esc(b.themeTxt)}</b>, about <b>${pct(b.pt)}</b> of games.${b.given != null ? ` When it happens, this basket hits <b>${pct(b.given)}</b> of the time.` : ""}</div>` : ""}
        <div class="table-wrap"><table>
          <thead><tr><th>Leg</th><th>Model</th>${priced ? `<th title="What you'd pay now (the ask)">Price</th><th title="Model chance minus price, in cents">Edge</th>` : `<th>Line</th>`}</tr></thead>
          <tbody>${legRows}</tbody>
        </table></div>
        <div class="basket-sum">${summary}</div>${warn}
      </div>`;
  }

  function foot(priced) {
    return `<div class="note">${priced ? "Every leg can take a $20 bet within 2¢ of its best price (thinner markets are left out), and payout uses what $20 would really cost; if Polymarket's parlay builder quotes a different price for the combo, use that. " : ""}Every storyline happens in at least 1 simulated game in 5 (the two \"runs away\" ones always show, marked Long shot when they don't). The basket on top of it can have up to 10 legs and be a long one, down to about 1 in 40; with prices, it's the one where the payout beats the model's odds by the most.
      The legs here are chosen to move together, which is the point of a storyline, but how strongly they move together is the model's estimate, not something it has been tested on yet.
      Every basket includes at least one bet on the game itself, uses one leg per player, one bet on the winner (spread or moneyline), and one total, and skips legs the model or the market gives under about a 40% chance. Players ruled Out or Doubtful are never used; Questionable ones are marked.</div>`;
  }

  return { underpriced, underLists, pull, STAKE, UNDER_MIN_EDGE, LOTTO_MAX, render, clear, pickSix, pullWindow, parseMarket, simulate, joint, best, stories, legsFromModel, legsFromMarkets, priceBooks, eventMatches, N };
})();
