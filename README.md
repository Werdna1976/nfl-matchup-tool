# NFL & NBA Matchup Lab

Two free web pages, one for NFL and one for NBA, switched with the NFL/NBA tabs in the top-left
corner. The sun/moon button in the top-right corner flips between light and dark mode (it
starts out matching your computer's setting and remembers your choice).

## NFL page

A free web page for this week's NFL games: betting lines, player stat trends, how steady each
player is, matchup strength (pass and run), and a projected range for each player's key props.
Built for picking alt lines and parlay legs on Polymarket.

**Live site:** https://werdna1976.github.io/nfl-matchup-tool/

## What's on the page

- **Games**: spread, total, and moneyline for this week and next, plus a projected score.
- **Total points and spread tools**: slide to any line to see the model's chance of over/under or cover with the fair price in cents.
- **NBA shot volume**: 3-point attempts, 2-pointers made, and 2-point attempts, projected from minutes like every other stat.
- **NBA minutes that add up**: projected starters from recent lineups, starter and bench minutes estimated separately, and each team's expected minutes fitted to 240. This season counts far more than last; players whose minutes changed a lot from last season are flagged.
- **Teammate injuries built in**: when a player is Out or Doubtful, his minutes (NBA) or carries and targets (NFL) are handed to teammates, blended with how they did in past games without him.
- **Best spots**: props where the projection sits well above the player's usual line (upside) or a steady player should clear it (safe floor).
- **Storyline baskets** (both pages): baskets of up to 10 legs built around a story (a defense shuts a team down, a scorer plus a playmaker, two players carry the team, a runaway, a close game, a shootout, a grind, and a pure "inefficiencies" pick) that pay more than 4x net. Each storyline must happen in at least 1 simulated game in 5 (each card shows that chance and how often the basket hits when it does); the basket on top can be a long one, down to about 1 in 40, and with prices it is the one whose payout beats the model's odds by the most. Six per game, always including both "team runs away with it" baskets; each has at least one moneyline, spread, or total leg, never stacks two bets on the same game market or player, and skips longshot legs (under about 40%). Lines read the way Polymarket shows them (8+, 7 or fewer). Priced from Polymarket's live order book at the ask, with thin or wide markets flagged, and pulled only on game day (NBA) or from the day before (NFL). Legs are simulated together so related legs move together. If Polymarket has no player props for a game, it says so and shows model-only baskets with their break-even payout.
- **Underpriced props** (both pages): single Polymarket bets (player props and game lines) whose ask is at least 3¢ below the model's chance, biggest gap first, with $20 depth required. Each line ladder is one row (its best line plus the range of lines also underpriced), and the list is mixed: one row per player, per side of the game result, and per total, and at most two of any one kind of bet. Prices are pulled on game day (NBA), the day before (NFL), or any time a game starts within 24 hours.
- **Lottery tickets** (both pages): about 10 of the best single long shots per game from Polymarket's real markets (4–30¢, only ones priced at or below the model's chance), with a grid of lettered groups (A–G) beside them that tend to hit on the same night; click a letter to fold its column. Before prices are out it previews each regular's big-night line on Polymarket's own ladder (5s for points and PRA, 2s for rebounds and assists).
- **Player notes**: injury status, good or tough matchups, hot and cold streaks, teammates ruled out (with how the player did in past games without them), and recent ESPN headlines.
- **Matchup strength**: each offense's passing and rushing vs. the opponent's pass and run defense, the expected pass rate, and implied team points.
- **Player projections**: QBs, RBs, WRs, TEs with a projected average and an 80% range for attempts, completions, yards, targets, receptions, carries, TDs, and INTs.
- **Player detail**: last 3/5/all games up top with averages, projection, and expected range for every stat. Pick a stat for an odds ladder at Polymarket's line steps (25 yds for QB passing, 10 for lead RBs and good WRs, 5 for TEs and depth WRs), plus a game-by-game chart.
- **Anytime TD**: each player's chance of a rushing or receiving TD (and 2+), with fair price.
- **Alt-line finder**: for a confidence level you pick (60–90%), the Polymarket-style line each player should clear, sorted steadiest first.
- **Parlay slip**: add legs, type in Polymarket prices, see the combined chance and whether the price looks good.
- **How the model works**: plain-language explanation plus its track record on past weeks this season.

