"use strict";

// ---------------------------------------------------------------- stat definitions

// short: column name on its own; sub: column name under its group header (Passing / Rushing / ...)
const STATS = {
  att: { label: "Pass attempts", short: "Att", sub: "Att", group: "Passing", dec: 1 },
  cmp: { label: "Completions", short: "Cmp", sub: "Cmp", group: "Passing", dec: 1 },
  pyd: { label: "Passing yards", short: "Pass yds", sub: "Yds", group: "Passing", dec: 0 },
  ptd: { label: "Passing TDs", short: "Pass TD", sub: "TD", group: "Passing", dec: 2, count: true },
  int: { label: "Interceptions", short: "INT", sub: "INT", group: "Passing", dec: 2, count: true },
  car: { label: "Rush attempts", short: "Rush att", sub: "Att", group: "Rushing", dec: 1 },
  ryd: { label: "Rushing yards", short: "Rush yds", sub: "Yds", group: "Rushing", dec: 0 },
  rtd: { label: "Rushing TDs", short: "Rush TD", sub: "TD", group: "Rushing", dec: 2, count: true },
  tgt: { label: "Targets", short: "Tgt", sub: "Tgt", group: "Receiving", dec: 1 },
  rec: { label: "Receptions", short: "Rec", sub: "Rec", group: "Receiving", dec: 1 },
  yds: { label: "Receiving yards", short: "Rec yds", sub: "Yds", group: "Receiving", dec: 0 },
  td: { label: "Receiving TDs", short: "Rec TD", sub: "TD", group: "Receiving", dec: 2, count: true },
  rry: { label: "Rush + rec yards", short: "Rush+rec yds", sub: "Rush+rec yds", group: "Total", dec: 0 },
};
// Full stat line for each position: QBs pass and run, backs run and catch, receivers catch and run
const POS_STATS = {
  QB: ["att", "cmp", "pyd", "ptd", "int", "car", "ryd", "rtd"],
  RB: ["car", "ryd", "rtd", "tgt", "rec", "yds", "td", "rry"],
  WR: ["tgt", "rec", "yds", "td", "car", "ryd", "rtd", "rry"],
  TE: ["tgt", "rec", "yds", "td", "car", "ryd", "rtd", "rry"],
};
// Two header rows: the group (Passing, Rushing, Receiving) over its columns. `lead` and `tail`
// are the plain columns before and after the stats. A thin rule starts each group.
const groupStart = (keys, i) => i === 0 || STATS[keys[i]].group !== STATS[keys[i - 1]].group;
function statHead(keys, lead, tail = []) {
  const groups = [];
  keys.forEach((k, i) => { if (groupStart(keys, i)) groups.push({ name: STATS[k].group, n: 1 }); else groups[groups.length - 1].n++; });
  const th = (t) => `<th rowspan="2">${t}</th>`;
  return `<thead>
    <tr class="grp">${lead.map(th).join("")}${groups.map((g) => `<th colspan="${g.n}" class="gs">${g.name}</th>`).join("")}${tail.map(th).join("")}</tr>
    <tr>${keys.map((k, i) => `<th class="${groupStart(keys, i) ? "gs" : ""}">${STATS[k].sub}</th>`).join("")}</tr>
  </thead>`;
}
const gsCls = (keys, i) => (groupStart(keys, i) ? ` class="gs"` : "");

// ---------------------------------------------------------------- team records

function recText(r) { return r ? `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}` : ""; }
function record(ab) { return recText(DATA.teams[ab]?.record); }
// "5-2 · 2-1 away · Won 2 · last 5 WWLWW"
function recordLine(ab, where) {
  const r = DATA.teams[ab]?.record;
  if (!r) return where === "home" ? "Home" : "Away";
  const [w, l, t] = r[where];
  const streak = r.streak ? `${r.streak[0] === "W" ? "Won" : r.streak[0] === "L" ? "Lost" : "Tied"} ${r.streak.slice(1)}` : "";
  const div = r.div.some((x) => x) ? ` · ${recText({ w: r.div[0], l: r.div[1], t: r.div[2] })} division` : "";
  return `<b class="rec">${recText(r)}</b><span class="rec-more"> · ${w}-${l}${t ? `-${t}` : ""} ${where}${div}${streak ? ` · ${streak}` : ""}${r.last5 ? ` · last ${r.last5.length}: ${r.last5}` : ""}</span><span class="rec-short"> ${where}</span>`;
}
// the props worth betting, by position, for the alt-line finder
const FEATURED = { QB: ["att", "cmp", "pyd", "ptd"], RB: ["car", "ryd", "rec", "yds", "rry"], WR: ["rec", "yds", "td"], TE: ["rec", "yds", "td"] };
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
function gammaCdf(x, mean, sd) {
  if (mean <= 0 || sd <= 0) return x >= mean ? 1 : 0;
  const shape = (mean / sd) ** 2, scale = sd ** 2 / mean;
  return gammaincLower(shape, x / scale);
}
// "gmix": a normal-game curve plus a small dud-game curve (see scripts/model.py)
function gmixParts(p) {
  const mb = p.mean / (1 - p.w + p.w * p.r), sb = p.mean > 0 ? p.sd * mb / p.mean : p.sd;
  return [[1 - p.w, mb, sb], [p.w, mb * p.r, sb * p.k]];
}
function totalSd(p) {
  if (p.dist !== "gmix") return p.sd;
  const m2 = gmixParts(p).reduce((a, [w, m, s]) => a + w * (s * s + m * m), 0);
  return Math.sqrt(Math.max(m2 - p.mean ** 2, 0));
}
function cdf(x, p) {
  if (p.dist === "poisson") return poissonCdf(Math.floor(x), p.mean);
  if (p.dist === "normal") return 0.5 * (1 + erf((x - p.mean) / (p.sd * Math.SQRT2)));
  if (p.dist === "gmix") return p.mean <= 0 ? (x >= 0 ? 1 : 0) : gmixParts(p).reduce((a, [w, m, s]) => a + w * gammaCdf(x, m, s), 0);
  return gammaCdf(x, p.mean, p.sd);
}
function quantile(q, p) {
  if (p.dist === "poisson") { let k = 0; while (poissonCdf(k, p.mean) < q && k < 50) k++; return k; }
  let lo = p.dist === "normal" ? p.mean - 10 * p.sd : 0, hi = p.mean + 12 * totalSd(p) + 1;
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
const state = { view: null, week: null, gameId: null, team: null, pos: "ALL", conf: 0.75, side: "over" };
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
    const out = {}, scores = {};
    for (const ev of j.events || []) {
      const c = ev.competitions?.[0]; if (!c) continue;
      const side = {}; for (const t of c.competitors) side[t.homeAway] = ESPN_TEAM[t.team.abbreviation] || t.team.abbreviation;
      const key = `${side.away}@${side.home}`;
      scores[key] = RESULT.fromEspn(ev);
      const o = c.odds?.[0];
      if (!o || o.spread == null || o.overUnder == null) continue;
      out[key] = { spread: -Number(o.spread), total: Number(o.overUnder), src: o.provider?.name || "ESPN" };
    }
    return { lines: out, scores };
  } finally { clearTimeout(t); }
}

async function refreshLines(manual) {
  const btn = $("#refreshBtn"); if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  const fileTime = new Date(DATA.updated).getTime();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LINES_KEY) || "{}"); } catch (e) { saved = {}; }
  let live = 0, ok = false, reached = false, scores = {};
  try {
    for (const w of DATA.weeks) {
      const { lines, scores: sc } = await fetchEspnLines(w);
      Object.assign(scores, sc);
      const now = Date.now();
      for (const [key, l] of Object.entries(lines)) { saved[key] = { ...l, t: now }; live++; }
    }
    ok = live > 0; reached = true;
    try { localStorage.setItem(LINES_KEY, JSON.stringify(saved)); } catch (e) { /* private mode */ }
  } catch (e) { ok = false; }
  for (const g of DATA.games) {
    const l = saved[`${g.away}@${g.home}`];
    if (l && l.t > fileTime && RESULT.state(g) !== "post") applyLine(g, l.spread, l.total, `${l.src} (live)`, l.t);
    if (scores[`${g.away}@${g.home}`]) g.live = scores[`${g.away}@${g.home}`];
  }
  LINE_STATUS = ok
    ? `Lines live from ESPN as of ${new Date().toLocaleTimeString()}`
    : reached
    ? `ESPN answered but has no lines posted yet for these games (checked ${new Date().toLocaleTimeString()}); showing the lines in the data file`
    : `Live lines blocked here, showing saved lines from ${new Date(Math.max(fileTime, ...Object.values(saved).map((l) => l.t || 0))).toLocaleString()}`;
  if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  await refreshInjuries();
  renderMeta(); renderGames();
}
let LINE_STATUS = "Checking for live lines…";

