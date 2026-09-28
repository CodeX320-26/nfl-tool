// ---- Game Previews Summary: one screenshot-ready card per game ----
// Same 1160x980 card as the TD / Props summaries. Lines, each team's
// wins & losses vs the spread, graded matchups (with the biggest General
// Stats / Scheme edges under them), starters on the injury report, and a
// live Pick Tracker on the right that saves to the same picks as the full
// page and shows up in the saved image. Boxes and chips, no sentences.

const GS_VIEW_KEY = "nfl-tool.preview-view.v1";
let gsView = "full";
try {
  gsView = localStorage.getItem(GS_VIEW_KEY) || "full";
} catch (e) {
  // localStorage unavailable -- opens on the full preview.
}
const GS_EDGE_Z = TIER_Z_THRESHOLD; // same line as the page's green/red tiers
const GS_EDGES_SHOWN = 6;
const GS_INJURIES_SHOWN = 5;

// ---- matchup tags ----
// good/bad from each side's own point of view (offense: produces a lot;
// defense: allows little).
const GS_TAGS = {
  mismatch: { label: "Mismatch", cls: "gs-tag-mismatch" },
  tough: { label: "Tough", cls: "gs-tag-tough" },
  strong: { label: "Good vs Good", cls: "gs-tag-strong" },
  weak: { label: "Bad vs Bad", cls: "gs-tag-weak" },
};
function gsTag(offGood, offBad, defGood, defBad) {
  if (offGood && defBad) return "mismatch";
  if (offBad && defGood) return "tough";
  if (offGood && defGood) return "strong";
  if (offBad && defBad) return "weak";
  return null;
}
function gsTagHtml(key) {
  return key ? `<span class="gs-tag ${GS_TAGS[key].cls}">${GS_TAGS[key].label}</span>` : `<span class="gs-tag gs-tag-even">Even</span>`;
}
function gsGradeBox(grade) {
  return `<span class="gs-grade ${gradeClass(grade)}"${gradeAlphaAttr(grade)}>${grade || "--"}</span>`;
}
function gsStatZ(key, team, invert) {
  const pool = teamsWithGames();
  return zScore(tierValue(team, key), pool.map((t) => tierValue(t, key)), invert);
}
function gsZClass(z) {
  if (z === null || z === undefined) return "";
  return z >= GS_EDGE_Z ? "gs-good" : z <= -GS_EDGE_Z ? "gs-bad" : "";
}

// "Scheme" on the full page = how an offense does against the looks a
// defense throws at it (blitzes, pressure, 7+ or 6- man boxes), and how a
// defense does when it shows them. Named for what it is on the card.
const GS_CATEGORY_LABELS = { Scheme: "Blitz & Box" };

// Team grades, offense vs the other defense.
function gsGradeRows(offTeam, defTeam) {
  return SUMMARY_CATEGORIES.map((cat) => {
    const offZ = cat.scheme ? schemeCompositeZ(offTeam, "off") : compositeZ(cat.off, offTeam);
    const defZ = cat.scheme ? schemeCompositeZ(defTeam, "def") : compositeZ(cat.def, defTeam);
    const og = gradeForZ(offZ);
    const dg = gradeForZ(defZ);
    const good = (g) => g === "A" || g === "B";
    const bad = (g) => g === "D" || g === "F";
    const tag = gsTag(good(og), bad(og), good(dg), bad(dg));
    return `<div class="gs-row"><span class="gs-row-label">${GS_CATEGORY_LABELS[cat.label] || cat.label}</span>${gsGradeBox(og)}<span class="gs-vs">vs</span>${gsGradeBox(dg)}${gsTagHtml(tag)}</div>`;
  }).join("");
}

const GS_SCHEME_SHORT = {
  "Heavy Box (7+)": "Heavy box",
  "Light Box (≤6)": "Light box",
  "Blitz (5+ rushers)": "Blitz",
  "Standard Rush": "4-man rush",
  Pressured: "Pressure",
  "Clean Pocket": "Clean pocket",
};

