"use strict";

// Best underpriced props across every game today and tomorrow, shared by the NFL and NBA pages.
//
// Each game is pulled from Polymarket the same way its own "Underpriced props" section is
// (BASKETS.pull + legsFromMarkets + underpriced): real listed lines, $20 of depth near the ask,
// one row per line ladder. Then the games are merged into one list, biggest edge first, and
// spread out so no single game or kind of bet fills the page.
//
// The page passes { games, adapter(g), onOpen(gameId), sport }.

const ALLPROPS = (() => {
  const SHOWN = 40;          // rows in the "best first" list
  const PER_GAME = 6;        // at most this many from one game in that list
  const PER_KIND = 4;        // and at most this many of one kind of bet (say, rebounds unders)
  const POOL = 3;            // games pulled at once
  const REPRICE_MS = 2 * 60 * 1000;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${p < 0.1 ? (p * 100).toFixed(1) : Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  let sortMode = "best";
  try { sortMode = localStorage.getItem("allPropsSort") || "best"; } catch (e) { /* private mode */ }

  // run fn over items, a few at a time
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  // one game: its status line and its underpriced rows, each tagged with the game
  async function scan(g, A, today) {
    const day = A.gameDay(g), when = A.kickoff(g);
    const info = { g, A, day, when, dayTxt: day === today ? "Today" : "Tomorrow", match: `${g.away} @ ${g.home}`, rows: [] };
    const win = BASKETS.pullWindow(A, g);
    if (!win.open) { info.status = A.isLive(g) ? "under way" : A.isPost(g) ? "over" : "prices not pulled yet"; info.why = win.why; return info; }
    const rec = await BASKETS.pull(A, g);
    info.rec = rec;
    const priced = rec.markets.some((m) => m.kind === "player");
    if (rec.src === "blocked") { info.status = "Polymarket unreachable"; return info; }
    if (!priced) { info.status = "no player props posted yet"; return info; }
    const legs = BASKETS.legsFromMarkets(A, g, rec.markets);
    info.rows = BASKETS.underpriced(legs).map((l) => ({ ...l, gi: info }));
    info.status = `${info.rows.length} underpriced${rec.src === "saved" ? " (saved prices)" : ""}`;
    info.ok = true;
    return info;
  }

  // the cross-game list: biggest edge first, capped per game and per kind of bet
  function best(all) {
    const kindOf = (l) => (l.kind === "player" ? `${l.key}|${l.side}` : l.kind === "total" ? "total" : "result");
    const byGame = new Map(), byKind = new Map(), out = [];
    for (const r of [...all].sort((a, b) => b.edge - a.edge)) {
      if (out.length >= SHOWN) break;
      const ng = byGame.get(r.gi) || 0, nk = byKind.get(kindOf(r)) || 0;
      if (ng >= PER_GAME || nk >= PER_KIND) continue;
      out.push(r); byGame.set(r.gi, ng + 1); byKind.set(kindOf(r), nk + 1);
    }
    return out;
  }

  function row(l, i, showGame) {
    const gi = l.gi;
    const bet = `${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l.label)}${l.q || l.flags.length ? `<div class="tags">${[l.q, ...l.flags].filter(Boolean).map((f) => `<span class="badge q">${esc(f)}</span>`).join(" ")}</div>` : ""}${l.range ? `<div class="muted small">${esc(l.range)}</div>` : ""}`;
    const game = showGame ? `<td class="ap-game"><button type="button" class="linkish" data-open="${esc(gi.g.id)}" title="Open this game">${esc(gi.match)}</button><div class="muted small">${gi.dayTxt} ${esc(clock(gi.when))}</div></td>` : "";
    return `<tr><td class="muted">${i + 1}</td><td class="lt-leg">${bet}</td>${game}
      <td><b>${pct(l.p)}</b></td><td>${cents(l.price)}${l.bid != null ? `<div class="muted small">bid ${cents(l.bid)}</div>` : ""}</td>
      <td class="edge-good">+${Math.round(l.edge * 100)}</td><td class="edge-good">+${Math.round((l.p / l.price - 1) * 100)}%</td></tr>`;
  }

  function table(rows, showGame) {
    return `<div class="table-wrap"><table class="lotto-t under-t ap-t">
      <thead><tr><th>#</th><th class="lt-leg">Bet</th>${showGame ? `<th class="ap-game">Game</th>` : ""}<th>Model</th><th>Price</th><th title="Model chance minus price, in cents">Edge</th><th title="Expected profit per $1 if the model is right">Return</th></tr></thead>
      <tbody>${rows.map((l, i) => row(l, i, showGame)).join("")}</tbody></table></div>`;
  }

  async function render(el, { games, adapter, onOpen, sport }) {
    const token = (el._apToken = {});
    const now = Date.now(), today = etDay(now), tomorrow = addDays(today, 1);
    const list = games.map((g) => ({ g, A: adapter(g) }))
      .filter(({ g, A }) => [today, tomorrow].includes(A.gameDay(g)) && !A.isPost(g))
      .sort((x, y) => x.A.kickoff(x.g) - y.A.kickoff(y.g));
    const head = (status, canRefresh) => `<div class="panel-head"><h2>Best underpriced props · ${esc(sport)} today and tomorrow</h2><span class="muted small">${status}</span>${canRefresh ? `<button type="button" class="btn" data-ap-refresh>Refresh prices</button>` : ""}</div>`;
    if (!list.length) { el.innerHTML = head("") + `<div class="empty">No ${esc(sport)} games left today or tomorrow.</div>`; return; }
    if (!el.dataset.apShown) el.innerHTML = head(`Pulling Polymarket prices for ${list.length} game${list.length > 1 ? "s" : ""}…`) + `<div class="empty">Checking each game's markets. This takes a few seconds.</div>`;

    const infos = await pool(list, POOL, ({ g, A }) => scan(g, A, today).catch(() => ({ g, A, day: A.gameDay(g), when: A.kickoff(g), dayTxt: A.gameDay(g) === today ? "Today" : "Tomorrow", match: `${g.away} @ ${g.home}`, rows: [], status: "couldn't check" })));
    if (el._apToken !== token) return;   // a newer render took over
    el.dataset.apShown = "1";

    const all = infos.flatMap((i) => i.rows);
    const checked = infos.filter((i) => i.rec);
    const blocked = checked.length && checked.every((i) => i.rec.src === "blocked");
    const newest = Math.max(0, ...checked.map((i) => i.rec.t || 0));
    const status = blocked ? "Couldn't reach Polymarket from this computer (it may be blocked on this network)."
      : checked.length ? `Polymarket prices as of <b>${clock(newest)}</b> (updates every 2 minutes) · ${infos.filter((i) => i.ok).length} of ${infos.length} games have props posted`
      : "No game's prices are open yet.";

    const chips = infos.map((i) => `<button type="button" class="note-chip ap-chip ${i.rows.length ? "good" : ""}" data-open="${esc(i.g.id)}" title="${esc(i.why || "Open this game")}"><b>${esc(i.match)}</b> ${i.dayTxt} ${esc(clock(i.when))} · ${esc(i.status)}</button>`).join("");
    const intro = `<div class="muted small">Single bets where Polymarket's ask is below the model's chance by at least ${Math.round(BASKETS.UNDER_MIN_EDGE * 100)}¢, pulled from every ${esc(sport)} game today and tomorrow. Same rules as each game's Underpriced props section: real listed lines only, each takes a $${BASKETS.STAKE} bet near the price shown, one row per line ladder, long shots under ${Math.round(BASKETS.LOTTO_MAX * 100)}¢ left out. Player props show the player's team in brackets. Click a game to open it.</div>`;
    const sorter = `<div class="ap-sort"><span class="muted small">Order:</span>
      <button type="button" class="chip" data-ap-sort="best" aria-pressed="${sortMode === "best"}">Best first</button>
      <button type="button" class="chip" data-ap-sort="game" aria-pressed="${sortMode === "game"}">By game</button></div>`;

    let body;
    if (!all.length) body = `<div class="empty">${blocked ? "No prices to compare: Polymarket is blocked here." : "Nothing underpriced right now. Polymarket posts NBA player props late (often only on game day), so check back closer to the start."}</div>`;
    else if (sortMode === "game") body = infos.filter((i) => i.rows.length).map((i) => `<div class="ap-gamehead"><button type="button" class="linkish" data-open="${esc(i.g.id)}"><b>${esc(i.match)}</b></button> <span class="muted small">${i.dayTxt} ${esc(clock(i.when))} · ${i.rows.length} underpriced</span></div>${table(i.rows, false)}`).join("");
    else {
      const top = best(all);
      body = table(top, true) + (all.length > top.length ? `<div class="note">Showing the best ${top.length} of ${all.length}, with at most ${PER_GAME} per game and ${PER_KIND} of any one kind of bet so the list stays spread out. "By game" shows them all.</div>` : "");
    }

    el.innerHTML = head(status, true) + `<div class="ap-chips note-chips">${chips}</div>` + intro + sorter + body;
    el.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => onOpen(b.dataset.open)));
    el.querySelectorAll("[data-ap-sort]").forEach((b) => (b.onclick = () => {
      sortMode = b.dataset.apSort;
      try { localStorage.setItem("allPropsSort", sortMode); } catch (e) { /* private mode */ }
      render(el, { games, adapter, onOpen, sport });
    }));
    const again = () => { BASKETS.clear(); render(el, { games, adapter, onOpen, sport }); };
    const rb = el.querySelector("[data-ap-refresh]");
    if (rb) rb.onclick = again;
    clearTimeout(el._apTimer);
    el._apTimer = setTimeout(() => { if (el.isConnected && el._apToken === token) again(); }, REPRICE_MS);
  }

  return { render, best };
})();