// ESPN's injury report is newer than the data file's (nflverse posts it once a day), so use
// it when this computer can reach it. NFL ids differ between the two, so match by name.
let NEWS_STATUS = "";
async function refreshInjuries() {
  try {
    const { byName, count } = await NOTES.injuries("football/nfl");
    if (count) {
      for (const p of Object.values(DATA.players)) {
        const e = byName[NOTES.norm(p.name)];
        if (e) p.inj = { ...e, wk: DATA.week, practice: p.inj?.practice || null }; else delete p.inj;
      }
      NEWS_STATUS = ` · injury report live as of ${new Date().toLocaleTimeString()}`;
    }
  } catch (e) { /* keep the file's injury report */ }
  try { await NOTES.news("football/nfl"); } catch (e) { /* headlines are optional */ }
  adjustForInjuries();
}

// reload the data file (rebuilt hourly) and re-check lines, injuries, and headlines
async function reloadAll() {
  BASKETS.clear();
  try { DATA = await loadData(); computeRanks(); } catch (e) { /* keep what we have */ }
  await refreshLines(true);
}

// short in the header, the whole story on hover
const lineShort = () => (/^Lines live/.test(LINE_STATUS) ? "live lines" : /blocked/.test(LINE_STATUS) ? "saved lines (ESPN blocked here)" : /no lines posted/.test(LINE_STATUS) ? "no live lines posted yet" : "checking lines…");
// say so in the header when the scheduled rebuild has stopped publishing
const staleNote = () => {
  const h = (Date.now() - new Date(DATA.updated).getTime()) / 36e5;
  return h >= 12 ? ` · data file is ${Math.round(h)} hours old` : "";
};
function renderMeta() {
  $("#meta").textContent = `${DATA.season} · stats through week ${DATA.stats_through} · ${lineShort()}` + staleNote();
  $("#meta").title = `Data file ${new Date(DATA.updated).toLocaleString()} · ${LINE_STATUS}${NEWS_STATUS}`;
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
  adjustForInjuries();
  const hash = new URLSearchParams(location.hash.slice(1));
  state.week = Number(hash.get("week")) || DATA.week;
  if (!DATA.weeks.includes(state.week)) state.week = DATA.weeks[0];
  state.gameId = hash.get("game");
  state.view = hash.get("view") === "props" ? "props" : null;
  renderMeta();
  $("#refreshBtn").onclick = reloadAll;
  $("#propsBtn").onclick = openProps;
  NOTES.autoRefresh(reloadAll);
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
  if (state.view) h.set("view", state.view);
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
  $("#weeks").querySelectorAll("button").forEach((b) => b.onclick = () => { state.view = null; state.week = Number(b.dataset.w); state.gameId = null; renderWeeks(); renderGames(); });
}

function renderGames() {
  const games = DATA.games.filter((g) => g.week === state.week);
  // open on the first game that isn't over yet
  if (!games.find((g) => g.id === state.gameId)) state.gameId = (games.find((g) => RESULT.state(g) !== "post") || games[0])?.id;
  $("#games").innerHTML = PROPS_CARD() + (games.map((g) => `
    <button type="button" class="gcard ${RESULT.state(g)}" data-id="${g.id}" aria-current="${!state.view && g.id === state.gameId}">
      <div class="row"><span class="teams">${RESULT.teams(g)}</span>${RESULT.badge(g) || `<span class="when">${esc(kickoff(g))}</span>`}</div>
      <div class="lines">${RESULT.state(g) === "post" ? esc(RESULT.settled(g)) : `${esc(spreadText(g))} · O/U ${g.total ?? "–"}`}</div>
      ${record(g.away) ? `<div class="recs">${g.away} ${record(g.away)} · ${g.home} ${record(g.home)}</div>` : ""}
    </button>`).join("") || `<div class="empty">No games this week.</div>`);
  $("#games").querySelectorAll(".gcard[data-id]").forEach((b) => b.onclick = () => { state.view = null; state.gameId = b.dataset.id; state.team = null; renderGames(); });
  $("#games").querySelector("[data-props]").onclick = openProps;
  setHash();
  renderGame();
}

// ---------------------------------------------------------------- game view

function curGame() { return DATA.games.find((g) => g.id === state.gameId); }

// ---------------------------------------------------------------- best bets: the lock plus best props, all games today and tomorrow

const PROPS_CARD = () => `
    <button type="button" class="gcard props-card" data-props aria-current="${state.view === "props"}">
      <div class="row"><span class="teams">🔒 Best bets</span></div>
      <div class="lines">Lock of the week + best mispriced props</div>
    </button>`;
function openProps() { state.view = "props"; renderGames(); window.scrollTo({ top: 0 }); }
function openFromProps(id) {
  const g = DATA.games.find((x) => x.id === id);
  if (!g) return;
  state.view = null; state.gameId = id; state.team = null; state.week = g.week;
  renderWeeks(); renderGames(); window.scrollTo({ top: 0 });
}
function renderProps() {
  let el = $("#allprops");
  if (!el) { $("#game").innerHTML = `<div class="panel" id="allprops"></div>`; el = $("#allprops"); }
  ALLPROPS.render(el, { games: DATA.games, adapter: basketAdapter, onOpen: openFromProps, sport: "NFL" });
}