// Biggest General Stats + Scheme edges for this offense vs that defense.
// Pace (plays/game), quarter splits and the red zone composite are left
// out -- pace isn't good or bad, quarters are noise at this size, and red
// zone already has its own grade above.
const GS_SKIP_ROWS = new Set(["Plays / Game", "Red Zone"]);
function gsStatEdges(offTeam, defTeam) {
  const edges = [];
  const fmtV = (v, r) => (v === null || v === undefined ? "--" : r.pct ? `${Math.round(v * 100)}%` : fmt(v, r.digits ?? 0));
  GENERAL_STAT_GROUPS.filter((g) => g.label !== "Scoring by Quarter").forEach((g) =>
    g.rows.forEach((r) => {
      if (r.composite || GS_SKIP_ROWS.has(r.label)) return;
      const offZ = gsStatZ(r.offKey, offTeam, r.offInvert);
      const defZ = gsStatZ(r.defKey, defTeam, r.defInvert);
      if (offZ === null || defZ === null) return;
      const tag = gsTag(offZ >= GS_EDGE_Z, offZ <= -GS_EDGE_Z, defZ >= GS_EDGE_Z, defZ <= -GS_EDGE_Z);
      if (!tag) return;
      edges.push({
        label: r.label,
        off: `<span class="gs-val ${gsZClass(offZ)}">${fmtV(tierValue(offTeam, r.offKey), r)}</span>`,
        def: `<span class="gs-val ${gsZClass(defZ)}">${fmtV(tierValue(defTeam, r.defKey), r)}</span>`,
        tag,
        weight: Math.abs(offZ) + Math.abs(defZ),
      });
    })
  );
  // Scheme: only looks this defense actually uses a lot (same rule as the
  // Scheme table's ADV column), offense good or bad against it.
  SCHEME_GROUPS.forEach((group) =>
    group.rows.forEach((r) => {
      const tend = DATA.team_stats[defTeam][r.tendKey];
      if (tend === null || tend === undefined || tend < SCHEME_ADV_MIN_TENDENCY) return;
      const freqZ = gsStatZ(r.tendKey, defTeam, false);
      const perfZ = gsStatZ(r.perfKey, offTeam, false);
      if (freqZ === null || perfZ === null || freqZ < GS_EDGE_Z || Math.abs(perfZ) < GS_EDGE_Z) return;
      const perf = DATA.team_stats[offTeam][r.perfKey];
      const perfText = group.pct ? `${Math.round(perf * 100)}%` : `${fmt(perf, 1)} Y/C`;
      edges.push({
        label: `vs ${GS_SCHEME_SHORT[r.label] || r.label}`,
        off: `<span class="gs-val ${gsZClass(perfZ)}">${perfText}</span>`,
        def: `<span class="gs-val gs-freq" title="How often ${defTeam} shows this look">${Math.round(tend * 100)}%</span>`,
        tag: perfZ > 0 ? "mismatch" : "tough",
        weight: Math.abs(perfZ) + freqZ,
        scheme: true,
      });
    })
  );
  return edges.sort((a, b) => b.weight - a.weight).slice(0, GS_EDGES_SHOWN);
}

function gsMatchupColumn(offTeam, defTeam) {
  const edges = gsStatEdges(offTeam, defTeam);
  const edgeRows = edges.length
    ? edges.map((e) => `<div class="gs-row gs-edge"><span class="gs-row-label">${e.label}</span>${e.off}<span class="gs-vs">vs</span>${e.def}${gsTagHtml(e.tag)}</div>`).join("")
    : `<div class="gs-none">No big stat edges</div>`;
  const head = (team, side) => {
    const rgb = teamAccentRgb(team);
    return `<span class="gs-head" style="background:rgba(${rgb.join(",")},0.35);border-bottom:3px solid rgb(${rgb.join(",")})">${teamLogoMini(team, 22)}<span>${side}</span></span>`;
  };
  return `<div class="sc-col gs-col">
    <div class="gs-row gs-head-row"><span></span>${head(offTeam, "OFF")}<span></span>${head(defTeam, "DEF")}<span></span></div>
    <div class="gs-rows">${gsGradeRows(offTeam, defTeam)}</div>
    <div class="gs-sub">Key stat edges</div>
    <div class="gs-rows">${edgeRows}</div>
  </div>`;
}