The NFL player model blends recent form with last season, sets each range from the size of the role (bigger roles swing less), and mixes "normal" games with occasional "dud" games so the upper tail isn't stretched. Its weights live in `scripts/model_params.json`, fitted on 2022–2024 game logs by `scripts/fit_model.py` and checked on 2025 and 2026: about 10% of results land above its 90th percentile and 5% above its 95th, top players included. Refit once a season with `python scripts/fit_model.py` (takes about 15 minutes).

## NBA page

**Live site:** https://werdna1976.github.io/nfl-matchup-tool/nba.html

- **Game days**: today, tomorrow, and the next game day, with spread, total, moneyline, and projected score.
- **Total points and spread tools**: same sliders as the NFL page.
- **NBA shot volume**: 3-point attempts, 2-pointers made, and 2-point attempts, projected from minutes like every other stat.
- **NBA minutes that add up**: projected starters from recent lineups, starter and bench minutes estimated separately, and each team's expected minutes fitted to 240. This season counts far more than last; players whose minutes changed a lot from last season are flagged.
- **Teammate injuries built in**: when a player is Out or Doubtful, his minutes (NBA) or carries and targets (NFL) are handed to teammates, blended with how they did in past games without him.
- **Best spots**: props where the projection sits well above the player's usual line (upside) or a steady player should clear it (safe floor).
- **Storyline baskets** (both pages): baskets of up to 10 legs built around a story (a defense shuts a team down, a scorer plus a playmaker, two players carry the team, a runaway, a close game, a shootout, a grind, and a pure "inefficiencies" pick) that pay more than 4x net. Each storyline must happen in at least 1 simulated game in 5 (each card shows that chance and how often the basket hits when it does); the basket on top can be a long one, down to about 1 in 40, and with prices it is the one whose payout beats the model's odds by the most. Priced from Polymarket's live order book at the ask, with thin or wide markets flagged, and pulled only on game day (NBA) or from the day before (NFL). Legs are simulated together so related legs move together. If Polymarket has no player props for a game, it says so and shows model-only baskets with their break-even payout.
- **Lottery tickets** (both pages): about 10 of the best single long shots per game from Polymarket's real markets (4–30¢, only ones priced at or below the model's chance), with a grid of lettered groups (A–G) beside them that tend to hit on the same night; click a letter to fold its column. Before prices are out it previews each regular's big-night line on Polymarket's own ladder (5s for points and PRA, 2s for rebounds and assists).
- **Player notes**: same as the NFL page, plus back-to-backs and likely blowouts.
- **Matchup strength**: scoring, 3-pointers, and rebounding for each offense vs. the opponent's defense, plus pace (more possessions means more stats for everyone).
- **Player projections**: minutes, points, rebounds, assists, 3-pointers, PRA, steals, blocks, each with an 80% range, plus double-double chance.
- **Player detail**: last 5/10/all recent games (early in the season this includes the end of last season, marked), averages, projection, 80% range, and consistency for every stat including P+R, P+A, R+A, steals + blocks, and turnovers. Pick a stat for an odds ladder: steps of 5 for points and point combos (2 for low scorers), 1 for rebounds, assists, threes, steals, blocks.
- **Alt-line finder**, **parlay slip** (kept separate from the NFL slip), and **How the model works** with its track record.

The NBA model projects minutes, then multiplies by each player's per-minute production, adjusted for pace, the opponent, and the betting market's implied team score. Early in the season it leans on the end of last season. Its 80% ranges were tested on past games: about 79% of results landed inside.

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
  `nba.html` + `nba.js` for NBA, `nav.js` for the dark/light toggle.
