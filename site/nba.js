"use strict";

// NBA page. Same layout and math as app.js (the NFL page), with basketball stats.

// ---------------------------------------------------------------- stat definitions

const STATS = {
  min: { label: "Minutes", short: "Min", dec: 1 },
  pts: { label: "Points", short: "Pts", dec: 1 },
  reb: { label: "Rebounds", short: "Reb", dec: 1 },
  ast: { label: "Assists", short: "Ast", dec: 1 },
  fg3: { label: "3-pointers made", short: "3PM", dec: 1 },
  fg3a: { label: "3-point attempts", short: "3PA", dec: 1 },
  fg2: { label: "2-pointers made", short: "2PM", dec: 1 },
  fg2a: { label: "2-point attempts", short: "2PA", dec: 1 },
  pra: { label: "Pts + Reb + Ast", short: "PRA", dec: 1, parts: ["pts", "reb", "ast"] },
  pr: { label: "Pts + Reb", short: "P+R", dec: 1, parts: ["pts", "reb"] },
  pa: { label: "Pts + Ast", short: "P+A", dec: 1, parts: ["pts", "ast"] },
  ra: { label: "Reb + Ast", short: "R+A", dec: 1, parts: ["reb", "ast"] },
  stl: { label: "Steals", short: "Stl", dec: 1 },
  blk: { label: "Blocks", short: "Blk", dec: 1 },
  sb: { label: "Steals + Blocks", short: "S+B", dec: 1, parts: ["stl", "blk"] },
  tov: { label: "Turnovers", short: "TO", dec: 1 },
};
const TABLE_KEYS = ["min", "pts", "reb", "ast", "fg3", "fg3a", "fg2", "fg2a", "pra", "stl", "blk"];
const ALL_KEYS = ["min", "pts", "reb", "ast", "fg3", "fg3a", "fg2", "fg2a", "pra", "pr", "pa", "ra", "stl", "blk", "sb", "tov"];
const PROP_KEYS = ALL_KEYS.filter((k) => k !== "min");
// the props worth betting, for the alt-line finder
const FEATURED = ["pts", "reb", "ast", "fg3", "pra"];
const val = (r, k) => (STATS[k].parts ? STATS[k].parts.reduce((a, c) => a + r[c], 0) : r[k]);

// ---------------------------------------------------------------- probability math (mirrors scripts/nba_build.py)

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
// counts with more game-to-game swing than Poisson allows (rebounds, assists, threes)
function negbinCdf(k, mean, sd) {
  k = Math.floor(k);
  if (k < 0) return 0;
  const v = sd * sd;
  if (v <= mean * 1.0001) return poissonCdf(k, mean);
  const p = mean / v, r = mean * mean / (v - mean);
  let term = Math.pow(p, r), sum = term;
  for (let i = 0; i < k; i++) { term *= (i + r) / (i + 1) * (1 - p); sum += term; }
  return Math.min(1, sum);
}
const isCount = (p) => p.dist === "poisson" || p.dist === "negbin";
function cdf(x, p) {
  if (p.dist === "poisson") return poissonCdf(Math.floor(x), p.mean);
  if (p.dist === "negbin") return negbinCdf(x, p.mean, p.sd);
  if (p.dist === "normal") return 0.5 * (1 + erf((x - p.mean) / (p.sd * Math.SQRT2)));
  if (p.mean <= 0 || p.sd <= 0) return x >= p.mean ? 1 : 0;
  const shape = (p.mean / p.sd) ** 2, scale = p.sd ** 2 / p.mean;
  return gammaincLower(shape, x / scale);
}
function quantile(q, p) {
  if (isCount(p)) { let k = 0; while (cdf(k, p) < q && k < 300) k++; return k; }
  let lo = p.dist === "normal" ? p.mean - 10 * p.sd : 0, hi = p.mean + 12 * p.sd + 1;
  for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (cdf(m, p) < q) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
// Stats are whole numbers, so a line of 24.5 splits cleanly and a line of 25 can push.
function probs(p, line) {
  const whole = Math.abs(line - Math.round(line)) < 1e-9;
  if (isCount(p)) {
    const under = whole ? cdf(line - 1, p) : cdf(Math.floor(line), p);
    const over = 1 - cdf(Math.floor(line), p);
    return { over, under, push: Math.max(0, 1 - over - under) };
  }
  if (whole) {
    const under = cdf(line - 0.5, p), over = 1 - cdf(line + 0.5, p);
    return { over, under, push: Math.max(0, 1 - over - under) };
  }
  const under = cdf(line, p);
  return { over: 1 - under, under, push: 0 };
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

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
const logo = (ab) => `https://a.espncdn.com/i/teamlogos/nba/500/${ab.toLowerCase()}.png`;
function spreadText(g) {
  if (g.spread == null) return "No line";
  if (g.spread === 0) return "Pick'em";
  return g.spread > 0 ? `${g.home} -${g.spread}` : `${g.away} -${-g.spread}`;
}
const tipoff = (g) => new Date(g.t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const tipTime = (g) => new Date(g.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function dayLabel(d) {
  const diff = Math.round((new Date(`${d}T12:00:00`) - new Date(`${DATA.today}T12:00:00`)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
}
const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
function stability(vals) {
  const n = vals.length;
  if (n < 2) return { cv: null, label: "Too few games", cls: "s3" };
  const m = vals.reduce((a, b) => a + b, 0) / n;
  if (m <= 0) return { cv: null, label: "Rarely", cls: "s4" };
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  const cv = sd / m;
  if (cv < 0.25) return { cv, sd, label: "Very steady", cls: "s1" };
  if (cv < 0.4) return { cv, sd, label: "Steady", cls: "s2" };
  if (cv < 0.65) return { cv, sd, label: "Swingy", cls: "s3" };
  return { cv, sd, label: "Very swingy", cls: "s4" };
}
const avg = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");

// ---------------------------------------------------------------- state

let DATA = null, BACKTEST = null;
const state = { date: null, gameId: null, team: null, conf: 0.75, side: "over", prop: "ALL" };
const SLIP_KEY = "nbaSlip";
let slip = [];
try { slip = JSON.parse(localStorage.getItem(SLIP_KEY) || "[]"); } catch (e) { slip = []; }
function saveSlip() { try { localStorage.setItem(SLIP_KEY, JSON.stringify(slip)); } catch (e) { /* private mode */ } renderSlipCount(); }

// ---------------------------------------------------------------- live lines and injuries

// The data file is rebuilt on a schedule. On top of that, the page asks ESPN for the latest
// spread, total, and injury report each time it loads. If ESPN is blocked on this computer,
// it uses the last lines it saw here (saved in the browser), else the file's.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const LINES_KEY = "nbaLiveLines";
let LINE_STATUS = "Checking for live lines…";

function applyLine(g, spread, total, src, asOf) {
  g.spread = spread; g.total = total; g.line_src = src; g.lines_asof = asOf;
  const m = g.model;
  m.total.mean = 0.8 * total + 0.2 * m.model_total;
  m.margin.mean = 0.8 * spread + 0.2 * m.model_margin;
  m.home_pts = (m.total.mean + m.margin.mean) / 2;
  m.away_pts = (m.total.mean - m.margin.mean) / 2;
}

async function getJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ESPN serves the same data from two hosts; if one fails here, try the other
async function espnJson(path) {
  try { return await getJson(`${ESPN}/${path}`); } catch (e) { return getJson(`${ESPN.replace("site.api", "site.web.api")}/${path}`); }
}

// "BOS -13.5" means Boston is favored by 13.5. Returned margin is positive when the home team is favored.
function parseOdds(c) {
  const o = c?.odds?.[0];
  if (!o || o.overUnder == null) return null;
  const side = {}; for (const t of c.competitors) side[t.homeAway] = t.team.abbreviation;
  let margin = null;
  const m = /^\s*([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)\s*$/.exec(o.details || "");
  if (m) margin = Math.abs(Number(m[2])) * (m[1] === side.home ? 1 : -1);
  else if (/^(EVEN|PK|PICK)$/i.test(o.details || "")) margin = 0;
  else if (o.spread != null) margin = -Number(o.spread);
  if (margin == null) return null;
  return { spread: margin, total: Number(o.overUnder), src: o.provider?.name || "ESPN" };
}

async function fetchEspnLines(day) {
  const j = await espnJson(`scoreboard?dates=${day.replaceAll("-", "")}&limit=100`);
  const out = {}, scores = {};
  for (const ev of j.events || []) {
    scores[String(ev.id)] = RESULT.fromEspn(ev);
    const l = parseOdds(ev.competitions?.[0]);
    if (l) out[String(ev.id)] = l;
  }
  return { lines: out, scores };
}

let NEWS_STATUS = "";
async function refreshInjuries() {
  try {
    const { byId, byName, count } = await NOTES.injuries("basketball/nba");
    if (!count) return;
    for (const [pid, p] of Object.entries(DATA.players)) {
      const e = byId[pid] || byName[NOTES.norm(p.name)];
      if (e) p.inj = e; else delete p.inj;
    }
    NEWS_STATUS = ` · injury report live as of ${new Date().toLocaleTimeString()}`;
  } catch (e) { /* keep the file's injury report */ }
  try { await NOTES.news("basketball/nba"); } catch (e) { /* headlines are optional */ }
  adjustForInjuries();
}

async function refreshLines() {
  const btn = $("#refreshBtn"); if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  const fileTime = new Date(DATA.updated).getTime();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LINES_KEY) || "{}"); } catch (e) { saved = {}; }
  let live = 0, ok = false, scores = {};
  try {
    for (const d of DATA.dates) {
      const { lines, scores: sc } = await fetchEspnLines(d);
      Object.assign(scores, sc);
      const now = Date.now();
      for (const [key, l] of Object.entries(lines)) { saved[key] = { ...l, t: now }; live++; }
    }
    ok = live > 0;
    try { localStorage.setItem(LINES_KEY, JSON.stringify(saved)); } catch (e) { /* private mode */ }
  } catch (e) { ok = false; }
  for (const g of DATA.games) {
    const l = saved[g.id];
    if (l && l.t > fileTime && RESULT.state(g) !== "post") applyLine(g, l.spread, l.total, `${l.src} (live)`, l.t);
    if (scores[g.id]) g.live = scores[g.id];
  }
  await refreshInjuries();
  const savedTimes = Object.values(saved).map((l) => l.t || 0);
  LINE_STATUS = ok
    ? `Lines live from ESPN as of ${new Date().toLocaleTimeString()}`
    : `Live lines blocked here, showing saved lines from ${new Date(Math.max(fileTime, ...savedTimes)).toLocaleString()}`;
  if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  renderMeta(); renderGames();
}

// reload the data file (rebuilt hourly) and re-check lines, injuries, and headlines
async function reloadAll() {
  BASKETS.clear();
  try { DATA = await loadData(); computeRanks(); DD_CACHE.clear(); } catch (e) { /* keep what we have */ }
  await refreshLines();
}

function renderMeta() {
  $("#meta").textContent = `${DATA.season} season · stats through ${DATA.stats_through ? shortDate(DATA.stats_through) : "–"} · data file ${new Date(DATA.updated).toLocaleString()} · ${LINE_STATUS}${NEWS_STATUS}`;
}

async function loadData() {
  const r = await fetch(`data/nba.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    DATA = await loadData();
  } catch (e) {
    $("#game").innerHTML = `<div class="panel empty">Couldn't load data/nba.json. If you just set the site up, wait for the first data update to finish.</div>`;
    return;
  }
  fetch("data/nba_backtest.json", { cache: "no-cache" }).then((r) => r.json()).then((b) => { BACKTEST = b; }).catch(() => {});
  computeRanks();
  adjustForInjuries();
  const hash = new URLSearchParams(location.hash.slice(1));
  state.date = hash.get("date");
  if (!DATA.dates.includes(state.date)) state.date = DATA.dates[0];
  state.gameId = hash.get("game");
  renderMeta();
  $("#refreshBtn").onclick = reloadAll;
  NOTES.autoRefresh(reloadAll);
  $("#slipBtn").onclick = () => toggleSlip(true);
  $("#howLink").onclick = (e) => { e.preventDefault(); openHow(); };
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); toggleSlip(false); } });
  renderDates(); renderGames(); renderSlipCount();
  refreshLines();
}

