"use strict";

// ---------------------------------------------------------------- stat definitions

const STATS = {
  att: { label: "Pass attempts", short: "Att", dec: 1 },
  cmp: { label: "Completions", short: "Cmp", dec: 1 },
  pyd: { label: "Passing yards", short: "Pass yds", dec: 0 },
  ptd: { label: "Passing TDs", short: "Pass TD", dec: 2, count: true },
  int: { label: "Interceptions", short: "INT", dec: 2, count: true },
  car: { label: "Rush attempts", short: "Rush att", dec: 1 },
  ryd: { label: "Rushing yards", short: "Rush yds", dec: 0 },
  rtd: { label: "Rushing TDs", short: "Rush TD", dec: 2, count: true },
  tgt: { label: "Targets", short: "Tgt", dec: 1 },
  rec: { label: "Receptions", short: "Rec", dec: 1 },
  yds: { label: "Receiving yards", short: "Rec yds", dec: 0 },
  td: { label: "Receiving TDs", short: "Rec TD", dec: 2, count: true },
};
const POS_STATS = {
  QB: ["att", "cmp", "pyd", "ptd", "int", "car", "ryd"],
  RB: ["car", "ryd", "rtd", "tgt", "rec", "yds"],
  WR: ["tgt", "rec", "yds", "td"],
  TE: ["tgt", "rec", "yds", "td"],
};
// the props worth betting, by position, for the alt-line finder
const FEATURED = { QB: ["att", "cmp", "pyd", "ptd"], RB: ["car", "ryd", "rec", "yds"], WR: ["rec", "yds", "td"], TE: ["rec", "yds", "td"] };
const POS_ORDER = ["QB", "RB", "WR", "TE"];

// ---------------------------------------------------------------- probability math (mirrors scripts/model.py)

