"use strict";

// Leaders view, shared by the NFL and NBA pages: who finishes on top of the slate in one stat
// (most passing yards this week, most points tonight), with each player's chance.
//
// Winning a leader market takes a big game, not a good average. A steady 270-yard passer loses
// most weeks to whichever gunslinger has his 380-yard day, so the chances come from simulating
// the whole slate, not from ranking projections:
//
// 1. Every game is simulated with the same engine as the game pages (BASKETS.simulate), so a
//    QB and his receivers, or two scorers sharing one ball, move together the way they have
//    in past seasons. Games are independent of one another.
// 2. Each player's draw is turned into a stat line on his own projected range, rounded to
//    whole numbers. Games that are over count with the real box score.
// 3. In each simulated slate the top number wins; ties are split (a dead heat), which is how
//    most books settle them. Polymarket rules vary, so read the market's own rules.
//
// Polymarket's leader markets ("most passing yards", "points leader") are looked up when the
// browser can reach Polymarket; when none is listed, the model's fair price is shown instead.
//
// The page passes { sport, league, scopes, cats, adapter(g), cdf(x, d), actual(pid, g, key),
// gameText(g), whenText(g), onOpen(gameId), env(g, team) }.

const LEADERS = (() => {
  const GAMMA = "https://gamma-api.polymarket.com";
  const SHOWN = 15;          // rows before "show all"
  const CACHE_MS = 90 * 1000;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => (p <= 0 ? "–" : p < 0.005 ? "<0.5%" : p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`);
  const cents = (p) => (p < 0.01 ? "<1¢" : `${Math.round(p * 100)}¢`);
  const american = (p) => (p <= 0 || p >= 1 ? "–" : p >= 0.5 ? `${Math.round(-100 * p / (1 - p))}` : `+${Math.round(100 * (1 - p) / p)}`);
  const ordn = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");
  const squash = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameKey = (s) => squash(String(s || "").replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, ""));
  const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
  const arr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || "[]"); } catch (e) { return []; } };

  const view = { scope: null, cat: null, all: false };
  const SIMS = new Map();    // scope|cat -> result, so flipping between tabs is instant

  // ---------------------------------------------------------------- one player's range as numbers

  // The inverse of his projected range: a chance u (0-1) -> his stat. Counts step through whole
  // numbers; yardage and points use a fine grid. Built once per player and stat.
  function inverse(d, cdf) {
    const count = d.dist === "poisson" || d.dist === "negbin";
    if (count) {
      const c = []; let k = 0;
      while (k < 400) { c.push(cdf(k, d)); if (c[k] > 0.99995) break; k++; }
      return (u) => { let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] >= u) hi = m; else lo = m + 1; } return lo; };
    }
    const lo0 = d.dist === "normal" ? d.mean - 7 * d.sd : 0;
    let hi0 = d.mean + 8 * Math.max(d.sd, 1);
    while (cdf(hi0, d) < 0.9999 && hi0 < d.mean * 50 + 100) hi0 *= 1.5;
    const n = 400, xs = new Float64Array(n + 1), cs = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) { xs[i] = lo0 + (hi0 - lo0) * i / n; cs[i] = cdf(xs[i], d); }
    return (u) => {
      if (u <= cs[0]) return xs[0];
      let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cs[m] < u) lo = m; else hi = m; }
      const span = cs[hi] - cs[lo];
      return xs[lo] + (span > 0 ? (u - cs[lo]) / span : 0) * (xs[hi] - xs[lo]);
    };
  }

  // ---------------------------------------------------------------- the slate simulation

  function simulateSlate(O, scope, cat) {
    cat = { ...cat, tail: O.tailOverride?.[cat.key] ?? cat.tail };
    const N = BASKETS.N, rows = [], notes = [];
    let liveGames = 0, missingBox = 0;
    for (const g of scope.games) {
      const A = O.adapter(g), st = RESULT.state(g);
      if (st === "in") liveGames++;
      const field = A.roster(g).filter((pl) => !pl.skip && pl.d[cat.key] && pl.d[cat.key].mean >= cat.floor && (!cat.pos || cat.pos.includes(pl.pos)));
      // a finished game counts with its real numbers, once the box score is in
      if (st === "post") {
        const done = field.map((pl) => ({ pl, v: O.actual(pl.pid, g, cat.key) }));
        if (done.some((x) => x.v != null)) {
          // anyone else on those teams who had a big day counts too, not just the projected field
          const extra = (O.extraActual?.(g, cat.key) || []).filter((x) => !done.some((y) => y.pl.pid === x.pid));
          for (const { pl, v } of done) rows.push({ pl, g, A, fixed: v ?? 0, vals: null });
          for (const x of extra) rows.push({ pl: { pid: x.pid, name: x.name, team: x.team, pos: x.pos, d: {} }, g, A, fixed: x.v, vals: null });
          continue;
        }
        missingBox++;
      }
      if (!field.length) continue;
      const legs = field.map((pl) => ({ kind: "player", pid: pl.pid, key: cat.key, side: "over", p: 0.5, team: pl.team, line: 0 }));
      BASKETS.simulate(A, g, legs);
      legs.forEach((leg, j) => {
        // the model's top tail runs a little long for leader purposes (see cat.tail on the page), so
        // results above his median are pulled in by that factor
        const pl = field[j], raw = inverse(pl.d[cat.key], O.cdf), med = raw(0.5), t = cat.tail ?? 1;
        const inv = (u) => { const v = raw(u); return v > med ? med + t * (v - med) : v; };
        // his draws in order -> evenly spaced chances -> stat values on his own range
        const order = Array.from(leg.lat.keys()).sort((a, b) => leg.lat[a] - leg.lat[b]);
        const vals = new Float64Array(N);
        order.forEach((i, r) => { vals[i] = Math.round(inv((r + 0.5) / N)); });
        rows.push({ pl, g, A, fixed: null, vals, inv });
      });
    }
    if (!rows.length) return { rows: [], notes, liveGames, missingBox };

    // who's on top in each simulated slate (ties split)
    const win = new Float64Array(rows.length), top = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let best = -Infinity, k = 0;
      for (let j = 0; j < rows.length; j++) {
        const v = rows[j].vals ? rows[j].vals[i] : rows[j].fixed;
        if (v > best) { best = v; k = 1; } else if (v === best) k++;
      }
      top[i] = best;
      for (let j = 0; j < rows.length; j++) if ((rows[j].vals ? rows[j].vals[i] : rows[j].fixed) === best) win[j] += 1 / k;
    }
    const topSorted = Float64Array.from(top).sort();
    const tq = (q) => topSorted[Math.min(N - 1, Math.floor(q * N))];
    const out = rows.map((r, j) => {
      const d = r.pl.d[cat.key];
      const q = (u) => (r.vals ? r.inv(u) : r.fixed);
      const mean = r.vals ? d.mean : r.fixed;
      const p50 = q(0.5), p90 = q(0.9), p97 = q(0.97);
      // how often he reaches the number that usually wins
      let reach = 0;
      if (r.vals) { for (let i = 0; i < N; i++) if (r.vals[i] >= tq(0.5)) reach++; reach /= N; } else reach = r.fixed >= tq(0.5) ? 1 : 0;
      return { ...r, p: win[j] / N, mean, p50, p90, p97, reach, cv: r.vals ? (p90 - p50) / Math.max(mean, 1e-6) : 0 };
    }).sort((a, b) => b.p - a.p || b.mean - a.mean);
    // ranks by projection and by ceiling, for the notes
    const live = out.filter((r) => r.vals);
    [...out].sort((a, b) => b.mean - a.mean).forEach((r, i) => { r.meanRank = i + 1; });
    [...out].sort((a, b) => b.p90 - a.p90).forEach((r, i) => { r.ceilRank = i + 1; });
    out.forEach((r, i) => { r.winRank = i + 1; });
    // volatility is judged among the real contenders (top 20 by projection), not against bench
    // players whose every good game looks like a spike
    const cvs = live.filter((r) => r.meanRank <= 20).map((r) => r.cv).sort((a, b) => a - b);
    const cvAt = (q) => cvs[Math.min(cvs.length - 1, Math.floor(q * cvs.length))] ?? 0;
    for (const r of live) r.swing = r.cv >= cvAt(0.67) ? "high" : r.cv <= cvAt(0.33) ? "low" : "mid";
    return { rows: out, win: { p10: tq(0.1), p50: tq(0.5), p90: tq(0.9) }, liveGames, missingBox };
  }

  // ---------------------------------------------------------------- notes on ceiling and volatility

  function noteFor(r, res, O, cat) {
    const n = [], u = cat.unit;
    if (!r.vals) return [`Done: ${Math.round(r.fixed)} ${u} (${O.whenText(r.g)})`];
    const gap = r.meanRank - r.winRank;
    if (gap >= 3) n.push(`Upside pick: ${ordn(r.meanRank)} by projection but ${ordn(r.winRank)} to lead, because his range is wide`);
    else if (gap <= -3) n.push(`Steady, not explosive: ${ordn(r.meanRank)} by projection but only ${ordn(r.winRank)} to lead`);
    if (r.ceilRank <= 3) n.push(`${r.ceilRank === 1 ? "Highest" : `${ordn(r.ceilRank)}-highest`} ceiling on the slate (1 game in 10: ${Math.round(r.p90)}+)`);
    if (r.swing === "high" && gap > -3) n.push("Boom-or-bust: big spread between his usual and his best games");
    else if (r.swing === "low" && r.winRank <= 8 && r.ceilRank > 3 && gap > -3) n.push("Low volatility: reliable, but leaders usually need a spike");
    if (r.reach >= 0.2 && r.winRank > 5) n.push(`Gets to ${Math.round(res.win.p50)}+ in ${pct(r.reach)} of games`);
    const env = O.env?.(r.g, r.pl.team, cat.key, res.rows);
    if (env) n.push(env);
    const inj = r.pl.q;
    if (inj) n.push(`${inj}: check his status before betting`);
    if (RESULT.state(r.g) === "in") n.push("Game under way: odds are pre-game");
    return n.slice(0, 3);
  }

  // ---------------------------------------------------------------- Polymarket leader markets

  let PM = { t: 0, events: null, err: null, league: null };
  async function pmEvents(league) {
    if (PM.league === league && Date.now() - PM.t < CACHE_MS) return PM;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
    try {
      const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      const r = await fetch(`${GAMMA}/events?tag_slug=${league}&closed=false&limit=500&end_date_min=${since}T00:00:00Z`, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      PM = { t: Date.now(), events: Array.isArray(j) ? j : [], err: null, league };
    } catch (e) { PM = { t: Date.now(), events: null, err: String(e.message || e), league }; }
    finally { clearTimeout(t); }
    return PM;
  }
  // A leader market for this stat and this slate: "most"/"leader" plus the stat's words, ending
  // within a few days of the slate (season-long leader markets are left out).
  function pmPrices(events, scope, cat, rows) {
    if (!events) return null;
    const start = Date.parse(`${scope.first}T00:00:00Z`), end = Date.parse(`${scope.last}T00:00:00Z`) + 3 * 864e5;
    const names = new Map(rows.map((r) => [nameKey(r.pl.name), r]));
    const found = new Map(); let ev = null;
    for (const e of events) {
      const etext = `${e.title || ""} ${e.slug || ""}`;
      for (const m of e.markets || []) {
        const text = `${etext} ${m.question || ""}`;
        if (!/\b(most|leader|leads?|highest)\b/i.test(text) || !cat.pm.test(text) || (cat.pmNot && cat.pmNot.test(text))) continue;
        if (/season|mvp|award|career|record\b.*all-time/i.test(text)) continue;
        const endT = Date.parse(m.endDate || e.endDate || "");
        if (isNaN(endT) || endT < start || endT > end) continue;
        const who = m.groupItemTitle || (String(m.question || "").match(/^Will (.+?) (?:have|record|lead|finish|throw|rush|score|get)\b/i) || [])[1];
        const r = names.get(nameKey(who));
        if (!r || m.closed) continue;
        const prices = arr(m.outcomePrices).map(Number);
        const ask = num(m.bestAsk) ?? prices[0], bid = num(m.bestBid);
        if (ask == null || ask <= 0 || ask >= 1) continue;
        found.set(r, { ask, bid, url: `https://polymarket.com/event/${e.slug}` });
        ev = e;
      }
    }
    return found.size ? { found, url: ev ? `https://polymarket.com/event/${ev.slug}` : null, title: ev?.title } : { found };
  }

  // ---------------------------------------------------------------- page

  function table(res, O, cat, pm) {
    const rows = view.all ? res.rows : res.rows.filter((r) => r.p >= 0.003).slice(0, SHOWN);
    const swingTxt = { high: "High", mid: "Medium", low: "Low" };
    const hasPm = pm && pm.found && pm.found.size;
    const body = rows.map((r) => {
      const q = pm?.found?.get(r);
      const edge = q ? r.p - q.ask : null;
      return `<tr>
        <td class="ld-name"><b>${esc(r.pl.name)}</b> <span class="pos-tag">${esc(r.pl.pos || "")} ${esc(r.pl.team)}</span>
          <div class="muted small"><button type="button" class="linkish" data-open="${esc(r.g.id)}">${esc(O.gameText(r.g))}</button> · ${esc(O.whenText(r.g))}</div></td>
        <td>${r.vals ? Math.round(r.mean) : `<b>${Math.round(r.fixed)}</b>`}</td>
        <td>${r.vals ? `${Math.round(r.p90)}<span class="muted small"> / ${Math.round(r.p97)}</span>` : "final"}</td>
        <td>${r.vals ? `<span class="ld-swing ${r.swing}">${swingTxt[r.swing]}</span>` : ""}</td>
        <td><b>${pct(r.p)}</b></td>
        <td>${r.p > 0.001 ? `${cents(r.p)} <span class="muted small">(${american(r.p)})</span>` : "–"}</td>
        ${hasPm ? `<td>${q ? `<a href="${esc(q.url)}" target="_blank" rel="noopener">${cents(q.ask)}</a>` : "–"}</td><td class="${edge == null ? "" : edge >= 0.02 ? "edge-good" : edge <= -0.02 ? "edge-bad" : ""}">${edge == null ? "" : `${edge >= 0 ? "+" : ""}${Math.round(edge * 100)}¢`}</td>` : ""}
        <td class="ld-notes small">${noteFor(r, res, O, cat).map(esc).join("<br>")}</td>
      </tr>`;
    }).join("");
    const more = res.rows.length > rows.length || view.all
      ? `<button type="button" class="btn" data-ld-all>${view.all ? "Show the top only" : `Show all ${res.rows.length}`}</button>` : "";
    return `<div class="ld-scroll"><table class="ld-t">
      <thead><tr><th>Player</th><th title="Projected average">Proj</th><th title="What he reaches 1 game in 10 / 1 game in 33">Ceiling<span class="muted small"> 90th / 97th</span></th><th title="How far his good games run above his usual one, compared with the rest of this field">Volatility</th>
        <th title="Chance he finishes first across the slate (ties split)">Chance to lead</th><th title="The price that breaks even on the model's chance">Fair price</th>
        ${hasPm ? `<th>Polymarket</th><th title="Model chance minus Polymarket's ask">Edge</th>` : ""}<th>Notes</th></tr></thead>
      <tbody>${body}</tbody></table></div>${more}`;
  }

  async function render(el, O) {
    if (!O.scopes.length) { el.innerHTML = `<div class="panel-head"><h2>Leaders · ${esc(O.sport)}</h2></div><div class="empty">No games in this ${O.sport === "NFL" ? "week" : "day"}.</div>`; return; }
    if (!O.scopes.find((s) => s.id === view.scope)) view.scope = O.scopes[0].id;
    if (!O.cats.find((c) => c.key === view.cat)) view.cat = O.cats[0].key;
    const scope = O.scopes.find((s) => s.id === view.scope), cat = O.cats.find((c) => c.key === view.cat);
    const key = `${O.sport}|${scope.id}|${scope.games.map((g) => g.id + RESULT.state(g)).join(",")}|${cat.key}`;
    if (!SIMS.has(key)) {
      el.innerHTML = head(O, scope, cat) + `<div class="empty">Simulating ${scope.games.length} game${scope.games.length > 1 ? "s" : ""}…</div>`;
      await new Promise((r) => setTimeout(r, 20));   // let the page paint first
      SIMS.set(key, simulateSlate(O, scope, cat));
    }
    const res = SIMS.get(key);
    const pmRaw = await pmEvents(O.league);
    const pm = pmPrices(pmRaw.events, scope, cat, res.rows);
    const pmLine = pmRaw.events == null
      ? "Polymarket is blocked here, so prices below are the model's fair prices only."
      : pm?.found?.size ? `Polymarket prices from <a href="${esc(pm.url)}" target="_blank" rel="noopener">${esc(pm.title || "its leader market")}</a> (the ask, what Yes costs now).`
        : `No Polymarket leader market found for ${esc(cat.label.toLowerCase())} on this slate, so prices below are the model's fair prices. When one is listed it shows up here.`;
    const allDone = res.rows.length && res.rows.every((r) => !r.vals);
    const winLine = allDone
      ? `Final: ${esc(res.rows[0].pl.name)} led with <b>${Math.round(res.rows[0].fixed)} ${esc(cat.unit)}</b>.`
      : res.rows.length
      ? `It usually takes <b>${Math.round(res.win.p50)} ${esc(cat.unit)}</b> to lead${scope.games.length > 1 ? ` ${esc(scope.span)}` : ""} (8 slates in 10: ${Math.round(res.win.p10)}–${Math.round(res.win.p90)}).`
      : "";
    const warn = [res.liveGames ? `${res.liveGames} game${res.liveGames > 1 ? "s are" : " is"} under way; the odds for those players are still pre-game.` : "",
      res.missingBox ? `${res.missingBox} finished game${res.missingBox > 1 ? "s" : ""} without a box score in the data yet, so ${res.missingBox > 1 ? "they count" : "it counts"} as if not played.` : ""].filter(Boolean).join(" ");
    el.innerHTML = head(O, scope, cat)
      + `<div class="muted small ld-sum">${winLine} ${pmLine}</div>`
      + (warn ? `<div class="warnbox">${esc(warn)}</div>` : "")
      + (res.rows.length ? table(res, O, cat, pm) : `<div class="empty">No players projected for this stat.</div>`)
      + how(O);
    el.querySelectorAll("[data-ld-scope]").forEach((b) => b.onclick = () => { view.scope = b.dataset.ldScope; view.all = false; render(el, O); });
    el.querySelectorAll("[data-ld-cat]").forEach((b) => b.onclick = () => { view.cat = b.dataset.ldCat; view.all = false; render(el, O); });
    el.querySelectorAll("[data-ld-all]").forEach((b) => b.onclick = () => { view.all = !view.all; render(el, O); });
    el.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => O.onOpen(b.dataset.open));
  }

  function head(O, scope, cat) {
    return `<div class="panel-head"><h2>🏆 Leaders · ${esc(O.title)}</h2><span class="muted small">Who finishes on top, and who has the upside to get there</span></div>
      <div class="ld-bar">${O.scopes.length > 1 ? O.scopes.map((s) => `<button type="button" class="chip" data-ld-scope="${esc(s.id)}" aria-pressed="${s.id === scope.id}">${esc(s.label)}</button>`).join("") : ""}</div>
      <div class="ld-bar">${O.cats.map((c) => `<button type="button" class="chip" data-ld-cat="${esc(c.key)}" aria-pressed="${c.key === cat.key}">${esc(c.label)}</button>`).join("")}</div>`;
  }

  function how(O) {
    return `<details class="how"><summary>How these are figured</summary><div>
      Each game on the slate is simulated ${BASKETS.N.toLocaleString()} times with the same engine as the game pages, so teammates
      move together the way they have in past seasons (${O.sport === "NFL" ? "a QB's big day lifts his receivers; two backs split carries" : "two starters split shots; starters sit in blowouts"}).
      Each player's result comes from his own projected range, and whoever has the top number in a simulated slate wins it (ties are split).
      Finished games count with their real box score.<br><br>
      <b>Why ceiling matters more than average:</b> the leader is whoever has the best game, and the best game on a slate is
      almost always someone's top-10% day. A player with a wide range wins more often than his average suggests; a steady one
      wins less. <b>Ceiling</b> is what he reaches 1 game in 10 (and 1 in 33). <b>Volatility</b> compares how far his good games
      run above his usual one with the rest of this field. "Upside pick" means his chance to lead ranks well above his projection.<br><br>
      <b>Fair price</b> is the price that breaks even on the model's chance (cents, and American odds). Ties: most books pay a dead
      heat (stake split); check the market's own rules before betting. Injured players listed Out or Doubtful are left out;
      Questionable players are counted as playing and flagged.
    </div></details>`;
  }

  return { render, simulateSlate, pmPrices, clear: () => SIMS.clear() };
})();