function setHash() {
  const h = new URLSearchParams();
  if (state.date) h.set("date", state.date);
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
  rank("ortg", (t) => DATA.teams[t].ortg, true);
  rank("drtg", (t) => DATA.teams[t].drtg, false);
  rank("pace", (t) => DATA.teams[t].pace, true);
  rank("fg3", (t) => DATA.teams[t].fg3100, true);
  rank("o_fg3", (t) => DATA.teams[t].o_fg3100, false);
  rank("reb", (t) => DATA.teams[t].reb100, true);
  rank("o_reb", (t) => DATA.teams[t].o_reb100, false);
}

// ---------------------------------------------------------------- date + game list

function renderDates() {
  $("#weeks").innerHTML = DATA.dates.map((d) => `<button type="button" aria-pressed="${d === state.date}" data-d="${d}">${esc(dayLabel(d))}</button>`).join("");
  $("#weeks").querySelectorAll("button").forEach((b) => b.onclick = () => { state.date = b.dataset.d; state.gameId = null; renderDates(); renderGames(); });
}

function renderGames() {
  const games = DATA.games.filter((g) => g.date === state.date);
  // open on the first game that isn't over yet
  if (!games.find((g) => g.id === state.gameId)) state.gameId = (games.find((g) => RESULT.state(g) !== "post") || games[0])?.id;
  $("#games").innerHTML = games.map((g) => `
    <button type="button" class="gcard ${RESULT.state(g)}" data-id="${g.id}" aria-current="${g.id === state.gameId}">
      <div class="row"><span class="teams">${RESULT.teams(g)}</span>${RESULT.badge(g) || `<span class="when">${esc(tipTime(g))}</span>`}</div>
      <div class="lines">${RESULT.state(g) === "post" ? esc(RESULT.settled(g)) : g.spread != null ? `${esc(spreadText(g))} · O/U ${g.total}` : `No line yet · model ${fmt(g.model.model_total, 0)}`}</div>
    </button>`).join("") || `<div class="empty">No games on this day.</div>`;
  $("#games").querySelectorAll(".gcard").forEach((b) => b.onclick = () => { state.gameId = b.dataset.id; state.team = null; renderGames(); });
  setHash();
  renderGame();
}

// ---------------------------------------------------------------- game view

function curGame() { return DATA.games.find((g) => g.id === state.gameId); }

function renderGame() {
  const g = curGame();
  if (!g) { $("#game").innerHTML = DATA.games.length ? "" : `<div class="panel empty">No upcoming NBA games in the data file. In the offseason this page is empty.</div>`; return; }
  if (!state.team) state.team = g.away;
  const N = DATA.team_names, T = DATA.teams;
  $("#game").innerHTML = `
    <div class="panel">
      <div class="scoreline">
        <div class="team"><img src="${logo(g.away)}" alt=""><div><div class="name">${esc(N[g.away])}</div><div class="muted small">Away · ${esc(T[g.away]?.record || "")}</div></div></div>
        <div class="mid">${RESULT.mid(g, `${fmt(g.model.away_pts, 1)} – ${fmt(g.model.home_pts, 1)}`)}</div>
        <div class="team right"><div><div class="name">${esc(N[g.home])}</div><div class="muted small">Home · ${esc(T[g.home]?.record || "")}</div></div><img src="${logo(g.home)}" alt=""></div>
      </div>
      <div class="kv">
        <span>Market spread <b>${esc(spreadText(g))}</b></span>
        <span>Market total <b>${g.total ?? "–"}</b></span>
        ${g.away_ml != null ? `<span>Moneyline <b>${g.away} ${g.away_ml > 0 ? "+" : ""}${g.away_ml} / ${g.home} ${g.home_ml > 0 ? "+" : ""}${g.home_ml}</b></span>` : ""}
        <span>Stats-only model: total <b>${fmt(g.model.model_total, 1)}</b>, ${g.model.model_margin >= 0 ? g.home : g.away} by <b>${fmt(Math.abs(g.model.model_margin), 1)}</b></span>
        <span class="muted">${esc(tipoff(g))} · about ${fmt(g.model.pace, 0)} possessions each · lines: ${esc(g.line_src)}, as of ${new Date(g.lines_asof || DATA.updated).toLocaleString()}</span>
      </div>
    </div>

    <div class="grid2">
      <div class="panel" id="totalTool"></div>
      <div class="panel" id="spreadTool"></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Matchup strength</h2><span class="muted small">Ratings compare each team with the league per 100 possessions. 0 = average.</span></div>
      <div class="grid2">${matchupSide(g, g.away, g.home)}${matchupSide(g, g.home, g.away)}</div>
    </div>

    <div class="panel" id="players"></div>
    <div class="panel" id="spots"></div>
    <div class="panel" id="baskets"></div>
    <div class="panel" id="notes"></div>
    <div class="panel" id="finder"></div>
  `;
  renderTotalTool(g); renderSpreadTool(g); renderPlayers(g); renderSpots(g); renderNotes(g); renderFinder(g);
  BASKETS.render($("#baskets"), g, basketAdapter(g));
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
  const d = g.model.total, def = g.total ?? Math.floor(d.mean) + 0.5;
  lineTool($("#totalTool"), {
    title: "Total points", sub: `Center ${fmt(d.mean, 1)} · 80% of games land ${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}`,
    dist: d, def, min: Math.round(def - 30), max: Math.round(def + 30),
    overLabel: (L) => `Over ${L}`, underLabel: (L) => `Under ${L}`,
    legLabel: (s, L) => `${g.away} @ ${g.home} ${s === "over" ? "Over" : "Under"} ${L} total points`,
  });
}