function erf(x) {
  // Abramowitz-Stegun 7.1.26, max error 1.5e-7
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function lgamma(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function gammaincLower(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let term = 1 / a, sum = term, ap = a;
    for (let i = 0; i < 500; i++) { ap += 1; term *= x / ap; sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-12) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
function poissonCdf(k, lam) {
  if (k < 0) return 0;
  let term = Math.exp(-lam), sum = term;
  for (let i = 1; i <= Math.floor(k); i++) { term *= lam / i; sum += term; }
  return Math.min(1, sum);
}
function cdf(x, p) {
  if (p.dist === "poisson") return poissonCdf(Math.floor(x), p.mean);
  if (p.dist === "normal") return 0.5 * (1 + erf((x - p.mean) / (p.sd * Math.SQRT2)));
  if (p.mean <= 0 || p.sd <= 0) return x >= p.mean ? 1 : 0;
  const shape = (p.mean / p.sd) ** 2, scale = p.sd ** 2 / p.mean;
  return gammaincLower(shape, x / scale);
}
function quantile(q, p) {
  if (p.dist === "poisson") { let k = 0; while (poissonCdf(k, p.mean) < q && k < 50) k++; return k; }
  let lo = p.dist === "normal" ? p.mean - 10 * p.sd : 0, hi = p.mean + 12 * p.sd + 1;
  for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (cdf(m, p) < q) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
// Stats are whole numbers, so a line of 4.5 splits cleanly and a line of 5 can push.
function probs(p, line) {
  const whole = Math.abs(line - Math.round(line)) < 1e-9;
  if (p.dist === "poisson") {
    const under = whole ? poissonCdf(line - 1, p.mean) : poissonCdf(Math.floor(line), p.mean);
    const over = 1 - poissonCdf(Math.floor(line), p.mean);
    return { over, under, push: Math.max(0, 1 - over - under) };
  }
  if (whole) {
    const under = cdf(line - 0.5, p), over = 1 - cdf(line + 0.5, p);
    return { over, under, push: Math.max(0, 1 - over - under) };
  }
  const under = cdf(line, p);
  return { over: 1 - under, under, push: 0 };
}

// ---------------------------------------------------------------- formatting

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (p) => `${Math.round(p * 100)}%`;
const fmt = (v, d = 1) => (v == null || isNaN(v) ? "–" : Number(v).toFixed(d));
const cents = (p) => `${Math.round(p * 100)}¢`;
function american(p) {
  if (p <= 0 || p >= 1) return "–";
  return p >= 0.5 ? `${Math.round(-100 * p / (1 - p))}` : `+${Math.round(100 * (1 - p) / p)}`;
}
const ESPN_LOGO = { WAS: "wsh", LA: "lar" };
const logo = (ab) => `https://a.espncdn.com/i/teamlogos/nfl/500/${ESPN_LOGO[ab] || ab.toLowerCase()}.png`;
function spreadText(g) {
  if (g.spread == null) return "No line";
  if (g.spread === 0) return "Pick'em";
  return g.spread > 0 ? `${g.home} -${g.spread}` : `${g.away} -${-g.spread}`;
}
// nflverse kickoff times are US Eastern; convert them to the viewer's own time zone
function easternOffset(day) {
  const [y, m, d] = day.split("-").map(Number);
  const nthSunday = (month, n) => { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  const t = m * 100 + d, start = 300 + nthSunday(3, 2), end = 1100 + nthSunday(11, 1);
  return t >= start && t < end ? "-04:00" : "-05:00";
}
function kickoff(g) {
  const d = new Date(`${g.day}T${g.time || "13:00"}:00${easternOffset(g.day)}`);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function stability(vals) {
  const n = vals.length;
  if (n < 2) return { cv: null, label: "Too few games", cls: "s3" };
  const m = vals.reduce((a, b) => a + b, 0) / n;
  if (m <= 0) return { cv: null, label: "Rarely used", cls: "s4" };
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  const cv = sd / m;
  if (cv < 0.25) return { cv, sd, label: "Very steady", cls: "s1" };
  if (cv < 0.4) return { cv, sd, label: "Steady", cls: "s2" };
  if (cv < 0.65) return { cv, sd, label: "Swingy", cls: "s3" };
  return { cv, sd, label: "Very swingy", cls: "s4" };
}

// ---------------------------------------------------------------- state

let DATA = null, BACKTEST = null;
const state = { week: null, gameId: null, team: null, pos: "ALL", conf: 0.75, side: "over" };
let slip = [];
try { slip = JSON.parse(localStorage.getItem("slip") || "[]"); } catch (e) { slip = []; }
function saveSlip() { try { localStorage.setItem("slip", JSON.stringify(slip)); } catch (e) { /* private mode */ } renderSlipCount(); }

// ---------------------------------------------------------------- live lines

// The site's data file is rebuilt on a schedule. On top of that, the page asks ESPN
// for the latest spread and total each time it loads. If ESPN is blocked on this
// computer, it uses the last lines it saw here (saved in the browser), else the file's.
const ESPN_TEAM = { WSH: "WAS", LAR: "LA" };
const LINES_KEY = "liveLines";

function applyLine(g, spread, total, src, asOf) {
  g.spread = spread; g.total = total; g.line_src = src; g.lines_asof = asOf;
  const m = g.model;
  m.total.mean = 0.8 * total + 0.2 * m.model_total;
  m.margin.mean = 0.8 * spread + 0.2 * m.model_margin;
  m.home_pts = (m.total.mean + m.margin.mean) / 2;
  m.away_pts = (m.total.mean - m.margin.mean) / 2;
}

async function fetchEspnLines(week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${DATA.season}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const out = {};
    for (const ev of j.events || []) {
      const c = ev.competitions?.[0]; const o = c?.odds?.[0];
      if (!o || o.spread == null || o.overUnder == null) continue;
      const side = {}; for (const t of c.competitors) side[t.homeAway] = ESPN_TEAM[t.team.abbreviation] || t.team.abbreviation;
      out[`${side.away}@${side.home}`] = { spread: -Number(o.spread), total: Number(o.overUnder), src: o.provider?.name || "ESPN" };
    }
    return out;
  } finally { clearTimeout(t); }
}

async function refreshLines(manual) {
  const btn = $("#refreshBtn"); if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  const fileTime = new Date(DATA.updated).getTime();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LINES_KEY) || "{}"); } catch (e) { saved = {}; }
  let live = 0, ok = false;
  try {
    for (const w of DATA.weeks) {
      const lines = await fetchEspnLines(w);
      const now = Date.now();
      for (const [key, l] of Object.entries(lines)) { saved[key] = { ...l, t: now }; live++; }
    }
    ok = live > 0;
    try { localStorage.setItem(LINES_KEY, JSON.stringify(saved)); } catch (e) { /* private mode */ }
  } catch (e) { ok = false; }
  for (const g of DATA.games) {
    const l = saved[`${g.away}@${g.home}`];
    if (l && l.t > fileTime) applyLine(g, l.spread, l.total, `${l.src} (live)`, l.t);
  }
  LINE_STATUS = ok
    ? `Lines live from ESPN as of ${new Date().toLocaleTimeString()}`
    : `Live lines blocked here, showing saved lines from ${new Date(Math.max(fileTime, ...Object.values(saved).map((l) => l.t || 0))).toLocaleString()}`;
  if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  renderMeta(); renderGames();
}
let LINE_STATUS = "Checking for live lines…";

function renderMeta() {
  $("#meta").textContent = `${DATA.season} season · stats through week ${DATA.stats_through} · data file ${new Date(DATA.updated).toLocaleString()} · ${LINE_STATUS}`;
}

async function loadData() {
  const r = await fetch(`data/data.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    DATA = await loadData();
  } catch (e) {
    $("#game").innerHTML = `<div class="panel empty">Couldn't load data/data.json. If you just set the site up, wait for the first data update to finish.</div>`;
    return;
  }
  fetch("data/backtest.json", { cache: "no-cache" }).then((r) => r.json()).then((b) => { BACKTEST = b; }).catch(() => {});
  computeRanks();
  const hash = new URLSearchParams(location.hash.slice(1));
  state.week = Number(hash.get("week")) || DATA.week;
  if (!DATA.weeks.includes(state.week)) state.week = DATA.weeks[0];
  state.gameId = hash.get("game");
  renderMeta();
  $("#refreshBtn").onclick = async () => {
    try { DATA = await loadData(); computeRanks(); } catch (e) { /* keep what we have */ }
    refreshLines(true);
  };
  $("#slipBtn").onclick = () => toggleSlip(true);
  $("#howLink").onclick = (e) => { e.preventDefault(); openHow(); };
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); toggleSlip(false); } });
  renderWeeks(); renderGames(); renderSlipCount();
  refreshLines(false);
}

function setHash() {
  const h = new URLSearchParams({ week: state.week });
  if (state.gameId) h.set("game", state.gameId);
  history.replaceState(null, "", `#${h}`);
}

