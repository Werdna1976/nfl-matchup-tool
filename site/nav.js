"use strict";

// Shared by the NFL and NBA pages: the dark/light toggle and the tabs on a game's page.
// The sport switch is plain links.
// The theme is set before the page draws by a one-line script in each page's <head>.
(function () {
  const btn = document.getElementById("themeBtn");
  if (!btn) return;
  const root = document.documentElement;
  const show = () => {
    const dark = root.dataset.theme === "dark";
    btn.textContent = dark ? "☀" : "☾";
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", btn.title);
  };
  btn.onclick = () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (e) { /* private mode */ }
    show();
  };
  show();
})();

// A game's page is split into tabs so the bets aren't buried under reference tables. The tab you
// picked last is remembered, so moving between games keeps you on it.
const GAME_TABS = (() => {
  const TABS = [["bets", "Bets"], ["players", "Players"], ["game", "Lines & matchup"], ["notes", "Notes & injuries"]];
  let cur = "bets";
  try { cur = localStorage.getItem("gameTab") || "bets"; } catch (e) { /* private mode */ }
  if (!TABS.some(([id]) => id === cur)) cur = "bets";
  const bar = () => `<div class="gtabs" role="tablist" aria-label="Game sections">${TABS.map(([id, label]) => `<button type="button" role="tab" data-gtab="${id}" aria-selected="${id === cur}">${label}</button>`).join("")}</div>`;
  function show(root) {
    root.querySelectorAll("[data-tab]").forEach((d) => { d.hidden = d.dataset.tab !== cur; });
    root.querySelectorAll("[data-gtab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.gtab === cur)));
  }
  function wire(root) {
    root.querySelectorAll("[data-gtab]").forEach((b) => (b.onclick = () => {
      cur = b.dataset.gtab;
      try { localStorage.setItem("gameTab", cur); } catch (e) { /* private mode */ }
      show(root);
    }));
    show(root);
  }
  return { bar, wire };
})();
