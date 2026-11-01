"use strict";

// Polymarket's prop ladders, in one place for every page and every bet list.
//
// Player props on Polymarket are "N+" markets: Yes on 4+ rebounds is over 3.5, and No on 4+ is
// "3 or fewer". The rungs come in fixed steps, so a line between rungs (5+ rebounds when the board
// is 4+ and 6+) can't be bet and must never be shown. Every generator (storyline baskets, lottery
// tickets, underpriced props, Best props, the lock, the alt-line finder, Best spots) reads its
// steps from here, and BASKETS drops any leg that isn't on a rung.
//
//   NBA: points, PRA, P+R, P+A in 5s (10+, 15+, 20+ ...); rebounds, assists, R+A in 2s (2+, 4+, 6+);
//        threes, steals, blocks, turnovers in 1s
//   NFL: passing yards in 25s; rushing, receiving, rush + rec yards on 5s (10s for lead backs and
//        good receivers, which still land on the 5s grid); counts (receptions, attempts, TDs) in 1s

const STEPS = (() => {
  const GRID = {
    nba: { pts: 5, pra: 5, pr: 5, pa: 5, reb: 2, ast: 2, ra: 2 },
    nfl: { pyd: 25, ryd: 5, yds: 5, rry: 5 },
  };
  // every rung of this stat is a multiple of this
  const grid = (league, key) => GRID[league]?.[key] || 1;
  // is "over line" (line = N - 0.5, the N+ market) a rung Polymarket lists?
  function onLadder(league, key, line) {
    const step = grid(league, key), n = line + 0.5;
    if (Math.abs(n - Math.round(n)) > 1e-9) return false;   // only N+ markets exist (half-point lines)
    return step === 1 ? n >= 1 : Math.round(n) % step === 0 && n >= step;
  }
  // the rung nearest x (a number of yards, points...), as the N in "N+"
  const snap = (league, key, x, step = grid(league, key)) => Math.max(step, Math.round(x / step) * step);
  return { grid, onLadder, snap };
})();