// ---- lines ----
function gsSigned(n) {
  if (n === null || n === undefined) return "--";
  if (n === 0) return "PK";
  return n > 0 ? `+${fmt(n, 1).replace(/\.0$/, "")}` : fmt(n, 1).replace(/\.0$/, "");
}
// Novig's main line and price first (pv), best-of-books when Novig has none.
function gsLines(game) {
  const { away, home } = game;
  const homeSpread = pv(game, "home_team_spread");
  const hasSpread = homeSpread !== null && homeSpread !== undefined;
  const fav = hasSpread ? (homeSpread <= 0 ? home : away) : null;
  const favLine = fav === home ? homeSpread : pv(game, "away_team_spread");
  const total = pv(game, "total_line");
  const ml = (team, odds, prob) => `<div class="gs-ml">${teamLogoMini(team, 16)}<b>${fmtOddsSigned(odds)}</b><span>${prob ? `${Math.round(prob * 100)}%` : ""}</span></div>`;
  return `<div class="gs-lines">
    <div class="gs-tile"><div class="gs-tile-label">Spread</div><div class="gs-tile-big">${fav ? `${teamLogoMini(fav, 20)} ${gsSigned(favLine)}` : "--"}</div></div>
    <div class="gs-tile"><div class="gs-tile-label">Total</div><div class="gs-tile-big">${total ? fmt(total, 1).replace(/\.0$/, "") : "--"}</div></div>
    <div class="gs-tile"><div class="gs-tile-label">Moneyline</div>${pv(game, "away_moneyline") !== null && pv(game, "away_moneyline") !== undefined ? ml(away, pv(game, "away_moneyline"), pv(game, "away_ml_implied_prob")) + ml(home, pv(game, "home_moneyline"), pv(game, "home_ml_implied_prob")) : `<div class="gs-tile-big">--</div>`}</div>
  </div>`;
}

// ---- Ratings: ESPN FPI (offense, defense, overall) as 1-100 league-normed
// ratings (build_stats.py compute_espn_ratings), plus schedule strength.
// Red (1) -> yellow (50) -> green (99); SOS rank 1 = toughest schedule so
// far, colored red, 32 = easiest, green. ----
function gsRatingStyle(hue) {
  return `background:hsla(${hue},70%,45%,0.28);border-color:hsl(${hue},70%,45%)`;
}
function gsRatingTile(rating, raw) {
  if (rating === null || rating === undefined) return `<span class="gs-rt">--</span>`;
  const sign = raw > 0 ? "+" : "";
  return `<span class="gs-rt" style="${gsRatingStyle(Math.round(rating * 1.2))}"><b>${rating}</b><small>${sign}${fmt(raw, 1)}</small></span>`;
}
function gsSosTile(rank) {
  if (!rank) return `<span class="gs-rt">--</span>`;
  return `<span class="gs-rt" style="${gsRatingStyle(Math.round(((rank - 1) / 31) * 120))}"><b>${propOrdinalSafe(rank)}</b><small>${rank <= 8 ? "tough" : rank >= 25 ? "easy" : "avg"}</small></span>`;
}
function propOrdinalSafe(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
}
function gsRatings(away, home) {
  const r = DATA.espn_ratings;
  if (!r || !r[away] || !r[home]) return "";
  const row = (team) => {
    const t = r[team];
    return `<div class="gs-rt-row"><span class="gs-res-team">${teamLogoMini(team, 18)} ${team}</span>${gsRatingTile(t.off_rating, t.off)}${gsRatingTile(t.def_rating, t.def)}${gsRatingTile(t.fpi_rating, t.fpi)}${gsSosTile(t.sos_rank)}</div>`;
  };
  return `<section class="sc-section gs-compact"><div class="sc-section-title">Ratings</div>
    <div class="gs-rt-row gs-rt-head"><span></span><span>Offensive Rating</span><span>Defensive Rating</span><span>FPI Rating</span><span>SOS</span></div>
    ${row(away)}${row(home)}
  </section>`;
}

