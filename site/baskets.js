"use strict";

// Polymarket bets for one game, shared by the NFL and NBA pages.
//
// 1. Pull Polymarket's prop and game markets for a game, but only when they are worth reading:
//    on game day for the NBA, from 4 days before kickoff for the NFL. Prices are the real order book:
//    a leg costs what you'd pay to buy it now (the ask), not the midpoint.
// 2. Simulate the game a few thousand times so legs that move together really do move
//    together, with weights fitted to past seasons (see simulate()).
// 3. Show the spread + total combo (combo.js), the mispriced single bets (the model's fair price beats Polymarket's), the negative
//    correlation multipliers (pairs that pull apart, pairs.js), and lottery tickets. locks.js reuses the legs, the
//    simulation, and the storylines below to build the cross-game Lock combos.
//
// Each page passes an adapter with its sport's rules (see basketAdapter in app.js and nba.js).

const BASKETS = (() => {
  const GAMMA = "https://gamma-api.polymarket.com";
  const CLOB = "https://clob.polymarket.com";
  const N = 6000;                    // simulated games per matchup
  const WIDE = 0.05;                 // bid-ask gap (in dollars per share) that counts as wide
  // Andrew bets $10-20 a time, so every leg must take $20 without paying more than 2¢ over
  // the best ask; anything thinner is left out, not just flagged. Without the order book, a
  // market needs $1,000 of liquidity to count.
  const STAKE = 20, MAX_SLIP = 0.02, MIN_LIQ = 1000;
  // A real, tradeable price: bid and ask no more than 10¢ apart, within 5¢ of the price Polymarket
  // shows on its site, and under 95¢ (dearer legs add almost nothing to a parlay's payout).
  // Empty markets sit at a 1¢ bid and a 97-99¢ ask, which are placeholders, not prices.
  const MAX_GAP = 0.1, MAX_OFF_SHOWN = 0.05, MAX_PRICE = 0.95;
  const REPRICE_MS = 2 * 60 * 1000;   // re-pull prices every 2 minutes while the page is open
  const CACHE_MS = 90 * 1000;        // reuse a pull for 90 seconds while clicking around
  const MIN_LEG_P = 0.4;             // model-only legs: no long shots
  // A storyline (used by the locks) must be at least a 1-in-5 scenario in the simulation
  const MIN_THEME = 0.2;
  const MAX_LEGS = 10;
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

  // NBA props go up on game day, so nothing is pulled earlier than that. NFL games are pulled
  // from 4 days before kickoff (daysBefore in the page's adapter), so a Sunday game's markets
  // show from Wednesday; player props may still be thin or missing that early.
  function pullWindow(A, g) {
    const day = A.gameDay(g), first = addDays(day, -A.daysBefore), today = etDay(Date.now());
    if (A.isPost(g)) return { open: false, why: "This game is over, so there's nothing left to bet." };
    if (A.isLive(g)) return { open: false, why: "This game is under way. Polymarket's prices now move with the score, and the model is pre-game, so prices aren't pulled." };
    // open from daysBefore days ahead (0 = game day), or any time the game starts within 24 hours
    const soon = A.kickoff(g) - Date.now() < 24 * 3600 * 1000;
    if (today < first && !soon) return { open: false, why: `Polymarket prices are pulled ${A.daysBefore ? `from ${A.daysBefore === 1 ? "the day" : `${A.daysBefore} days`} before kickoff` : "on game day"} or within 24 hours of the start, starting ${niceDay(first)}.` };
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
    // events that haven't ended yet (Polymarket rejects a start_date_min with a time on it, which
    // made this list fail every time)
    const events = await getJson(`${GAMMA}/events?tag_slug=${A.league}&closed=false&limit=500&end_date_min=${etDay(Date.now())}`);
    LISTS[A.league] = { t: Date.now(), events: Array.isArray(events) ? events : [] };
    return LISTS[A.league].events;
  }

  // Polymarket dates its slugs by the UTC day of the start, so a night game (8:20pm ET Sunday
  // is 00:20 UTC Monday) is slugged with the next day: nfl-phi-was-2026-11-02 for a Nov 1 game.
  // Both the local game day and the UTC day count.
  function slugDays(A, g) {
    const day = A.gameDay(g), k = A.kickoff(g);
    const utc = isNaN(k) ? day : new Date(k).toISOString().slice(0, 10);
    return [...new Set([day, utc])];
  }

  function eventMatches(A, g, e) {
    const slug = String(e.slug || "").toLowerCase(), parts = slug.split("-");
    const near = (list) => list.map((t) => (t ? Date.parse(String(t).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : NaN)).filter((t) => !isNaN(t))
      .map((t) => Math.abs(t - A.kickoff(g)) < 6 * 3600 * 1000);
    // a dated slug must carry this game's date, local or UTC; since that lets a late game and the
    // next day's game share a date, a market's own start time, when it has one, must also be
    // within 6 hours of kickoff (teams can meet on back-to-back nights). An undated slug goes by
    // the event's start time alone.
    const starts = near((e.markets || []).slice(0, 3).map((m) => m.gameStartTime));
    const dayOk = /\d{4}-\d{2}-\d{2}/.test(slug)
      ? slugDays(A, g).some((d) => slug.includes(d)) && (!starts.length || starts.some(Boolean))
      : [...starts, ...near([e.startTime, e.eventDate])].some(Boolean);
    const title = squash(`${e.title || ""} ${e.ticker || ""}`);
    const teamOk = (tm) => A.nicknames(tm).some((n) => title.includes(n)) || A.codes(tm).some((c) => parts.includes(c));
    return dayOk && teamOk(g.away) && teamOk(g.home);
  }

  async function findEvents(A, g) {
    const found = new Map();
    let reached = false;
    // Player props live in their own event next to the game's: nfl-was-nyg-2026-11-13 holds the
    // moneyline, spreads, and totals, nfl-was-nyg-2026-11-13-player-props holds the props.
    outer: for (const day of slugDays(A, g).reverse()) for (const a of A.codes(g.away)) for (const h of A.codes(g.home)) {
      const base = `${A.league}-${a}-${h}-${day}`;
      const got = await Promise.all([base, `${base}-player-props`].map((slug) => getJson(`${GAMMA}/events?slug=${slug}`).catch(() => null)));
      for (const j of got) {
        if (!j) continue;
        reached = true;
        for (const e of j) if (!Array.isArray(e.markets) || eventMatches(A, g, e)) found.set(String(e.id), e);
      }
      if (found.size) break outer;
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
    // A ladder market ("4+ rebounds", Yes/No) is over 3.5: buying No means 3 or fewer. If
    // Polymarket's line field carries the threshold itself (4) or the text says "4+", use 3.5,
    // so the under reads "3 or fewer" and not a "4 or fewer" that isn't on the board.
    const plus = /(?<![\d.])(\d+)\s*\+|at least\s+(\d+)(?![\d.])/i.exec(`${q} ${m.groupItemTitle || ""}`);
    if (plus) line = Number(plus[1] ?? plus[2]) - 0.5;
    // Polymarket has no pushes, so a whole-number line on a player prop is the N+ threshold too
    else if (Number.isInteger(line) && line >= 1) line -= 0.5;
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
    // only rungs Polymarket lists (steps.js): no 5+ rebounds when the board is 4+ and 6+
    if (key !== "anytd" && !STEPS.onLadder(A.league, key, line)) return null;
    const pr = A.prob(pl, key, line);
    if (!pr) return null;
    const p = side === "over" ? pr.over : pr.under;
    const who = `${pl.name} [${pl.team}]`;
    return {
      kind, pid, key, line, side, p, gid: g.id, team: pl.team, core: pl.core, story: A.storyKeys(pl).includes(key), tags: A.tags(pl, key), name: pl.name, q: pl.q,
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
  // tools use). A team's scoring follows from those. Every player's stat line then depends on a
  // few shared swings, with weights fitted to past seasons (A.load, see PM_LOAD in app.js and
  // nba.js): his team's scoring (b), his team's lead (m), his team's passing volume (pass), how
  // lopsided the game is (w: NBA starters sit in blowouts), how much of the game his team has
  // the ball (poss: the other team's share is the mirror image), a passing-friendly game for
  // both sides (env), touchdowns coming through the air vs. on the ground (tds), and a share of a
  // pool he splits with teammates (comp: backs split carries, receivers split targets, NBA
  // regulars split shots), which is what makes some teammates' props pull apart.
  // The rest is his own luck. Each leg's own chance is kept exactly as the model has it; only
  // how legs move together comes from here.
  function simulate(A, g, legs) {
    const r = rng(g.id), norm = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const vec = () => { const v = new Float64Array(N); for (let i = 0; i < N; i++) v[i] = norm(); return v; };
    const m = g.model, sT = m.total.sd, sM = m.margin.sd, S = Math.hypot(sT, sM);
    const T = new Float64Array(N), M = new Float64Array(N), zH = new Float64Array(N), zA = new Float64Array(N);
    const zM = new Float64Array(N), blow = new Float64Array(N);
    const passH = vec(), passA = vec(), tdsH = vec(), tdsA = vec(), poss = vec(), env = vec();
    for (let i = 0; i < N; i++) {
      const a = norm(), b = norm();
      T[i] = m.total.mean + sT * a; M[i] = m.margin.mean + sM * b; zM[i] = b;
      zH[i] = (sT * a + sM * b) / S; zA[i] = (sT * a - sM * b) / S;
      blow[i] = (Math.abs(M[i]) - 0.8 * sM) / (0.6 * sM);
    }
    // pools: each member gets his own draw minus the pool's average, so members pull apart
    // (two members: -c1*c2; n members: about -c1*c2/(n-1)) while the pool as a whole doesn't move
    const pools = new Map();
    const poolZ = (pl, name) => {
      const key = `${pl.team}|${name}`;
      if (!pools.has(key)) {
        const mem = A.roster(g).filter((x) => x.team === pl.team && !x.skip && (A.pools?.(x) || []).includes(name));
        const z = new Map(mem.map((x) => [x.pid, vec()]));
        const n = mem.length, f = n > 1 ? Math.sqrt(n / (n - 1)) : 0;
        if (n > 1) for (let i = 0; i < N; i++) {
          let avg = 0; for (const v of z.values()) avg += v[i];
          avg /= n; for (const v of z.values()) v[i] = (v[i] - avg) * f;
        }
        pools.set(key, z);
      }
      return pools.get(key).get(pl.pid) || null;
    };
    const own = new Map(), latent = new Map();
    const playerZ = (pid) => { if (!own.has(pid)) own.set(pid, vec()); return own.get(pid); };
    for (const leg of legs) {
      const hit = new Uint8Array(N);
      if (leg.kind === "total") for (let i = 0; i < N; i++) hit[i] = leg.side === "over" ? T[i] > leg.line : T[i] < leg.line;
      else if (leg.kind === "spread" || leg.kind === "ml") { const s = leg.side === g.home ? 1 : -1, L = leg.kind === "ml" ? 0 : leg.line; for (let i = 0; i < N; i++) hit[i] = s * M[i] + L > 0; }
      else {
        const id = `${leg.pid}|${leg.key}`;
        if (!latent.has(id)) {
          const pl = A.player(leg.pid), home = leg.team === g.home, L = A.load(pl, leg.key) || {};
          const f = (k) => L[k] || 0;
          const comps = Object.entries(L.comp || {}).map(([name, c]) => [poolZ(pl, name), c]).filter(([z]) => z);
          const shared = f("b") ** 2 + f("m") ** 2 + f("pass") ** 2 + f("w") ** 2 + f("poss") ** 2 + f("env") ** 2 + f("tds") ** 2 + comps.reduce((a, [, c]) => a + c * c, 0);
          const rest = Math.sqrt(Math.max(0.05, 1 - shared));
          const zp = playerZ(leg.pid), x = new Float64Array(N), sg = home ? 1 : -1;
          const zT = home ? zH : zA, pass = home ? passH : passA, tds = home ? tdsH : tdsA;
          for (let i = 0; i < N; i++) {
            let v = f("b") * zT[i] + f("m") * sg * zM[i] + f("pass") * pass[i] + f("w") * blow[i] + f("poss") * sg * poss[i] + f("env") * env[i] + f("tds") * tds[i]
              + rest * (0.55 * zp[i] + 0.835 * norm());
            for (const [z, c] of comps) v += c * z[i];
            x[i] = v;
          }
          latent.set(id, { x, sorted: Float64Array.from(x).sort() });
        }
        const { x, sorted } = latent.get(id);
        leg.lat = x;   // the raw draw itself, for leaders.js (who finishes on top across games)
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

  // ---------------------------------------------------------------- panel

  async function render(el, g, A) {
    const token = (el._basketToken = {});
    const win = pullWindow(A, g);
    // on a re-pull for the same game, keep showing the last prices until the new ones arrive
    if (el.dataset.gid !== g.id) el.innerHTML = head(win.open ? "Checking Polymarket…" : esc(win.why)) + `<div class="empty">${win.open ? "Pulling Polymarket prices for this game…" : "Working out the model-only pairs…"}</div>`;
    el.dataset.gid = g.id;
    let rec = null;
    if (win.open) rec = await pull(A, g);
    if (el._basketToken !== token) return;   // a newer render took over

    const priced = !!(rec && rec.markets.some((m) => m.kind === "player"));
    let legs = priced ? legsFromMarkets(A, g, rec.markets) : legsFromModel(A, g);
    let status;
    if (!win.open) status = `${esc(win.why)} Until then the pairs use the model's own lines, so compare each pair's break-even payout with Polymarket's price.`;
    else if (rec.src === "blocked") status = "Couldn't reach Polymarket from this computer (it may be blocked on this network). These use the model's own lines instead.";
    else if (!priced) status = `Polymarket isn't listing player props for this game yet${rec.events ? ` (found ${rec.events} event${rec.events > 1 ? "s" : ""}, but no player markets)` : ""}, checked ${new Date(rec.t).toLocaleTimeString()}. These use the model's own lines instead.`;
    else status = `${rec.src === "saved" ? `<b>Saved</b> Polymarket prices from ${new Date(rec.t).toLocaleTimeString()} (couldn't refresh, prices may have moved)` : `Polymarket prices as of <b>${new Date(rec.t).toLocaleTimeString()}</b> (updates every 2 minutes)`} · ${rec.markets.filter((m) => m.kind === "player").length} player markets${rec.book ? " · checked against the order book" : " · summary quotes (order book unavailable)"} · hover a leg to see the exact market`;

    // the underpriced singles, each pressure-tested (vet.js); the price-history check needs the network
    const under = priced ? underpriced(legs, (r) => VET.grade(r, { A, g, legs })) : [];
    if (under.length) { await VET.drift(under); if (el._basketToken !== token) return; }
    // each leg's adjusted chance (vet.js): a basket's expected return is judged on that, not the raw model
    if (priced) for (const l of legs) l.pa = VET.adjusted(l, { A, g });
    simulate(A, g, legs);
    // single bets first (the steadiest edge), then negative correlation multipliers (pairs that pull apart), then
    // the long shots. The storyline baskets were retired (Andrew, 2026-11-04: "the scenarios
    // aren't working well"); stories() stays because the locks use it to keep same-game legs consistent.
    // the spread + total combo (combo.js) goes first: it only needs the game's spread and total markets
    const combo = typeof COMBO !== "undefined" ? COMBO.html(A, g, rec) : "";
    el.innerHTML = head(status, win.open) + combo + underpricedHtml(under, priced, !combo) + PAIRS.html(legs, priced) + lotteryHtml(lottery(legs, priced), priced);
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
  const UNDER_SHOWN = 30, UNDER_MIN_EDGE = 0.03;
  const UNDER_PER_PLAYER = 2, UNDER_PER_KIND = 4;   // keep the list spread across players and kinds of bet
  // One row per ladder (all of a team's spreads, one side of the total, one side of a player's
  // stat): its best line, plus the range of lines on that ladder that are also underpriced.
  // Then a mix: up to two stats per player, one row per side of the game result (spread or
  // moneyline), one per total, and at most four of any one kind of bet (say, assists unders).
  // With a vet function (VET.grade, bound to the game), every ladder's row is checked and the mix is
  // built best adjusted edge first. Flagged rows are kept, with their likely issue named.
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
    // flagged rows stay in: they're ordered by the edge left after the checks, so they sink on
    // their own, and each one names its likely issue
    if (vet) rows = VET.sort(rows.map(vet));
    const kindOf = (l) => (l.kind === "player" ? `${l.key}|${l.side}` : l.kind === "total" ? "total" : `result|${l.side}`);
    const used = new Map(), per = new Map(), out = [];
    for (const r of rows) {
      if (out.length >= UNDER_SHOWN) break;
      const who = r.kind === "player" ? r.grp : kindOf(r), n = used.get(kindOf(r)) || 0, m = per.get(who) || 0;
      if (m >= (r.kind === "player" ? UNDER_PER_PLAYER : 1) || n >= UNDER_PER_KIND) continue;   // two stats per player, one per result side / total, four of any kind
      out.push(r); per.set(who, m + 1); used.set(kindOf(r), n + 1);
    }
    return out;
  }

  // One row of the underpriced table (also used by the Best props page, with a Game column)
  function underRow(l, i, game = "") {
    return `<tr class="${l.vet ? `vet-row-${l.vet.level}` : ""}"><td class="muted">${i + 1}</td>
      <td class="lt-leg">${TREND.link(l)}${l.q || l.flags.length ? `<div class="tags">${[l.q, ...l.flags].filter(Boolean).map((f) => `<span class="badge q">${esc(f)}</span>`).join(" ")}</div>` : ""}${l.range ? `<div class="muted small">${esc(l.range)}</div>` : ""}${VET.why(l)}</td>${game}
      <td><b>${cents(l.p)}</b><div class="muted small">pays ${xs(1 / l.p)}</div></td><td>${cents(l.price)}<div class="muted small">pays ${xs(1 / l.price)}${l.bid != null ? ` · bid ${cents(l.bid)}` : ""}</div></td>
      <td class="edge-good">+${Math.round(l.edge * 100)}<div class="muted small">+${Math.round((l.p / l.price - 1) * 100)}%</div></td>${VET.cell(l)}</tr>`;
  }
  function underTable(rows, gameCol = null) {
    return `<div class="table-wrap"><table class="lotto-t under-t${gameCol ? " ap-t" : ""}">
      <thead><tr><th>#</th><th class="lt-leg">Bet</th>${gameCol ? `<th class="ap-game">Game</th>` : ""}<th title="The model's chance, as the price it would be fair to pay, and the payout (total back per $1) that price means">Fair price</th><th title="What $20 costs per share on Polymarket now, and what it pays back per $1">Polymarket</th><th title="Fair price minus Polymarket's, in cents; below it, the expected profit per $1 if the model is right">Edge</th><th title="Pressure test: Verified, Caution or Flagged, and the edge left after the checks">Check</th></tr></thead>
      <tbody>${rows.map((l, i) => underRow(l, i, gameCol ? gameCol(l) : "")).join("")}</tbody></table></div>`;
  }
  // checked rows in one list, best first by the edge left after the checks; flagged ones stay in,
  // marked with their likely issue
  function underLists(rows, gameCol = null) {
    const sorted = VET.sort(rows);
    if (!sorted.length) return `<div class="empty">Nothing priced below the model right now.</div>`;
    const n = (lv) => sorted.filter((l) => l.vet?.level === lv).length;
    const counts = sorted.some((l) => l.vet) ? `<div class="muted small vet-counts">${sorted.length} bets priced below the model: ${n("verified")} verified, ${n("caution")} caution, ${n("skip")} flagged (likely issue named under the bet).</div>` : "";
    return counts + underTable(sorted, gameCol);
  }

  function underpricedHtml(list, priced, first = true) {
    const box = (body) => `<div class="lotto${first ? " first" : ""}"><h3>Mispriced props</h3>${body}</div>`;
    if (!priced) return box(`<div class="empty">Single bets where the model's fair price beats Polymarket's show here once Polymarket posts player props for this game (game day for the NBA, up to 4 days before kickoff for the NFL, though NFL props are often posted later).</div>`);
    return box(`<div class="muted small">Single bets where the model's fair price is at least ${Math.round(UNDER_MIN_EDGE * 100)}¢ above Polymarket's, so Polymarket pays more than the bet is worth. Trust the <b>Check</b> column over the raw edge. Click a player's bet (or its <b>Last 10</b> button) to see his last 10 games.</div>
      ${how(`Each line ladder (a spread, a total, one player's stat) is one row: its best-priced line, with the range of lines that are also cheap. Every row can take a $${STAKE} bet near the price shown. The list is mixed: up to two stats per player, one row per side of the game result and per total, and at most four of any one kind of bet. Long shots under ${Math.round(LOTTO_MAX * 100)}¢ are in Lottery tickets below.<br><br>${VET.RULES}`)}
      ${list.length ? underLists(list) : `<div class="empty">Nothing underpriced right now.</div>`}`);
  }

  // One compact table: the long shots on the left, and a column per group (A-G) on the right with
  // a dot on each leg in it. Clicking a group's letter folds that column away.
  function lotteryHtml({ list, groups }, priced) {
    if (!list.length) return `<div class="lotto"><h3>Lottery tickets</h3><div class="empty">${priced ? "No long shots on Polymarket for this game priced at or below the model's chance with enough depth for $20." : "No long shots to list for this game."}</div></div>`;
    const pct1 = (p) => `${p < 0.01 ? String(+(p * 100).toPrecision(1)) : p < 0.1 ? (p * 100).toFixed(1) : Math.round(p * 100)}%`;
    const L = "ABCDEFG";
    const gh = groups.map((gr, j) => `<th class="lg" data-g="${j}"><button type="button" class="lg-btn" data-lotto-g="${j}" title="Hide or show group ${L[j]}">${L[j]}</button></th>`).join("");
    const rows = list.map((l, i) => `<tr><td class="muted">${i + 1}</td>
      <td class="lt-leg">${TREND.link(l)}${l.q ? ` <span class="badge q">${esc(l.q)}</span>` : ""}</td>
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
          ? "Polymarket long shots at 4–30¢, priced at or below the model's chance, best value first. Most of these lose; bet small."
          : "Preview: each regular's big-night line on Polymarket's own ladder. Only buy one priced at or below its chance here once prices are posted."}</div>
        <div class="table-wrap"><table class="lotto-t">
          <thead><tr><th>#</th><th class="lt-leg">Leg</th><th>Model</th>${priced ? "<th>Price</th><th>Pays</th>" : "<th>Break-even</th>"}${groups.length ? `<th class="lg-gap"></th>` : ""}${gh}</tr></thead>
          <tbody>${rows}${foot}</tbody>
        </table></div>
        ${groups.length ? `<div class="small muted">Lettered columns (A–G) are small groups that tend to hit on the same night, so a group hits more often than its chances multiplied. Bet a group as its own parlay, never all ten together. Click a letter to fold its column.</div>` : `<div class="small muted">None of these move together strongly enough to suggest a group.</div>`}
      </div>`;
  }

  function head(status, canRefresh) {
    return `<div class="panel-head"><h2>Polymarket bets for this game</h2>${canRefresh ? `<button type="button" class="btn" data-pm-refresh>Refresh prices</button>` : ""}</div><div class="muted small status">${status}</div>`;
  }
  // a fold-away explanation, so the rules are there when wanted and out of the way otherwise
  const how = (body, label = "How these are picked") => `<details class="how"><summary>${label}</summary><div>${body}</div></details>`;

  return { underpriced, underLists, pull, STAKE, UNDER_MIN_EDGE, LOTTO_MAX, MIN_THEME, render, clear, pullWindow, parseMarket, simulate, joint, stories, themed, pack, popcount, and, how, legsFromModel, legsFromMarkets, priceBooks, eventMatches, N };
})();
