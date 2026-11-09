"use strict";

// Player trend panel, shared by the NFL and NBA pages. Click any player prop on a Bets list (or
// the Best bets view) and a side panel opens with that player's last 10 games: every stat, with
// the prop's own stat highlighted, each game marked hit or miss against the prop's line, a bar
// chart of that stat, and a small trend line for each of the others.
//
// Each page sets TREND.config (see app.js / nba.js): which stats a player has (in table order),
// how to read a stat from a game-log row, how to label a game, and optionally which group
// (Passing, Shooting, ...) each stat sits under. A stat no game in the window has is left out,
// so older data files without the extra box-score columns still open cleanly.
// Clicking the same bet's "Last 10" chip again closes the panel. config.flag(row), if set, marks
// a game to read with care (NFL partial games) with a tag and a hover note.

const TREND = (() => {
  const N = 10;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const fmt = (v, d = 1) => (v == null || isNaN(v) ? "–" : Number(v).toFixed(d));
  let config = null;
  const legs = new Map();
  let nextId = 1;
  let shown = null;   // the bet the open panel is about, so a second click on it closes the panel
  const sig = (l) => [l.pid, l.key, l.line, l.side, l.gid].join("|");
  const has = (v) => v != null && !Number.isNaN(v);

  // A prop's label plus a "Last 10" chip. Both open the side panel (nothing navigates away);
  // the Polymarket market is linked from inside the panel instead.
  function link(l) {
    if (!l || l.kind !== "player" || !config) return esc(l?.label);
    const id = String(nextId++);
    legs.set(id, l);
    if (legs.size > 3000) legs.delete(legs.keys().next().value);
    const tip = `Show ${esc(l.name || "this player")}'s last ${N} games`;
    return `<button type="button" class="linkish trend-btn" data-trend="${id}" title="${tip}">${esc(l.label)}</button> <button type="button" class="trend-chip" data-trend="${id}" title="${tip}" aria-label="${tip}"><svg viewBox="0 0 14 10" aria-hidden="true"><rect x="0" y="5" width="3" height="5"/><rect x="5.5" y="2" width="3" height="8"/><rect x="11" y="0" width="3" height="10"/></svg>Last ${N}</button>`;
  }

  function el() {
    let d = document.getElementById("trend");
    if (!d) {
      d = document.createElement("aside");
      d.id = "trend"; d.className = "drawer trend"; d.hidden = true;
      d.setAttribute("aria-label", "Player trend");
      document.body.appendChild(d);
    }
    return d;
  }
  function close() { el().hidden = true; shown = null; mark(null); }
  // keep the bet the panel is showing highlighted on the page underneath, and its chip filled in
  function mark(row) {
    document.querySelectorAll("tr.trend-on").forEach((r) => r.classList.remove("trend-on"));
    document.querySelectorAll(".trend-chip.on").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-expanded", "false"); });
    if (row) row.classList.add("trend-on");
    if (!shown) return;
    document.querySelectorAll(".trend-chip[data-trend]").forEach((b) => {
      const l = legs.get(b.dataset.trend);
      if (l && sig(l) === shown) { b.classList.add("on"); b.setAttribute("aria-expanded", "true"); }
    });
  }

  // bars for the prop's stat, oldest to newest, with the line marked
  function bars(rows, k, line, side) {
    const W = 900, H = 190, padL = 30, padB = 30, padT = 12;
    const vals = rows.map((r) => config.val(r, k) ?? 0);
    const maxV = Math.max(1, ...vals, line ?? 0) * 1.12;
    const bw = (W - padL - 4) / Math.max(rows.length, 1);
    const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" role="img" aria-label="${esc(config.label(k))}, last ${rows.length} games">`;
    [0, maxV / 2].forEach((t) => { s += `<text x="${padL - 4}" y="${y(t) + 3}" text-anchor="end">${Math.round(t)}</text><line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" />`; });
    rows.forEach((r, i) => {
      const v = vals[i], x = padL + i * bw + 3, hit = line == null ? null : side === "under" ? v < line : v > line;
      s += `<rect x="${x}" y="${y(v)}" width="${bw - 6}" height="${Math.max(0, y(0) - y(v))}" rx="2" fill="${hit == null ? "var(--bar)" : hit ? "var(--good)" : "var(--bar)"}" opacity="${hit === false ? 0.55 : 1}"><title>${esc(config.when(r))}: ${v}${config.flag?.(r) ? ` (${esc(config.flag(r))})` : ""}</title></rect>`;
      if (config.flag?.(r)) s += `<text x="${x + (bw - 6) / 2}" y="${y(v) - 14}" text-anchor="middle" class="part-svg">partial</text>`;
      s += `<text x="${x + (bw - 6) / 2}" y="${y(v) - 3}" text-anchor="middle" class="v">${v}</text>`;
      const [a, b] = config.when(r, true);
      s += `<text x="${x + (bw - 6) / 2}" y="${H - 16}" text-anchor="middle">${esc(a)}</text><text x="${x + (bw - 6) / 2}" y="${H - 4}" text-anchor="middle">${esc(b)}</text>`;
    });
    if (line != null) s += `<line x1="${padL}" x2="${W}" y1="${y(line)}" y2="${y(line)}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="5 4"><title>Line ${line}</title></line>`;
    return s + "</svg>";
  }

  // a small trend line for one stat
  function spark(rows, k) {
    const W = 120, H = 34, vals = rows.map((r) => config.val(r, k) ?? 0);
    const minV = Math.min(0, ...vals), span = Math.max(1, ...vals) - minV, n = vals.length;   // plus-minus can go negative
    const x = (i) => (n > 1 ? (i / (n - 1)) * (W - 6) : W / 2) + 3, y = (v) => H - 3 - ((v - minV) / span) * (H - 8);
    const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--bar-hi)" stroke-width="1.6"/>${vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="1.8" fill="var(--bar-hi)"/>`).join("")}</svg>`;
  }

  function open(l) {
    const p = config.player(l.pid);
    if (!p) return;
    const k = l.key, line = l.line, side = l.side;
    const all = config.log(p);
    const rows = all.slice(-N);                       // oldest first
    const v = (r, x) => config.val(r, x);
    const cell = (x) => (Number.isInteger(x) ? String(x) : has(x) ? fmt(x, 1) : "–");
    // every stat the player has, in the page's order, with the bet's own stat kept in its place
    let cols = config.keys(p).filter((x) => x === k || rows.some((r) => has(v(r, x))));
    if (!cols.includes(k)) cols = [k, ...cols];
    const others = cols.filter((x) => x !== k);
    const grp = (x) => config.group?.(x) || "";
    const grouped = cols.some((x) => grp(x));
    const gs = (i) => grouped && (i === 0 || grp(cols[i]) !== grp(cols[i - 1]));
    const hit = (r) => (side === "under" ? v(r, k) < line : v(r, k) > line);
    const hits = rows.filter(hit).length, hitsAll = all.filter(hit).length;
    const avg = (x, rs) => { const ns = rs.map((r) => v(r, x)).filter(has); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null; };
    const proj = config.proj?.(p, l, k);
    const flag = (r) => config.flag?.(r) || "";   // a game to read with care (NFL: partial games)
    const th = (x, i) => `<th class="${x === k ? "hl" : ""}${gs(i) ? " gs" : ""}" title="${esc(config.label(x))}">${esc(config.short(x))}</th>`;
    const td = (x, i, body, extra = "") => `<td class="${x === k ? "hl" : ""}${gs(i) ? " gs" : ""}${extra}">${body}</td>`;
    let groupRow = "";
    if (grouped) {
      const gl = [];
      cols.forEach((x, i) => { if (gs(i)) gl.push({ name: grp(x), n: 1 }); else gl[gl.length - 1].n++; });
      groupRow = `<tr class="grp"><th rowspan="2">Game</th>${gl.map((g) => `<th colspan="${g.n}" class="gs">${esc(g.name)}</th>`).join("")}</tr>`;
    }
    const d = el();
    d.innerHTML = `
      <div class="trend-head">
        ${p.img ? `<img src="${esc(p.img)}" alt="">` : ""}
        <div><h2>${esc(p.name)}</h2><div class="muted small">${esc(config.teamLine(p))}</div></div>
        <button type="button" class="x" aria-label="Close">×</button>
      </div>
      <div class="trend-prop">
        <div><b>${esc(l.label)}</b></div>
        <div class="small">Model <b>${pct(l.p)}</b>${l.pa != null ? ` · careful ${pct(l.pa)}` : ""}${l.price != null ? ` · price <b>${cents(l.price)}</b>` : ""}${proj != null ? ` · projected <b>${fmt(proj, 1)}</b>` : ""}
          · cleared <b>${hits} of last ${rows.length}</b>${all.length > rows.length ? ` (${hitsAll} of ${all.length} in the log)` : ""}</div>
      </div>
      ${config.extra ? `<div class="trend-form">${config.extra(p, l)}</div>` : ""}
      <h3>${esc(config.label(k))}, last ${rows.length} games</h3>
      ${bars(rows, k, line, side)}
      <div class="muted small">Green = would have cleared this bet. Dashed line = the line (${esc(String(line))}). Average ${fmt(avg(k, rows), 1)}.</div>
      <h3>Every stat, last ${rows.length} games <span class="muted small">(newest first; hover a column name for its full name)</span></h3>
      <div class="table-wrap"><table class="trend-t${grouped ? " grouped" : ""}">
        <thead>${groupRow}<tr>${grouped ? "" : "<th>Game</th>"}${cols.map(th).join("")}</tr></thead>
        <tbody>${[...rows].reverse().map((r) => `<tr${flag(r) ? ' class="partial"' : ""}><td${flag(r) ? ` title="${esc(flag(r))}"` : ""}>${esc(config.when(r))}${flag(r) ? ' <span class="part-mark">partial</span>' : ""}</td>${cols.map((x, i) => (x === k
          ? td(x, i, `<b>${cell(v(r, k))}</b>`, hit(r) ? " edge-good" : " edge-bad")
          : td(x, i, cell(v(r, x))))).join("")}</tr>`).join("")}
        <tr class="sum"><td>Average</td>${cols.map((x, i) => td(x, i, x === k ? `<b>${fmt(avg(x, rows), 1)}</b>` : fmt(avg(x, rows), 1))).join("")}</tr></tbody>
      </table></div>
      ${rows.some(flag) ? `<div class="muted small">"partial" = he played under half his usual share of snaps (left hurt, ejected, or rested in a blowout). Hover the game for details. Those games still count in the projection: leaving them out didn't backtest better.</div>` : ""}
      <h3>Trends</h3>
      <div class="sparks">${others.map((x) => `<div class="sp"><div class="small"><b title="${esc(config.label(x))}">${esc(config.short(x))}</b> <span class="muted">avg ${fmt(avg(x, rows), 1)}</span></div>${spark(rows, x)}</div>`).join("")}</div>
      <div class="trend-foot">${config.more ? `<button type="button" class="btn" data-more>Full player page</button>` : ""}${l.url ? `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">Open on Polymarket ↗</a>` : ""}</div>`;
    shown = sig(l);
    d.querySelector(".x").onclick = close;
    const more = d.querySelector("[data-more]");
    if (more) more.onclick = () => { close(); config.more(l); };
    d.hidden = false;
    d.scrollTop = 0;
  }

  // "Form": last 4 games vs. last 12 for a few stats, with what the backtests say a change means.
  // rows: [{label, a (last 4), b (last 12), dec, unit, note, hl}]
  function form(rows, sub, note, rest) {
    rows = rows.filter((r) => has(r.a) && has(r.b));
    if (!rows.length && !rest) return "";
    const chg = (r) => {
      if (!(r.b > 0)) return "";
      const d = r.a / r.b - 1, big = Math.abs(d) >= 0.1;
      return `<span class="${big ? (d > 0 ? "edge-good" : "edge-bad") : "muted"}">${d >= 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}%</span>`;
    };
    return `<h3>Form: last 4 games vs last 12 ${sub ? `<span class="muted small">(${esc(sub)})</span>` : ""}</h3>
      ${rows.length ? `<table class="form-t"><thead><tr><th></th><th>Last 4</th><th>Last 12</th><th>Change</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr${r.hl ? ' class="hl"' : ""}><td>${esc(r.label)}</td><td>${fmt(r.a, r.dec ?? 1)}${r.unit || ""}</td><td>${fmt(r.b, r.dec ?? 1)}${r.unit || ""}</td><td>${chg(r)}</td><td class="muted small">${esc(r.note || "")}</td></tr>`).join("")}
      </tbody></table>` : ""}
      ${rest ? `<div class="small">${esc(rest)}</div>` : ""}
      ${note ? `<div class="muted small">${esc(note)}</div>` : ""}`;
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-trend]");
    if (!b) return;
    const l = legs.get(b.dataset.trend);
    if (!l) return;
    e.preventDefault();
    if (!el().hidden && shown === sig(l)) { close(); return; }   // same bet again: toggle closed
    open(l); mark(b.closest("tr"));
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  return { link, open, close, form, set config(c) { config = c; }, get config() { return config; } };
})();
