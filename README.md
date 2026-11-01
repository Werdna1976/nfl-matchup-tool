# NFL & NBA Matchup Lab

Two free web pages, one for NFL and one for NBA, switched with the NFL/NBA tabs in the top-left
corner. The sun/moon button in the top-right corner flips between light and dark mode (it
starts out matching your computer's setting and remembers your choice).

## How the site is laid out

**Live site:** https://werdna1976.github.io/nfl-matchup-tool/ (NBA: [nba.html](https://werdna1976.github.io/nfl-matchup-tool/nba.html))

- **🔒 Best bets** (header button, or the first card in the game list): the place to start on game day.
  - **Lock of the week** (NFL) / **Lock of the day** (NBA): up to three short parlays across one day's games
    (for example all of Sunday's NFL games, never two days at once), each paying 2.5x to 5x. Every leg is a
    real Polymarket line priced 35–92¢ with $20 of depth, passes the pressure test below, and has an adjusted
    chance at or above its price; at least two legs per lock are Verified. Legs from the same game must fit
    one storyline that happens in at least 1 game in 5 and never pull against each other. Each lock needs
    +5% expected return on cautious chances (half of the simulated "legs move together" boost counted), and
    the ones shown give the most return for the risk, share no player or game result, and use a game in at
    most two locks. Each card shows its "still worth it" payout, for when Polymarket's parlay builder quotes less.
  - **Best underpriced props**: single bets across every game today and tomorrow, pressure-tested.
- **Each game** has four tabs:
  - **Bets** (Polymarket, opens on its own): **Underpriced props** (single bets at least 3¢ under the model,
    graded Verified / Caution / Skip), **Storyline baskets** (parlays of up to 10 legs around one story,
    paying more than 5x; overpriced ones are folded away), and **Lottery tickets** (long shots at 4–30¢ priced at
    or below their chance, with small A–G groups that tend to hit together).
  - **Players**: projections with 80% ranges, anytime TD (NFL), the alt-line finder, and best spots. Tap a
    player for game logs, an odds ladder on Polymarket's steps, and a chart.
  - **Lines & matchup**: total and spread sliders, matchup strength.
  - **Notes & injuries**: injury report, hot and cold streaks, teammates out, ESPN headlines.
- **Parlay slip** (header): add legs, type Polymarket prices, compare with the model.
- **How the model works** (footer link): the method and its track record.

Lines read the way Polymarket shows them: "8+" for an over, "7 or fewer" for buying No on 8+.

### The pressure test

Every Polymarket leg the site recommends is checked: the model's backtested calibration for that kind of
bet, whether Polymarket's whole line ladder sees the same player the model does, the sportsbook line (game
bets), injuries and practice notes, ESPN headlines from the last 4 days, questionable teammates, the
24-hour price move, and edges too big to be real. The **adjusted chance** blends the calibrated model 50/50
with Polymarket's midpoint (plus the sportsbook line for game bets); Verified needs 3¢ of edge on that.
Basket and lock returns are judged on adjusted chances too, not the raw model.

### Models

The NFL player model blends recent form with last season, sets each range from the size of the role, and
mixes "normal" and occasional "dud" games so the upper tail isn't stretched. Its weights live in
`scripts/model_params.json`, fitted on 2022–2024 game logs by `scripts/fit_model.py` and checked on 2025 and
2026 (about 10% of results land above its 90th percentile). Refit once a season with
`python scripts/fit_model.py` (about 15 minutes).

The NBA model projects minutes (lineups fitted to 240 per team, teammates out handed to the rest), then
multiplies by per-minute production adjusted for pace, opponent, and the implied team score. Its 80% ranges
caught about 79% of past results.

Polymarket prices are pulled on game day (NBA), from the day before (NFL), or any time a game starts within
24 hours, and re-pulled every 2 minutes while a page is open.

## Where the data comes from

| What | Source | Key needed? |
|---|---|---|
| Player and team stats, schedule, consensus lines, injuries | [nflverse](https://github.com/nflverse/nflverse-data) | No |
| Fresher spread and total | ESPN public scoreboard | No |
| NBA box scores, schedule | [sportsdataverse](https://github.com/sportsdataverse/sportsdataverse-data) (ESPN data, updated daily) | No |
| NBA lines, injury report, last night's box scores | ESPN public API | No |
| Live injury report and headlines for player notes (both sports) | ESPN public API, read by your browser | No |

A GitHub Action rebuilds the data every hour and republishes the site. While a page is open it
re-checks lines, the ESPN injury report, and headlines every 10 minutes. Each time the page
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
python scripts/nba_build.py           # writes site/data/nba.json and nba_backtest.json
cd site && python -m http.server 8000 # open http://localhost:8000
```

## Files

- `scripts/build_data.py` downloads data and builds projections.
- `scripts/model.py` holds the probability math (mirrored in `site/app.js`).
- `scripts/backtest.py` replays past weeks to check the ranges and tunes their width.
- `scripts/nba_build.py` downloads NBA data, builds projections, and tests the ranges on past games.
- `site/` is the web pages (plain HTML, CSS, JavaScript; no build step): `index.html` + `app.js` for NFL,
  `nba.html` + `nba.js` for NBA. Shared by both: `nav.js` (dark/light toggle, game tabs), `baskets.js`
  (Polymarket pull, simulation, baskets, underpriced props, lottery), `vet.js` (pressure test), `locks.js`
  (Lock of the week/day), `allprops.js` (Best bets view), `notes.js`, `roles.js`, `result.js`.
