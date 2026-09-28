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
  - `sync.js`: **member profiles**. It mirrors saved plays, picks, notes, summary rails and manual Outs to the logged-in Discord member's profile (`/api/state`, Cloudflare D1), so they follow them to any device. (Replaced the owner-only Firebase sync on 2026-09-28.)
  - `teams.js`: team names, colors and logo URLs.
  - `style.css`: dark/light theme tokens and all page styles.

### Hosting (moving to Cloudflare, started 2026-09-28)

- **Today:** `nfl.gmgsports.org` is a CNAME to GitHub Pages (`greenmeansgobetting.github.io`).
  The domain is at **Namecheap**, which also runs email forwarding (MX `eforward*.registrar-servers.com`).
  **Don't move the whole domain's nameservers**; only the `nfl` record changes.
- **deploy.yml** also publishes the same built folder to **Cloudflare Pages** project `gmg-nfl`
  (test address `*.pages.dev`), using the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
  Those steps are `continue-on-error`, so they never block the GitHub Pages deploy.
- `.github/workflows/cloudflare-domain.yml` attached `nfl.gmgsports.org` to the Pages project
  through the API. It can be re-run from the Actions tab and prints the verification status.
  (The Cloudflare connector for Claude can't manage Pages domains; the GitHub secret token can.)
- **Plan, one step at a time:**
  1. Cloudflare copy verified, then switch the `nfl` CNAME at Namecheap to the pages.dev address.
  2. Discord login gate (Pages Functions). A bot checks the member's **current** roles
     server-side on every visit (short session, re-checked every ~15–30 min), so cancelling
     or losing a role cuts access. data.json is gated too.
  3. Free vs Supporter roles.
  4. Sell the role (Discord Server Subscriptions / Patreon / Whop).
  5. Optional Patreon/Whop login for people without Discord.
- The user wants access tied to live roles; someone who paid a week must not keep access after cancelling.
- **Gate code:** `nfl_tool/functions/_middleware.js` (Pages Functions; deploy.yml deploys from `nfl_tool/`
  so the functions get bundled). It holds the config constants: GUILD_ID `1295760852892385290`,
  CLIENT_ID, ALLOWED_ROLE_IDS (`1471877733868109937`, `1471880013824393266`) and INVITE_URL (`https://gmgsports.buildr.bet/`).
  - The secrets `DISCORD_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` live in GitHub secrets and are copied
    into the Pages project by deploy.yml before each Cloudflare deploy.
  - The gate stays **off** (site open) until CLIENT_ID (`1554268816521957447`), roles and both secrets exist.
  - **ENFORCE = true since 2026-09-28: the gate is ON.** `false` is test mode (site open;
    `/auth/login` plus `/auth/check` show whether an account would get in).
  - **The build gets through the gate:** `fetch_previous_odds_snapshot` sends
    `X-GMG-Build: HMAC-SHA256(bot token, "gmg-build-v1")`, and deploy.yml passes `DISCORD_BOT_TOKEN`
    to the build step. Push builds rely on this to reuse SGO odds.
  - Bot invite: `https://discord.com/oauth2/authorize?client_id=1554268816521957447&scope=bot&permissions=0&guild_id=1295760852892385290`.
  - `https://nfl.gmgsports.org/auth/status` shows which pieces are in place, never the values.
  - Roles are re-checked with the bot every 15 min. Sessions last 30 days. If Discord's API is down,
    access is honored for 2 h after the last good check.
  - OAuth scope is `identify` only; redirect URI `<origin>/auth/callback`.
  - The session HMAC key is derived from the bot token, so rotating the token logs everyone out.
  - **Member profiles:**
    - `/api/state` in the middleware (GET all, PUT one key; newest `updated` wins) is backed by the D1
      database `gmg-nfl-users` (table `user_state(uid,k,v,updated)`), bound as `DB`.
    - deploy.yml creates the database and table and writes `nfl_tool/wrangler.toml` in CI, so the
      token needs **D1 Edit** as well as Pages Edit.
    - `site/sync.js` keeps localStorage as the working copy. It pulls on load and on tab focus,
      pushes each save debounced, and on first contact merges pre-profile local data (lists by id,
      objects by key) instead of overwriting it.
    - Synced keys are listed in both `SYNC_KEYS` (middleware) and `KEYS` (sync.js). **Add new
      per-user data to both**, and call `window.NFLSync?.push(key, value)` in its save function.
    - Display prefs (theme, views, selected game) stay per-device.
  - **Owner-only controls:** `OWNER_IDS` (the user's Discord ID `613105360286253076`) makes `/api/state`
    return `user.owner`. sync.js then adds `html.is-owner`, and the **Update Odds** button (which runs
    the GitHub build) is shown only then, plus on localhost.
  - Known bypass until fixed: the GitHub Pages copy still serves the site to anyone who hits
    GitHub's IPs directly, and the repo is public. Turn off GitHub Pages and make the repo
    private once the gate is confirmed.

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
- **Zone Targets** (`zoneTargets` / `renderZoneTargets` in props-summary.js): pass catchers whose targets land where the defense is soft.
  - **Zone softness** is 50% the zone's own completion % and EPA allowed (shrunk with 8 prior attempts) plus how often it's attacked, and 50% the opponent-adjusted depth band from `prop_matchup_model`.
  - **Player opportunity:** lineup-aware targets per game as a percentile at his position (70%) plus recent snap share (30%).
  - **Markets:** Receptions (volume into soft short zones), Long Rec (10+ yd share into soft zones, defense gives up 20+ plays), Rec Yds (overall match plus volume); YAC is a bonus tag.
  - **Where it shows:** a panel under each Pass D Allowed grid; on the Props Summary card, flagged players list first with a ★ in receiving packages.
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
- **Every matchup call reads BOTH sides (the user's rule, 2026-09-28).** Any Tough / Mismatch /
  Target / Fade / ADV logo / tag must use the offense's number AND the defense's ALLOWED number for
  the same thing. How often a defense shows a look (blitz %, box %) only decides whether the look
  matters, never which way it points. Use `matchupCall` / `matchupKind` in common.js:
  - A call needs one side clearly pointing one way and the other side not pointing the other way
    (`MATCHUP_CONTRA`).
  - An average alone is not enough, because it lets a strong side hide a contradicting one. That
    bug had "PHI 3.0 Y/C vs heavy box" read as Tough while CHI allowed 4.9 Y/C in that box.
  - Applied to: Game Summary Key stat edges (Blitz/Box rows show offense vs defense-allowed, with
    the look % in the label), the Scheme ADV column, the TD Data tags (Beats the blitz, Pressure
    trouble, Clean pocket, Light-box runs, Beats stacked box, RZ wall), and Props Summary packages
    (a market is dropped if either side contradicts it).
  - Rows where the sides don't act on each other (penalty yards) aren't matchups; keep them out of
    edges.
- **Distrust small samples.** 2–3 games can be one weird matchup (a backup QB, bad
  weather). Prefer approaches that discount flukes and lean on the market.
- The TD Data page is considered solid; change it only when asked.
- The Game Previews Summary card:
  - Order: injuries strip; Lines + W&L vs the spread side by side; Ratings box; Matchups
    with A–F grades and Mismatch/Tough/Good vs Good/Bad vs Bad tags.
  - Right side: My Picks rail with the Novig ad.
  - "Scheme" is labeled "Blitz & Box" on the card.
- **One look across the whole site (the summary-card look), set 2026-09-28.** It lives in the
  "Facelift v2" block at the end of `style.css`:
  - Every `.data-table` is rounded tiles with 3px gaps, not hairline grid lines.
  - Colored values are shaded boxes (tint plus a matching 1px edge) in the bold display font.
  - Headers are small uppercase muted labels.
  - Team banners are team-color tints with a 4px team-color left edge (`teamBannerHeader`).
  - Rush lanes are big tiles like the pass zones.
  - The Passing tab is one boxed column per team.
  - Pick Tracker buttons match the summary's My Picks rail.
  - Tier cells are **filled** (tint plus a soft edge), never outline-only, in both themes.
  - Group headers inside tables (Production, Turnovers & Pressure, Run Defense, Team Grades...)
    are solid bars with an accent left edge and a small gap above (`group-gap` spacer rows).
  - Game Previews General Stats & Scheme is two boxed matchups ("ATL Offense vs GB Defense"),
    each holding its stat table plus scheme and Team Grades. Grade letters are the same size as
    the numbers, and Heavy/Light Box values stay on one line.
  - Game Previews order: Injuries, Odds, **Recent Games**, General Stats & Scheme, Pick Tracker.
    The Raw Stats / vs Opponents toggle sits in the General Stats header, with a copy on the
    Summary toolbar because the card's matchups use it too.
  - Recent Games runs Week 1 first, with opponent logos, the closing spread and total from the
    schedule, and ATS (Covered/Missed/Push) and O/U results. Clicking a row opens the box score.
  - **League-rank popups are paired** (`openPairedRankModal` / `pairedRankPartner` in common.js):
    - Clicking any number in an OFF/DEF matchup row shows TEAM | offense value | defense value |
      TEAM. Each column is sorted on its own, with equal-width halves.
    - This matchup's offense is highlighted on the left and its defense on the right.
    - The partner is the opposite side's cell in the matching column, learned from a complete row
      of the same table, so a blank "--" never mis-pairs.
    - Cells with `noPair` (e.g. scheme Tendency %) or no real counterpart open the single list.
    - Team Grades use `openPairedGradeModal`; Red Zone's Trips/TDs/FGs/Avg columns appear on both halves.
  - New UI should reuse these patterns rather than add a new look.
- Player Props pass-zone grids (Pass D Allowed / Passing Offense) use the summary-card look: rounded zone tiles, big share numbers, header/row shares as big red→green numbers with fill bars (no small % tags), stat tiles underneath. The offense per-player mini grids sit 3 cards per row with uniform row heights.
- Schedule strip (top of every page): finished games show each team's score under its logo (winner bold), not the date.
- Player Props page extras:
  - The **Pick props** list is grouped Passing / Rushing / Receiving / Other, then by player.
  - Each player has an **Out?** switch for late news the injury report misses.