function renderGame() {
  if (state.view === "props") return renderProps();
  const g = curGame();
  if (!g) { $("#game").innerHTML = ""; return; }
  if (!state.team) state.team = "BOTH";
  const N = DATA.team_names;
  $("#game").innerHTML = `
    <div class="panel">
      <div class="scoreline">
        <div class="team"><img src="${logo(g.away)}" alt=""><div><div class="name">${esc(N[g.away])}</div><div class="muted small">${recordLine(g.away, "away")}</div></div></div>
        <div class="mid">${RESULT.mid(g, `${fmt(g.model.away_pts, 1)} – ${fmt(g.model.home_pts, 1)}`)}</div>
        <div class="team right"><div><div class="name">${esc(N[g.home])}</div><div class="muted small">${recordLine(g.home, "home")}</div></div><img src="${logo(g.home)}" alt=""></div>
      </div>
      <div class="kv">
        <span>Market spread <b>${esc(spreadText(g))}</b></span>
        <span>Market total <b>${g.total ?? "–"}</b></span>
        ${g.away_ml != null ? `<span>Moneyline <b>${g.away} ${g.away_ml > 0 ? "+" : ""}${g.away_ml} / ${g.home} ${g.home_ml > 0 ? "+" : ""}${g.home_ml}</b></span>` : ""}
        <span>Stats-only model: total <b>${fmt(g.model.model_total, 1)}</b>, ${g.model.model_margin >= 0 ? g.home : g.away} by <b>${fmt(Math.abs(g.model.model_margin), 1)}</b></span>
        <span class="muted">${esc(kickoff(g))} · ${esc(g.roof || "")}${g.wind != null ? ` · wind ${g.wind} mph` : ""}${g.temp != null ? ` · ${g.temp}°F` : ""} · lines: ${esc(g.line_src)}, as of ${new Date(g.lines_asof || DATA.updated).toLocaleString()}</span>
      </div>
    </div>

    ${GAME_TABS.bar()}
    <div data-tab="bets">
      <div class="panel" id="baskets"></div>
    </div>
    <div data-tab="players">
      <div class="panel" id="players"></div>
      <div class="wide2">
        <div class="panel" id="tds"></div>
        <div class="panel" id="finder"></div>
      </div>
      <div class="panel" id="spots"></div>
    </div>
    <div data-tab="game">
      <div class="grid2">
        <div class="panel" id="totalTool"></div>
        <div class="panel" id="spreadTool"></div>
      </div>
      <div class="panel" id="teamTotals"></div>
      <div class="panel">
        <div class="panel-head"><h2>Matchup strength</h2><span class="muted small">Ratings use EPA per play (points added per play) vs. the league. 0 = average.</span></div>
        <div class="grid2">${matchupSide(g, g.away, g.home)}${matchupSide(g, g.home, g.away)}</div>
      </div>
    </div>
    <div data-tab="notes">
      <div class="panel" id="notes"></div>
    </div>
  `;
  GAME_TABS.wire($("#game"));
  renderTotalTool(g); renderSpreadTool(g); renderTeamTotals(g); renderPlayers(g); renderSpots(g); renderNotes(g); renderTds(g); renderFinder(g);
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
  const passEdge = T.rating.off_pass - O.rating.def_pass, rushEdge = T.rating.off_rush - O.rating.def_rush;
  let lean = "No strong lean either way.";
  if (passEdge - rushEdge > 0.75) lean = `Passing is the better path for ${tm} here.`;
  else if (rushEdge - passEdge > 0.75) lean = `Running is the better path for ${tm} here.`;
  const prDelta = (s.pass_rate - T.off.pass_rate) * 100;
  return `<div>
    <h3>${tm} offense vs ${opp} defense <span class="muted small">(${tm} ${record(tm)}, ${opp} ${record(opp)})</span></h3>
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
// ESPN also lists injured reserve and suspensions; treat those like Out
const isOut = (p) => /^(out|injured reserve|suspen)/i.test(p.inj?.status || "");
function injBadge(p) {
  const s = p.inj?.status;
  if (!s) return "";
  const tip = [p.inj.injury, p.inj.note, `week ${p.inj.wk}`].filter(Boolean).join(" · ");
  return `<span class="badge ${isOut(p) || s === "Doubtful" ? "out" : "q"}" title="${esc(tip)}">${esc(s)}</span>`;
}

function renderPlayers(g) {
  const el = $("#players");
  const posList = state.pos === "ALL" ? POS_ORDER : [state.pos];
  const teamBlock = (tm) => {
    const rows = playerRows(g, tm).filter((p) => state.pos === "ALL" || p.pos === state.pos);
    const tables = posList.map((pos) => {
      const ps = rows.filter((p) => p.pos === pos);
      if (!ps.length) return "";
      const keys = POS_STATS[pos];
      return `<h4>${pos}</h4><div class="table-wrap"><table class="statline">
        ${statHead(keys, ["Player"], ["Any TD", "Games"])}
        <tbody>${ps.map((p) => {
          const pr = p.proj[g.id];
          const last = p.log.slice(-3);
          if (ROLES.outWeight(p) >= 1) return `<tr class="click" data-pid="${p.pid}"><td><span class="pname">${esc(p.name)}</span>${injBadge(p)}</td>${ROLES.outRow(keys.length + 2)}</tr>`;
          return `<tr class="click" data-pid="${p.pid}"><td><span class="pname">${esc(p.name)}</span>${injBadge(p)}</td>
            ${keys.map((k, i) => {
              const d = pr[k];
              if (!d) return `<td${gsCls(keys, i)}>–</td>`;
              const season = p.log.reduce((a, r) => a + (r[k] || 0), 0) / p.log.length;
              const l3 = last.reduce((a, r) => a + (r[k] || 0), 0) / last.length;
              const rng = STATS[k].count ? `${pct(1 - poissonCdf(0, d.mean))} for 1+` : `${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}`;
              return `<td${gsCls(keys, i)} title="${STATS[k].label}: season avg ${fmt(season, 1)} · last 3 avg ${fmt(l3, 1)}"><b>${fmt(d.mean, STATS[k].dec)}</b>${ROLES.mark(p, g.id, k, STATS[k].dec)}<span class="rng">${rng}</span></td>`;
            }).join("")}
            <td class="gs"><b>${pct(anyTd(tdLambda(p, g)))}</b></td><td>${p.log.length}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }).join("");
    return `<div class="team-block"><h3><img src="${logo(tm)}" alt="">${esc(DATA.team_names[tm])} <span class="muted small">${record(tm)}</span></h3>
      ${tables || `<div class="empty">No players with recent snaps found.</div>`}</div>`;
  };
  const shown = state.team === "BOTH" ? [g.away, g.home] : [state.team];
  el.innerHTML = `
    <div class="panel-head"><h2>Player projections this game</h2><span class="muted small">Bold = projected average (▲▼ = changed for a teammate who is out; hover for details). Small text = 80% range (or chance of 1+ TD). Tap a player for game logs and lines.</span></div>
    <div class="tabs">
      ${["BOTH", g.away, g.home].map((t) => `<button class="chip" data-team="${t}" aria-pressed="${t === state.team}">${t === "BOTH" ? "Both teams" : esc(DATA.team_names[t])}</button>`).join("")}
      <span style="width:12px"></span>
      ${["ALL", ...POS_ORDER].map((p) => `<button class="chip" data-pos="${p}" aria-pressed="${p === state.pos}">${p === "ALL" ? "All" : p}</button>`).join("")}
    </div>
    <div class="team-cols">${shown.map(teamBlock).join("")}</div>`;
  el.querySelectorAll("[data-team]").forEach((b) => b.onclick = () => { state.team = b.dataset.team; renderPlayers(g); });
  el.querySelectorAll("[data-pos]").forEach((b) => b.onclick = () => { state.pos = b.dataset.pos; renderPlayers(g); });
  el.querySelectorAll("tr[data-pid]").forEach((tr) => tr.onclick = () => openPlayer(tr.dataset.pid, g));
}

// ---------------------------------------------------------------- teammate injuries

// Volume stats and the stats that ride on them (yards per carry, catch rate, and yards per
// target stay the same; there are just more or fewer chances)
const RIDES = { car: ["car", "ryd", "rtd"], tgt: ["tgt", "rec", "yds", "td"] };
// a backup QB is usually a bit less efficient than the starter
const BACKUP_QB = { att: 1, cmp: 0.95, pyd: 0.9, ptd: 0.85, int: 1.15, car: 1, ryd: 1, rtd: 1 };

// When a player is out, his carries go to the other backs and 90% of his targets go to the
// other receivers (most to the same position, by their current share), and that's blended
// with how each teammate really did in past games without him. A starting QB out hands his
// volume to the backup at lower efficiency, and his receivers lose a little.
function adjustForInjuries() {
  ROLES.reset(DATA);
  for (const g of DATA.games) {
    for (const tm of [g.home, g.away]) {
      const roster = (g.players[tm] || []).map((pid) => DATA.players[pid]);
      for (const m of roster) {
        const w = ROLES.outWeight(m);
        if (!w) continue;
        const share = w * ROLES.share(m, tm, roster, "w", g.week, 3);
        if (share < 0.2) continue;
        const mp = m.base[g.id], mates = roster.filter((p) => p !== m && !ROLES.outWeight(p));
        if (m.pos === "QB") {
          if ((mp.att?.mean || 0) < 15) continue;
          const backup = mates.filter((p) => p.pos === "QB").sort((a, b) => b.proj[g.id].att.mean - a.proj[g.id].att.mean)[0];
          if (backup) {
            for (const [k, eff] of Object.entries(BACKUP_QB)) {
              const d = backup.proj[g.id][k];
              if (!d || !mp[k] || mp[k].mean * eff <= d.mean) continue;
              const target = mp[k].mean * eff;
              const was = Math.max(d.mean, 0.05 * target);
              // take the starter's shape, scaled to the backup's own average
              Object.assign(d, { ...mp[k], f: d.f }); ROLES.scale(d, was / Math.max(mp[k].mean, 1e-6));
              ROLES.scale(d, (was + share * (target - was)) / was);
            }
            ROLES.because(backup, g.id, m);
          }
          for (const p of mates.filter((x) => x.pos !== "QB")) {
            ROLES.scale(p.proj[g.id].yds, 1 - 0.08 * share); ROLES.scale(p.proj[g.id].td, 1 - 0.12 * share);
            ROLES.because(p, g.id, m);
          }
          continue;
        }
        const give = (vol, amount, who, weight) => {
          const W = who.reduce((a, p) => a + weight(p), 0);
          if (amount <= 0 || !W) return;
          for (const p of who) {
            const d = p.proj[g.id];
            const r = (d[vol].mean + amount * weight(p) / W) / Math.max(d[vol].mean, 0.1);
            for (const k of RIDES[vol]) ROLES.scale(d[k], r);
            ROLES.because(p, g.id, m);
          }
        };
        const before = new Map(mates.map((p) => [p, { car: p.proj[g.id].car?.mean, tgt: p.proj[g.id].tgt?.mean }]));
        if ((mp.car?.mean || 0) >= 1) {
          give("car", share * mp.car.mean, mates.filter((p) => p.pos === "RB"), (p) => p.proj[g.id].car.mean + 1);
        }
        if ((mp.tgt?.mean || 0) >= 1) {
          const aff = (p) => (p.pos === m.pos ? 1.5 : p.pos === "RB" || m.pos === "RB" ? 0.6 : 1);
          give("tgt", 0.9 * share * mp.tgt.mean, mates.filter((p) => p.pos !== "QB"), (p) => (p.proj[g.id].tgt.mean + 0.5) * aff(p));
        }
        // real games without him, on the volume he shared with them
        for (const p of mates) {
          if (p.pos === "QB") continue;
          const vol = p.pos === "RB" && m.pos === "RB" ? "car" : p.pos !== "RB" && m.pos !== "RB" ? "tgt" : null;
          const d = p.proj[g.id], b0 = before.get(p)[vol];
          if (!vol || !(b0 > 0.5)) continue;
          const rm = d[vol].mean / b0, r = ROLES.blend(p, m, (x) => x[vol], "w", rm);
          if (Math.abs(r - rm) > 1e-6) { for (const k of RIDES[vol]) ROLES.scale(d[k], Math.max(0.6, r / rm)); ROLES.because(p, g.id, m); }
        }
        for (const vol of ["car", "tgt"]) {
          const who = mates.filter((p) => p.proj[g.id][vol]);
          ROLES.cap(who, who.map((p) => before.get(p)[vol]), share * (mp[vol]?.mean || 0), (p) => p.proj[g.id][vol].mean,
            (p, r) => { for (const k of RIDES[vol]) ROLES.scale(p.proj[g.id][k], r); });
        }
      }
      reconcile(g, tm, roster);
      // rush + rec yards follow whatever happened to the two parts
      for (const p of roster) {
        const d = p.proj[g.id], b = p.base[g.id];
        if (d?.rry && b?.ryd && b?.yds) ROLES.scale(d.rry, (d.ryd.mean + d.yds.mean) / Math.max(b.ryd.mean + b.yds.mean, 0.1));
      }
      for (const p of roster) if (ROLES.outWeight(p) >= 1) ROLES.zeroOut(p, g.id);
    }
  }
}

// ---------------------------------------------------------------- team totals

// Players' stats have to add up to the team's game. The data file carries a team-level line
// (team stats alone: attempts, yards, carries, touchdowns from the implied score) and the share
// of team totals the listed players usually produce. Each team stat's target is half the team
// line and half what the players add up to; then the players are scaled to hit it:
//   - receivers' targets, catches, yards, and TDs add up to the team's passing line (times
//     their usual share; depth receivers who aren't listed catch the rest)
//   - runners' carries, yards, and TDs (QB runs included) add up to the team's rushing line
//   - the starting QB moves halfway to the team's passing line (his own numbers forecast him
//     better than the team's do when he gets hurt or pulled); the rest is backups and trick plays
//   - touchdowns add up to the implied score (about 0.107 offensive TDs per point), split
//     between passing and rushing the way the players' own projections split them
// In 2024-2026 backtests (with market lines) this left receiver and runner projections slightly
// more accurate and team totals much closer than the plain sum of player lines.
const RECON_W = 0.5, TGT_PER_ATT = 0.955;
function reconcile(g, tm, roster) {
  const T = g.team_model?.[tm], sh = g.share?.[tm];
  if (!T || !sh) return;
  const id = g.id, avail = roster.filter((p) => !ROLES.outWeight(p) && p.proj[id]);
  const qb = avail.filter((p) => p.pos === "QB").sort((a, b) => (b.proj[id].att?.mean || 0) - (a.proj[id].att?.mean || 0))[0];
  const rec = avail.filter((p) => p.pos !== "QB");
  const sum = (ps, k) => ps.reduce((a, p) => a + (p.proj[id][k]?.mean || 0), 0);
  const scaleAll = (ps, k, r) => { if (r > 0 && isFinite(r)) for (const p of ps) ROLES.scale(p.proj[id][k], r); };
  const out = { qb: qb?.name || null, rows: {} };
  // team = the reconciled team total; tl = the team-level line alone; before / listed = the
  // listed players' sum before and after scaling; others = what unlisted players are expected to add
  const row = (k, team, tl, before, listed, share) => (out.rows[k] = { team, tl, before, listed, others: Math.max(0, team - listed) });
  // passing: team line, the starter, and what the receivers add up to all count
  for (const [qk, rk, tl] of [["att", "tgt", T.att * TGT_PER_ATT], ["cmp", "rec", T.cmp], ["pyd", "yds", T.pyd]]) {
    const q = qb?.proj[id][qk]?.mean, rsum = sum(rec, rk);
    const qline = qk === "att" ? (q ?? tl) * TGT_PER_ATT : q ?? tl;
    const target = RECON_W * tl + (1 - RECON_W) * (0.5 * qline + 0.5 * (rsum > 0 ? rsum / sh[rk] : qline));
    if (rsum > 0) scaleAll(rec, rk, target * sh[rk] / rsum);
    const qTarget = qk === "att" ? target / TGT_PER_ATT : target;
    if (qb && q > 0) ROLES.scale(qb.proj[id][qk], Math.sqrt(qTarget / q));
    row(qk, qTarget, qk === "att" ? T.att : tl, q ?? 0, qb?.proj[id][qk]?.mean ?? 0);
    row(rk, target, tl, rsum, sum(rec, rk));
  }
  // rushing: everyone who runs, QB included
  for (const k of ["car", "ryd"]) {
    const s = sum(avail, k);
    if (!(s > 0)) continue;
    const target = RECON_W * T[k] + (1 - RECON_W) * s / sh[k];
    scaleAll(avail, k, target * sh[k] / s);
    row(k, target, T[k], s, sum(avail, k));
  }
  // touchdowns: the implied score sets the total, the players set the pass/run split
  const ptd = qb?.proj[id].ptd?.mean || 0, rtd = sum(avail, "rtd") / sh.rtd;
  if (ptd + rtd > 0) {
    const tds = RECON_W * T.tds + (1 - RECON_W) * (ptd + rtd), passTd = tds * ptd / (ptd + rtd), runTd = tds - passTd;
    const rs = sum(rec, "td"), us = sum(avail, "rtd");
    if (ptd > 0) ROLES.scale(qb.proj[id].ptd, passTd / ptd);
    if (rs > 0) scaleAll(rec, "td", passTd * sh.td / rs);
    if (us > 0) scaleAll(avail, "rtd", runTd * sh.rtd / us);
    row("ptd", passTd, T.tds * ptd / (ptd + rtd), ptd, qb?.proj[id].ptd?.mean ?? 0);
    row("td", passTd, T.tds * ptd / (ptd + rtd), rs, sum(rec, "td"));
    row("rtd", runTd, T.tds - T.tds * ptd / (ptd + rtd), us, sum(avail, "rtd"));
    out.tds = tds; out.tl_tds = T.tds;
  }
  out.pts = T.pts;
  (g.recon ||= {})[tm] = out;
}

// How the players add up to each team's line (Lines & matchup tab)
function renderTeamTotals(g) {
  const el = $("#teamTotals");
  if (!el) return;
  const R = g.recon || {};
  if (!R[g.home] && !R[g.away]) { el.innerHTML = ""; return; }
  const ROWS = [["Passing (starting QB)", [["att", "Pass attempts", 1], ["cmp", "Completions", 1], ["pyd", "Passing yards", 0], ["ptd", "Passing TDs", 2]]],
    ["Receiving (everyone)", [["tgt", "Targets", 1], ["rec", "Receptions", 1], ["yds", "Receiving yards", 0], ["td", "Receiving TDs", 2]]],
    ["Rushing (QB included)", [["car", "Rush attempts", 1], ["ryd", "Rushing yards", 0], ["rtd", "Rushing TDs", 2]]]];
  const side = (tm) => {
    const r = R[tm];
    if (!r) return "";
    return `<div><h3><img src="${logo(tm)}" alt="" class="tiny-logo"> ${esc(DATA.team_names[tm])}</h3>
      <div class="table-wrap"><table class="tt">
        <thead><tr><th>Stat</th><th title="Team stats alone: pace, pass rate, matchup, implied score">Team line</th><th title="What the listed players added up to before reconciling">Players, raw</th><th title="The listed players now (what every prop on the page uses)">Players</th><th title="Expected from players too small to list, or from backup QBs">Rest</th><th>Team total</th></tr></thead>
        <tbody>${ROWS.map(([grp, rows]) => `<tr class="grp-row"><td colspan="6">${grp}</td></tr>` + rows.filter(([k]) => r.rows[k]).map(([k, label, dec]) => {
          const x = r.rows[k];
          return `<tr><td>${label}</td><td>${fmt(x.tl, dec)}</td><td class="muted">${fmt(x.before, dec)}</td><td><b>${fmt(x.listed, dec)}</b></td><td class="muted">${fmt(x.others, dec)}</td><td><b>${fmt(x.team, dec)}</b></td></tr>`;
        }).join("")).join("")}
        ${r.tds != null ? `<tr class="grp-row"><td colspan="6">Scoring</td></tr><tr><td>Offensive TDs</td><td>${fmt(r.tl_tds, 2)}</td><td colspan="3" class="muted small">from ${fmt(r.pts, 1)} implied points</td><td><b>${fmt(r.tds, 2)}</b></td></tr>` : ""}
        </tbody></table></div>
      ${r.qb ? `<div class="muted small">Passing is ${esc(r.qb)}'s line; the receivers' column adds up to the team's passing total.</div>` : ""}</div>`;
  };
  el.innerHTML = `<div class="panel-head"><h2>How the players add up</h2><span class="muted small">Every player prop on this page is scaled so each team's players add up to one team line: half from team stats (pace, pass rate, matchup, the score the betting line implies), half from the players' own projections. "Rest" is what players too small to list usually add.</span></div>
    <div class="grid2">${side(g.away)}${side(g.home)}</div>`;
}

// ---------------------------------------------------------------- player notes

// Reasons a player may have a good or bad game. Matchup and teammates who are out are
// already in the projections; streaks are flagged here but not built in.
function playerNotes(p, g) {
  const out = [], pr = p.proj[g.id], opp = p.team === g.home ? g.away : g.home;
  if (p.inj?.status) {
    const why = [p.inj.injury, p.inj.practice, p.inj.note].filter(Boolean).join(". ");
    out.push({ kind: isOut(p) ? "bad" : "warn", text: `${p.inj.status}${why ? `: ${why}` : ""}` });
    if (isOut(p)) return out;
  }
  const k = MAIN_STAT[p.pos], d = pr[k], name = STATS[k].label.toLowerCase();
  if (d.mean >= 30) {   // skip depth players: one note on the starters is enough
    if (d.f >= 1.1) out.push({ kind: "good", text: `Good matchup: ${opp} gives up ${name} (+${Math.round((d.f - 1) * 100)}%)` });
    else if (d.f <= 0.9) out.push({ kind: "bad", text: `Tough matchup: ${opp} limits ${name} (−${Math.round((1 - d.f) * 100)}%)` });
  }
  // hot or cold: last 3 games against the season
  if (p.log.length >= 5) {
    const a = avg(p.log.slice(-3).map((r) => r[k])), b = avg(p.log.map((r) => r[k])), min = k === "pyd" ? 40 : 15;
    if (b >= 15 && a >= 1.3 * b && a - b >= min) out.push({ kind: "good", text: `Hot: ${Math.round(a)} ${name} a game last 3 (season ${Math.round(b)})` });
    else if (b >= 15 && a <= 0.7 * b && b - a >= min) out.push({ kind: "bad", text: `Cold: ${Math.round(a)} ${name} a game last 3 (season ${Math.round(b)})` });
  }
  // teammates ruled out: how this player did in past games without them
  for (const pid of g.players[p.team] || []) {
    const m = DATA.players[pid];
    if (m === p || !isOut(m)) continue;
    if (m.pos === "QB" && p.pos !== "QB") { out.push({ kind: "bad", text: `QB ${m.name} is out: backup throwing to him` }); continue; }
    const catcher = (x) => x === "WR" || x === "TE";
    const share = p.pos === "RB" && m.pos === "RB" ? "car" : catcher(p.pos) && catcher(m.pos) ? "tgt" : null;
    if (!share || volume({ proj: m.base || m.proj }, g) < 4) continue;
    const sp = NOTES.without(p, m, (r) => r[share], "w");
    if (sp && Math.abs(sp.without - sp.with) >= 1.5) {
      out.push({ kind: sp.without > sp.with ? "good" : "bad", text: `Without ${m.name} (out): ${fmt(sp.without, 1)} ${STATS[share].short.toLowerCase()} a game in ${sp.n} vs ${fmt(sp.with, 1)} with him` });
    }
  }
  const dk = p.pos === "QB" ? "att" : (pr.car?.mean || 0) > (pr.tgt?.mean || 0) ? "car" : "tgt";
  const dv = ROLES.delta(p, g.id, dk), dy = ROLES.delta(p, g.id, MAIN_STAT[p.pos]);
  if (dv || dy) {
    const b = p.base[g.id];
    out.push({ kind: (dv || dy) > 0 ? "good" : "bad", text: `Projection ${(dv || dy) > 0 ? "up" : "down"} for ${p.why[g.id].join(", ")} out: ${fmt(b[dk].mean, 1)} → ${fmt(pr[dk].mean, 1)} ${STATS[dk].short.toLowerCase()}, ${Math.round(b[MAIN_STAT[p.pos]].mean)} → ${Math.round(pr[MAIN_STAT[p.pos]].mean)} ${STATS[MAIN_STAT[p.pos]].short.toLowerCase()}` });
  }
  for (const n of NOTES.newsFor(p.name).slice(0, 2)) out.push({ kind: "info", text: `News: ${n.headline}` });
  return out;
}

// Notes for a whole team: scoring expectations and weather
function teamNotes(g, tm) {
  const out = [], pts = tm === g.home ? g.model.home_pts : g.model.away_pts, avgPts = DATA.teams[tm].off.ppg;
  if (pts >= avgPts + 4) out.push({ kind: "good", text: `${tm} implied for ${fmt(pts, 1)} points, above its ${fmt(avgPts, 1)} average: TD chances up` });
  else if (pts <= avgPts - 4) out.push({ kind: "bad", text: `${tm} implied for ${fmt(pts, 1)} points, below its ${fmt(avgPts, 1)} average` });
  if (g.wind != null && g.wind >= 15 && !/dome|closed/i.test(g.roof || "")) out.push({ kind: "bad", text: `Wind ${g.wind} mph: passing and kicking suffer` });
  return out;
}

function renderNotes(g) {
  const rows = [g.away, g.home].flatMap((tm) => [
    ...(teamNotes(g, tm).length ? [{ name: DATA.team_names[tm], tag: "team", notes: teamNotes(g, tm) }] : []),
    ...playerRows(g, tm).map((p) => ({ pid: p.pid, name: p.name, tag: `${p.team} ${p.pos}`, notes: playerNotes(DATA.players[p.pid], g) })),
  ]);
  NOTES.panel($("#notes"), rows, [
    ["ESPN injury report", "https://www.espn.com/nfl/injuries"],
    ["RotoWire news", "https://www.rotowire.com/football/news.php"],
    ["r/sportsbook", "https://www.reddit.com/r/sportsbook/"],
  ]);
  $("#notes").querySelectorAll(".note-row[data-pid]:not([data-pid=''])").forEach((r) => r.onclick = () => openPlayer(r.dataset.pid, g));
}

// ---------------------------------------------------------------- best spots

// Featured yardage and volume props (not touchdowns), measured against this season's games
function renderSpots(g) {
  const cand = [];
  for (const tm of [g.away, g.home]) {
    for (const p of playerRows(g, tm)) {
      if (ROLES.outWeight(p) || volume(p, g) < (p.pos === "QB" ? 20 : 4)) continue;
      const games = p.log.filter((r) => r.w < g.week);
      for (const k of FEATURED[p.pos]) {
        const d = p.proj[g.id][k], vals = games.map((r) => r[k]);
        if (!d || STATS[k].count || avg(vals) < (/yd|yds/.test(k) ? 15 : 1.5)) continue;
        cand.push({ p, pid: p.pid, gid: g.id, k, d, vals, label: STATS[k].label, tag: `${p.team} ${p.pos}`, st: stability(vals) });
      }
    }
  }
  ROLES.spotsPanel($("#spots"), ROLES.spots(cand, (c) => stepFor(c.k, c.p, c.d)), {
    dec: (k) => STATS[k].dec,
    onAdd: (it) => addLeg({ label: `${it.p.name} ${it.line + 0.5}+ ${it.label.toLowerCase()}`, p: it.over, game: g.id }),
  });
  $("#spots").querySelectorAll("tr[data-pid]").forEach((tr) => tr.onclick = () => openPlayer(tr.dataset.pid, g));
}

// ---------------------------------------------------------------- storyline baskets

// NFL rules for baskets.js: Polymarket's team codes and stat names, which stats tell which
// story, and how each stat moves with the game (see simulate() there).
const PM_CODES = { LA: ["lar", "la"], WAS: ["was", "wsh"], JAX: ["jax", "jac"], LV: ["lv", "lvr"] };
const PM_STATS = {
  passingyards: "pyd", passyards: "pyd", passingtouchdowns: "ptd", passingtds: "ptd", passtds: "ptd", passtouchdowns: "ptd",
  passingcompletions: "cmp", completions: "cmp", passcompletions: "cmp", passingattempts: "att", passattempts: "att",
  interceptions: "int", interceptionsthrown: "int", passinginterceptions: "int",
  rushingyards: "ryd", rushyards: "ryd", rushingattempts: "car", rushattempts: "car", carries: "car",
  receivingyards: "yds", recyards: "yds", receptions: "rec", rushingtouchdowns: "rtd", receivingtouchdowns: "td",
  rushingreceivingyards: "rry", rushandreceivingyards: "rry", rushrecyards: "rry", rushingandreceivingyards: "rry", scrimmageyards: "rry",
  anytimetouchdown: "anytd", anytimetd: "anytd", anytimetouchdownscorer: "anytd", touchdown: "anytd", touchdowns: "anytd", scoreatouchdown: "anytd", tds: "anytd",
};
// How each stat moves with the game, fitted to 2024-2026 results (about 1,400 games: each
// player's result vs. his projection, paired with teammates', opponents', and the final score).
// Factors: b = his team's scoring, m = his team's lead (backs run more ahead, QBs throw more
// behind), pass = his team's passing volume, poss = how much of the game his team has the ball
// (one team's long drives are the other's short game: opposing lead backs' carries run -0.29),
// env = a passing-friendly game for both sides (opposing QBs' yards run +0.16), tds = touchdowns
// going through the air rather than on the ground, comp = sharing one pool (two backs split
// carries, receivers split targets: a QB's yards run +0.41 with his top receiver's, but two
// receivers' yards barely move together, +0.02).
const PM_LOAD = {
  QB: { att: { b: 0.11, m: -0.37, pass: 0.79, env: 0.34 }, cmp: { b: 0.26, m: -0.36, pass: 0.8, env: 0.37 }, pyd: { b: 0.49, m: -0.35, pass: 0.79, env: 0.31 },
    ptd: { b: 0.62, m: -0.19, pass: 0.38, tds: 0.52 }, int: { b: -0.03, m: -0.24 }, car: { m: 0.14 }, ryd: { b: 0.04, m: -0.09 },
    rtd: { b: 0.2, tds: -0.3 }, anytd: { b: 0.2, tds: -0.3 } },
  RB: { car: { b: -0.05, m: 0.29, poss: 0.28, comp: { rb: 0.4 } }, ryd: { m: 0.27, poss: 0.41, comp: { rb: 0.45 } },
    rtd: { b: 0.2, m: 0.14, poss: -0.09, tds: -0.44 }, anytd: { b: 0.2, m: 0.1, tds: -0.35 },
    tgt: { m: -0.22, pass: 0.3 }, rec: { m: -0.22, pass: 0.3 }, yds: { b: 0.08, m: -0.1, pass: 0.22 }, td: { b: 0.25, pass: 0.15, tds: 0.2 },
    rry: { m: 0.2, poss: 0.32, pass: 0.08, comp: { rb: 0.35 } } },
  WR: { tgt: { b: 0.08, m: -0.21, pass: 0.22, env: 0.27, comp: { rec: 0.5 } }, rec: { b: 0.18, m: -0.17, pass: 0.25, env: 0.24, comp: { rec: 0.5 } },
    yds: { b: 0.24, m: -0.16, pass: 0.2, env: 0.16, comp: { rec: 0.5 } }, td: { b: 0.32, pass: 0.19, tds: 0.26 }, anytd: { b: 0.32, pass: 0.19, tds: 0.26 },
    rry: { b: 0.24, m: -0.16, pass: 0.2, env: 0.16, comp: { rec: 0.5 } }, car: { b: 0.05 }, ryd: { b: 0.05 }, rtd: { b: 0.2 } },
};
PM_LOAD.TE = PM_LOAD.WR;
const PM_TAGS = { pyd: ["qb", "score"], ptd: ["qb", "score"], cmp: ["qb"], att: ["qb"], yds: ["rec", "skill", "score"], rec: ["rec", "skill"], ryd: ["skill", "rush"], car: ["skill", "rush"], anytd: ["skill", "score"], rtd: ["skill"], td: ["skill"], rry: ["skill", "rush"] };
function basketAdapter(g) {
  const nickOf = (tm) => (DATA.team_names[tm] || tm).split(" ").slice(-1)[0];
  const info = (pid) => {
    const p = DATA.players[pid], d = p?.proj[g.id];
    if (!d) return null;
    const w = ROLES.outWeight(p);
    const core = p.pos === "QB" ? (d.att?.mean || 0) >= 20 : p.pos === "RB" ? (d.car?.mean || 0) >= 10 || (d.tgt?.mean || 0) >= 4 : (d.tgt?.mean || 0) >= 5;
    return { pid, name: p.name, team: p.team, pos: p.pos, d, skip: w >= 0.75, q: !w && p.inj?.status ? p.inj.status : null, core };
  };
  const roster = [g.away, g.home].flatMap((tm) => (g.players[tm] || []).map(info).filter(Boolean));
  const byId = new Map(roster.map((r) => [r.pid, r]));
  const lam = (pl) => (pl.d.rtd?.mean || 0) + (pl.d.td?.mean || 0);
  const MIN_STORY = { pyd: 150, ptd: 0.8, ryd: 30, yds: 20, rec: 2 };   // too small to tell a story with
  const KEYS = { QB: ["pyd", "ptd"], RB: ["ryd", "yds", "anytd"], WR: ["yds", "rec", "anytd"], TE: ["yds", "rec", "anytd"] };
  return {
    league: "nfl", daysBefore: 1,
    gameDay: () => g.day, kickoff: () => Date.parse(`${g.day}T${g.time || "13:00"}:00${easternOffset(g.day)}`), isPost: () => RESULT.state(g) === "post", isLive: () => RESULT.state(g) === "in",
    codes: (tm) => PM_CODES[tm] || [tm.toLowerCase()],
    nicknames: (tm) => [nickOf(tm).toLowerCase().replace(/[^a-z0-9]/g, "")],
    shortName: nickOf,
    runMargin: 10, closeMargin: 7,
    roster: () => roster, player: (pid) => byId.get(pid),
    statKey: (type, text) => PM_STATS[type] || PM_STATS[text] || null,
    statLabel: (k) => (k === "anytd" ? "touchdowns" : STATS[k].label.toLowerCase()),
    storyKeys: (pl) => (KEYS[pl.pos] || []).filter((k) => (k === "anytd" ? lam(pl) >= 0.25 : pl.d[k]?.mean >= (MIN_STORY[k] || 0))),
    // a line on Polymarket's own ladder (25 passing yards, 10 or 5 rushing/receiving, 1 for counts) near the q-th quantile
    lineAt: (pl, k, q) => {
      if (k === "anytd") return q >= 0.8 ? 1.5 : 0.5;
      const step = stepFor(k, pl, pl.d[k]);
      return Math.max(step, Math.round(quantile(q, pl.d[k]) / step) * step) - 0.5;
    },
    // yardage sits on Polymarket's ladder (25s, 10s, 5s), so the main line is the ladder line closest
    // to a coin flip and its under reads like "No on 60+" = "59 or fewer"
    mainLine: (pl, k) => (k === "anytd" ? 0.5 : k === "ptd" ? 1.5 : ladderMid(pl.d[k], stepFor(k, pl, pl.d[k]))),
    prob: (pl, k, line) => (k === "anytd" ? probs({ mean: lam(pl), sd: Math.sqrt(lam(pl)), dist: "poisson" }, line) : pl.d[k] ? probs(pl.d[k], line) : null),
    tags: (pl, k) => PM_TAGS[k] || [],
    load: (pl, k) => PM_LOAD[pl.pos]?.[k] || { b: 0.3 },
    // pools of teammates who split one supply: lead backs split carries, receivers split targets
    pools: (pl) => (pl.pos === "RB" && (pl.d.car?.mean || 0) >= 4 ? ["rb"] : ["WR", "TE"].includes(pl.pos) && (pl.d.tgt?.mean || 0) >= 3 ? ["rec"] : []),
    // for the checks in vet.js: the chance with his volume times r, his projection, the model's track record
    scaled: (pl, k, line, r) => {
      if (k === "anytd") { const l = lam(pl) * r; return probs({ mean: l, sd: Math.sqrt(l), dist: "poisson" }, line); }
      if (!pl.d[k]) return null;
      const d = JSON.parse(JSON.stringify(pl.d[k])); ROLES.scale(d, r); return probs(d, line);
    },
    mean: (pl, k) => (k === "anytd" ? null : pl.d[k]?.mean ?? null),
    calib: (k) => BACKTEST?.calib?.[k] || null,
    person: (pid) => DATA.players[pid],
    // questionable teammates big enough to change his game: the QB, or a lead back or top target at his position
    mates: (pl) => (g.players[pl.team] || []).filter((pid) => pid !== pl.pid).map((pid) => DATA.players[pid]).filter((m) => {
      if (!m || !/question/i.test(m.inj?.status || "")) return false;
      const d = m.proj[g.id] || {};
      if (m.pos === "QB") return pl.pos !== "QB" && (d.att?.mean || 0) >= 20;
      const same = m.pos === pl.pos || (["WR", "TE"].includes(m.pos) && ["WR", "TE"].includes(pl.pos));
      return same && ((d.tgt?.mean || 0) >= 6 || (d.car?.mean || 0) >= 12);
    }).map((m) => `${m.name} (${m.pos})`),
    duo: { a: "qb", b: "rec", title: (t) => `${t} QB and his top target connect`, blurb: (t) => `The ${t} passing game takes off: the quarterback's yards and his favorite receiver's numbers rise together.` },
    carry: { tag: "skill", title: (t) => `Two playmakers carry the ${t}`, blurb: (t) => `A lead back and a receiver (or two receivers) both have big days for the ${t}.` },
    runTags: ["skill", "qb"], scoreTags: ["score", "skill"],
    blowoutNote: " The winners lean on the run late, so their back's numbers move with the lead.",
  };
}

// ---------------------------------------------------------------- alt-line finder

function finderLine(d, k, p, conf, side) {
  const levels = ladder(k, p, d, 0.01, 0.99, Infinity);
  if (side === "over") {
    const ok = levels.filter((r) => r.p >= conf && (STATS[k].count || r.x >= 2));
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
      if (isOut(p)) continue;
      for (const k of FEATURED[p.pos]) {
        const d = p.proj[g.id][k];
        if (!d || d.mean < (STATS[k].count ? 0.05 : 1)) continue;
        const r = finderLine(d, k, p, state.conf, state.side);
        if (!r) continue;
        const st = stability(p.log.map((x) => x[k]));
        const hits = p.log.filter((x) => (state.side === "over" ? x[k] >= r.x : x[k] < r.x)).length;
        items.push({ p, k, d, x: r.x, prob: r.p, st, hits });
      }
    }
  }
  items.sort((a, b) => (a.st.cv ?? 9) - (b.st.cv ?? 9));
  const lineTxt = (it) => (state.side === "over" ? `${it.x}+` : `${it.x - 1} or fewer`);   // No on X+ = X-1 or fewer
  el.innerHTML = `
    <div class="panel-head"><h2>Alt-line finder</h2><span class="muted small">The ${state.side === "over" ? "highest" : "lowest"} Polymarket-style line each player should ${state.side === "over" ? "reach" : "stay under"} at your chosen confidence. Steadiest players first.</span></div>
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
        <td>${lineTxt(it)}</td>
        <td><b>${pct(it.prob)}</b></td>
        <td>${cents(it.prob)}</td>
        <td>${it.hits} of ${it.p.log.length}</td>
        <td><span class="stab ${it.st.cls}">${it.st.label}</span></td>
        <td><button class="btn add" data-i="${i}">+ Slip</button></td></tr>`).join("")}</tbody>
    </table></div>
    <div class="note">"Hit this season" counts past games that would have cleared the line. Teammates listed Out or Doubtful are built in; a late scratch isn't until the page refreshes.</div>`;
  el.querySelectorAll("[data-side]").forEach((b) => b.onclick = () => { state.side = b.dataset.side; renderFinder(g); });
  el.querySelectorAll("[data-conf]").forEach((b) => b.onclick = () => { state.conf = Number(b.dataset.conf); renderFinder(g); });
  el.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
    const it = items[Number(b.dataset.i)];
    addLeg({ label: `${it.p.name} ${lineTxt(it)} ${STATS[it.k].label.toLowerCase()}`, p: it.prob, game: g.id });
  });
}

// ---------------------------------------------------------------- anytime touchdowns

function tdLambda(p, g) {
  const pr = p.proj[g.id] || {};
  return (pr.rtd?.mean || 0) + (pr.td?.mean || 0);
}
const anyTd = (lam) => 1 - Math.exp(-lam);
const twoTd = (lam) => 1 - Math.exp(-lam) * (1 + lam);

function renderTds(g) {
  const el = $("#tds");
  const items = [g.away, g.home].flatMap((tm) => playerRows(g, tm))
    .filter((p) => !isOut(p))
    .map((p) => ({ p, lam: tdLambda(p, g), scored: p.log.filter((r) => r.rtd + r.td > 0).length }))
    .filter((it) => it.lam > 0.02)
    .sort((a, b) => b.lam - a.lam);
  el.innerHTML = `
    <div class="panel-head"><h2>Anytime touchdown</h2><span class="muted small">Chance each player scores a rushing or receiving TD (QB passing TDs not counted).</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Anytime TD</th><th>Fair price</th><th>2+ TDs</th><th>Scored this season</th><th></th></tr></thead>
      <tbody>${items.map((it, i) => `<tr>
        <td><span class="pname">${esc(it.p.name)}</span><span class="pos-tag">${it.p.team} ${it.p.pos}</span>${injBadge(it.p)}</td>
        <td><b>${pct(anyTd(it.lam))}</b></td><td>${cents(anyTd(it.lam))} · ${american(anyTd(it.lam))}</td>
        <td>${pct(twoTd(it.lam))}</td><td>${it.scored} of ${it.p.log.length} games</td>
        <td><button class="btn add" data-i="${i}">+ Slip</button></td></tr>`).join("")}</tbody>
    </table></div>`;
  el.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
    const it = items[Number(b.dataset.i)];
    addLeg({ label: `${it.p.name} anytime TD`, p: anyTd(it.lam), game: g.id });
  });
}

