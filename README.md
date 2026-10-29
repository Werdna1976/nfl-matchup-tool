# NFL Matchup Lab

A free web page for this week's NFL games: betting lines, player stat trends, how steady each
player is, matchup strength (pass and run), and a projected range for each player's key props.
Built for picking alt lines and parlay legs on Polymarket.

**Live site:** https://werdna1976.github.io/nfl-matchup-tool/

## What's on the page

- **Games**: spread, total, and moneyline for this week and next, plus a projected score.
- **Total points and spread tools**: slide to any line and see the model's chance of over/under or cover, with the fair price in cents.
- **Matchup strength**: each offense's passing and rushing vs. the opponent's pass and run defense, the expected pass rate, and implied team points.
- **Player projections**: QBs, RBs, WRs, TEs with a projected average and an 80% range for attempts, completions, yards, targets, receptions, carries, TDs, and INTs.
- **Player detail**: season and last-3 averages, how swingy the stat is, a game-by-game chart, and an over/under calculator for any line.
- **Alt-line finder**: for a confidence level you pick (60–90%), the line each player should clear, sorted steadiest first.
- **Parlay slip**: add legs, type in Polymarket prices, see the combined chance and whether the price looks good.
- **How the model works**: plain-language explanation plus its track record on past weeks this season.

## Where the data comes from

| What | Source | Key needed? |
|---|---|---|
| Player and team stats, schedule, consensus lines, injuries | [nflverse](https://github.com/nflverse/nflverse-data) | No |
| Fresher spread and total | ESPN public scoreboard | No |
| Polymarket game markets and prices | Polymarket public API | No |

A GitHub Action rebuilds the data every 3 hours and republishes the site. Each time the page
loads (or you press **Refresh**), it also asks ESPN for the latest lines. If ESPN is blocked on
that computer, it keeps the last lines it saw.

Note: GitHub pauses scheduled Actions in a repo that has had no activity for 60 days. If the
data stops updating, open the **Actions** tab and re-enable the workflow, or run it by hand
with **Run workflow**.

## Running it on your own computer

```bash
pip install -r requirements.txt
python scripts/build_data.py          # writes site/data/data.json
python scripts/backtest.py 2026       # writes site/data/backtest.json
cd site && python -m http.server 8000 # open http://localhost:8000
```

## Files

- `scripts/build_data.py` downloads data and builds projections.
- `scripts/model.py` holds the probability math (mirrored in `site/app.js`).
- `scripts/backtest.py` replays past weeks to check the ranges and tunes their width.
- `site/` is the web page (plain HTML, CSS, JavaScript; no build step).