// league ranks for the matchup panel: 1 = best
const RANKS = {};
function computeRanks() {
  const ab = Object.keys(DATA.teams);
  const rank = (key, get, highGood) => {
    const sorted = [...ab].sort((a, b) => (highGood ? get(b) - get(a) : get(a) - get(b)));
    sorted.forEach((t, i) => { (RANKS[t] ||= {})[key] = i + 1; });
  };
  rank("off_pass", (t) => DATA.teams[t].off.pass_ypg, true);
  rank("off_rush", (t) => DATA.teams[t].off.rush_ypg, true);
  rank("def_pass", (t) => DATA.teams[t].def.pass_ypg, false);
  rank("def_rush", (t) => DATA.teams[t].def.rush_ypg, false);
}
const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");

// ---------------------------------------------------------------- week + game list

function renderWeeks() {
  $("#weeks").innerHTML = DATA.weeks.map((w) => `<button type="button" aria-pressed="${w === state.week}" data-w="${w}">Week ${w}</button>`).join("");
  $("#weeks").querySelectorAll("button").forEach((b) => b.onclick = () => { state.week = Number(b.dataset.w); state.gameId = null; renderWeeks(); renderGames(); });
}

function renderGames() {
  const games = DATA.games.filter((g) => g.week === state.week);
  if (!games.find((g) => g.id === state.gameId)) state.gameId = games[0]?.id;
  $("#games").innerHTML = games.map((g) => `
    <button type="button" class="gcard" data-id="${g.id}" aria-current="${g.id === state.gameId}">
      <div class="row"><span class="teams">${g.away} @ ${g.home}</span><span class="when">${esc(kickoff(g))}</span></div>
      <div class="lines">${esc(spreadText(g))} · O/U ${g.total ?? "–"}</div>
    </button>`).join("") || `<div class="empty">No games this week.</div>`;
  $("#games").querySelectorAll(".gcard").forEach((b) => b.onclick = () => { state.gameId = b.dataset.id; state.team = null; renderGames(); });
  setHash();
  renderGame();
}

// ---------------------------------------------------------------- game view

function curGame() { return DATA.games.find((g) => g.id === state.gameId); }

function renderGame() {
  const g = curGame();
  if (!g) { $("#game").innerHTML = ""; return; }
  if (!state.team) state.team = g.away;
  const N = DATA.team_names;
  $("#game").innerHTML = `
    <div class="panel">
      <div class="scoreline">
        <div class="team"><img src="${logo(g.away)}" alt=""><div><div class="name">${esc(N[g.away])}</div><div class="muted small">Away</div></div></div>
        <div class="mid"><div class="pts">${fmt(g.model.away_pts, 1)} – ${fmt(g.model.home_pts, 1)}</div>projected score</div>
        <div class="team right"><div><div class="name">${esc(N[g.home])}</div><div class="muted small">Home</div></div><img src="${logo(g.home)}" alt=""></div>
      </div>
      <div class="kv">
        <span>Market spread <b>${esc(spreadText(g))}</b></span>
        <span>Market total <b>${g.total ?? "–"}</b></span>
        ${g.away_ml != null ? `<span>Moneyline <b>${g.away} ${g.away_ml > 0 ? "+" : ""}${g.away_ml} / ${g.home} ${g.home_ml > 0 ? "+" : ""}${g.home_ml}</b></span>` : ""}
        <span>Stats-only model: total <b>${fmt(g.model.model_total, 1)}</b>, ${g.model.model_margin >= 0 ? g.home : g.away} by <b>${fmt(Math.abs(g.model.model_margin), 1)}</b></span>
        <span class="muted">${esc(kickoff(g))} · ${esc(g.roof || "")}${g.wind != null ? ` · wind ${g.wind} mph` : ""}${g.temp != null ? ` · ${g.temp}°F` : ""} · lines: ${esc(g.line_src)}, as of ${new Date(g.lines_asof || DATA.updated).toLocaleString()}</span>
      </div>
    </div>

    <div class="grid2">
      <div class="panel" id="totalTool"></div>
      <div class="panel" id="spreadTool"></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Matchup strength</h2><span class="muted small">Ratings use EPA per play (points added per play) vs. the league. 0 = average.</span></div>
      <div class="grid2">${matchupSide(g, g.away, g.home)}${matchupSide(g, g.home, g.away)}</div>
    </div>

    <div class="panel" id="players"></div>
    <div class="panel" id="finder"></div>
    ${g.poly && g.poly.length ? `<div class="panel" id="poly">${polyHtml(g)}</div>` : ""}
  `;
  renderTotalTool(g); renderSpreadTool(g); renderPlayers(g); renderFinder(g);
}

function lineTool(el, { title, sub, dist, def, min, max, overLabel, underLabel, legLabel }) {
  el.innerHTML = `
    <div class="panel-head"><h2>${title}</h2><span class="muted small">${sub}</span></div>
    <div class="liner"><label class="small muted" for="${el.id}-in">Line</label>
      <input id="${el.id}-in" type="number" step="0.5" value="${def}">
      <input type="range" min="${min}" max="${max}" step="0.5" value="${def}" aria-label="Line">
    </div>
    <div class="out"></div>`;
  const num = el.querySelector('input[type="number"]'), rng = el.querySelector('input[type="range"]'), out = el.querySelector(".out");
  const update = (v) => {
    const L = Number(v); const pr = probs(dist, L);
    out.innerHTML = `
      <div class="liner">
        <span class="prob">${esc(overLabel(L))} <b>${pct(pr.over)}</b> <span class="price">fair ${cents(pr.over)} · ${american(pr.over)}</span></span>
        <button class="btn add" data-s="over">+ Slip</button>
      </div>
      <div class="liner">
        <span class="prob">${esc(underLabel(L))} <b>${pct(pr.under)}</b> <span class="price">fair ${cents(pr.under)} · ${american(pr.under)}</span></span>
        <button class="btn add" data-s="under">+ Slip</button>
      </div>
      ${pr.push > 0.005 ? `<div class="note">Push (exact tie) chance ${pct(pr.push)}.</div>` : ""}`;
    out.querySelectorAll(".add").forEach((b) => b.onclick = () => addLeg({
      label: legLabel(b.dataset.s, L), p: b.dataset.s === "over" ? pr.over : pr.under, game: curGame().id,
    }));
  };
  num.oninput = () => { rng.value = num.value; update(num.value); };
  rng.oninput = () => { num.value = rng.value; update(rng.value); };
  update(def);
}

