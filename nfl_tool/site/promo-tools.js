// ---- Promo Tools: King of the Endzone ----
// DraftKings' weekly promo pays on whoever scores the game's LONGEST TD
// (D/ST included). This page ranks every player on the checked teams by
// long-play upside -- TD lengths so far, 20+/40+ yard plays, how deep he's
// used -- next to how many big plays this week's defense gives up, plus a
// D/ST table (return TDs, takeaways, the opponent's giveaways). Data:
// build_stats.py compute_koe -> DATA.koe.

const KOE_TEAMS_KEY = "nfl-tool.koe.teams"; // per-device view preference
const KOE_POS = ["All", "RB", "WR", "TE", "QB"];
const KOE_MIN_TOUCHES_PG = 1.5; // shown if this involved, or any TD / 20+ play
// Upside = weighted z-scores vs every qualifying player in the league,
// shown as a league percentile. Rates are shrunk toward the league average
// by KOE_PRIOR_GAMES games so one long play in one game can't top the list.
const KOE_PRIOR_GAMES = 2;
const KOE_UPSIDE_PARTS = [
  { key: "big_pg", w: 0.35, label: "20+ yd plays / game" },
  { key: "huge_pg", w: 0.15, label: "40+ yd plays / game" },
  { key: "role", w: 0.15, label: "Deep role (deep targets or 10+ yd runs / game)" },
  { key: "td_len", w: 0.1, label: "TD length (20+ yd TDs, avg TD yds)" },
  { key: "opp", w: 0.25, label: "Opponent big plays allowed / game" },
];

let koePos = "All";
let koeSort = { key: "upside", dir: -1 };
let koeTeams = new Set();

function koeWeekGames() {
  const games = (DATA.schedule || []).filter((g) => g.week === DATA.current_week);
  const open = games.filter((g) => g.status !== "final");
  if (open.length) return open;
  const next = (DATA.schedule || []).filter((g) => g.week === DATA.current_week + 1);
  return next.length ? next : games;
}
function koeOpponent(team) {
  const g = koeWeekGames().find((x) => x.away === team || x.home === team);
  return g ? (g.away === team ? g.home : g.away) : null;
}
function loadKoeTeams() {
  try {
    const saved = JSON.parse(localStorage.getItem(KOE_TEAMS_KEY));
    if (Array.isArray(saved)) return new Set(saved);
  } catch (e) {
    // localStorage unavailable -- default below.
  }
  const first = koeWeekGames()[0];
  return new Set(first ? [first.away, first.home] : []);
}
function saveKoeTeams() {
  try {
    localStorage.setItem(KOE_TEAMS_KEY, JSON.stringify([...koeTeams]));
  } catch (e) {
    // localStorage unavailable -- selection just won't stick.
  }
}

// ---- per-player numbers ----
function koeRow(team, p) {
  const k = DATA.koe;
  const g = p.games || 1;
  const opp = koeOpponent(team);
  const ot = (k.teams || {})[opp] || null;
  const og = ot ? ot.games || 1 : 1;
  const big = p.runs20 + p.catches20;
  const huge = p.runs40 + p.catches40;
  const tds = p.tds || [];
  const longTds = tds.filter((y) => y >= k.big).length;
  // The defense's big plays allowed that fit this player: runs for RBs/QBs,
  // catches for WRs/TEs, both halves for anyone used both ways.
  const runShare = p.carries + p.targets ? p.carries / (p.carries + p.targets) : 0;
  const oppBig = ot ? (runShare * ot.runs20_allowed + (1 - runShare) * ot.catches20_allowed) / og : null;
  const oppLongTds = ot ? ot.tds_allowed.filter((y) => y >= k.big).length : null;
  return {
    team,
    opp,
    name: p.name,
    pos: p.position,
    games: g,
    touches_pg: (p.carries + p.targets) / g,
    tds: tds.length,
    avg_td: tds.length ? tds.reduce((a, b) => a + b, 0) / tds.length : null,
    long_td: tds.length ? tds[0] : null,
    b10: tds.filter((y) => y <= 10).length,
    b20: tds.filter((y) => y > 10 && y <= 20).length,
    b40: tds.filter((y) => y > 20 && y <= 40).length,
    b41: tds.filter((y) => y > 40).length,
    big_pg: big / g,
    big,
    huge,
    huge_pg: huge / g,
    long_play: Math.max(p.long_rush || 0, p.long_rec || 0),
    runs20: p.runs20,
    catches20: p.catches20,
    adot: p.position === "WR" || p.position === "TE" ? p.adot : null,
    deep_pg: p.deep_targets / g,
    role: p.position === "RB" || p.position === "QB" ? p.runs10 / g : p.deep_targets / g,
    long_tds: longTds,
    td_len: longTds + (tds.length ? (tds.reduce((a, b) => a + b, 0) / tds.length) / 40 : 0),
    opp_big_pg: oppBig,
    opp_long_tds: oppLongTds,
    opp_avg_td: ot && ot.tds_allowed.length ? ot.tds_allowed.reduce((a, b) => a + b, 0) / ot.tds_allowed.length : null,
    opp_g: og,
  };
}
function koeQualifies(r, p) {
  return r.touches_pg >= KOE_MIN_TOUCHES_PG || (p.tds || []).length > 0 || r.big > 0;
}