// ---------------------------------------------------------------- odds ladders

// Polymarket's yardage steps: 25 for QB passing, 10 for lead backs and good receivers, 5 for TEs and depth receivers
// (the base grid is in steps.js; a 10-yard ladder still sits on its 5-yard grid)
function stepFor(k, p, d) {
  const g = STEPS.grid("nfl", k);
  if (g === 5) return (p.pos !== "TE" && d.mean >= 40) || d.mean >= 60 ? 10 : 5;
  return g;
}

// The line on a step-sized ladder (X+ = over X - 0.5) whose over is closest to 50%.
// Step 1 keeps the plain midpoint (floor of the median + 0.5).
function ladderMid(d, step) {
  if (step <= 1) return Math.floor(quantile(0.5, d)) + 0.5;
  const x0 = Math.max(step, Math.floor(quantile(0.5, d) / step) * step);
  const off = (x) => Math.abs(probs(d, x - 0.5).over - 0.5);
  return (off(x0 + step) < off(x0) ? x0 + step : x0) - 0.5;
}

// "X+" rows from very likely down to unlikely. p = chance of X or more.
function ladder(k, p, d, qlo = 0.08, qhi = 0.93, maxRows = 16) {
  if (STATS[k].count) return [1, 2, 3].map((x) => ({ x, p: probs(d, x - 0.5).over }));
  const step = stepFor(k, p, d);
  const lo = Math.max(step, Math.ceil(quantile(qlo, d) / step) * step);
  const hi = Math.max(lo, Math.floor(quantile(qhi, d) / step) * step);
  let s = step;
  while ((hi - lo) / s > maxRows - 1) s += step;   // keep Polymarket's step unless the table would run past maxRows
  const rows = [];
  for (let x = lo; x <= hi; x += s) rows.push({ x, p: probs(d, x - 0.5).over });
  return rows;
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

// the stat a player's view opens on: the prop people bet most for that position
const MAIN_STAT = { QB: "pyd", RB: "ryd", WR: "yds", TE: "yds" };
const pv = { n: 5, stat: null };

function openPlayer(pid, g) {
  const p = DATA.players[pid];
  if (!pv.stat || !POS_STATS[p.pos].includes(pv.stat)) pv.stat = MAIN_STAT[p.pos];
  renderPlayerView(pid, g);
  $("#modal").hidden = false;
  $("#modal").scrollTop = 0;
}

const avg = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);