function renderTotalTool(g) {
  const d = g.model.total, def = g.total ?? Math.round(d.mean * 2) / 2;
  lineTool($("#totalTool"), {
    title: "Total points", sub: `Center ${fmt(d.mean, 1)} · 80% of games land ${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}`,
    dist: d, def, min: Math.round(def - 15), max: Math.round(def + 15),
    overLabel: (L) => `Over ${L}`, underLabel: (L) => `Under ${L}`,
    legLabel: (s, L) => `${g.away} @ ${g.home} ${s === "over" ? "Over" : "Under"} ${L} total points`,
  });
}

function renderSpreadTool(g) {
  // margin = home minus away. "Home -L" wins when margin > L.
  const m = g.model.margin, fav = (g.spread ?? m.mean) >= 0 ? g.home : g.away;
  const sign = fav === g.home ? 1 : -1;
  const favDist = { ...m, mean: sign * m.mean };
  const def = g.spread != null ? Math.abs(g.spread) : Math.round(Math.abs(m.mean) * 2) / 2;
  const dog = fav === g.home ? g.away : g.home;
  lineTool($("#spreadTool"), {
    title: "Point spread", sub: `${fav} projected to win by ${fmt(favDist.mean, 1)}`,
    dist: favDist, def, min: -14, max: 21,
    overLabel: (L) => `${fav} ${L >= 0 ? "-" : "+"}${Math.abs(L)} covers`, underLabel: (L) => `${dog} ${L >= 0 ? "+" : "-"}${Math.abs(L)} covers`,
    legLabel: (s, L) => (s === "over" ? `${fav} ${L >= 0 ? "-" : "+"}${Math.abs(L)}` : `${dog} ${L >= 0 ? "+" : "-"}${Math.abs(L)}`) + ` (${g.away} @ ${g.home})`,
  });
}

function matchupRow(label, off, def, offTxt, defTxt) {
  const edge = off - def;
  const w = Math.min(Math.abs(edge), 3) / 3 * 50;
  const color = edge >= 0 ? "var(--good)" : "var(--bad)";
  let verdict = "Even";
  if (edge > 1.25) verdict = "Big edge: offense"; else if (edge > 0.5) verdict = "Edge: offense";
  else if (edge < -1.25) verdict = "Big edge: defense"; else if (edge < -0.5) verdict = "Edge: defense";
  return `<div class="match">
    <div class="lbl"><b>${label}</b><span class="${edge > 0.5 ? "edge-good" : edge < -0.5 ? "edge-bad" : ""}">${verdict} (${edge >= 0 ? "+" : ""}${edge.toFixed(1)})</span></div>
    <div class="meter"><div class="mid"></div><div class="fill" style="background:${color};${edge >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></div></div>
    <div class="small muted">${offTxt}<br>${defTxt}</div>
  </div>`;
}

function matchupSide(g, tm, opp) {
  const T = DATA.teams[tm], O = DATA.teams[opp], s = g.script[tm];
  const passEdge = T.rating.off_pass - O.rating.def_pass, rushEdge = T.rating.off_rush - O.rating.def_rush;
  let lean = "No strong lean either way.";
  if (passEdge - rushEdge > 0.75) lean = `Passing is the better path for ${tm} here.`;
  else if (rushEdge - passEdge > 0.75) lean = `Running is the better path for ${tm} here.`;
  const prDelta = (s.pass_rate - T.off.pass_rate) * 100;
  return `<div>
    <h3>${tm} offense vs ${opp} defense</h3>
    ${matchupRow("Passing", T.rating.off_pass, O.rating.def_pass,
      `${tm} pass offense: ${fmt(T.off.pass_ypg, 0)} yds/g (${ord(RANKS[tm].off_pass)}), rating ${fmt(T.rating.off_pass, 1)}`,
      `${opp} pass defense: ${fmt(O.def.pass_ypg, 0)} yds/g allowed (${ord(RANKS[opp].def_pass)}), rating ${fmt(O.rating.def_pass, 1)}`)}
    ${matchupRow("Rushing", T.rating.off_rush, O.rating.def_rush,
      `${tm} run offense: ${fmt(T.off.rush_ypg, 0)} yds/g (${ord(RANKS[tm].off_rush)}), ${fmt(T.off.ypc, 1)} per carry`,
      `${opp} run defense: ${fmt(O.def.rush_ypg, 0)} yds/g allowed (${ord(RANKS[opp].def_rush)}), ${fmt(O.def.ypc, 1)} per carry`)}
    <div class="small">${lean} Expected pass rate <b>${pct(s.pass_rate)}</b> (season ${pct(T.off.pass_rate)}, ${prDelta >= 0 ? "+" : ""}${prDelta.toFixed(1)} pts) on about <b>${Math.round(s.plays)}</b> plays.
    Implied team points ${tm === g.home ? fmt(g.model.home_pts, 1) : fmt(g.model.away_pts, 1)} vs. ${fmt(T.off.ppg, 1)} season average.</div>
  </div>`;
}

