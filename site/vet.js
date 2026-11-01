"use strict";

// Pressure-tests each underpriced prop before it's shown, shared by the NFL and NBA pages.
//
// A big gap between the model and Polymarket is either a real mispricing or, more often, the
// model missing something: a role change, an injury that isn't on the report yet, a bad
// calibration for that kind of bet. Each check below looks for one of those and leaves a
// reason. The grade:
//   Verified  every check passes and the adjusted edge is at least MIN_ADJ
//   Caution   something worth reading first, or the adjusted edge is small
//   Skip      a check failed badly: likely news or model error, not a mispricing
//
// The adjusted chance blends the model (corrected by its own track record on that kind of bet)
// with Polymarket's midpoint, and for game lines with the sportsbook line too. It's a fairer
// number to compare with the price than the raw model chance, so big edges get cut down to size.
//
// Each page's adapter supplies: scaled(pl, key, line, r) (the chance with the player's volume
// times r), mean(pl, key), calib(key), person(pid), mates(pl).

const VET = (() => {
  const CLOB = "https://clob.polymarket.com";
  const MIN_ADJ = 0.03;                    // adjusted edge needed for Verified
  const SKIP_ADJ = 0.01;                   // below this the edge is gone once checked
  const BIG_EDGE = 0.15, HUGE_EDGE = 0.25; // raw edges this large are rarely real on a liquid market
  const GAP_WARN = 0.15, GAP_BAD = 0.3;    // Polymarket sees this much less (or more) of the player than the model
  const DRIFT_WARN = 0.05, DRIFT_BAD = 0.1;   // price moved this far against the bet in a day
  const W_MODEL = 0.5;                     // weight on the model (vs Polymarket's midpoint) in the adjusted chance
  const HIST_MS = 10 * 60 * 1000;          // reuse a price history for 10 minutes

  const pctTxt = (p) => `${Math.round(p * 100)}%`;
  const c = (p) => `${Math.round(p * 100)}¢`;
  // an edge in cents, with a decimal when small so 2.6 doesn't read as 3
  const ec = (e) => { const v = e * 100, a = Math.abs(v); return `${v >= 0 ? "+" : "−"}${a < 10 ? a.toFixed(1) : Math.round(a)}`; };
  const fmtN = (v) => (v >= 20 ? Math.round(v) : Math.round(v * 10) / 10);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const mid = (l) => (l.bid != null && l.ask != null ? (l.bid + l.ask) / 2 : null);

  function Phi(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  // Words in a headline that mean the player's health or role is in doubt
  const HEALTH = /injur|concussion|illness|\bill\b|sick|headache|migraine|hamstring|ankle|knee|groin|calf|quad|achilles|back (?:injury|spasm|tightness)|shoulder|wrist|\bhand\b|foot|toe|hip|rib|oblique|questionable|doubtful|game-time|limited|did not practice|\bdnp\b|ruled out|personal reasons|suspend|\bsore|soreness|minutes restriction|load management|resting/i;
  const ROLE = /bench|demot|snap count|pitch count|starter|starting|depth chart|split|committee|trade|traded|released|waived|activated|returns|return from|elevated|promoted/i;

  // ------------------------------------------------------------ calibration

  // The model's chance corrected by its record on this kind of bet (from the backtest). curve.c[i]
  // is the share of past results at or below the model's (5 * i)th percentile. "Over" bets win
  // when the result lands above the line, so their real rate is 1 - C(1 - p).
  function calibrated(curve, p, overLike) {
    if (!curve?.c || curve.c.length !== 21) return null;
    const C = (u) => { const x = Math.min(20, Math.max(0, u * 20)), i = Math.min(19, Math.floor(x)); return curve.c[i] + (curve.c[i + 1] - curve.c[i]) * (x - i); };
    const real = overLike ? 1 - C(1 - p) : C(p);
    const w = curve.n / (curve.n + 300);   // trust a small sample less
    return p + w * (real - p);
  }

  // over-like: the bet wins when the stat (or home margin, for game lines) comes in high
  const overLike = (l, g) => (l.kind === "player" || l.kind === "total" ? l.side === "over" : l.side === g.home);
  const calibKey = (l) => (l.kind === "player" ? l.key : l.kind === "total" ? "total" : "margin");

  // ------------------------------------------------------------ market vs model on volume

  // The volume multiplier r at which the model's chance for this leg equals Polymarket's midpoint:
  // r = 0.8 means Polymarket prices him as if he'll get 20% less than the model projects.
  function impliedScale(A, pl, l) {
    const target = mid(l);
    if (target == null || target <= 0.02 || target >= 0.98) return null;
    const at = (r) => { const pr = A.scaled(pl, l.key, l.line, r); return pr ? (l.side === "over" ? pr.over : pr.under) : null; };
    if (at(1) == null) return null;
    let lo = Math.log(0.25), hi = Math.log(4);
    const up = l.side === "over";   // overs get likelier as volume rises, unders less likely
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2, v = at(Math.exp(m));
      if ((v < target) === up) lo = m; else hi = m;
    }
    return Math.exp((lo + hi) / 2);
  }

  // ------------------------------------------------------------ one row's checks

  function grade(row, { A, g, legs }) {
    const reasons = [];   // {lvl: ok | warn | bad, text}
    const add = (lvl, text) => reasons.push({ lvl, text });
    const m = mid(row);

    // 1. calibration by bet type
    const curve = A.calib(calibKey(row));
    const pc = calibrated(curve, row.p, overLike(row, g));
    const pCal = pc ?? row.p;
    if (pc != null && Math.abs(pc - row.p) >= 0.02) {
      add(pc < row.p ? "warn" : "ok", `Track record: bets like this have hit about ${pctTxt(pc)} when the model said ${pctTxt(row.p)}`);
    }

    // 2. game lines: what the sportsbooks' line says
    let pBook = null;
    if (row.kind !== "player") {
      const gm = g.model, book = /stats model|no line/i.test(g.line_src || "") ? null : g;
      if (row.kind === "total" && book?.total != null) {
        const under = Phi((row.line - book.total) / gm.total.sd);
        pBook = row.side === "over" ? 1 - under : under;
      } else if ((row.kind === "spread" || row.kind === "ml") && book?.spread != null) {
        const mean = row.side === g.home ? book.spread : -book.spread;
        pBook = 1 - Phi((-(row.kind === "spread" ? row.line : 0) - mean) / gm.margin.sd);
      }
      const what = row.kind === "total" ? `total ${book?.total}` : `spread ${book?.spread > 0 ? `${g.home} -${book?.spread}` : book?.spread < 0 ? `${g.away} -${-book?.spread}` : "pick'em"}`;
      if (pBook != null) {
        const e = pBook - row.price, src = String(g.line_src || "sportsbook").replace(/\s*\(live\)/, "");
        if (e < 0) add("bad", `Sportsbooks disagree: their ${what} (${src}) makes this a ${pctTxt(pBook)} bet, below the ${c(row.price)} price`);
        else if (e < MIN_ADJ) add("warn", `Sportsbooks barely agree: their ${what} makes this ${pctTxt(pBook)} against a ${c(row.price)} price`);
        else add("ok", `Sportsbooks agree: their ${what} makes this ${pctTxt(pBook)}`);
      } else add("warn", "No sportsbook line to compare with yet");
    }

    // 3. player props: does Polymarket see the same player the model does?
    const pl = row.kind === "player" ? A.player(row.pid) : null;
    if (pl) {
      const ladder = legs.filter((l) => l.kind === "player" && l.pid === row.pid && l.key === row.key);
      const rs = ladder.map((l) => impliedScale(A, pl, l)).filter((r) => r != null);
      if (rs.length) {
        const r = median(rs), against = row.side === "over" ? 1 - r : r - 1, mean = A.mean(pl, row.key);
        const how = row.key === "anytd" || !(mean > 0)
          ? `rates his ${row.key === "anytd" ? "touchdown" : A.statLabel(row.key)} chances ${Math.round(Math.abs(1 - r) * 100)}% ${r < 1 ? "lower" : "higher"} than the model does`
          : `prices him for about ${fmtN(mean * r)} ${A.statLabel(row.key)}; the model projects ${fmtN(mean)}`;
        const nLines = new Set(ladder.map((l) => l.line)).size;
        const lines = nLines > 1 ? ` (read from ${nLines} lines)` : "";
        if (against >= GAP_BAD) add("bad", `Polymarket ${how}${lines}. A gap this size usually means news or a role change the model hasn't seen`);
        else if (against >= GAP_WARN) add("warn", `Polymarket ${how}${lines}. Check for news before betting`);
        else add("ok", `Polymarket ${how}${lines}: close, so this is a pricing gap, not a different read on the player`);
      }

      // 4. injuries, news, teammates
      const p = A.person(row.pid) || {};
      const inj = p.inj || {};
      if (row.q) {
        const dnp = /did not|dnp|^out|not participate/i.test(inj.practice || "");
        const why = [inj.injury, inj.practice, inj.note].filter(Boolean).join(", ");
        add(row.side === "over" && dnp ? "bad" : "warn", `${row.q}${why ? ` (${why})` : ""}: he may sit or leave early, and Polymarket may already know more`);
      } else if (/limited|did not|dnp/i.test(inj.practice || "")) {
        add("warn", `Practice: ${inj.practice}${inj.injury ? ` (${inj.injury})` : ""}, though not on the game status report`);
      }
      const news = (typeof NOTES !== "undefined" ? NOTES.newsFor(pl.name) : []).slice(0, 3);
      for (const n of news) {
        const txt = `${n.headline} ${n.text || ""}`;
        if (HEALTH.test(txt)) add(row.side === "over" ? "bad" : "warn", `Health news: "${n.headline}"`);
        else if (ROLE.test(txt)) add("warn", `Role news: "${n.headline}"`);
        else add("ok", `Recent news (read it): "${n.headline}"`);
      }
      const gid = g.id, base = p.base?.[gid]?.[row.key]?.mean, now = p.proj?.[gid]?.[row.key]?.mean;
      if (p.why?.[gid]?.length && base != null && now != null && Math.abs(now - base) >= Math.max(0.05 * base, 0.15)) {
        const helps = (now > base) === (row.side === "over");
        if (helps) add("warn", `The model moved his ${A.statLabel(row.key)} from ${fmtN(base)} to ${fmtN(now)} because ${p.why[gid].join(", ")} ${p.why[gid].length > 1 ? "are" : "is"} out. That shift is an estimate, and part of this edge`);
      }
      const mates = A.mates ? A.mates(pl) : [];
      if (mates.length) add("warn", `Teammate${mates.length > 1 ? "s" : ""} questionable: ${mates.join(", ")}. If ${mates.length > 1 ? "they sit" : "he sits"}, this projection changes`);
      const games = (p.log || []).filter((r) => r.tm === p.team).length;
      if (p.log && games < 3) add("warn", `Only ${games} game${games === 1 ? "" : "s"} with this team to go on`);
    }

    // 5. edge size
    if (row.edge >= HUGE_EDGE) add("bad", `A ${Math.round(row.edge * 100)}¢ edge on a market with $${BASKETS.STAKE} of depth is almost never real`);
    else if (row.edge >= BIG_EDGE) add("warn", `${Math.round(row.edge * 100)}¢ is a big edge: treat it as a question, not an answer`);

    // the adjusted chance: the calibrated model, blended with Polymarket's midpoint (and the sportsbook line for game bets)
    const parts = [[pCal, W_MODEL]];
    if (m != null) parts.push([m, 1 - W_MODEL]);
    if (pBook != null) parts.push([pBook, 1 - W_MODEL]);
    const tw = parts.reduce((a, [, w]) => a + w, 0);
    const pAdj = parts.reduce((a, [v, w]) => a + v * w, 0) / tw;
    return finish({ ...row, vet: { reasons, pCal, pBook, pAdj, adj: pAdj - row.price, drift: null } });
  }

  function finish(row) {
    const v = row.vet, rs = v.reasons;
    let level = rs.some((r) => r.lvl === "bad") ? "skip" : rs.some((r) => r.lvl === "warn") || v.adj < MIN_ADJ ? "caution" : "verified";
    if (v.adj < SKIP_ADJ) level = "skip";
    v.level = level;
    // say so when the only problem is how little edge is left
    v.adjNote = v.adj < MIN_ADJ ? `Only ${ec(v.adj)}¢ left after blending the model with Polymarket's price (Verified needs +${Math.round(MIN_ADJ * 100)}¢)` : null;
    v.order = { verified: 0, caution: 1, skip: 2 }[level];
    return row;
  }

  // ------------------------------------------------------------ price drift over the last day

  const HIST = {};
  async function history(token) {
    const h = HIST[token];
    if (h && Date.now() - h.t < HIST_MS) return h.v;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    let v = null;
    try {
      const r = await fetch(`${CLOB}/prices-history?market=${encodeURIComponent(token)}&interval=1d&fidelity=30`, { signal: ctl.signal, cache: "no-store" });
      if (r.ok) {
        const pts = ((await r.json()).history || []).map((x) => ({ t: Number(x.t) * 1000, p: Number(x.p) })).filter((x) => x.p > 0 && x.p < 1).sort((a, b) => a.t - b.t);
        if (pts.length >= 2 && pts.at(-1).t - pts[0].t >= 3 * 3600e3) v = { from: pts[0].p, to: pts.at(-1).p, hours: Math.round((pts.at(-1).t - pts[0].t) / 3600e3) };
      }
    } catch (e) { /* no history: skip the check */ } finally { clearTimeout(timer); }
    HIST[token] = { t: Date.now(), v };
    return v;
  }

  // Adds the drift check to rows that will be shown (a few at a time), then re-grades them
  async function drift(rows) {
    let next = 0;
    const work = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        if (!row.token || !row.vet) continue;
        const h = await history(row.token);
        if (!h) continue;
        const d = h.to - h.from, span = h.hours >= 20 ? "the last day" : `the last ${h.hours} hours`;
        row.vet.drift = d;
        if (d <= -DRIFT_BAD) row.vet.reasons.push({ lvl: "bad", text: `Price fell ${c(h.from)} → ${c(h.to)} over ${span}: money is going the other way` });
        else if (d <= -DRIFT_WARN) row.vet.reasons.push({ lvl: "warn", text: `Price slipped ${c(h.from)} → ${c(h.to)} over ${span}: the market is leaning away from this bet` });
        else if (d >= DRIFT_WARN) row.vet.reasons.push({ lvl: "ok", text: `Price rose ${c(h.from)} → ${c(h.to)} over ${span}: others are buying this side too` });
        finish(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, rows.length) }, work));
    return rows;
  }

  // ------------------------------------------------------------ display

  const LABEL = { verified: "Verified", caution: "Caution", skip: "Skip" };
  const ICON = { ok: "✓", warn: "⚠", bad: "✕" };
  const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  // the Check cell: grade badge and the edge left after the checks
  function cell(row) {
    const v = row.vet;
    if (!v) return `<td></td>`;
    return `<td class="vet-cell"><span class="vet-badge vet-${v.level}">${LABEL[v.level]}</span><div class="muted small" title="Adjusted chance ${pctTxt(v.pAdj)}: the model corrected by its track record, blended with Polymarket's midpoint${v.pBook != null ? " and the sportsbook line" : ""}">adj. ${ec(v.adj)}</div></td>`;
  }

  // the reasons, under the bet: problems first, then up to two passes
  function why(row) {
    const v = row.vet;
    if (!v) return "";
    const rank = { bad: 0, warn: 1, ok: 2 };
    const rs = [...v.reasons].sort((a, b) => rank[a.lvl] - rank[b.lvl]);
    const shown = [...(v.adjNote ? [{ lvl: v.level === "skip" && !rs.some((r) => r.lvl === "bad") ? "bad" : "warn", text: v.adjNote }] : []),
      ...rs.filter((r) => r.lvl !== "ok"), ...rs.filter((r) => r.lvl === "ok").slice(0, 2)];
    if (!shown.length) return "";
    return `<ul class="vet-why">${shown.map((r) => `<li class="vet-${r.lvl}"><span aria-hidden="true">${ICON[r.lvl]}</span> ${escH(r.text)}</li>`).join("")}</ul>`;
  }

  // best first, with Skips held back for their own list
  const sort = (rows) => [...rows].sort((a, b) => (a.vet && b.vet ? b.vet.adj - a.vet.adj : b.edge - a.edge));

  const RULES = `Each bet is checked before it's listed: the model's record on that kind of bet, whether Polymarket's whole line ladder sees the same player the model does, the sportsbook line (game bets), the injury report and practice notes, ESPN headlines from the last 4 days, teammates who are questionable, how far the price moved in the last day, and whether the edge is too big to be real. <b>Verified</b> passes everything with at least ${Math.round(MIN_ADJ * 100)}¢ of edge left after adjusting; <b>Caution</b> has something to read first; <b>Skip</b> failed a check. "Adj." is the edge after blending the model with Polymarket's own price, which is the number to trust over the raw edge.`;

  return { grade, drift, cell, why, sort, RULES, MIN_ADJ, calibrated, impliedScale };
})();