function renderPlayerView(pid, g) {
  const p = DATA.players[pid], pr = p.proj[g.id];
  const opp = p.team === g.home ? g.away : g.home;
  const keys = POS_STATS[p.pos];
  const recent = p.log.slice(-pv.n).reverse();
  const lam = tdLambda(p, g);
  const card = $("#modal .modal-card");
  const rangeCell = (k) => {
    const d = pr[k];
    return STATS[k].count ? `${pct(1 - poissonCdf(0, d.mean))} for 1+` : `${Math.round(quantile(0.1, d))}–${Math.round(quantile(0.9, d))}`;
  };
  card.innerHTML = `
    <div class="modal-head">
      ${p.img ? `<img src="${esc(p.img)}" alt="">` : ""}
      <div><h2>${esc(p.name)} ${injBadge(p)}</h2>
        <div class="muted">${esc(DATA.team_names[p.team])} ${p.pos} · vs ${esc(DATA.team_names[opp])} · ${p.log.length} games played</div>
        <div class="small">Anytime TD <b>${pct(anyTd(lam))}</b> <span class="muted">(fair ${cents(anyTd(lam))}, ${american(anyTd(lam))})</span>
          <button class="btn add" id="tdAdd">+ Slip</button></div>
        ${(() => { const ns = [...playerNotes(p, g), ...teamNotes(g, p.team)]; return ns.length ? `<div class="note-chips" style="margin-top:6px">${ns.map(NOTES.chip).join("")}</div>` : ""; })()}</div>
      <button class="x" aria-label="Close">×</button>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Recent games</h3>
        <div class="tabs" style="margin:0">${[3, 5, 99].map((n) => `<button class="chip" data-n="${n}" aria-pressed="${n === pv.n}">${n === 99 ? "All" : `Last ${n}`}</button>`).join("")}</div></div>
      <div class="table-wrap"><table>
        ${statHead(keys, ["Week"])}
        <tbody>
          ${recent.map((r) => `<tr><td>Wk ${r.w} ${esc(r.opp)}${r.tm !== p.team ? ` <span class="muted small">(${esc(r.tm)})</span>` : ""}</td>${keys.map((k, i) => `<td${gsCls(keys, i)}>${r[k] ?? 0}</td>`).join("")}</tr>`).join("")}
          <tr class="sum"><td>Avg, ${pv.n === 99 ? "all" : `last ${recent.length}`}</td>${keys.map((k, i) => `<td${gsCls(keys, i)}>${fmt(avg(recent.map((r) => r[k] || 0)), 1)}</td>`).join("")}</tr>
          <tr class="sum"><td>Season avg</td>${keys.map((k, i) => `<td${gsCls(keys, i)}>${fmt(avg(p.log.map((r) => r[k] || 0)), 1)}</td>`).join("")}</tr>
          <tr class="sum proj"><td>Projected vs ${opp}</td>${keys.map((k, i) => `<td${gsCls(keys, i)}><b>${pr[k] ? fmt(pr[k].mean, STATS[k].count ? 2 : 1) : "–"}</b></td>`).join("")}</tr>
          <tr class="sum"><td>Expected range (80%)</td>${keys.map((k, i) => `<td${gsCls(keys, i)}>${pr[k] ? rangeCell(k) : "–"}</td>`).join("")}</tr>
          <tr class="sum"><td>Consistency</td>${keys.map((k, i) => { const st = stability(p.log.map((r) => r[k] || 0)); return STATS[k].count ? `<td class="muted small${groupStart(keys, i) ? " gs" : ""}">${p.log.filter((r) => r[k] > 0).length} of ${p.log.length}</td>` : `<td${gsCls(keys, i)}><span class="stab ${st.cls}">${st.label}</span></td>`; }).join("")}</tr>
        </tbody>
      </table></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Odds by line</h3><span class="muted small">Pick a stat</span></div>
      <div class="tabs">${keys.map((k) => `<button class="chip" data-stat="${k}" aria-pressed="${k === pv.stat}">${STATS[k].label}</button>`).join("")}</div>
      <div class="grid2" id="statDetail"></div>
    </div>`;
  card.querySelector(".x").onclick = closeModal;
  card.querySelector("#tdAdd").onclick = () => addLeg({ label: `${p.name} anytime TD`, p: anyTd(lam), game: g.id });
  card.querySelectorAll("[data-n]").forEach((b) => b.onclick = () => { pv.n = Number(b.dataset.n); renderPlayerView(pid, g); });
  card.querySelectorAll("[data-stat]").forEach((b) => b.onclick = () => { pv.stat = b.dataset.stat; renderPlayerView(pid, g); });
  renderStatDetail(p, pv.stat, pr[pv.stat], g);
}

