"use strict";

// Player trend panel, shared by the NFL and NBA pages. Click any player prop on a Bets list (or
// the Best bets view) and a side panel opens with that player's last 10 games: every stat, with
// the prop's own stat highlighted, each game marked hit or miss against the prop's line, a bar
// chart of that stat, and a small trend line for each of the others.
//
// Each page sets TREND.config (see app.js / nba.js): which stats a player has, how to read a
// stat from a game-log row, and how to label a game.

const TREND = (() => {
  const N = 10;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const fmt = (v, d = 1) => (v == null || isNaN(v) ? "–" : Number(v).toFixed(d));
  let config = null;
  const legs = new Map();
  let nextId = 1;

  // A prop's label as a button that opens the panel, plus a small link to the Polymarket market
  function link(l) {
    if (!l || l.kind !== "player" || !config) {
      return l?.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "")}">${esc(l.label)}</a>` : esc(l?.label);
    }
    const id = String(nextId++);
    legs.set(id, l);
    if (legs.size > 3000) legs.delete(legs.keys().next().value);
    return `<button type="button" class="linkish trend-btn" data-trend="${id}" title="Show ${esc(l.name || "")}'s last ${N} games">${esc(l.label)}</button>${l.url ? `&nbsp;<a class="pm-link" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.src || "Open on Polymarket")}">↗</a>` : ""}`;
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
  function close() { el().hidden = true; }

  // bars for the prop's stat, oldest to newest, with the line marked
  function bars(rows, k, line, side) {
    const W = 560, H = 150, padL = 30, padB = 30, padT = 10;
    const vals = rows.map((r) => config.val(r, k));
    const maxV = Math.max(1, ...vals, line ?? 0) * 1.12;
    const bw = (W - padL - 4) / Math.max(rows.length, 1);
    const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" role="img" aria-label="${esc(config.label(k))}, last ${rows.length} games">`;
    [0, maxV / 2].forEach((t) => { s += `<text x="${padL - 4}" y="${y(t) + 3}" text-anchor="end">${Math.round(t)}</text><line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" />`; });
    rows.forEach((r, i) => {
      const v = vals[i], x = padL + i * bw + 3, hit = line == null ? null : side === "under" ? v < line : v > line;
      s += `<rect x="${x}" y="${y(v)}" width="${bw - 6}" height="${Math.max(0, y(0) - y(v))}" rx="2" fill="${hit == null ? "var(--bar)" : hit ? "var(--good)" : "var(--bar)"}" opacity="${hit === false ? 0.55 : 1}"><title>${esc(config.when(r))}: ${v}</title></rect>`;
      s += `<text x="${x + (bw - 6) / 2}" y="${y(v) - 3}" text-anchor="middle" class="v">${v}</text>`;
      const [a, b] = config.when(r, true);
      s += `<text x="${x + (bw - 6) / 2}" y="${H - 16}" text-anchor="middle">${esc(a)}</text><text x="${x + (bw - 6) / 2}" y="${H - 4}" text-anchor="middle">${esc(b)}</text>`;
    });
    if (line != null) s += `<line x1="${padL}" x2="${W}" y1="${y(line)}" y2="${y(line)}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="5 4"><title>Line ${line}</title></line>`;
    return s + "</svg>";
  }

  // a small trend line for one stat
  function spark(rows, k) {
    const W = 120, H = 34, vals = rows.map((r) => config.val(r, k));
    const maxV = Math.max(1, ...vals), n = vals.length;
    const pts = vals.map((v, i) => `${(n > 1 ? (i / (n - 1)) * (W - 6) : W / 2) + 3},${H - 3 - (v / maxV) * (H - 8)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--bar-hi)" stroke-width="1.6"/>${vals.map((v, i) => `<circle cx="${(n > 1 ? (i / (n - 1)) * (W - 6) : W / 2) + 3}" cy="${H - 3 - (v / maxV) * (H - 8)}" r="1.8" fill="var(--bar-hi)"/>`).join("")}</svg>`;
  }

  function open(l) {
    const p = config.player(l.pid);
    if (!p) return;
    const k = l.key, line = l.line, side = l.side;
    const all = config.log(p);
    const rows = all.slice(-N);                       // oldest first
    const keys = config.keys(p).filter((x) => x !== k);
    const hit = (r) => (side === "under" ? config.val(r, k) < line : config.val(r, k) > line);
    const hits = rows.filter(hit).length, hitsAll = all.filter(hit).length;
    const avg = (ks, rs) => rs.reduce((a, r) => a + config.val(r, ks), 0) / Math.max(rs.length, 1);
    const proj = config.proj?.(p, l, k);
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
      <h3>${esc(config.label(k))}, last ${rows.length} games</h3>
      ${bars(rows, k, line, side)}
      <div class="muted small">Green = would have cleared this bet. Dashed line = the line (${esc(String(line))}). Average ${fmt(avg(k, rows), 1)}.</div>
      <h3>Every stat, last ${rows.length} games</h3>
      <div class="table-wrap"><table class="trend-t">
        <thead><tr><th>Game</th><th class="hl">${esc(config.short(k))}</th>${keys.map((x) => `<th>${esc(config.short(x))}</th>`).join("")}</tr></thead>
        <tbody>${[...rows].reverse().map((r) => `<tr><td>${esc(config.when(r))}</td><td class="hl ${hit(r) ? "edge-good" : "edge-bad"}"><b>${config.val(r, k)}</b></td>${keys.map((x) => `<td>${config.val(r, x)}</td>`).join("")}</tr>`).join("")}
        <tr class="sum"><td>Average</td><td class="hl"><b>${fmt(avg(k, rows), 1)}</b></td>${keys.map((x) => `<td>${fmt(avg(x, rows), 1)}</td>`).join("")}</tr></tbody>
      </table></div>
      <div class="sparks">${keys.map((x) => `<div class="sp"><div class="small"><b>${esc(config.short(x))}</b> <span class="muted">avg ${fmt(avg(x, rows), 1)}</span></div>${spark(rows, x)}</div>`).join("")}</div>
      ${config.more ? `<button type="button" class="btn" data-more>Full player page</button>` : ""}`;
    d.querySelector(".x").onclick = close;
    const more = d.querySelector("[data-more]");
    if (more) more.onclick = () => { close(); config.more(l); };
    d.hidden = false;
    d.scrollTop = 0;
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-trend]");
    if (!b) return;
    const l = legs.get(b.dataset.trend);
    if (l) { e.preventDefault(); open(l); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  return { link, open, close, set config(c) { config = c; }, get config() { return config; } };
})();