// League pool (every team) so colors and Upside don't depend on which
// teams are checked.
function koeLeague() {
  if (koeLeague.cache) return koeLeague.cache;
  const rows = [];
  Object.entries(DATA.koe.players || {}).forEach(([team, list]) =>
    list.forEach((p) => {
      const r = koeRow(team, p);
      if (koeQualifies(r, p)) rows.push(r);
    })
  );
  // Shrink per-game rates toward the league average (KOE_PRIOR_GAMES).
  const avg = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0) / (rows.length || 1);
  const shrink = { big_pg: avg("big_pg"), huge_pg: avg("huge_pg"), role: avg("role") };
  rows.forEach((r) => {
    Object.entries(shrink).forEach(([key, m]) => (r[`${key}_s`] = (r[key] * r.games + m * KOE_PRIOR_GAMES) / (r.games + KOE_PRIOR_GAMES)));
    r.opp_s = r.opp_big_pg === null ? null : r.opp_big_pg + (r.opp_long_tds || 0) / (r.opp_g || 1);
  });
  const vals = (key) => rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  const pools = { big_pg: vals("big_pg_s"), huge_pg: vals("huge_pg_s"), role: vals("role_s"), td_len: vals("td_len"), opp: vals("opp_s") };
  const src = { big_pg: "big_pg_s", huge_pg: "huge_pg_s", role: "role_s", td_len: "td_len", opp: "opp_s" };
  rows.forEach((r) => {
    r.parts = KOE_UPSIDE_PARTS.map((part) => ({ ...part, z: r[src[part.key]] === null ? 0 : zScore(r[src[part.key]], pools[part.key], false) || 0 }));
    r.score = r.parts.reduce((s, part) => s + part.w * part.z, 0);
  });
  const scores = rows.map((r) => r.score).sort((a, b) => a - b);
  rows.forEach((r) => (r.upside = Math.round((100 * scores.filter((s) => s <= r.score).length) / scores.length)));
  koeLeague.cache = rows;
  return rows;
}

