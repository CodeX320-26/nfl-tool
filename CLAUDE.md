# GMG's NFL Suite — project guide for Claude

**Keep this file current.** Whenever a feature, data source, workflow, or one of the
user's preferences changes, update the matching section here **in the same commit**.
Any session on any machine (desktop, laptop, claude.ai/code) relies on this file for
context. It is the only copy that travels with the repo.

## What this is

- Live at **https://nfl.gmgsports.org**. Repo: `GreenMeansGoBetting/nfl-tool`.
- Owner: a sports-betting content creator ("GMG" = Green Means Go) with no coding
  background. Explain in plain language and do the technical work yourself.
- The user screenshots sections and the **Summary cards** (fixed 1160×980, sized to their
  video template's left area) and drops them into betting videos. Favor dense,
  screenshot-ready, visually clean layouts.
- NFL is the active project. (A separate CFB tool is paused.)

## Workflow the user expects

1. Make the change and verify it locally (see below).
2. **Commit and push to `main`**. GitHub Actions rebuilds and deploys automatically.
3. Confirm it's live: poll `https://nfl.gmgsports.org/<file>?x=N` until the new code or
   data shows up, usually 60–105 s.
4. Tell the user to hard refresh (Ctrl+Shift+R).
5. Update this CLAUDE.md in the same commit whenever anything below changes.

- Commit messages end with the Co-Authored-By line the environment specifies.
- **Never view, print, or ask the user to paste API keys.** `SGO_API_KEY` and
  `SGO_API_KEY_BACKUP` are GitHub Actions secrets. Any future key (e.g. a Novig trading
  key) goes in GitHub Settings → Secrets, added by the user.

## Architecture

- `nfl_tool/build_stats.py`: the whole data pipeline. It reads nflverse play-by-play,
  rosters, injuries, snap counts, FTN charting and schedules, plus odds from Novig and
  SportsGameOdds and ESPN FPI, and writes `nfl_tool/site/data.json` (untracked; built in CI).
- `.github/workflows/deploy.yml`: runs build_stats and deploys `nfl_tool/site` to GitHub Pages.
  - It runs on a cron every 6 h, on pushes touching `nfl_tool/**`, and on manual dispatch.
  - Pushes set `SKIP_SGO_FETCH=1`, so SGO odds are reused from the live site to save quota.
    Novig and ESPN are free, so they're fetched fresh on every build.
- `nfl_tool/site/`: static HTML/CSS/JS pages.
  - `game-overview.html/.js` + `game-summary.js`: **Game Previews** (Full Preview + Summary card).
  - `index.html` + `app.js`: **TD Data** (Season TDs, First TD, Summary card).
  - `player-props.html/.js` + `props-summary.js`: **Player Props** (Receiving/Rushing/Passing + Summary card).
  - `possible-plays.html/.js`: the Possible Plays list.
  - `picks.js`: the Pick Tracker.
  - `common.js`: shared helpers — tiers, possible plays, modals, the summary-card
    photo/banner/fit/**Save image** helpers, and lineup weights.
  - `firebase-sync.js`: syncs possible plays, notes and picks across devices.
  - `teams.js`: team names, colors and logo URLs.
  - `style.css`: dark/light theme tokens and all page styles.

### Local verification

- Build: `SKIP_SGO_FETCH=1 python nfl_tool/build_stats.py --season 2026 --out nfl_tool/site/data.json`.
  If the build hits a 404, it's a transient nflverse error; re-run.
- Serve `nfl_tool/site` with `python -m http.server <fresh port>` and check in the browser.
  Use a fresh port each time; the preview caches aggressively.
- Summary cards are 1160×980. `fitSummaryCard()` scales the content down if it overflows,
  and a scale near 1 is the goal.
- Save image uses html-to-image with `includeQueryParams: true`. Without it, ESPN logo URLs
  that differ only by query string collapse to one image.

## Data sources and key models

- **Odds: Novig first, SGO fills gaps.**
  - Novig's public game feed is `POST https://api.novig.us/v1/graphql`, operation
    `EventMarkets_Query`. The query text is saved verbatim in
    `nfl_tool/novig_event_markets.graphql`.
    - Novig only accepts its own site's exact query. If `novig_debug.error` shows up in
      data.json, recapture the request body from the browser network tab on any novig.com
      game page and overwrite the file.
    - Games come from `GET https://api.novig.us/v3/public/catalog/events?league=NFL`.
    - `is_consensus` marks the main line; `outcomes[].available` is the price (0–1).
  - Player props, Anytime/First TD, and game spread/total/moneyline (`game.novig`) come
    from Novig. A market is only used from Novig when both sides are priced. Thin books
    are flagged `thin`.
  - The user promotes Novig (code **GMGO**: deposit $10 → $25 in trade credits; QR at
    `site/novig-qr.png`). The user says Novig is fine with outside tools reading its feed.
  - SGO (SportsGameOdds, free tier) leaves many props without a book price. See
    `sgo_props_debug` in data.json.
- **ESPN FPI** (`espn_ratings`): offense/defense/FPI turned into 1–100 league-normed
  ratings, plus SOS rank. FPI is predictive; it includes preseason priors and QB changes.
- **Opponent adjustment:**
  - `prop_matchup_model` gives what each defense allows and each offense produces by
    position, throw depth and play type, with ranks.
  - `team_stats_adj` powers the Game Previews **Raw / vs Opponents** toggle.
  - Early samples are shrunk toward league average.
- **Context weights (passing numbers):** games in rain, snow or 15+ mph wind count 30%;
  games against a backup QB count 30% toward the defense's numbers.
- **Lineup-aware player usage (important):**
  - Uses `player_snaps` plus injuries.
  - A game a regular left early doesn't count.
  - A fill-in game while a regular (healthy now) was out counts 15%.
  - TD Data uses `lineupWeights` / `lineupAdjustedXtd` in common.js; Props uses
    `propBaselineGames`.
  - **Never surface a backup off one fill-in game.**
- **Pick Tracker** grades each pick on the price saved at pick time, which is Novig's when
  available.

## The user's preferences (hard-won — follow them)

- **Summary cards:** direct attention and don't explain.
  - No wordy blurbs. Use color and shaded boxes, not plain colored text.
  - No "#5" rank badges on the card; put ranks in hovers or small tags.
  - The card must never contradict itself (e.g. an RB over under a note that the run D is strong).
  - Give the rows and boxes room: use the full card height and don't cram.
- **Props Summary is directional, not a pick sheet** (the user's call on 2026-09-28):
  - It's a Target / Fade list of *packages*: a team position group plus betting markets
    plus its players' lines (e.g. "PHI WRs · Rec Yds · Long Rec → Smith, Wicks, Lemon").
  - Only real betting markets: no YPA, INTs or sacks.
  - Each package must agree with the betting market (spread for RB rushing, implied team
    total otherwise).
  - Rank tags list offense first, shaded red → yellow → green by how good the rank is for
    that unit.
  - No projections, "model edge" numbers or model-picked players anywhere. The user
    draws the conclusions and adds players to the Prop Picks rail themselves.
- **Distrust small samples.** 2–3 games can be one weird matchup (a backup QB, bad
  weather). Prefer approaches that discount flukes and lean on the market.
- The TD Data page is considered solid; change it only when asked.
- The Game Previews Summary card:
  - Order: injuries strip; Lines + W&L vs the spread side by side; Ratings box; Matchups
    with A–F grades and Mismatch/Tough/Good vs Good/Bad vs Bad tags.
  - Right side: My Picks rail with the Novig ad.
  - "Scheme" is labeled "Blitz & Box" on the card.
- Player Props page extras:
  - The **Pick props** list is grouped Passing / Rushing / Receiving / Other, then by player.
  - Each player has an **Out?** switch for late news the injury report misses.