// ---------------------------------------------------------------- players

function playerRows(g, tm) {
  return (g.players[tm] || []).map((pid) => ({ pid, ...DATA.players[pid] }))
    .sort((a, b) => POS_ORDER.indexOf(a.pos) - POS_ORDER.indexOf(b.pos) || volume(b, g) - volume(a, g));
}
function volume(p, g) {
  const pr = p.proj[g.id] || {};
  return p.pos === "QB" ? (pr.att?.mean || 0) : (pr.car?.mean || 0) + (pr.tgt?.mean || 0);
}
function injBadge(p) {
  const s = p.inj?.status;
  if (!s) return "";
  return `<span class="badge ${s === "Out" || s === "Doubtful" ? "out" : "q"}" title="${esc(p.inj.injury || "")} (week ${p.inj.wk})">${esc(s)}</span>`;
}

function renderPlayers(g) {
  const el = $("#players");
  const rows = playerRows(g, state.team).filter((p) => state.pos === "ALL" || p.pos === state.pos);
  const posList = state.pos === "ALL" ? POS_ORDER : [state.pos];
  const tables = posList.map((pos) => {
    const ps = rows.filter((p) => p.pos === pos);
    if (!ps.length) return "";
    const keys = POS_STATS[pos];
    return `<h3>${pos}</h3><div class="table-wrap"><table>
      <thead><tr><th>Player</th>${keys.map((k) => `<th>${STATS[k].short}</th>`).join("")}<th>Games</th></tr></thead>
      <tbody>${ps.map((p) => {
        const pr = p.proj[g.id];
        const last = p.log.slice(-3);
        return `<tr class="click" data-pid="${p.pid}"><td><span class="pname">${esc(p.name)}</span>${injBadge(p)}</td>
          ${keys.map((k) => {
            const d = pr[k];
            const season = p.log.reduce((a, r) => a + r[k], 0) / p.log.length;
            const l3 = last.reduce((a, r) => a + r[k], 0) / last.length;
            const rng = STATS[k].count ? `${pct(1 - poissonCdf(0, d.mean))} for 1+` : `${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}`;
            return `<td title="Season avg ${fmt(season, 1)} · last 3 avg ${fmt(l3, 1)}"><b>${fmt(d.mean, STATS[k].dec)}</b><span class="rng">${rng}</span></td>`;
          }).join("")}
          <td>${p.log.length}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }).join("");
  el.innerHTML = `
    <div class="panel-head"><h2>Player projections this game</h2><span class="muted small">Bold = projected average. Small text = 80% range (or chance of 1+ TD). Tap a player for game logs and lines.</span></div>
    <div class="tabs">
      ${[g.away, g.home].map((t) => `<button class="chip" data-team="${t}" aria-pressed="${t === state.team}">${esc(DATA.team_names[t])}</button>`).join("")}
      <span style="width:12px"></span>
      ${["ALL", ...POS_ORDER].map((p) => `<button class="chip" data-pos="${p}" aria-pressed="${p === state.pos}">${p === "ALL" ? "All" : p}</button>`).join("")}
    </div>
    ${tables || `<div class="empty">No players with recent snaps found.</div>`}`;
  el.querySelectorAll("[data-team]").forEach((b) => b.onclick = () => { state.team = b.dataset.team; renderPlayers(g); });
  el.querySelectorAll("[data-pos]").forEach((b) => b.onclick = () => { state.pos = b.dataset.pos; renderPlayers(g); });
  el.querySelectorAll("tr[data-pid]").forEach((tr) => tr.onclick = () => openPlayer(tr.dataset.pid, g));
}

// ---------------------------------------------------------------- alt-line finder

function finderLine(d, k, conf, side) {
  if (STATS[k].count) {
    // touchdowns: "1+" (over 0.5) and "2+" (over 1.5) are the real markets
    for (const L of side === "over" ? [1.5, 0.5] : [0.5, 1.5]) {
      const pr = probs(d, L);
      if ((side === "over" ? pr.over : pr.under) >= conf) return { L, p: side === "over" ? pr.over : pr.under };
    }
    return null;
  }
  if (side === "over") {
    let L = Math.floor(quantile(1 - conf, d)) - 0.5;
    if (L < 1.5) return null;   // "over 0.5 receptions" style lines aren't worth a parlay leg
    return { L, p: probs(d, L).over };
  }
  const L = Math.ceil(quantile(conf, d)) + 0.5;
  return { L, p: probs(d, L).under };
}

