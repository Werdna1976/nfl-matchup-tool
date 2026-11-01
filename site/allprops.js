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
    // each row pressure-tested (vet.js) against its own game's markets
    info.rows = BASKETS.underpriced(legs, (l) => VET.grade(l, { A, g, legs })).map((l) => ({ ...l, gi: info }));
    info.status = `${info.rows.filter((l) => l.vet.level !== "skip").length} passed checks${rec.src === "saved" ? " (saved prices)" : ""}`;
    info.ok = true;
    return info;
  }

  // the cross-game list: the most edge left after the checks first, capped per game and per
  // kind of bet. Skips aren't in it; they're listed apart.
  function best(all, n = SHOWN) {
    const kindOf = (l) => (l.kind === "player" ? `${l.key}|${l.side}` : l.kind === "total" ? "total" : "result");
    const byGame = new Map(), byKind = new Map(), out = [];
    for (const r of VET.sort(all.filter((l) => l.vet?.level !== "skip"))) {
      if (out.length >= n) break;
      const ng = byGame.get(r.gi) || 0, nk = byKind.get(kindOf(r)) || 0;
      if (ng >= PER_GAME || nk >= PER_KIND) continue;
      out.push(r); byGame.set(r.gi, ng + 1); byKind.set(kindOf(r), nk + 1);
    }
    return out;
  }

  const gameCell = (l) => `<td class="ap-game"><button type="button" class="linkish" data-open="${esc(l.gi.g.id)}" title="Open this game">${esc(l.gi.match)}</button><div class="muted small">${l.gi.dayTxt} ${esc(clock(l.gi.when))}</div></td>`;

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
    const intro = `<div class="muted small vet-rules">${VET.RULES}</div><div class="muted small">Single bets where Polymarket's ask is below the model's chance by at least ${Math.round(BASKETS.UNDER_MIN_EDGE * 100)}¢, pulled from every ${esc(sport)} game today and tomorrow. Same rules as each game's Underpriced props section: real listed lines only, each takes a $${BASKETS.STAKE} bet near the price shown, one row per line ladder, long shots under ${Math.round(BASKETS.LOTTO_MAX * 100)}¢ left out. Player props show the player's team in brackets. Click a game to open it.</div>`;
    const sorter = `<div class="ap-sort"><span class="muted small">Order:</span>
      <button type="button" class="chip" data-ap-sort="best" aria-pressed="${sortMode === "best"}">Best first</button>
      <button type="button" class="chip" data-ap-sort="game" aria-pressed="${sortMode === "game"}">By game</button></div>`;

    // the price-history check needs the network, so run it only on rows that could be shown
    let body;
    if (!all.length) body = `<div class="empty">${blocked ? "No prices to compare: Polymarket is blocked here." : "Nothing underpriced right now. Polymarket posts NBA player props late (often only on game day), so check back closer to the start."}</div>`;
    else if (sortMode === "game") {
      await VET.drift(all);
      if (el._apToken !== token) return;
      body = infos.filter((i) => i.rows.length).map((i) => `<div class="ap-gamehead"><button type="button" class="linkish" data-open="${esc(i.g.id)}"><b>${esc(i.match)}</b></button> <span class="muted small">${i.dayTxt} ${esc(clock(i.when))} · ${i.rows.length} underpriced, ${i.rows.filter((l) => l.vet?.level === "verified").length} verified</span></div>${BASKETS.underLists(i.rows)}`).join("");
    } else {
      const skipped = VET.sort(all.filter((l) => l.vet?.level === "skip")).slice(0, 20);
      await VET.drift([...best(all, Math.round(SHOWN * 1.5)), ...skipped]);
      if (el._apToken !== token) return;
      const top = best(all), skip = VET.sort(all.filter((l) => l.vet?.level === "skip")).slice(0, 20);
      const nv = top.filter((l) => l.vet.level === "verified").length;
      body = `<div class="note">${nv} verified, ${top.length - nv} caution${skip.length ? `, ${all.filter((l) => l.vet?.level === "skip").length} failed the checks` : ""}. Ordered by the edge left after the checks, not the raw edge.</div>`
        + BASKETS.underLists([...top, ...skip], gameCell)
        + (all.length - skip.length > top.length ? `<div class="note">Showing the best ${top.length} that passed, with at most ${PER_GAME} per game and ${PER_KIND} of any one kind of bet so the list stays spread out. "By game" shows them all.</div>` : "");
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
