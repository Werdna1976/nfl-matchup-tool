"use strict";

// Shared by the NFL and NBA pages: the dark/light toggle. The sport switch is plain links.
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