function renderSpreadTool(g) {
  // margin = home minus away. "Home -L" wins when margin > L.
  const m = g.model.margin, fav = (g.spread ?? m.mean) >= 0 ? g.home : g.away;
  const sign = fav === g.home ? 1 : -1;
  const favDist = { ...m, mean: sign * m.mean };
  const def = g.spread != null ? Math.abs(g.spread) : Math.floor(Math.abs(m.mean)) + 0.5;
  const dog = fav === g.home ? g.away : g.home;
  lineTool($("#spreadTool"), {
    title: "Point spread", sub: `${fav} projected to win by ${fmt(favDist.mean, 1)}`,
    dist: favDist, def, min: -15, max: 25,
    overLabel: (L) => L === "" ? `${fav} covers` : `${fav} ${L >= 0 ? "-" : "+"}${Math.abs(L)} covers`,
    underLabel: (L) => L === "" ? `${dog} covers` : `${dog} ${L >= 0 ? "+" : "-"}${Math.abs(L)} covers`,
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
  const implied = tm === g.home ? g.model.home_pts : g.model.away_pts;
  return `<div>
    <h3>${tm} offense vs ${opp} defense</h3>
    ${matchupRow("Scoring", T.rating.ortg, O.rating.drtg,
      `${tm} offense: ${fmt(T.ortg, 1)} pts per 100 possessions (${ord(RANKS[tm].ortg)})`,
      `${opp} defense: ${fmt(O.drtg, 1)} allowed per 100 (${ord(RANKS[opp].drtg)})`)}
    ${matchupRow("3-pointers", T.rating.fg3100, O.rating.o_fg3100,
      `${tm} makes ${fmt(T.fg3100 * T.pace / 100, 1)} threes a game (${ord(RANKS[tm].fg3)})`,
      `${opp} allows ${fmt(O.o_fg3100 * O.pace / 100, 1)} a game (${ord(RANKS[opp].o_fg3)} fewest)`)}
    ${matchupRow("Rebounding", T.rating.reb100, O.rating.o_reb100,
      `${tm} grabs ${fmt(T.reb100 * T.pace / 100, 1)} boards a game (${ord(RANKS[tm].reb)})`,
      `${opp} allows ${fmt(O.o_reb100 * O.pace / 100, 1)} a game (${ord(RANKS[opp].o_reb)} fewest)`)}
    <div class="small">Pace: ${tm} plays ${fmt(T.pace, 1)} possessions a game (${ord(RANKS[tm].pace)} fastest), this game projects ${fmt(g.model.pace, 1)}${s.pace_f > 1.02 ? ", a bit faster than usual, so more stats to go around" : s.pace_f < 0.98 ? ", a bit slower than usual" : ""}.
    Implied team points <b>${fmt(implied, 1)}</b> vs. ${fmt(T.ppg, 1)} season average.</div>
  </div>`;
}

// ---------------------------------------------------------------- players

function playerRows(g, tm) {
  return (g.players[tm] || []).map((pid) => ({ pid, ...DATA.players[pid] }))
    .sort((a, b) => (ROLES.outWeight(a) >= 1) - (ROLES.outWeight(b) >= 1) || (b.proj[g.id]?.min.mean || 0) - (a.proj[g.id]?.min.mean || 0));
}
function injBadge(p) {
  const s = p.inj?.status;
  if (!s) return "";
  const bad = /out|doubtful|suspend/i.test(s);
  const tip = [p.inj.injury, p.inj.note, p.inj.ret ? `expected back ${p.inj.ret}` : ""].filter(Boolean).join(" · ");
  return `<span class="badge ${bad ? "out" : "q"}" title="${esc(tip)}">${esc(s)}</span>`;
}
const isOut = (p) => /^out$/i.test(p.inj?.status || "");
const rangeTxt = (d) => `${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}`;
const thisSeason = (p) => p.log.filter((r) => !r.ly);

// Projected starter, and players whose minutes jumped or fell from last season
function roleTags(p, g) {
  const me = DATA.players[p.pid], r = me.role?.[g.id];
  const tags = [];
  if (g.starters?.[me.team]?.has(me)) tags.push(`<span class="role-tag st" title="Projected starter (started ${Math.round((r?.st || 0) * 100)}% of recent games, weighted to the latest)">Starter</span>`);
  if (r?.was != null) tags.push(`<span class="role-tag shift" title="About ${Math.round(r.now)} minutes a game this season vs ${Math.round(r.was)} last season, so last season barely counts">${r.now > r.was ? "Bigger" : "Smaller"} role</span>`);
  if (r && r.pp < 0.75) tags.push(`<span class="role-tag dnp" title="Sat out (coach's decision) in ${Math.round((1 - r.pp) * 100)}% of recent games he was available for. Projections assume he plays.">Sits ${Math.round((1 - r.pp) * 100)}%</span>`);
  return tags.join("");
}

function renderPlayers(g) {
  const el = $("#players");
  const ps = playerRows(g, state.team);
  el.innerHTML = `
    <div class="panel-head"><h2>Player projections this game</h2><span class="muted small">Bold = projected average if he plays (▲▼ = changed for a teammate who is out; hover for details). Small text = 80% range. Minutes add up to the team's 240. Tap a player for game logs and lines.</span></div>
    <div class="tabs">
      ${[g.away, g.home].map((t) => `<button class="chip" data-team="${t}" aria-pressed="${t === state.team}">${esc(DATA.team_names[t])}</button>`).join("")}
    </div>
    ${ps.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Player</th>${TABLE_KEYS.map((k) => `<th>${STATS[k].short}</th>`).join("")}<th title="Chance of 10+ in two of points, rebounds, assists">Dbl-dbl</th><th>Games</th></tr></thead>
      <tbody>${ps.map((p) => {
        const pr = p.proj[g.id], cur = thisSeason(p), last5 = p.log.slice(-5);
        if (ROLES.outWeight(p) >= 1) return `<tr class="click" data-pid="${p.pid}"><td><span class="pname">${esc(p.name)}</span><span class="pos-tag">${esc(p.pos)}</span>${injBadge(p)}</td>${ROLES.outRow(TABLE_KEYS.length + 2)}</tr>`;
        return `<tr class="click" data-pid="${p.pid}"><td><span class="pname">${esc(p.name)}</span><span class="pos-tag">${esc(p.pos)}</span>${roleTags(p, g)}${injBadge(p)}</td>
          ${TABLE_KEYS.map((k) => {
            const d = pr[k];
            if (!d) return `<td>–</td>`;
            return `<td title="This season avg ${fmt(avg(cur.map((r) => val(r, k))), 1)} · last 5 avg ${fmt(avg(last5.map((r) => val(r, k))), 1)}"><b>${fmt(d.mean, STATS[k].dec)}</b>${ROLES.mark(p, g.id, k, STATS[k].dec)}<span class="rng">${rangeTxt(d)}</span></td>`;
          }).join("")}
          <td>${pct(multi(p.pid, g).dd)}</td><td>${cur.length}</td></tr>`;
      }).join("")}</tbody></table></div>` : `<div class="empty">No players with recent minutes found.</div>`}`;
  el.querySelectorAll("[data-team]").forEach((b) => b.onclick = () => { state.team = b.dataset.team; renderPlayers(g); });
  el.querySelectorAll("tr[data-pid]").forEach((tr) => tr.onclick = () => openPlayer(tr.dataset.pid, g));
}

// ---------------------------------------------------------------- teammate injuries

const RATE_KEYS = ["pts", "reb", "ast", "fg3", "stl", "blk", "tov", "fg3a", "fg2", "fg2a"];
const COMBO_KEYS = ALL_KEYS.filter((k) => STATS[k].parts);
const posGroup = (pos) => (/C/.test(pos || "") ? 2 : /F/.test(pos || "") ? 1 : 0);   // guard, forward, center

// Mirrors fit_team_minutes() in scripts/nba_build.py: the five likeliest starters start (a
// backup moving into the lineup gets halfway to his starter minutes), then everyone's expected
// minutes are scaled to the team's total. Cuts fall mostly on the bench; additions go to
// whoever has room below 40, more to players at an injured player's position (aff).
const PROMOTE_W = 0.5, STARTER_CUT = 0.4;
function fitTeamMinutes(players, target) {
  const n = players.length;
  if (!n) return { mult: [], starters: new Set() };
  let m = players.map((p) => p.min);
  const order = [...players.keys()].sort((a, b) => (players[b].st + (players[b].bonus || 0)) - (players[a].st + (players[a].bonus || 0)) || m[b] - m[a]);
  const starters = new Set(order.slice(0, 5));
  players.forEach((p, i) => {
    if (starters.has(i) && p.st < 0.5) m[i] = Math.max(m[i], PROMOTE_W * p.ms + (1 - PROMOTE_W) * m[i]);
    else if (!starters.has(i) && p.st >= 0.5) m[i] = Math.min(m[i], PROMOTE_W * p.mb + (1 - PROMOTE_W) * m[i]);
  });
  const pp = players.map((p) => p.pp);
  for (let it = 0; it < 4; it++) {
    const gap = target - m.reduce((a, mi, i) => a + mi * pp[i], 0);
    if (Math.abs(gap) < 0.5) break;
    const w = m.map((mi, i) => gap < 0 ? mi * pp[i] * (starters.has(i) ? STARTER_CUT : 1) : mi * pp[i] * Math.max(0, 40 - mi) / 40 * (players[i].aff || 1));
    const W = w.reduce((a, b) => a + b, 0);
    if (W <= 0) break;
    m = m.map((mi, i) => Math.max(0, Math.min(42, mi + gap * w[i] / W / Math.max(pp[i], 0.2))));
  }
  return { mult: m.map((mi, i) => (players[i].min > 0 ? mi / players[i].min : 1)), starters };
}

// The data file's minutes already add up with everyone available. Here the injury report
// takes players out (Doubtful ones play a quarter of the time), the lineup and minutes are
// refit, and every stat moves with the minutes. Scoring, rebounding, and passing the extra
// minutes don't cover gets spread across the rest (bigger roles for everyone), less 10%
// because teams usually play a bit worse without a regular. Then it's blended with how each
// teammate really did in past games without him.
function adjustForInjuries() {
  ROLES.reset(DATA);
  for (const g of DATA.games) {
    g.starters = {};
    for (const tm of [g.home, g.away]) {
      const roster = (g.players[tm] || []).map((pid) => DATA.players[pid]);
      const outs = roster.filter((p) => ROLES.outWeight(p));
      const avail = roster.filter((p) => ROLES.outWeight(p) < 1);
      const before = new Map(roster.map((p) => [p, p.proj[g.id].pts.mean]));
      // a starter who is out opens a spot, most likely for a backup at his position
      const gone = outs.filter((m) => ROLES.outWeight(m) === 1 && (m.role?.[g.id]?.st || 0) >= 0.5);
      const info = avail.map((p) => {
        const r = p.role?.[g.id] || { st: 0, ms: p.proj[g.id].min.mean, mb: p.proj[g.id].min.mean, pp: 1 };
        const near = outs.some((m) => posGroup(m.pos) === posGroup(p.pos));
        return { ...r, min: p.proj[g.id].min.mean, pp: r.pp * (ROLES.outWeight(p) ? 0.25 : 1),
                 bonus: gone.some((m) => posGroup(m.pos) === posGroup(p.pos)) ? 0.3 : 0, aff: near ? 2 : 1 };
      });
      const fit = fitTeamMinutes(info, 240 - (g.bench_min?.[tm] || 0));
      g.starters[tm] = new Set([...fit.starters].map((i) => avail[i]));
      const added = new Map();
      avail.forEach((p, i) => {
        const d = p.proj[g.id], r = fit.mult[i];
        added.set(p, d.min.mean * (r - 1));
        if (Math.abs(r - 1) < 1e-3) return;
        for (const k of ["min", ...RATE_KEYS]) ROLES.scale(d[k], r);
        if (outs.length && r > 1.02) for (const m of outs) ROLES.because(p, g.id, m);
      });
      const mates = avail.filter((p) => !ROLES.outWeight(p));
      for (const m of outs) {
        const share = ROLES.outWeight(m) * ROLES.share(m, tm, roster, "d", g.date, 5);
        const mp = m.base[g.id];
        if (share < 0.2 || mp.min.mean < 10) continue;
        // what the added minutes already cover at each teammate's own per-minute rates
        for (const k of RATE_KEYS) {
          const covered = mates.reduce((a, p) => {
            const b = p.base[g.id]; return a + (b.min.mean > 0 ? Math.max(0, added.get(p)) * b[k].mean / b.min.mean : 0);
          }, 0) / outs.length;
          const gap = share * mp[k].mean * 0.9 - covered;
          const pool = mates.reduce((a, p) => a + p.proj[g.id][k].mean, 0);
          if (gap > 0 && pool > 0) for (const p of mates) { ROLES.scale(p.proj[g.id][k], 1 + gap / pool); ROLES.because(p, g.id, m); }
        }
        // real games without him
        for (const p of mates) {
          const d = p.proj[g.id], rm = d.pts.mean / Math.max(before.get(p), 0.1);
          const r = ROLES.blend(p, m, (x) => x.pts, "d", rm);
          if (Math.abs(r - rm) > 1e-6) for (const k of RATE_KEYS) ROLES.scale(d[k], Math.max(0.6, r / rm));
        }
      }
      const lost = outs.reduce((a, m) => a + ROLES.outWeight(m) * ROLES.share(m, tm, roster, "d", g.date, 5) * m.base[g.id].pts.mean, 0);
      if (outs.length) ROLES.cap(mates, mates.map((p) => before.get(p)), lost, (p) => p.proj[g.id].pts.mean,
        (p, r) => { for (const k of RATE_KEYS) ROLES.scale(p.proj[g.id][k], r); });
      // combined props follow their parts
      for (const p of roster) {
        const d = p.proj[g.id], b = p.base[g.id];
        if (!d) continue;
        for (const c of COMBO_KEYS) {
          const was = STATS[c].parts.reduce((a, k) => a + b[k].mean, 0), now = STATS[c].parts.reduce((a, k) => a + d[k].mean, 0);
          if (was > 0) ROLES.scale(d[c], now / was);
        }
      }
    }
  }
  for (const g of DATA.games) for (const tm of [g.home, g.away]) {
    for (const pid of g.players[tm] || []) if (ROLES.outWeight(DATA.players[pid]) >= 1) ROLES.zeroOut(DATA.players[pid], g.id);
  }
  DD_CACHE.clear();
}

// ---------------------------------------------------------------- double-doubles

// Points, rebounds, and assists rise and fall together (more minutes, more of everything),
// so these are simulated jointly instead of multiplied. Correlation 0.3 is typical game to game.
const DD_CACHE = new Map();
function multi(pid, g) {
  const key = `${pid}|${g.id}`;
  if (DD_CACHE.has(key)) return DD_CACHE.get(key);
  const pr = DATA.players[pid].proj[g.id], keys = ["pts", "reb", "ast"], rho = 0.3, N = 4000;
  // whole-number cumulative tables for fast sampling
  const tabs = keys.map((k) => {
    const d = pr[k], hi = Math.ceil(quantile(0.9995, d)) + 1, t = [];
    for (let x = 0; x <= hi; x++) t.push(isCount(d) ? cdf(x, d) : cdf(x + 0.5, d));
    t[t.length - 1] = 1;
    return t;
  });
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
  const norm = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  let dd = 0, td = 0;
  for (let i = 0; i < N; i++) {
    const z0 = norm();
    let tens = 0;
    for (const t of tabs) {
      const u = Phi(Math.sqrt(rho) * z0 + Math.sqrt(1 - rho) * norm());
      let x = 0; while (t[x] < u) x++;
      if (x >= 10) tens++;
    }
    if (tens >= 2) dd++;
    if (tens === 3) td++;
  }
  const out = { dd: dd / N, td: td / N };
  DD_CACHE.set(key, out);
  return out;
}

// ---------------------------------------------------------------- player notes

const NOTE_STAT = { pts: ["scoring", "pts", 3], reb: ["rebounding", "reb", 2], ast: ["assists", "ast", 1.5], fg3: ["3-point", "threes", 1] };

// Reasons a player may have a good or bad night. The projections already include the
// matchup, pace, and teammates who are out; streaks are flagged here but not built in.
function playerNotes(p, g) {
  const out = [], pr = p.proj[g.id];
  if (p.inj?.status) {
    out.push({ kind: isOut(p) ? "bad" : "warn", text: `${p.inj.status}${p.inj.injury ? ` (${p.inj.injury})` : ""}${p.inj.note ? `. ${p.inj.note}` : ""}` });
    if (isOut(p)) return out;
  }
  // hot or cold: last 5 games against this season (or everything logged, early on)
  const cur = thisSeason(p), base = cur.length >= 8 ? cur : p.log, last = p.log.slice(-5);
  if (last.length >= 4 && base.length >= 6) {
    for (const [k, [, unit, minDiff]] of Object.entries(NOTE_STAT)) {
      const a = avg(last.map((r) => r[k])), b = avg(base.map((r) => r[k]));
      if (b < (k === "pts" ? 8 : 1.5)) continue;
      if (a >= 1.25 * b && a - b >= minDiff) out.push({ kind: "good", text: `Hot: ${fmt(a, 1)} ${unit} last ${last.length} (avg ${fmt(b, 1)})` });
      else if (a <= 0.75 * b && b - a >= minDiff) out.push({ kind: "bad", text: `Cold: ${fmt(a, 1)} ${unit} last ${last.length} (avg ${fmt(b, 1)})` });
    }
  }
  // teammates ruled out: show how this player did in past games without them
  for (const pid of g.players[p.team] || []) {
    const m = DATA.players[pid];
    if (m === p || !isOut(m) || ((m.base || m.proj)[g.id]?.min.mean || 0) < 20) continue;
    const sp = NOTES.without(p, m, (r) => r.pts, "d");
    if (sp && Math.abs(sp.without - sp.with) >= 2) {
      out.push({ kind: sp.without > sp.with ? "good" : "bad", text: `Without ${m.name} (out): ${fmt(sp.without, 1)} pts in ${sp.n} games vs ${fmt(sp.with, 1)} with him` });
    }
  }
  const up = ROLES.delta(p, g.id, "pts"), upMin = ROLES.delta(p, g.id, "min");
  if (up || upMin) out.push({ kind: up >= 0 && upMin >= 0 ? "good" : "bad", text: `Projection ${up >= 0 ? "up" : "down"} for ${p.why[g.id].join(", ")} out: ${fmt(p.base[g.id].pts.mean, 1)} → ${fmt(pr.pts.mean, 1)} pts, ${fmt(p.base[g.id].min.mean, 0)} → ${fmt(pr.min.mean, 0)} min` });
  for (const n of NOTES.newsFor(p.name).slice(0, 2)) out.push({ kind: "info", text: `News: ${n.headline}` });
  return out;
}

// Notes that apply to a whole team: matchup, tired legs, and expected blowouts
function teamNotes(g, tm) {
  const out = [];
  const prev = new Date(`${g.date}T12:00:00Z`); prev.setUTCDate(prev.getUTCDate() - 1);
  const played = (g.players[tm] || []).some((pid) => DATA.players[pid].log.at(-1)?.d === prev.toISOString().slice(0, 10));
  if (played) out.push({ kind: "warn", text: `${tm} played last night: rest days or lighter minutes possible` });
  // matchup and pace apply to the whole roster (and are already in every projection)
  const opp = tm === g.home ? g.away : g.home, sc = g.script[tm], O = DATA.teams[opp];
  const f = { pts: sc.pts_f, reb: sc.pace_f * O.f_reb, ast: sc.pace_f * O.f_ast, fg3: sc.pace_f * O.f_fg3 };
  for (const [k, [what]] of Object.entries(NOTE_STAT)) {
    if (f[k] >= 1.05) out.push({ kind: "good", text: `Good ${what} spot vs ${opp} (+${Math.round((f[k] - 1) * 100)}%)` });
    else if (f[k] <= 0.95) out.push({ kind: "bad", text: `Tough ${what} spot vs ${opp} (−${Math.round((1 - f[k]) * 100)}%)` });
  }
  const margin = g.script[tm].margin;
  if (margin > 10) out.push({ kind: "warn", text: `${tm} favored by ${fmt(margin, 0)}: its starters may sit late in a blowout` });
  return out;
}

function renderNotes(g) {
  const rows = [g.away, g.home].flatMap((tm) => [
    ...(teamNotes(g, tm).length ? [{ name: DATA.team_names[tm], tag: "team", notes: teamNotes(g, tm) }] : []),
    ...playerRows(g, tm).map((p) => ({ pid: p.pid, name: p.name, tag: `${p.team} ${p.pos}`, notes: playerNotes(DATA.players[p.pid], g) })),
  ]);
  NOTES.panel($("#notes"), rows, [
    ["ESPN injury report", "https://www.espn.com/nba/injuries"],
    ["RotoWire lineups", "https://www.rotowire.com/basketball/nba-lineups.php"],
    ["r/sportsbook", "https://www.reddit.com/r/sportsbook/"],
  ]);
  $("#notes").querySelectorAll(".note-row[data-pid]:not([data-pid=''])").forEach((r) => r.onclick = () => openPlayer(r.dataset.pid, g));
}

// ---------------------------------------------------------------- best spots

// Featured props for regulars, measured against each player's last 10 games before this one
function renderSpots(g) {
  const cand = [];
  for (const tm of [g.away, g.home]) {
    for (const p of playerRows(g, tm)) {
      if (ROLES.outWeight(p) || p.proj[g.id].min.mean < 20) continue;
      const recent = p.log.filter((r) => r.d < g.date).slice(-10);
      for (const k of FEATURED) {
        const d = p.proj[g.id][k], vals = recent.map((r) => val(r, k));
        if (!d || avg(vals) < (k === "pts" || k === "pra" ? 8 : 1.5)) continue;
        cand.push({ p, pid: p.pid, gid: g.id, k, d, vals, label: STATS[k].label, tag: `${p.team} ${p.pos}`, st: stability(vals) });
      }
    }
  }
  ROLES.spotsPanel($("#spots"), ROLES.spots(cand), {
    dec: (k) => STATS[k].dec,
    onAdd: (it) => addLeg({ label: `${it.p.name} over ${it.line} ${it.label.toLowerCase()}`, p: it.over, game: g.id }),
  });
  $("#spots").querySelectorAll("tr[data-pid]").forEach((tr) => tr.onclick = () => openPlayer(tr.dataset.pid, g));
}

// ---------------------------------------------------------------- storyline baskets

// NBA rules for baskets.js: Polymarket's team codes and stat names, which stats tell which
// story, and how each stat moves with the game (see simulate() there).
const PM_CODES = { GS: ["gsw", "gs"], NY: ["nyk", "ny"], SA: ["sas", "sa"], NO: ["nop", "no"], UTAH: ["uta", "utah"], WSH: ["was", "wsh"], BKN: ["bkn", "bk"], PHX: ["phx", "pho"] };
const PM_STATS = {
  points: "pts", pts: "pts", rebounds: "reb", reb: "reb", totalrebounds: "reb", assists: "ast", ast: "ast",
  threes: "fg3", threepointers: "fg3", threepointersmade: "fg3", "3pointersmade": "fg3", "3pt": "fg3", "3pm": "fg3", threepointfieldgoalsmade: "fg3", madethrees: "fg3",
  pointsreboundsassists: "pra", pra: "pra", ptsrebast: "pra", ptsrebsasts: "pra", pointsrebounds: "pr", ptsreb: "pr", pointsassists: "pa", ptsast: "pa", reboundsassists: "ra", rebast: "ra",
  steals: "stl", blocks: "blk", stealsblocks: "sb", turnovers: "tov",
};
// share of a stat's game-to-game swing that follows its team's scoring (b), kept modest because teammates also
// compete for the same shots; starters lose a little in blowouts (w)
const PM_LOAD = { pts: 0.3, fg3: 0.2, ast: 0.25, reb: 0.1, pra: 0.3, pr: 0.25, pa: 0.3, ra: 0.2, stl: 0.05, blk: 0.05, sb: 0.05, tov: 0.1 };
const PM_TAGS = { pts: ["score"], fg3: ["score"], ast: ["help"], reb: ["help"], ra: ["help"], pra: ["big"], pr: ["big"], pa: ["big"] };
function basketAdapter(g) {
  const nickOf = (tm) => (DATA.team_names[tm] || tm).split(" ").slice(-1)[0];
  const info = (pid) => {
    const p = DATA.players[pid], d = p?.proj[g.id];
    if (!d) return null;
    const w = ROLES.outWeight(p);
    return { pid, name: p.name, team: p.team, pos: p.pos, d, skip: w >= 0.75, q: !w && p.inj?.status ? p.inj.status : null, core: d.min.mean >= 24 };
  };
  const roster = [g.away, g.home].flatMap((tm) => (g.players[tm] || []).map(info).filter(Boolean));
  const byId = new Map(roster.map((r) => [r.pid, r]));
  const big = { pts: 10, reb: 5, ast: 4, fg3: 1.5, pra: 20 };
  return {
    league: "nba", daysBefore: 0,
    gameDay: () => g.date, kickoff: () => Date.parse(g.t), isPost: () => RESULT.state(g) === "post", isLive: () => RESULT.state(g) === "in",
    codes: (tm) => PM_CODES[tm] || [tm.toLowerCase()],
    nicknames: (tm) => [nickOf(tm).toLowerCase().replace(/[^a-z0-9]/g, "")],
    shortName: nickOf,
    runMargin: 10, closeMargin: 5,
    roster: () => roster, player: (pid) => byId.get(pid),
    statKey: (type, text) => PM_STATS[type] || PM_STATS[text] || null,
    statLabel: (k) => (STATS[k].parts ? STATS[k].short : STATS[k].label.toLowerCase()),
    storyKeys: (pl) => Object.keys(big).filter((k) => pl.d[k]?.mean >= big[k]),
    // a line on Polymarket's own ladder (5s for points and PRA, 2s for rebounds and assists) near the q-th quantile
    lineAt: (pl, k, q) => { const step = stepFor(k, pl.d[k]); return Math.max(step, Math.round(quantile(q, pl.d[k]) / step) * step) - 0.5; },
    mainLine: (pl, k) => Math.floor(pl.d[k].mean) + 0.5,
    prob: (pl, k, line) => (pl.d[k] ? probs(pl.d[k], line) : null),
    tags: (pl, k) => PM_TAGS[k] || [],
    load: (pl, k) => ({ b: PM_LOAD[k] ?? 0.2, m: 0, pass: 0, w: pl.d.min.mean >= 28 ? -0.25 : pl.d.min.mean < 18 ? 0.15 : 0 }),
    duo: { a: "score", b: "help", title: (t) => `Big night for a ${t} scorer and a playmaker`, blurb: (t) => `One ${t} player piles up points while a teammate racks up assists or rebounds. Both ride the same good night for the offense.` },
    carry: { tag: "big", title: (t) => `Two players carry the ${t}`, blurb: (t) => `Two ${t} regulars fill the stat sheet (points, rebounds, and assists together).` },
    runTags: ["score", "big"], scoreTags: ["score", "big"],
    blowoutNote: " In a true blowout the winners' starters can sit the fourth quarter, which the odds account for.",
  };
}

// ---------------------------------------------------------------- alt-line finder

function finderLine(d, k, p, conf, side) {
  const levels = ladder(k, d, 0.01, 0.99, Infinity);
  if (side === "over") {
    const ok = levels.filter((r) => r.p >= conf && r.x >= 1);
    return ok.length ? ok[ok.length - 1] : null;
  }
  const ok = levels.filter((r) => 1 - r.p >= conf);
  return ok.length ? { x: ok[0].x, p: 1 - ok[0].p } : null;
}

function renderFinder(g) {
  const el = $("#finder");
  const items = [];
  for (const tm of [g.away, g.home]) {
    for (const p of playerRows(g, tm)) {
      if (isOut(p) || p.proj[g.id].min.mean < 16) continue;   // skip deep bench: their minutes swing too much
      for (const k of FEATURED) {
        if (state.prop !== "ALL" && k !== state.prop) continue;
        const d = p.proj[g.id][k];
        if (!d || d.mean < 1) continue;
        const r = finderLine(d, k, p, state.conf, state.side);
        if (!r) continue;
        const vals = p.log.map((x) => val(x, k));
        const st = stability(vals);
        const hits = vals.filter((v) => (state.side === "over" ? v >= r.x : v < r.x)).length;
        items.push({ p, k, d, x: r.x, prob: r.p, st, hits, n: vals.length });
      }
    }
  }
  items.sort((a, b) => (a.st.cv ?? 9) - (b.st.cv ?? 9));
  const lineTxt = (it) => (state.side === "over" ? `${it.x}+` : `Under ${it.x}`);
  el.innerHTML = `
    <div class="panel-head"><h2>Alt-line finder</h2><span class="muted small">The ${state.side === "over" ? "highest" : "lowest"} Polymarket-style line each player should ${state.side === "over" ? "reach" : "stay under"} at your chosen confidence. Steadiest players first.</span></div>
    <div class="tabs">
      ${["over", "under"].map((s) => `<button class="chip" data-side="${s}" aria-pressed="${s === state.side}">${s === "over" ? "Overs" : "Unders"}</button>`).join("")}
      <span style="width:12px"></span>
      ${[0.6, 0.7, 0.75, 0.8, 0.9].map((c) => `<button class="chip" data-conf="${c}" aria-pressed="${c === state.conf}">${pct(c)}</button>`).join("")}
    </div>
    <div class="tabs">
      ${["ALL", ...FEATURED].map((k) => `<button class="chip" data-prop="${k}" aria-pressed="${k === state.prop}">${k === "ALL" ? "All props" : STATS[k].label}</button>`).join("")}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Prop</th><th>Line</th><th>Model chance</th><th>Fair price</th><th>Hit, last ${Math.max(...items.map((i) => i.n), 0)} games</th><th>Consistency</th><th></th></tr></thead>
      <tbody>${items.map((it, i) => `<tr>
        <td><span class="pname">${esc(it.p.name)}</span><span class="pos-tag">${it.p.team}</span>${injBadge(it.p)}</td>
        <td>${STATS[it.k].label}</td>
        <td>${lineTxt(it)}</td>
        <td><b>${pct(it.prob)}</b></td>
        <td>${cents(it.prob)}</td>
        <td>${it.hits} of ${it.n}</td>
        <td><span class="stab ${it.st.cls}">${it.st.label}</span></td>
        <td><button class="btn add" data-i="${i}">+ Slip</button></td></tr>`).join("")}</tbody>
    </table></div>
    <div class="note">"Hit" counts recent games (this season, plus the end of last season early on) that would have cleared the line. Teammates listed Out or Doubtful are built in; a late scratch isn't until the page refreshes.</div>`;
  el.querySelectorAll("[data-side]").forEach((b) => b.onclick = () => { state.side = b.dataset.side; renderFinder(g); });
  el.querySelectorAll("[data-conf]").forEach((b) => b.onclick = () => { state.conf = Number(b.dataset.conf); renderFinder(g); });
  el.querySelectorAll("[data-prop]").forEach((b) => b.onclick = () => { state.prop = b.dataset.prop; renderFinder(g); });
  el.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
    const it = items[Number(b.dataset.i)];
    addLeg({ label: `${it.p.name} ${lineTxt(it)} ${STATS[it.k].label.toLowerCase()}`, p: it.prob, game: g.id });
  });
}