// ---- wins & losses vs the spread ----
function gsResumeRow(team, week) {
  const games = resumeGamesFor(team, week).sort((a, b) => a.week - b.week);
  const s = resumeSummary(games);
  const chips = games.length
    ? games
        .map((g) => {
          const q = g.label[0] === "Q" ? "q" : g.label[0] === "B" ? "b" : g.label === "T" ? "n" : "n";
          const wl = g.margin > 0 ? "W" : g.margin < 0 ? "L" : "T";
          return `<span class="gs-res gs-res-${q} gs-res-${wl.toLowerCase()}" title="Wk ${g.week} ${g.isHome ? "vs" : "@"} ${g.opp} ${g.pf}-${g.pa} (${RESUME_LABELS[g.label]})">${teamLogoMini(g.opp, 16)}<b>${wl}</b></span>`;
        })
        .join("")
    : `<span class="gs-none">No games yet</span>`;
  return `<div class="gs-res-row">
    <span class="gs-res-team">${teamLogoMini(team, 20)} ${team}</span>
    <span class="gs-res-chips">${chips}</span>
    <span class="gs-res-recs"><span><span class="gs-res-lbl">SU</span> ${s.su}</span><span><span class="gs-res-lbl">ATS</span> ${s.ats}</span></span>
  </div>`;
}

// ---- key injuries: starters only ----
const GS_STATUS_RANK = { Out: 0, Doubtful: 1, DNP: 2, Questionable: 3, Limited: 4 };
function gsInjuries(team, week) {
  const list = ((DATA.injuries || {})[team] || {})[String(week)] || [];
  const starters = list
    .map((p) => ({ ...p, abbr: statusAbbr(p.status) }))
    .filter((p) => (p.snap_share || 0) >= INJURY_STARTER_SNAP_SHARE && p.abbr in GS_STATUS_RANK)
    .sort((a, b) => GS_STATUS_RANK[a.abbr] - GS_STATUS_RANK[b.abbr] || (b.snap_share || 0) - (a.snap_share || 0));
  const shown = starters.slice(0, GS_INJURIES_SHOWN);
  const chips = shown
    .map((p) => `<span class="gs-inj">${summaryHeadshot(team, p.full_name, 22)}<span class="gs-inj-name">${shortName(p.full_name)} <span class="muted">${p.position}</span></span><span class="gs-inj-status ${statusClass(p.status)}">${p.abbr === "Questionable" ? "Q" : p.abbr}</span></span>`)
    .join("");
  const more = starters.length > shown.length ? `<span class="gs-inj-more">+${starters.length - shown.length}</span>` : "";
  return `<div class="gs-inj-row"><span class="gs-res-team">${teamLogoMini(team, 18)} ${team}</span><span class="gs-inj-list">${chips || `<span class="gs-none">No starters listed</span>`}${more}</span></div>`;
}