function renderFinder(g) {
  const el = $("#finder");
  const items = [];
  for (const tm of [g.away, g.home]) {
    for (const p of playerRows(g, tm)) {
      if (p.inj?.status === "Out") continue;
      for (const k of FEATURED[p.pos]) {
        const d = p.proj[g.id][k];
        if (!d || d.mean < (STATS[k].count ? 0.05 : 1)) continue;
        const r = finderLine(d, k, state.conf, state.side);
        if (!r) continue;
        const st = stability(p.log.map((x) => x[k]));
        const hits = p.log.filter((x) => (state.side === "over" ? x[k] > r.L : x[k] < r.L)).length;
        items.push({ p, k, d, L: r.L, prob: r.p, st, hits });
      }
    }
  }
  items.sort((a, b) => (a.st.cv ?? 9) - (b.st.cv ?? 9));
  el.innerHTML = `
    <div class="panel-head"><h2>Alt-line finder</h2><span class="muted small">The ${state.side} line each player should clear with your chosen confidence. Steadiest players first.</span></div>
    <div class="tabs">
      ${["over", "under"].map((s) => `<button class="chip" data-side="${s}" aria-pressed="${s === state.side}">${s === "over" ? "Overs" : "Unders"}</button>`).join("")}
      <span style="width:12px"></span>
      ${[0.6, 0.7, 0.75, 0.8, 0.9].map((c) => `<button class="chip" data-conf="${c}" aria-pressed="${c === state.conf}">${pct(c)}</button>`).join("")}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Prop</th><th>Line</th><th>Model chance</th><th>Fair price</th><th>Hit this season</th><th>Consistency</th><th></th></tr></thead>
      <tbody>${items.map((it, i) => `<tr>
        <td><span class="pname">${esc(it.p.name)}</span><span class="pos-tag">${it.p.team} ${it.p.pos}</span>${injBadge(it.p)}</td>
        <td>${STATS[it.k].label}</td>
        <td>${state.side === "over" ? "Over" : "Under"} ${it.L}</td>
        <td><b>${pct(it.prob)}</b></td>
        <td>${cents(it.prob)}</td>
        <td>${it.hits} of ${it.p.log.length}</td>
        <td><span class="stab ${it.st.cls}">${it.st.label}</span></td>
        <td><button class="btn add" data-i="${i}">+ Slip</button></td></tr>`).join("")}</tbody>
    </table></div>
    <div class="note">"Hit this season" counts past games that would have cleared the line. Ranges assume normal playing time; check the injury report before betting.</div>`;
  el.querySelectorAll("[data-side]").forEach((b) => b.onclick = () => { state.side = b.dataset.side; renderFinder(g); });
  el.querySelectorAll("[data-conf]").forEach((b) => b.onclick = () => { state.conf = Number(b.dataset.conf); renderFinder(g); });
  el.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
    const it = items[Number(b.dataset.i)];
    addLeg({ label: `${it.p.name} ${state.side === "over" ? "Over" : "Under"} ${it.L} ${STATS[it.k].label.toLowerCase()}`, p: it.prob, game: g.id });
  });
}

// ---------------------------------------------------------------- player detail

function chartSvg(log, k, d) {
  const W = 300, H = 120, padL = 26, padB = 22, padT = 8;
  const vals = log.map((r) => r[k]);
  const hi10 = STATS[k].count ? Math.max(2, d.mean * 3) : quantile(0.9, d);
  const maxV = Math.max(1, ...vals, hi10) * 1.08;
  const n = log.length + 1;
  const bw = (W - padL - 6) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
  const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(STATS[k].label)} by game">`;
  // axis ticks
  [0, maxV / 2].forEach((t) => { s += `<text x="${padL - 4}" y="${y(t) + 3}" text-anchor="end">${Math.round(t)}</text><line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" />`; });
  log.forEach((r, i) => {
    const x = padL + i * bw + 2;
    s += `<rect x="${x}" y="${y(r[k])}" width="${bw - 4}" height="${Math.max(0, y(0) - y(r[k]))}" fill="var(--bar)" rx="2"><title>Week ${r.w} vs ${r.opp}: ${r[k]}</title></rect>`;
    s += `<text x="${x + (bw - 4) / 2}" y="${H - 9}" text-anchor="middle">${r.w}</text><text x="${x + (bw - 4) / 2}" y="${H - 0.5}" text-anchor="middle">${esc(r.opp)}</text>`;
  });
  // projection: 80% and 50% bands with the average marked
  const x = padL + log.length * bw + 2;
  if (!STATS[k].count) {
    s += `<rect x="${x}" y="${y(quantile(0.9, d))}" width="${bw - 4}" height="${y(quantile(0.1, d)) - y(quantile(0.9, d))}" fill="var(--band80)" rx="2"><title>80% range</title></rect>`;
    s += `<rect x="${x}" y="${y(quantile(0.75, d))}" width="${bw - 4}" height="${y(quantile(0.25, d)) - y(quantile(0.75, d))}" fill="var(--band50)" rx="2"><title>50% range</title></rect>`;
  }
  s += `<line x1="${x}" x2="${x + bw - 4}" y1="${y(d.mean)}" y2="${y(d.mean)}" stroke="var(--bar-hi)" stroke-width="2.5"><title>Projection ${fmt(d.mean, 1)}</title></line>`;
  s += `<text x="${x + (bw - 4) / 2}" y="${H - 9}" text-anchor="middle">next</text>`;
  s += `<line x1="${padL}" x2="${x - 2}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--muted)" stroke-dasharray="3 3"><title>Season average ${fmt(avg, 1)}</title></line>`;
  return s + "</svg>";
}