// ---------------------------------------------------------------- odds ladders

// Polymarket's steps: 5 for points and point combos, 2 for rebounds, assists, and rebounds + assists,
// 1 for threes, steals, blocks, and turnovers
function stepFor(k, d) {
  if (k === "pts" || k === "pra" || k === "pr" || k === "pa") return 5;
  if (k === "reb" || k === "ast" || k === "ra") return 2;
  return 1;
}

// "X+" rows from very likely down to unlikely. p = chance of X or more.
function ladder(k, d, qlo = 0.08, qhi = 0.93, maxRows = 16) {
  const step = stepFor(k, d);
  const lo = Math.max(step === 1 ? 1 : step, Math.ceil(quantile(qlo, d) / step) * step);
  const hi = Math.max(lo, Math.floor(quantile(qhi, d) / step) * step);
  let s = step;
  while ((hi - lo) / s > maxRows - 1) s += step;   // keep the step unless the table would run past maxRows
  const rows = [];
  for (let x = lo; x <= hi; x += s) rows.push({ x, p: probs(d, x - 0.5).over });
  return rows;
}

// ---------------------------------------------------------------- player detail

function chartSvg(log, k, d) {
  const W = 300, H = 120, padL = 26, padB = 22, padT = 8;
  const vals = log.map((r) => val(r, k));
  const maxV = Math.max(1, ...vals, quantile(0.9, d)) * 1.08;
  const n = log.length + 1;
  const bw = (W - padL - 6) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
  const cur = log.filter((r) => !r.ly).map((r) => val(r, k));
  const mean = avg(cur.length ? cur : vals);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(STATS[k].label)} by game">`;
  [0, maxV / 2].forEach((t) => { s += `<text x="${padL - 4}" y="${y(t) + 3}" text-anchor="end">${Math.round(t)}</text><line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" />`; });
  log.forEach((r, i) => {
    const x = padL + i * bw + 1;
    const v = val(r, k);
    s += `<rect x="${x}" y="${y(v)}" width="${Math.max(bw - 2, 1)}" height="${Math.max(0, y(0) - y(v))}" fill="var(--bar)" opacity="${r.ly ? 0.45 : 1}" rx="1.5"><title>${shortDate(r.d)} ${r.h ? "vs" : "@"} ${r.opp}${r.ly ? " (last season)" : ""}: ${v}</title></rect>`;
    if (n <= 12 || i % Math.ceil(n / 9) === 0) s += `<text x="${x + (bw - 2) / 2}" y="${H - 9}" text-anchor="middle">${esc(r.opp)}</text>`;
  });
  const x = padL + log.length * bw + 1;
  s += `<rect x="${x}" y="${y(quantile(0.9, d))}" width="${bw - 2}" height="${y(quantile(0.1, d)) - y(quantile(0.9, d))}" fill="var(--band80)" rx="2"><title>80% range</title></rect>`;
  s += `<rect x="${x}" y="${y(quantile(0.75, d))}" width="${bw - 2}" height="${Math.max(1, y(quantile(0.25, d)) - y(quantile(0.75, d)))}" fill="var(--band50)" rx="2"><title>50% range</title></rect>`;
  s += `<line x1="${x}" x2="${x + bw - 2}" y1="${y(d.mean)}" y2="${y(d.mean)}" stroke="var(--bar-hi)" stroke-width="2.5"><title>Projection ${fmt(d.mean, 1)}</title></line>`;
  s += `<text x="${x + (bw - 2) / 2}" y="${H - 0.5}" text-anchor="middle">next</text>`;
  s += `<line x1="${padL}" x2="${x - 2}" y1="${y(mean)}" y2="${y(mean)}" stroke="var(--muted)" stroke-dasharray="3 3"><title>This season average ${fmt(mean, 1)}</title></line>`;
  return s + "</svg>";
}

