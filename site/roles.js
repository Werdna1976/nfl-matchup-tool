"use strict";

// Teammate injuries, built into the projections, plus the "best spots" panel. Shared by the
// NFL and NBA pages. When a player is ruled out, each page hands his minutes (NBA) or carries
// and targets (NFL) to teammates using its own rules; this file keeps the original projections,
// works out how much of his role is really up for grabs, blends in how teammates did in past
// games without him, and shows what changed.

const ROLES = (() => {
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Restore the data file's projections so the adjustment can be redone after an injury update
  function reset(data) {
    for (const p of Object.values(data.players)) {
      if (!p.base) p.base = clone(p.proj); else p.proj = clone(p.base);
      p.why = {};
    }
  }

  // How sure we are he sits: Out (and IR or suspended) counts fully, Doubtful mostly
  const outWeight = (p) => /^(out|injured reserve|suspen)/i.test(p.inj?.status || "") ? 1 : /^doubtful/i.test(p.inj?.status || "") ? 0.75 : 0;

  // Share of the team's last n games he played. If he has already been missing, the
  // teammates' recent numbers (and so their projections) already reflect that.
  function share(m, tm, roster, key, before, n) {
    const keys = [...new Set(roster.flatMap((p) => p.log.filter((r) => r.tm === tm && r[key] < before).map((r) => r[key])))].sort().slice(-n);
    if (!keys.length) return 0;
    const his = new Set(m.log.filter((r) => r.tm === tm).map((r) => r[key]));
    return keys.filter((k) => his.has(k)).length / keys.length;
  }

  // Scale a projection's average and keep its shape: the same spread relative to the average
  // for yardage and points, the same extra-randomness ratio for counts
  function scale(d, r) {
    if (!d || !(r > 0) || Math.abs(r - 1) < 1e-9) return;
    d.mean *= r;
    if (d.dist === "gamma" || d.dist === "normal") d.sd *= r;
    else if (d.dist === "negbin") d.sd *= Math.sqrt(r);
  }

  // Blend the model's change with what really happened in past games without him.
  // Six games of evidence count as much as the model.
  function blend(p, m, stat, key, modelRatio) {
    const sp = NOTES.without(p, m, stat, key);
    if (!sp || sp.n < 3 || sp.with < 1) return modelRatio;
    // those games can be from another season or roster, so they never outweigh the model
    // a teammate sitting never shrinks anyone's role here, whatever a small sample says
    const real = Math.min(1.6, Math.max(1, sp.without / sp.with)), n = Math.min(sp.n, 6);
    return (n * real + 6 * modelRatio) / (n + 6);
  }

  // Teammates can't gain more in total than the injured player gave up (times `keep`).
  // stat(p) reads the current value; apply(p, r) scales that player's affected stats by r.
  function cap(mates, before, total, stat, apply) {
    const gain = mates.reduce((a, p, i) => a + Math.max(0, stat(p) - before[i]), 0);
    if (gain <= total || gain <= 0) return;
    mates.forEach((p, i) => {
      const now = stat(p), add = Math.max(0, now - before[i]);
      if (now > 0 && add > 0) apply(p, (before[i] + add * total / gain) / now);
    });
  }

  function because(p, gid, m) {
    const w = (p.why[gid] ||= []);
    if (!w.includes(m.name)) w.push(m.name);
  }

  // Change from the data file's projection, if big enough to show
  function delta(p, gid, k) {
    const a = p.base?.[gid]?.[k]?.mean, b = p.proj[gid]?.[k]?.mean;
    if (a == null || b == null || !p.why[gid]?.length) return 0;
    return Math.abs(b - a) >= Math.max(0.05 * a, 0.15) ? b - a : 0;
  }
  // Small arrow next to an adjusted number
  function mark(p, gid, k, dec) {
    const dlt = delta(p, gid, k);
    if (!dlt) return "";
    const tip = `${dlt > 0 ? "Up" : "Down"} from ${p.base[gid][k].mean.toFixed(dec)} because ${p.why[gid].join(", ")} ${p.why[gid].length > 1 ? "are" : "is"} out`;
    return `<span class="adj ${dlt > 0 ? "up" : "down"}" title="${esc(tip)}">${dlt > 0 ? "▲" : "▼"}</span>`;
  }

  // ---------------------------------------------------------------- best spots

  // Books set most player lines close to a player's recent average. Without real prop lines,
  // that average (to the nearest .5) stands in for the line.
  const lastName = (n) => n.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "").split(" ").slice(1).join(" ") || n;
  const typicalLine = (vals) => Math.floor(vals.reduce((a, b) => a + b, 0) / vals.length) + 0.5;

  // cand: [{p, k, d, label, vals, st, gid}] -> props with upside or a solid floor, best first
  function spots(cand) {
    const out = [];
    for (const c of cand) {
      if (c.vals.length < 3) continue;
      const line = typicalLine(c.vals), pr = probs(c.d, line);
      const lift = c.d.mean / line - 1;
      const upside = lift >= 0.1 && pr.over >= 0.55;
      const safe = pr.over >= 0.6 && (c.st.cls === "s1" || c.st.cls === "s2");
      if (!upside && !safe) continue;
      const why = [];
      const dlt = delta(c.p, c.gid, c.k);
      if (dlt > 0) why.push({ kind: "good", text: `+${dlt.toFixed(1)}, ${c.p.why[c.gid].map(lastName).join(", ")} out` });
      if (c.d.f >= 1.05) why.push({ kind: "good", text: `Good matchup +${Math.round((c.d.f - 1) * 100)}%` });
      if (safe) why.push({ kind: "info", text: c.st.label });
      out.push({ ...c, line, over: pr.over, floor: quantile(0.2, c.d), ceil: quantile(0.9, c.d), upside, safe, why });
    }
    return out.sort((a, b) => b.over - a.over);
  }

  function spotsPanel(el, items, { dec, onAdd }) {
    items = items.slice(0, 14);
    el.innerHTML = `
      <div class="panel-head"><h2>Best spots</h2><span class="muted small"><b>Upside</b>: projection at least 10% above his usual line. <b>Safe floor</b>: a steady player the model likes to clear his usual line. Teammate injuries are built in.</span></div>
      ${items.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Player</th><th>Prop</th><th title="His recent average, to the nearest .5. Books usually set lines close to this.">Usual line</th><th>Projection</th><th>Chance over</th><th title="1 game in 5 goes below this, 1 in 10 goes above that">Bad night / big night</th><th>Why</th><th></th></tr></thead>
        <tbody>${items.map((it, i) => `<tr class="click" data-pid="${it.pid}">
          <td><span class="pname">${esc(it.p.name)}</span><span class="pos-tag">${esc(it.tag)}</span><div>${it.upside ? `<span class="spot up">Upside</span>` : ""}${it.safe ? `<span class="spot safe">Safe floor</span>` : ""}</div></td>
          <td>${esc(it.label)}</td>
          <td>${it.line}</td>
          <td><b>${it.d.mean.toFixed(dec(it.k))}</b>${mark(it.p, it.gid, it.k, dec(it.k))}</td>
          <td><b>${pct(it.over)}</b> <span class="muted small">${cents(it.over)}</span></td>
          <td>${Math.round(it.floor)} / ${Math.round(it.ceil)}</td>
          <td class="why"><div class="note-chips">${it.why.map(NOTES.chip).join("")}</div></td>
          <td><button class="btn add" data-i="${i}">+ Slip</button></td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty">Nothing stands out against the usual lines for this game.</div>`}
      <div class="note">Compare with the real line before betting: if the book's line is higher than the usual line shown here, the edge shrinks.</div>`;
    el.querySelectorAll("[data-i]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); onAdd(items[Number(b.dataset.i)]); });
    return items;
  }

  return { reset, outWeight, share, scale, blend, cap, because, delta, mark, spots, spotsPanel };
})();