// ---- Pick Tracker rail (same saved picks as the full page) ----
let gsDraft = {};
function gsPickMarket(game, m) {
  const pick = getPick(game.game_id, m.key);
  const sides = marketSides(game, m.key);
  if (!sides.every((s) => s.available)) {
    return `<div class="gs-pick"><div class="gs-pick-label">${m.label}</div><div class="gs-none">Not posted</div></div>`;
  }
  const chosen = pick ? pick.side : gsDraft[m.key];
  const color = pick ? pick.color : null;
  const sideBtns = sides
    .map((s) => {
      const on = chosen === s.side;
      const odds = m.key === "moneyline" ? "" : ` <span class="gs-price">${fmtOddsSigned(s.odds)}</span>`;
      return `<button type="button" class="gs-pick-side${on ? ` gs-on${color ? ` pick-color-${color}` : " gs-pending"}` : ""}" data-market="${m.key}" data-side="${s.side}">${s.label}${odds}</button>`;
    })
    .join("");
  const colorBtns = COLORS.map((c) => `<button type="button" class="gs-pick-color pick-color-${c.key}${color === c.key ? " gs-on" : ""}" data-market="${m.key}" data-color="${c.key}">${c.label}</button>`).join("");
  const result = pick && pick.graded ? `<span class="pick-result pick-result-${pick.graded}">${pick.graded.toUpperCase()}</span>` : "";
  return `<div class="gs-pick${pick ? " gs-pick-set" : ""}">
    <div class="gs-pick-label">${m.label} ${result}</div>
    <div class="gs-pick-sides">${sideBtns}</div>
    <div class="gs-pick-colors">${colorBtns}</div>
  </div>`;
}
function gsPickRail(game) {
  regradeAllPicks(DATA.schedule);
  return `<section class="sc-section sc-section-odds gs-picks">
    <div class="sc-section-title">My Picks</div>
    ${MARKETS.map((m) => gsPickMarket(game, m)).join("")}
  </section>`;
}

function renderGameSummaryCard(game) {
  const card = document.getElementById("summary-card");
  if (!card || !game) return;
  const { away, home } = game;
  const when = game.date ? new Date(game.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
  card.dataset.kind = "game";
  card.dataset.away = away;
  card.dataset.home = home;
  card.innerHTML = `<div class="sc-inner gs-card">
    <div class="sc-header">
      <div class="sc-title-row">
        <img src="${teamLogoUrl(away)}" crossorigin="anonymous" class="sc-logo" alt="">
        <div class="sc-matchup">${TEAM_NAMES[away] || away} <span class="sc-at">@</span> ${TEAM_NAMES[home] || home}</div>
        <img src="${teamLogoUrl(home)}" crossorigin="anonymous" class="sc-logo" alt="">
      </div>
      <div class="sc-meta">Week ${game.week}${when ? ` &middot; ${when}` : ""}${game.time ? ` &middot; ${fmtGameTime(game.time)}` : ""} &middot; ${away} ${teamCurrentRecord(away)} &middot; ${home} ${teamCurrentRecord(home)}${statsMode === "adj" ? ` &middot; <span class="gs-adj-badge">Stats vs opponents</span>` : ""}</div>
      <div class="sc-brand"><span class="brand-mark">GMG</span><span class="sc-brand-name">Game Summary</span></div>
    </div>
    <div class="sc-body">
      <div class="sc-main">
        <section class="sc-section gs-compact"><div class="sc-section-title">Key Injuries</div><div class="gs-two">${gsInjuries(away, game.week)}${gsInjuries(home, game.week)}</div></section>
        <div class="gs-top">
          <section class="sc-section gs-compact"><div class="sc-section-title">Lines</div>${gsLines(game)}</section>
          <section class="sc-section gs-compact"><div class="sc-section-title">Wins &amp; Losses vs the Spread</div>${gsResumeRow(away, game.week)}${gsResumeRow(home, game.week)}</section>
        </div>
        ${gsRatings(away, home)}
        <section class="sc-section gs-matchups"><div class="sc-section-title">Matchups</div>
          <div class="sc-cols">${gsMatchupColumn(away, home)}${gsMatchupColumn(home, away)}</div>
        </section>
      </div>
      ${gsPickRail(game)}
    </div>
    <div class="sc-footer">
      <span><span class="gs-res gs-res-q gs-res-w"><b>W</b></span> quality <span class="gs-res gs-res-n gs-res-w"><b>W</b></span> neutral <span class="gs-res gs-res-b gs-res-w"><b>W</b></span> bad (vs the spread) &middot; grades A-F vs the league</span>
      <span>Ratings 1-100 vs the league (ESPN FPI) &middot; SOS 1st = toughest schedule so far &middot; <span class="gs-val gs-good">green</span> good for that side &middot; <span class="gs-val gs-bad">red</span> bad &middot; vs Blitz / Box % = how often the defense shows it</span>
    </div>
  </div>`;
  fitSummaryCard();
  card.querySelectorAll("img").forEach((img) => img.addEventListener("load", fitSummaryCard, { once: true }));
}

// Pick clicks: a side, then a confidence saves it; clicking the chosen side
// again clears it; changing either on a saved pick updates it in place.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#summary-card .gs-pick-side, #summary-card .gs-pick-color");
  if (!btn) return;
  const game = currentGame();
  if (!game) return;
  const market = btn.dataset.market;
  const existing = getPick(game.game_id, market);
  const save = (side, color) => {
    const sideInfo = marketSides(game, market).find((s) => s.side === side);
    upsertPick({
      game_id: game.game_id,
      season: DATA.requested_season,
      week: game.week,
      away: game.away,
      home: game.home,
      market,
      side,
      line_at_pick: sideInfo.line,
      odds_at_pick: sideInfo.odds,
      color,
      created_at: existing ? existing.created_at : new Date().toISOString(),
    });
  };
  if (btn.dataset.side) {
    const side = btn.dataset.side;
    if (existing && existing.side === side) deletePick(game.game_id, market);
    else if (existing) save(side, existing.color);
    else gsDraft[market] = gsDraft[market] === side ? undefined : side;
  } else {
    const side = existing ? existing.side : gsDraft[market];
    if (!side) return;
    save(side, btn.dataset.color);
    delete gsDraft[market];
  }
  renderGameSummaryCard(game);
});