const pv = { n: 10, stat: "pts" };

function openPlayer(pid, g) {
  renderPlayerView(pid, g);
  $("#modal").hidden = false;
  $("#modal").scrollTop = 0;
}

function renderPlayerView(pid, g) {
  const p = DATA.players[pid], pr = p.proj[g.id];
  const opp = p.team === g.home ? g.away : g.home;
  const recent = p.log.slice(-pv.n).reverse();
  const cur = thisSeason(p);
  const mm = multi(pid, g);
  const ddPast = recent.filter((r) => [r.pts, r.reb, r.ast].filter((v) => v >= 10).length >= 2).length;
  const card = $("#modal .modal-card");
  card.innerHTML = `
    <div class="modal-head">
      ${p.img ? `<img src="${esc(p.img)}" alt="">` : ""}
      <div><h2>${esc(p.name)} ${injBadge(p)}</h2>
        <div class="muted">${esc(DATA.team_names[p.team])} ${esc(p.pos)} · ${p.team === g.home ? "vs" : "@"} ${esc(DATA.team_names[opp])} · ${cur.length} games this season</div>
        <div class="small">Double-double <b>${pct(mm.dd)}</b> <span class="muted">(fair ${cents(mm.dd)}, ${american(mm.dd)}; ${ddPast} of last ${recent.length})</span>
          <button class="btn add" id="ddAdd">+ Slip</button>
          ${mm.td >= 0.005 ? ` · Triple-double <b>${pct(mm.td)}</b> <button class="btn add" id="tdAdd">+ Slip</button>` : ""}</div>
        ${(() => { const ns = [...playerNotes(p, g), ...teamNotes(g, p.team)]; return ns.length ? `<div class="note-chips" style="margin-top:6px">${ns.map(NOTES.chip).join("")}</div>` : ""; })()}</div>
      <button class="x" aria-label="Close">×</button>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Recent games</h3>
        <div class="tabs" style="margin:0">${[5, 10, 99].map((n) => `<button class="chip" data-n="${n}" aria-pressed="${n === pv.n}">${n === 99 ? "All" : `Last ${n}`}</button>`).join("")}</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Game</th>${ALL_KEYS.map((k) => `<th>${STATS[k].short}</th>`).join("")}</tr></thead>
        <tbody>
          ${recent.map((r) => `<tr><td>${shortDate(r.d)} ${r.h ? "vs" : "@"} ${esc(r.opp)}${r.tm !== p.team ? ` <span class="muted small">(${esc(r.tm)})</span>` : ""}${r.ly ? ` <span class="muted small">last season</span>` : ""}</td>${ALL_KEYS.map((k) => `<td>${val(r, k)}</td>`).join("")}</tr>`).join("")}
          <tr class="sum"><td>Avg, ${pv.n === 99 ? "all shown" : `last ${recent.length}`}</td>${ALL_KEYS.map((k) => `<td>${fmt(avg(recent.map((r) => val(r, k))), 1)}</td>`).join("")}</tr>
          <tr class="sum"><td>This season avg</td>${ALL_KEYS.map((k) => `<td>${cur.length ? fmt(avg(cur.map((r) => val(r, k))), 1) : "–"}</td>`).join("")}</tr>
          <tr class="sum proj"><td>Projected vs ${opp}</td>${ALL_KEYS.map((k) => `<td><b>${fmt(pr[k].mean, 1)}</b></td>`).join("")}</tr>
          <tr class="sum"><td>Expected range (80%)</td>${ALL_KEYS.map((k) => `<td>${rangeTxt(pr[k])}</td>`).join("")}</tr>
          <tr class="sum"><td>Consistency</td>${ALL_KEYS.map((k) => { const st = stability(p.log.map((r) => val(r, k))); return `<td><span class="stab ${st.cls}">${st.label}</span></td>`; }).join("")}</tr>
        </tbody>
      </table></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Odds by line</h3><span class="muted small">Pick a stat</span></div>
      <div class="tabs">${PROP_KEYS.map((k) => `<button class="chip" data-stat="${k}" aria-pressed="${k === pv.stat}">${STATS[k].label}</button>`).join("")}</div>
      <div class="grid2" id="statDetail"></div>
    </div>`;
  card.querySelector(".x").onclick = closeModal;
  card.querySelector("#ddAdd").onclick = () => addLeg({ label: `${p.name} double-double`, p: mm.dd, game: g.id });
  const tdb = card.querySelector("#tdAdd"); if (tdb) tdb.onclick = () => addLeg({ label: `${p.name} triple-double`, p: mm.td, game: g.id });
  card.querySelectorAll("[data-n]").forEach((b) => b.onclick = () => { pv.n = Number(b.dataset.n); renderPlayerView(pid, g); });
  card.querySelectorAll("[data-stat]").forEach((b) => b.onclick = () => { pv.stat = b.dataset.stat; renderPlayerView(pid, g); });
  renderStatDetail(p, pv.stat, pr[pv.stat], g);
}

