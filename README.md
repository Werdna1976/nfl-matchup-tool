# NFL & NBA Matchup Lab

Two free web pages, one for NFL and one for NBA, switched with the NFL/NBA tabs in the top-left
corner. The sun/moon button in the top-right corner flips between light and dark mode (it
starts out matching your computer's setting and remembers your choice).

## How the site is laid out

**Live site:** https://werdna1976.github.io/nfl-matchup-tool/ (NBA: [nba.html](https://werdna1976.github.io/nfl-matchup-tool/nba.html))

- **🔒 Best bets** (header button, or the first card in the game list): the place to start on game day.
  - **Lock of the week** (NFL) / **Lock of the day** (NBA): up to five short parlays across one day's games
    (for example all of Sunday's NFL games, never two days at once), each paying 2.5x to 5x. Every leg is a
    real Polymarket line priced 35–92¢ with $20 of depth that the pressure test grades Verified or Caution
    (never Flagged); Verified legs aren't required, since real Verified misprices are rare. Legs from the same game must fit
    one storyline that happens in at least 1 game in 5 and never pull against each other. Each lock needs
    +2% expected return on cautious chances (half of the simulated "legs move together" boost counted), and
    the ones shown give the most return for the risk, share no player or game result, and use a game in at
    most three locks. Each card shows its "still worth it" payout, for when Polymarket's parlay builder quotes less.
  - **Best mispriced props**: single bets across every game today and tomorrow where the model's fair price
    beats Polymarket's, pressure-tested.
- **🏆 Leaders** (header button, or the second card in the game list): who finishes on top of the slate in one
  stat, with each player's chance and fair price. NFL: passing yards, passing TDs, rushing yards, receiving yards,
  and receptions for the whole week or one day (Thursday, Sunday, Monday). NBA: points, rebounds, assists, threes,
  and PRA for the day picked at the top. Every game is simulated with the same engine as the game pages and the top
  number in each simulated slate wins (ties split); finished games count with their real box score. Each player shows
  his projection, his **ceiling** (what he reaches 1 game in 10 and 1 in 33), his **volatility** next to the other
  contenders, and notes such as "Upside pick" (his chance to lead ranks well above his projection) or "Steady, not
  explosive", plus game script (likely trailing, blowout risk, highest total). When Polymarket lists a leader market
  for that stat and slate, its price and the edge show next to the model's.
- **Each game** has four tabs:
  - **Bets** (Polymarket, opens on its own): **Mispriced props** (single bets where the model's fair price is at
    least 3¢ above Polymarket's, graded Verified / Caution / Flagged; flagged bets stay listed with their likely issue named), **Negative correlation multipliers** (two props that land
    together less often than their chances multiplied but still at least 1 game in 8, both priced at or below fair,
    with the payout a parlay needs to be worth it and how much more than straight multiplication that is), and **Lottery tickets** (long shots at 4–30¢ priced at or below their chance). Click any player's bet (or its **Last 10** button) to open a
    side panel with his last 10 games: every stat, the bet's stat highlighted, each game marked hit or miss.
  - **Players**: projections with 80% ranges, anytime TD (NFL), the alt-line finder, and best spots. Tap a
    player for game logs, an odds ladder on Polymarket's steps, and a chart.
  - **Lines & matchup**: total and spread sliders, **How the players add up** (each team's line next to what its
    players add up to), matchup strength.
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

**Players add up to the team.** Each team gets a line from team stats alone (NFL: pace, pass rate, matchup, and
touchdowns from the score the betting line implies; NBA: the implied score, plus pace times the team's rebound,
assist, and 3-point rates against what the opponent allows). Players are scaled so they add up to it. NFL
passing, receiving, rushing, and touchdowns meet halfway between the team line and the players' own sum (the
starting QB moves half as far, since his own numbers forecast him better); NBA points add up to the implied score
exactly and the rest to a 50/50 blend. Unlisted depth players keep their usual share. In 2024–2026 backtests this
brought team totals much closer (NFL team receiving yards: average miss 72 when summed from the receivers, 61 blended) and left player
projections as good or slightly better.

**How props move together.** The game simulation behind the pairs and locks is fitted to past results (each
player's result vs. his projection, paired with teammates', opponents', and the final score): NFL 2024–2026,
NBA 2024-25 and 2025-26. Examples: a QB's passing yards and his top receiver's yards +0.41, opposing lead backs'
carries −0.29, two NBA starters' points −0.02.

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
  (Polymarket pull, simulation, mispriced props, lottery), `pairs.js` (negative correlation multipliers),
  `trend.js` (the last-10-games side panel), `vet.js` (pressure test), `locks.js`
  (Lock of the week/day), `allprops.js` (Best bets view), `notes.js`, `roles.js`, `result.js`.