// ---- Raw / vs Opponents stats toggle ----
// Swaps DATA.team_stats for a copy with the opponent-adjusted numbers
// (build_stats.py compute_opponent_adjusted_stats) laid over the raw ones,
// so every table, color, grade, tag and the Summary card follow along.
const STATS_MODE_KEY = "nfl-tool.stats-mode.v1";
let statsMode = "raw";
function initStatsMode() {
  DATA.team_stats_raw = DATA.team_stats;
  const adj = DATA.team_stats_adj || {};
  DATA.team_stats_opp = {};
  Object.entries(DATA.team_stats_raw).forEach(([t, s]) => (DATA.team_stats_opp[t] = { ...s, ...(adj[t] || {}) }));
  try {
    statsMode = localStorage.getItem(STATS_MODE_KEY) || "raw";
  } catch (e) {
    // localStorage unavailable -- raw stats.
  }
  if (!DATA.team_stats_adj) statsMode = "raw";
  applyStatsMode();
}
function applyStatsMode() {
  DATA.team_stats = statsMode === "adj" ? DATA.team_stats_opp : DATA.team_stats_raw;
  document.querySelectorAll(".stats-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === statsMode);
    b.disabled = !DATA.team_stats_adj;
  });
}
document.querySelectorAll(".stats-mode-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    statsMode = btn.dataset.mode;
    try {
      localStorage.setItem(STATS_MODE_KEY, statsMode);
    } catch (e) {
      // localStorage unavailable -- toggle just won't stick.
    }
    applyStatsMode();
    render();
  })
);

// ---- view toggle: Full Preview / Summary ----
function applyPreviewView(game) {
  const summary = gsView === "summary";
  document.querySelectorAll(".preview-view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === gsView));
  const wrap = document.getElementById("section-game-summary");
  if (!game) {
    wrap.hidden = true;
    return;
  }
  SECTIONS.forEach((s) => {
    const el = document.getElementById(`section-${s}`);
    if (el && summary) el.hidden = true;
  });
  document.querySelectorAll("#game-flipper-bottom").forEach((el) => (el.hidden = summary));
  wrap.hidden = !summary;
  if (summary) {
    gsDraft = {};
    renderGameSummaryCard(game);
  }
}
document.querySelectorAll(".preview-view-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    gsView = btn.dataset.view;
    try {
      localStorage.setItem(GS_VIEW_KEY, gsView);
    } catch (e) {
      // localStorage unavailable -- toggle just won't stick.
    }
    render();
  })
);