function renderStatDetail(p, k, d, g) {
  const el = $("#statDetail");
  const rows = ladder(k, d);
  const vals = p.log.map((r) => val(r, k));
  const name = STATS[k].label.toLowerCase();
  const factorTxt = d.f > 1.03 ? `Pace and matchup push this up ${Math.round((d.f - 1) * 100)}%.` : d.f < 0.97 ? `Pace and matchup pull this down ${Math.round((1 - d.f) * 100)}%.` : "Matchup is roughly neutral.";
  el.innerHTML = `
    <div>
      <div class="table-wrap"><table class="ladder">
        <thead><tr><th>Line</th><th>Chance</th><th>Fair price</th><th>Hit, last ${vals.length}</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td><b>${r.x}+</b> <span class="price">o${r.x - 0.5}</span></td><td><b>${pct(r.p)}</b></td><td>${cents(r.p)} · ${american(r.p)}</td>
          <td>${vals.filter((v) => v >= r.x).length} of ${vals.length}</td>
          <td><button class="btn add" data-i="${i}" data-s="yes">+ Yes</button> <button class="btn add" data-i="${i}" data-s="no">+ No</button></td></tr>`).join("")}</tbody>
      </table></div>
      <div class="liner"><label class="small muted">Other line</label><input type="number" step="0.5" min="0" value="${(rows[Math.floor(rows.length / 2)]?.x ?? 1) - 0.5}"><span class="out"></span></div>
    </div>
    <div class="statcard">
      <h3>${STATS[k].label} by game</h3>
      ${chartSvg(p.log, k, d)}
      <div class="small muted">Bars: each game, oldest to newest (faded = last season). Dashed line: this season's average. Last column: this game's projection with its 50% (dark) and 80% (light) ranges. 50% range ${Math.round(quantile(0.25, d))}–${Math.round(quantile(0.75, d))}. Projected ${fmt(p.proj[g.id].min.mean, 0)} minutes. ${factorTxt}</div>
    </div>`;
  el.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
    const r = rows[Number(b.dataset.i)], yes = b.dataset.s === "yes";
    addLeg({ label: `${p.name} ${yes ? `${r.x}+` : `under ${r.x}`} ${name}`, p: yes ? r.p : 1 - r.p, game: g.id });
  });
  const input = el.querySelector("input"), out = el.querySelector(".out");
  const update = () => {
    const L = Number(input.value), pr = probs(d, L);
    out.innerHTML = `<span class="prob">Over <b>${pct(pr.over)}</b></span> <button class="btn add" data-o="over">+</button>
      <span class="prob">Under <b>${pct(pr.under)}</b></span> <button class="btn add" data-o="under">+</button>`;
    out.querySelectorAll("[data-o]").forEach((b) => b.onclick = () => addLeg({
      label: `${p.name} ${b.dataset.o === "over" ? "Over" : "Under"} ${L} ${name}`, p: b.dataset.o === "over" ? pr.over : pr.under, game: g.id,
    }));
  };
  input.oninput = update; update();
}

function closeModal() { $("#modal").hidden = true; }

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
      ${sameGame ? `<div class="warnbox">Some legs are from the same game. Those tend to move together, so the true chance is different from this simple multiplied number. A player's points and the game total over help each other (higher than shown); two teammates' points overs compete for the same shots (lower than shown).</div>` : ""}
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
    <div class="modal-head"><h2>How the NBA model works</h2><button class="x" aria-label="Close">×</button></div>
    <div class="panel">
      <p><b>Minutes first.</b> Almost every NBA stat follows playing time, so the model projects minutes, then multiplies by what the player produces per minute. Minutes are estimated separately for games a player starts and comes off the bench (recent games count more), then mixed by how often he has started lately.</p>
      <p><b>Lineups that add up.</b> The five likeliest starters (from recent starts) are penciled in, and everyone's expected minutes are scaled so the team totals 240. Expected means minutes when he plays times how often he plays: a player who sits by coach's decision a third of the time counts for two thirds. Players ruled out are removed first, and a backup at the same position gets first shot at an open starting spot.</p>
      <p><b>This season first.</b> Last season counts as only one game's worth of minutes (half a game once his minutes clearly differ from last year's, marked "Bigger role" or "Smaller role") and six games' worth for per-minute production, which is steadier from year to year. On last season's games, these changes cut the average minutes miss from 5.0 to 4.6 in the first month and from 5.2 to 5.0 after that.</p>
      <p><b>Pace and matchup.</b> A fast game means more possessions and more stats for everyone. Rebounds, assists, and threes are scaled by how many the opponent allows per 100 possessions compared with the league. Points follow the team's implied score from the betting spread and total. Big favorites' starters lose a few minutes to expected blowouts.</p>
      <p><b>Ranges.</b> Each player's own game-to-game swing, blended with the typical swing for players with similar averages, then tuned until past 80% ranges really did catch about 80% of results. Rebounds, assists, threes, steals, blocks, and turnovers use count odds (negative binomial); points and combos use a smooth curve. Totals and spreads use the market line with an 18-point (total) and 12.5-point (margin) typical miss, nudged 20% toward a pace-and-efficiency model.</p>
      <p><b>Double-doubles.</b> Points, rebounds, and assists are simulated together, since a big-minutes night lifts all three.</p>
      <p><b>Teammates who are out.</b> When a regular is listed Out (or Doubtful, counted at 75%), the lineup and minutes are refit without him, with more of his minutes going to his position, and the scoring, rebounding, and passing those minutes don't cover is spread across the rest. Where a teammate has played games without him, those real numbers are blended in. Changed numbers carry a ▲ or ▼.</p>
      <p><b>What it doesn't know.</b> Late scratches until the page refreshes, minutes limits, and coaching choices. Check the injury report close to tip-off.</p>
      <p><b>Using it for alt lines.</b> If the model says 80% and Polymarket charges 70¢, that's a possible edge. If it charges 85¢, it isn't. Multiplying many 80% legs drops fast: five of them is about 33%.</p>
      <p><b>Storyline baskets.</b> On game day (or within 24 hours of tip-off) the page reads Polymarket's player and game markets for the game you're viewing, priced at the ask (what you'd pay right now), with thin or wide markets flagged. It simulates the game 6,000 times so legs move together the way they do in real games: a fast, high-scoring night lifts every scorer, a blowout sits the starters. For each story it picks 2–4 legs with the best expected return that together pay more than 4x net. How strongly legs move together is a reasoned estimate, not yet checked against past games. Below the baskets, <b>Underpriced props</b> lists single bets whose Polymarket price is at least 3¢ under the model's chance, biggest gap first.</p>
    </div>
    ${bt.length ? `<div class="panel"><h3>Track record</h3>
      <div class="small muted" style="margin-bottom:6px">${esc(BACKTEST.note)} A well-tuned model lands about 80% inside its 80% range and 50% inside its 50% range. "Avg miss" is the average gap between projection and result.</div>
      <div class="table-wrap"><table><thead><tr><th>Stat</th><th>Results</th><th>Inside 80% range</th><th>Inside 50% range</th><th>Avg miss</th><th>Avg miss using season avg</th></tr></thead>
      <tbody>${bt.map((r) => `<tr><td>${esc(r.stat)}</td><td>${r.n}</td><td>${pct(r.in80)}</td><td>${pct(r.in50)}</td><td>${fmt(r.mae, 2)}</td><td>${fmt(r.mae_season_avg, 2)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
  card.querySelector(".x").onclick = closeModal;
  $("#modal").hidden = false;
}

boot();