// ---- rendering ----
const KOE_COLS = [
  { key: "tds", label: "TDs", group: "Touchdowns", fmt: (v) => v || "", title: "Rushing + receiving TDs" },
  { key: "avg_td", label: "Avg", group: "Touchdowns", fmt: (v) => (v === null ? "" : fmt(v, 0)), title: "Average TD length (yds)" },
  { key: "long_td", label: "Long", group: "Touchdowns", fmt: (v) => (v === null ? "" : v), title: "Longest TD (yds)" },
  { key: "b10", label: "1-10", group: "TDs by distance", fmt: (v) => v || "", title: "TDs of 10 yds or less" },
  { key: "b20", label: "11-20", group: "TDs by distance", fmt: (v) => v || "", title: "TDs of 11-20 yds" },
  { key: "b40", label: "21-40", group: "TDs by distance", fmt: (v) => v || "", title: "TDs of 21-40 yds" },
  { key: "b41", label: "41+", group: "TDs by distance", fmt: (v) => v || "", title: "TDs of 41+ yds" },
  { key: "big_pg", label: "20+/g", group: "Big plays", fmt: (v) => (v ? fmt(v, 1) : ""), title: "Runs + catches of 20+ yds per game" },
  { key: "huge", label: "40+", group: "Big plays", fmt: (v) => v || "", title: "Runs + catches of 40+ yds (season)" },
  { key: "long_play", label: "Long", group: "Big plays", fmt: (v) => v || "", title: "Longest run or catch (yds)" },
  { key: "touches_pg", label: "Tch/g", group: "Role", fmt: (v) => fmt(v, 1), title: "Carries + targets per game" },
  { key: "runs20", label: "Run 20+", group: "Role", fmt: (v) => v || "", title: "Runs of 20+ yds (season)" },
  { key: "catches20", label: "Rec 20+", group: "Role", fmt: (v) => v || "", title: "Catches of 20+ yds (season)" },
  { key: "adot", label: "ADOT", group: "Role", fmt: (v) => (v === null ? "" : fmt(v, 1)), title: "Average depth of target (air yds)" },
  { key: "deep_pg", label: "Deep/g", group: "Role", fmt: (v) => (v ? fmt(v, 1) : ""), title: "Targets 20+ yds downfield per game" },
  { key: "opp_big_pg", label: "20+ alw/g", group: "vs this week's D", zero: true, fmt: (v) => (v === null ? "" : fmt(v, 1)), title: "20+ yd plays this defense allows per game -- runs for runners, catches for receivers" },
  { key: "opp_long_tds", label: "20+ TDs", group: "vs this week's D", zero: true, fmt: (v) => (v === null ? "" : v), title: "TDs of 20+ yds this defense has allowed" },
  { key: "opp_avg_td", label: "Avg TD", group: "vs this week's D", fmt: (v) => (v === null ? "" : fmt(v, 0)), title: "Average length of TDs this defense has allowed" },
];

const KOE_GROUP_CLASS = { Touchdowns: "td", "TDs by distance": "dist", "Big plays": "big", Role: "role", "vs this week's D": "def" };

function koeCell(col, r, league) {
  const v = r[col.key];
  if (v === null || v === undefined) return `<td class="num"></td>`;
  if (v === 0) return `<td class="num">${col.zero ? 0 : ""}</td>`;
  const pool = league.map((x) => x[col.key]).filter((x) => x !== null && x !== undefined);
  return `<td class="num ${percentileTier(v, pool, false)}"${tierAlphaAttr(v, pool, false)}>${col.fmt(v)}</td>`;
}
function koeUpsideCell(r) {
  const hue = Math.round((r.upside / 100) * 120);
  const why = r.parts.map((p) => `${p.label}: ${p.z >= 0 ? "+" : ""}${p.z.toFixed(1)}`).join("\n");
  return `<td class="num"><span class="koe-upside" style="background:hsla(${hue},70%,45%,0.22);border-color:hsla(${hue},70%,45%,0.6)" title="League percentile. Parts (z vs league):\n${why}">${r.upside}</span></td>`;
}