function renderStatDetail(p, k, d, g) {
  const el = $("#statDetail");
  const rows = ladder(k, p, d);
  const vals = p.log.map((r) => r[k]);
  const name = STATS[k].label.toLowerCase();
  const factorTxt = d.f > 1.03 ? `Matchup and game script push this up ${Math.round((d.f - 1) * 100)}%.` : d.f < 0.97 ? `Matchup and game script pull this down ${Math.round((1 - d.f) * 100)}%.` : "Matchup is roughly neutral.";
  el.innerHTML = `
    <div>
      <div class="table-wrap"><table class="ladder">
        <thead><tr><th>Line</th><th>Chance</th><th>Fair price</th><th>Hit this season</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td><b>${r.x}+</b></td><td><b>${pct(r.p)}</b></td><td>${cents(r.p)} · ${american(r.p)}</td>
          <td>${vals.filter((v) => v >= r.x).length} of ${vals.length}</td>
          <td><button class="btn add" data-i="${i}" data-s="yes">+ Yes</button> <button class="btn add" data-i="${i}" data-s="no">+ No</button></td></tr>`).join("")}</tbody>
      </table></div>
      <div class="liner"><label class="small muted">Other line</label><input type="number" step="0.5" min="0" value="${rows[Math.floor(rows.length / 2)]?.x ?? 1}"><span class="out"></span></div>
    </div>
    <div class="statcard">
      <h3>${STATS[k].label} by game</h3>
      ${chartSvg(p.log, k, d)}
      <div class="small muted">Bars: each game (week and opponent). Dashed line: season average. Last column: this game's projection with its 50% (dark) and 80% (light) ranges. ${STATS[k].count ? "" : `50% range ${Math.round(quantile(0.25, d))}–${Math.round(quantile(0.75, d))}. `}${factorTxt}</div>
    </div>`;
  el.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
    const r = rows[Number(b.dataset.i)], yes = b.dataset.s === "yes";
    addLeg({ label: `${p.name} ${yes ? `${r.x}+` : `${r.x - 1} or fewer`} ${name}`, p: yes ? r.p : 1 - r.p, game: g.id });
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

// The side panel that opens when a player prop is clicked on a Bets list (trend.js)
TREND.config = {
  player: (pid) => DATA.players[pid],
  keys: (p) => POS_STATS[p.pos] || [],
  val: (r, k) => (k === "anytd" ? (r.rtd || 0) + (r.td || 0) : r[k] ?? 0),
  label: (k) => (k === "anytd" ? "Touchdowns (rushing + receiving)" : STATS[k].label),
  short: (k) => (k === "anytd" ? "TDs" : STATS[k].short),
  when: (r, split) => (split ? [`Wk ${r.w}`, r.opp] : `Wk ${r.w} ${r.opp}`),
  log: (p) => p.log,
  teamLine: (p) => `${DATA.team_names[p.team] || p.team} ${p.pos} · ${p.log.length} games this season${p.inj?.status ? ` · ${p.inj.status}` : ""}`,
  proj: (p, l, k) => (k === "anytd" ? null : p.proj?.[l.gid]?.[k]?.mean ?? null),
  more: (l) => { const g = DATA.games.find((x) => x.id === l.gid); if (g) openPlayer(l.pid, g); },
};

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
      <p><b>Starting point.</b> Each player's recent average, where a game four weeks back counts half as much as last week's, pulled part of the way toward his per-game average last season (a few games' worth) so a hot or cold start doesn't run away with the projection.</p>
      <p><b>Game script.</b> The betting spread and total tell us how many points each team should score and who is likely to be trailing. Trailing teams throw more, leading teams run more. That shifts pass attempts, carries, and targets.</p>
      <p><b>Matchup.</b> Yardage gets scaled by how many yards the opponent allows per pass, per carry, and per target to that position (WR, TE, RB), compared to the league. Small samples are pulled toward average so one blowout doesn't swing things too far. Touchdowns scale with the team's implied points, blended with the league TD rate so a player who hasn't scored yet still has a real chance.</p>
      <p><b>Ranges.</b> Bigger roles swing less in relative terms, so the spread depends on the size of the projection, lightly blended with the player's own game-to-game swing. Each stat mixes a "normal game" curve with a small "dud game" curve (hurt early, benched, schemed out), so the upper tail isn't stretched to cover those games. Every weight was fitted on 2022–2024 game logs and checked on 2025 and this season: results land above the model's 90th and 95th percentiles about 10% and 5% of the time, including for top players. Touchdowns and interceptions use count odds (Poisson), pulled toward the league rate for the player's volume. Totals and spreads use the market line with a 13-point typical miss, nudged 20% toward a stats-only score model.</p>
      <p><b>Teammates who are out.</b> When a player is listed Out (or Doubtful, counted at 75%), his carries go to the other backs and most of his targets to the other receivers, weighted toward his position. A starting QB out hands his volume to the backup at lower efficiency. Where a teammate has played games without him, those real numbers are blended in. Changed numbers carry a ▲ or ▼.</p>
      <p><b>What it doesn't know.</b> Injuries during the week until the page refreshes, weather beyond what's listed, coaching changes, and snap-count news. A player listed Questionable could be on a snap limit.</p>
      <p><b>Using it for alt lines.</b> If the model says 80% and Polymarket charges 70¢, that's a possible edge. If it charges 85¢, it isn't. Multiplying many 80% legs drops fast: five of them is about 33%.</p>
      <p><b>Players add up to the team.</b> Each team's players are scaled so they add up to one team line: passing, receiving, rushing, and touchdowns meet halfway between a team-stats line and the players' own sum (see <b>How the players add up</b> on the Lines &amp; matchup tab). Tested on past seasons, this made team totals much closer and didn't hurt the player projections.</p>
      <p><b>Polymarket bets.</b> From the day before kickoff (or within 24 hours of the start) each game's <b>Bets</b> tab reads Polymarket's player and game markets, priced at what a $20 bet would really cost. <b>Mispriced props</b> are single bets where the model's fair price is at least 3¢ above Polymarket's, each pressure-tested (the model's track record, Polymarket's whole line ladder, the sportsbook line, injuries, news, and price moves) and graded Verified, Caution, or Flagged; flagged bets stay listed with their likely issue named. <b>Pairs that pull apart</b> and <b>pairs that move together</b> come from simulating the game 6,000 times with weights fitted to past seasons (a QB's passing yards and his top receiver's yards +0.41, opposing lead backs' carries −0.29, a lead back's carries and his own QB's attempts −0.11); each shows its break-even payout next to straight multiplication of the two prices. <b>Lottery tickets</b> are long shots priced at or below their chance. Click any player's bet, or its <b>Last 10</b> button, to see his last 10 games in a side panel.</p>
      <p><b>Lock of the week.</b> On the Best bets page: two to five legs across at least two games on the same day, paying 2.5x to 5x, built from legs the pressure test grades Verified or Caution (never Flagged), with same-game legs that fit one storyline. It counts only half of the simulated boost from legs moving together and needs at least +2% expected return on those cautious chances.</p>
    </div>
    ${bt.length ? `<div class="panel"><h3>Track record this season</h3>
      <div class="small muted" style="margin-bottom:6px">${esc(BACKTEST.note)} A well-tuned model lands about 80% inside its 80% range and 50% inside its 50% range. "Avg miss" is the average gap between projection and result.</div>
      <div class="table-wrap"><table><thead><tr><th>Stat</th><th>Results</th><th>Inside 80% range</th><th>Inside 50% range</th><th title="Should be about 10%">Above 90th pct</th><th>Avg miss</th><th>Avg miss using season avg</th></tr></thead>
      <tbody>${bt.map((r) => `<tr><td>${esc(r.stat)}</td><td>${r.n}</td><td>${pct(r.in80)}</td><td>${pct(r.in50)}</td><td>${r.above90 == null ? "–" : pct(r.above90)}</td><td>${fmt(r.mae, 1)}</td><td>${fmt(r.mae_season_avg, 1)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
  card.querySelector(".x").onclick = closeModal;
  $("#modal").hidden = false;
}

boot();