function openPlayer(pid, g) {
  const p = DATA.players[pid], pr = p.proj[g.id];
  const opp = p.team === g.home ? g.away : g.home;
  const keys = POS_STATS[p.pos];
  const card = $("#modal .modal-card");
  card.innerHTML = `
    <div class="modal-head">
      ${p.img ? `<img src="${esc(p.img)}" alt="">` : ""}
      <div><h2>${esc(p.name)} ${injBadge(p)}</h2><div class="muted">${esc(DATA.team_names[p.team])} ${p.pos} · vs ${esc(DATA.team_names[opp])} · ${p.log.length} games played</div>
      ${p.inj ? `<div class="small muted">Injury report (week ${p.inj.wk}): ${esc(p.inj.injury || "–")}${p.inj.practice ? `, ${esc(p.inj.practice)}` : ""}</div>` : ""}</div>
      <button class="x" aria-label="Close">×</button>
    </div>
    <div class="statcards">${keys.map((k) => statCard(p, k, pr[k], g)).join("")}</div>
    <div class="panel" style="margin-top:12px"><h3>Game log</h3><div class="table-wrap"><table>
      <thead><tr><th>Week</th><th>Opp</th>${keys.map((k) => `<th>${STATS[k].short}</th>`).join("")}</tr></thead>
      <tbody>${p.log.slice().reverse().map((r) => `<tr><td>${r.w}</td><td>${esc(r.opp)}${r.tm !== p.team ? ` <span class="muted small">(${esc(r.tm)})</span>` : ""}</td>${keys.map((k) => `<td>${r[k]}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div></div>`;
  card.querySelector(".x").onclick = closeModal;
  keys.forEach((k) => wireStatCard(card, p, k, pr[k], g));
  $("#modal").hidden = false;
}

function statCard(p, k, d, g) {
  const vals = p.log.map((r) => r[k]);
  const season = vals.reduce((a, b) => a + b, 0) / vals.length;
  const l3v = vals.slice(-3), l3 = l3v.reduce((a, b) => a + b, 0) / l3v.length;
  const st = stability(vals);
  const def = STATS[k].count ? 0.5 : Math.max(0.5, Math.round(d.mean) - 0.5);
  const tdGames = vals.filter((v) => v > 0).length;
  const factorTxt = d.f > 1.03 ? `Matchup and game script push this up ${Math.round((d.f - 1) * 100)}%.` : d.f < 0.97 ? `Matchup and game script pull this down ${Math.round((1 - d.f) * 100)}%.` : "Matchup is roughly neutral.";
  return `<div class="statcard" data-k="${k}">
    <div class="panel-head" style="margin:0"><h3>${STATS[k].label}</h3>
      ${STATS[k].count ? `<span class="small muted">Scored in ${tdGames} of ${vals.length}</span>` : `<span class="stab ${st.cls}" title="Typical miss from average: ${st.cv != null ? Math.round(st.cv * 100) + "%" : "–"}">${st.label}</span>`}</div>
    <div class="nums">
      <div>Season avg<b>${fmt(season, 1)}</b></div>
      <div>Last 3 avg<b>${fmt(l3, 1)}</b></div>
      <div>${STATS[k].count ? "1+ chance" : "Typical swing"}<b>${STATS[k].count ? pct(1 - poissonCdf(0, d.mean)) : "±" + fmt(st.sd ?? 0, 0)}</b></div>
      <div>Projection<b>${fmt(d.mean, STATS[k].dec === 2 ? 2 : 1)}</b></div>
    </div>
    ${chartSvg(p.log, k, d)}
    <div class="small muted">${STATS[k].count ? "" : `50% range ${Math.round(quantile(0.25, d))}–${Math.round(quantile(0.75, d))} · 80% range ${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}. `}${factorTxt}</div>
    <div class="liner"><label class="small muted">Line</label><input type="number" step="0.5" min="0" value="${def}"><span class="out"></span></div>
  </div>`;
}

function wireStatCard(card, p, k, d, g) {
  const el = card.querySelector(`.statcard[data-k="${k}"]`);
  const input = el.querySelector("input"), out = el.querySelector(".out");
  const update = () => {
    const L = Number(input.value), pr = probs(d, L);
    out.innerHTML = `<span class="prob">O <b>${pct(pr.over)}</b></span> <button class="btn add" data-s="over">+ Over</button>
      <span class="prob">U <b>${pct(pr.under)}</b></span> <button class="btn add" data-s="under">+ Under</button>`;
    out.querySelectorAll(".add").forEach((b) => b.onclick = () => addLeg({
      label: `${p.name} ${b.dataset.s === "over" ? "Over" : "Under"} ${L} ${STATS[k].label.toLowerCase()}`,
      p: b.dataset.s === "over" ? pr.over : pr.under, game: g.id,
    }));
  };
  input.oninput = update; update();
}

function closeModal() { $("#modal").hidden = true; }

// ---------------------------------------------------------------- polymarket

function polyHtml(g) {
  return `<div class="panel-head"><h2>Polymarket prices</h2><span class="muted small">Live prices when the data last updated. Price = market's implied chance.</span></div>
    <div class="table-wrap"><table><thead><tr><th>Market</th><th>Prices</th></tr></thead><tbody>
    ${g.poly.map((m) => `<tr><td><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.q)}</a></td>
      <td>${m.o.map((o, i) => `${esc(o)} ${m.p[i] != null ? Math.round(m.p[i] * 100) + "¢" : "–"}`).join(" · ")}</td></tr>`).join("")}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------- slip

function addLeg(leg) {
  slip.push({ ...leg, id: Date.now() + Math.random(), price: null });
  saveSlip();
  const b = $("#slipBtn"); b.animate([{ transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 250 });
}
function renderSlipCount() { $("#slipCount").textContent = slip.length; if (!$("#slip").hidden) renderSlip(); }
function toggleSlip(open) { $("#slip").hidden = !open; if (open) renderSlip(); }

function renderSlip() {
  const el = $("#slip");
  const pModel = slip.reduce((a, l) => a * l.p, 1);
  const priced = slip.length && slip.every((l) => l.price > 0 && l.price < 100);
  const pMarket = priced ? slip.reduce((a, l) => a * l.price / 100, 1) : null;
  const games = new Set(slip.map((l) => l.game));
  const sameGame = slip.length > games.size;
  el.innerHTML = `
    <div class="panel-head"><h2>Parlay slip</h2><button class="x" aria-label="Close">×</button></div>
    <div class="note" style="margin-top:0">Type the Polymarket price (in cents) for each leg to compare it with the model.</div>
    ${slip.map((l) => {
      const edge = l.price ? l.p - l.price / 100 : null;
      return `<div class="leg" data-id="${l.id}">
        <div class="top-row"><span>${esc(l.label)}</span><button class="x" data-del aria-label="Remove">×</button></div>
        <div class="liner small">Model <b>${pct(l.p)}</b> (fair ${cents(l.p)})
          <span style="margin-left:auto">Price ¢ <input type="number" min="1" max="99" value="${l.price ?? ""}"></span></div>
        ${edge != null ? `<div class="small ${edge > 0.02 ? "edge-good" : edge < -0.02 ? "edge-bad" : "muted"}">${edge >= 0 ? "Model sees value: +" : "Market is richer: "}${Math.round(edge * 100)} pts</div>` : ""}
      </div>`;
    }).join("") || `<div class="empty">No legs yet. Use "+ Slip" buttons on a game.</div>`}
    ${slip.length ? `<div class="summary">
      <div>Model chance all ${slip.length} hit: <b>${pct(pModel)}</b> · fair price ${cents(pModel)} (${american(pModel)})</div>
      ${pMarket != null ? `<div>Polymarket price product: <b>${(pMarket * 100).toFixed(1)}¢</b> · expected return per $1: <b class="${pModel / pMarket >= 1 ? "edge-good" : "edge-bad"}">${pModel / pMarket >= 1 ? "+" : ""}${Math.round((pModel / pMarket - 1) * 100)}%</b></div>` : ""}
      ${sameGame ? `<div class="warnbox">Some legs are from the same game. Those tend to move together (a QB's yards and his WR's yards rise and fall as a pair), so the true chance of hitting is different from this simple multiplied number: higher if the legs help each other, lower if they work against each other (e.g. an RB rushing over plus a game-total under is fine; a QB yards over plus his team's RB rush-attempts over pull in opposite directions).</div>` : ""}
      <button class="btn" id="clearSlip" style="margin-top:8px">Clear slip</button>
    </div>` : ""}`;
  el.querySelector(".x").onclick = () => toggleSlip(false);
  el.querySelectorAll(".leg").forEach((d) => {
    const leg = slip.find((l) => String(l.id) === d.dataset.id);
    d.querySelector("[data-del]").onclick = () => { slip = slip.filter((l) => l !== leg); saveSlip(); };
    const inp = d.querySelector("input");
    inp.onchange = () => { leg.price = Number(inp.value) || null; saveSlip(); };
  });
  const c = $("#clearSlip"); if (c) c.onclick = () => { slip = []; saveSlip(); };
}

// ---------------------------------------------------------------- how it works

function openHow() {
  const card = $("#modal .modal-card");
  const bt = BACKTEST?.summary || [];
  card.innerHTML = `
    <div class="modal-head"><h2>How the model works</h2><button class="x" aria-label="Close">×</button></div>
    <div class="panel">
      <p><b>Starting point.</b> Each player's recent average, where a game four weeks back counts half as much as last week's.</p>
      <p><b>Game script.</b> The betting spread and total tell us how many points each team should score and who is likely to be trailing. Trailing teams throw more, leading teams run more. That shifts pass attempts, carries, and targets.</p>
      <p><b>Matchup.</b> Yardage gets scaled by how many yards the opponent allows per pass, per carry, and per target to that position (WR, TE, RB), compared to the league. Small samples are pulled toward average so one blowout doesn't swing things too far. Touchdowns scale with the team's implied points, blended with the league TD rate so a player who hasn't scored yet still has a real chance.</p>
      <p><b>Ranges.</b> Each player's own game-to-game swing, blended with the typical swing for that position, then widened until past weeks' 80% ranges really did catch about 80% of results. Touchdowns and interceptions use count odds (Poisson). Totals and spreads use the market line with a 13-point typical miss, nudged 20% toward a stats-only score model.</p>
      <p><b>What it doesn't know.</b> Injuries during the week, weather beyond what's listed, coaching changes, and snap-count news. A player listed Questionable could be on a snap limit.</p>
      <p><b>Using it for alt lines.</b> If the model says 80% and Polymarket charges 70¢, that's a possible edge. If it charges 85¢, it isn't. Multiplying many 80% legs drops fast: five of them is about 33%.</p>
    </div>
    ${bt.length ? `<div class="panel"><h3>Track record this season</h3>
      <div class="small muted" style="margin-bottom:6px">${esc(BACKTEST.note)} A well-tuned model lands about 80% inside its 80% range and 50% inside its 50% range. "Avg miss" is the average gap between projection and result.</div>
      <div class="table-wrap"><table><thead><tr><th>Stat</th><th>Results</th><th>Inside 80% range</th><th>Inside 50% range</th><th>Avg miss</th><th>Avg miss using season avg</th></tr></thead>
      <tbody>${bt.map((r) => `<tr><td>${esc(r.stat)}</td><td>${r.n}</td><td>${pct(r.in80)}</td><td>${pct(r.in50)}</td><td>${fmt(r.mae, 1)}</td><td>${fmt(r.mae_season_avg, 1)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
  card.querySelector(".x").onclick = closeModal;
  $("#modal").hidden = false;
}

boot();