function renderKoePlayers() {
  const el = document.getElementById("koe-players");
  if (!koeTeams.size) {
    el.innerHTML = `<p class="no-data-note">Check one or more teams above.</p>`;
    document.getElementById("koe-count").textContent = "";
    return;
  }
  const league = koeLeague();
  const week = koeWeekGames()[0]?.week || DATA.current_week;
  let out = 0;
  const rows = league.filter((r) => {
    if (!koeTeams.has(r.team) || (koePos !== "All" && r.pos !== koePos)) return false;
    if (r.pos === "QB" && normName(r.name) !== normName(currentStarterQb(r.team, week) || "")) return false;
    if (lineupOutOn(r.team, r.name, week)) {
      out += 1;
      return false;
    }
    return true;
  });
  const { key, dir } = koeSort;
  rows.sort((a, b) => dir * (((a[key] ?? -1e9) > (b[key] ?? -1e9)) - ((a[key] ?? -1e9) < (b[key] ?? -1e9))) || b.upside - a.upside);
  document.getElementById("koe-count").textContent = `${rows.length} players${out ? ` · ${out} ruled out hidden` : ""}`;
  // Column groups become header bubbles spanning their columns, with an
  // empty gap column between groups so each reads as its own block.
  const groups = [];
  KOE_COLS.forEach((c) => (groups.length && groups[groups.length - 1].name === c.group ? groups[groups.length - 1].cols.push(c) : groups.push({ name: c.group, cols: [c] })));
  const gcls = (name) => `koe-g-${KOE_GROUP_CLASS[name]}`;
  const sortCls = (k) => (koeSort.key === k ? ` koe-sorted${koeSort.dir > 0 ? " koe-asc" : ""}` : "");
  const gap = (tag) => `<${tag} class="koe-gap"></${tag}>`;
  const upTitle = "Long-TD upside: league percentile of 20+ yd plays (35%), 40+ yd plays (15%), deep role (15%), TD length (10%) and this week's defense's big plays allowed (25%)";
  const cols = `<colgroup><col class="koe-c-player"><col class="koe-c-opp">${groups.map((g) => `<col class="koe-c-gap">${g.cols.map(() => `<col class="koe-c-stat">`).join("")}`).join("")}<col class="koe-c-gap"><col class="koe-c-up"></colgroup>`;
  const head = `<tr class="koe-group-row"><th></th><th></th>${groups.map((g) => `${gap("th")}<th colspan="${g.cols.length}" class="koe-group ${gcls(g.name)}"><span>${g.name}</span></th>`).join("")}${gap("th")}<th class="koe-group koe-g-up"><span>Upside</span></th></tr>
    <tr class="koe-label-row"><th class="koe-sort${sortCls("name")}" data-sort="name">Player</th><th>Opp</th>${groups.map((g) => `${gap("th")}${g.cols.map((c) => `<th class="num koe-sort ${gcls(g.name)}${sortCls(c.key)}" data-sort="${c.key}" title="${c.title}">${c.label}</th>`).join("")}`).join("")}${gap("th")}<th class="num koe-sort koe-g-up${sortCls("upside")}" data-sort="upside" title="${upTitle}">0-100</th></tr>`;
  const body = rows
    .map((r) => {
      const who = playerClick(r.team, r.name, `${summaryHeadshot(r.team, r.name, 30)}<span class="koe-name">${r.name}</span>`, r.opp);
      return `<tr>
        <td class="koe-player">${who}<span class="koe-meta">${teamLogoMini(r.team, 14)} ${r.team} &middot; ${r.pos}</span></td>
        <td class="koe-opp">${r.opp ? `${teamLogoMini(r.opp, 18)} ${r.opp}` : "--"}</td>
        ${groups.map((g) => `${gap("td")}${g.cols.map((c) => koeCell(c, r, league)).join("")}`).join("")}
        ${gap("td")}${koeUpsideCell(r)}
      </tr>`;
    })
    .join("");
  el.innerHTML = rows.length
    ? `<section class="koe-section"><table class="data-table koe-table">${cols}<thead>${head}</thead><tbody>${body}</tbody></table></section>`
    : `<p class="no-data-note">No players at this position on the checked teams.</p>`;
  wrapWideTablesForPhone();
}

// D/ST: return TDs so far, takeaways, and this week's opponent's giveaways
// and D/ST TDs allowed.
function renderKoeDst() {
  const el = document.getElementById("koe-dst");
  const teams = [...koeTeams].filter((t) => DATA.koe.teams[t]);
  if (!teams.length || (koePos !== "All")) {
    el.innerHTML = "";
    return;
  }
  const ts = DATA.team_stats || {};
  const chip = (t) => `<span class="koe-dst-td" title="Week ${t.week} vs ${t.opp}">${t.kind} <b>${t.yds}</b></span>`;
  const all = (key) => Object.values(ts).map((s) => s[key]).filter((v) => v !== null && v !== undefined);
  const tier = (v, key) => (v === null || v === undefined ? `<td class="num">--</td>` : `<td class="num ${percentileTier(v, all(key), false)}"${tierAlphaAttr(v, all(key), false)}>${fmt(v, 1)}</td>`);
  const rows = teams
    .map((team) => {
      const k = DATA.koe.teams[team];
      const opp = koeOpponent(team);
      const ok = opp ? DATA.koe.teams[opp] : null;
      return `<tr>
        <td class="koe-player"><span class="koe-dst-team">${teamLogoMini(team, 26)} <b>${team}</b> D/ST</span></td>
        <td class="koe-opp">${opp ? `${teamLogoMini(opp, 18)} ${opp}` : "--"}</td>
        <td class="koe-gap"></td>
        <td>${k.dst_tds.length ? k.dst_tds.map(chip).join("") : `<span class="muted">none</span>`}</td>
        <td class="koe-gap"></td>
        ${tier((ts[team] || {}).takeaways_per_g, "takeaways_per_g")}
        ${tier(opp ? (ts[opp] || {}).turnovers_per_g : null, "turnovers_per_g")}
        <td class="koe-gap"></td>
        <td>${ok && ok.dst_tds_allowed.length ? ok.dst_tds_allowed.map(chip).join("") : `<span class="muted">none</span>`}</td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `<section class="koe-section">
    <h3 class="koe-sub">D/ST <span class="section-note">counts in the promo: pick-sixes, fumble returns, kick and punt returns</span></h3>
    <table class="data-table koe-table koe-dst"><colgroup><col class="koe-c-player"><col class="koe-c-opp"><col class="koe-c-gap"><col class="koe-c-list"><col class="koe-c-gap"><col class="koe-c-wide"><col class="koe-c-wide"><col class="koe-c-gap"><col class="koe-c-list"></colgroup><thead><tr class="koe-label-row"><th>D/ST</th><th>Opp</th><th class="koe-gap"></th><th class="koe-g-td">D/ST TDs (yds)</th><th class="koe-gap"></th><th class="num koe-g-big" title="Interceptions + fumble recoveries per game">Takeaways/g</th><th class="num koe-g-big" title="This week's opponent: giveaways per game">Opp giveaways/g</th><th class="koe-gap"></th><th class="koe-g-def" title="D/ST TDs this week's opponent has given up">Opp has allowed</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

function renderKoeTeamPicker() {
  const games = koeWeekGames();
  document.getElementById("koe-week").textContent = games.length ? `Week ${games[0].week}` : "";
  document.getElementById("koe-games").innerHTML = games
    .map((g) => {
      const btn = (t) => `<button type="button" class="koe-team${koeTeams.has(t) ? " active" : ""}" data-team="${t}">${teamLogoMini(t, 20)} ${t}</button>`;
      const both = koeTeams.has(g.away) && koeTeams.has(g.home);
      return `<div class="koe-game${both ? " koe-game-on" : ""}">${btn(g.away)}<button type="button" class="koe-at" data-game="${g.away}|${g.home}" title="Check / uncheck both teams">@</button>${btn(g.home)}</div>`;
    })
    .join("");
  document.getElementById("koe-pos").innerHTML = KOE_POS.map((p) => `<button type="button" class="view-toggle-btn${koePos === p ? " active" : ""}" data-pos="${p}">${p}</button>`).join("");
}

function renderKoe() {
  if (!DATA.koe) {
    document.getElementById("koe-players").innerHTML = `<p class="no-data-note">King of the Endzone appears after the next data refresh.</p>`;
    return;
  }
  renderKoeTeamPicker();
  renderKoePlayers();
  renderKoeDst();
}

document.addEventListener("click", (e) => {
  const team = e.target.closest(".koe-team");
  const game = e.target.closest(".koe-at");
  const pos = e.target.closest("[data-pos]");
  const sort = e.target.closest(".koe-sort");
  if (team) {
    const t = team.dataset.team;
    koeTeams.has(t) ? koeTeams.delete(t) : koeTeams.add(t);
  } else if (game) {
    const [a, h] = game.dataset.game.split("|");
    const on = koeTeams.has(a) && koeTeams.has(h);
    [a, h].forEach((t) => (on ? koeTeams.delete(t) : koeTeams.add(t)));
  } else if (e.target.closest("#koe-all")) {
    koeWeekGames().forEach((g) => (koeTeams.add(g.away), koeTeams.add(g.home)));
  } else if (e.target.closest("#koe-none")) {
    koeTeams.clear();
  } else if (pos) {
    koePos = pos.dataset.pos;
  } else if (sort) {
    const k = sort.dataset.sort;
    koeSort = koeSort.key === k ? { key: k, dir: -koeSort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
  } else {
    return;
  }
  saveKoeTeams();
  renderKoe();
});

fetch("data.json")
  .then((r) => r.json())
  .then((data) => {
    DATA = data;
    koeTeams = loadKoeTeams();
    renderKoe();
  })
  .catch((err) => {
    document.getElementById("koe-players").innerHTML = "<p>Couldn't load data.json.</p>";
    console.error(err);
  });
