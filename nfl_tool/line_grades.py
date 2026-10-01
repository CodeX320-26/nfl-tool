"""Offensive line grades (and the mirror-image defensive front grades).

Designed with the user 2026-10-01. Every component is computed for BOTH
sides from the same plays -- a team's offense (what its line allowed) and
its defense (what its front generated) -- so any OL grade can be read
against the opponent's front grade (two-sided matchup rule).

Pipeline per metric:
  1. per-play value from pbp (+ FTN charting / NFL Next Gen Stats),
  2. shrunk toward the league average by a prior sample size k (early
     season, 3-4 games, one ugly game can't make a line an F),
  3. opponent-adjusted: a team's number minus how the opponents it
     actually faced usually do, play-weighted (holding up vs a great
     pass rush counts for more),
  4. z-scored across the league (sign flipped where lower is better).
Weighted means of z's form Pass Pro / Run Block / Discipline, each
re-standardized across the league and mapped to the same A-F bands as the
site's Team Grades (game-overview.js GRADE_BANDS).

Public data has no true "hurries"; pressure = sack or QB hit (the site's
standing proxy), with sacks the QB caused (FTN is_qb_fault_sack) taken off
the line's sack rate, and pressure also read against how long the QB holds
the ball (Next Gen Stats time to throw).
"""

import math
import sys
import urllib.request
from pathlib import Path

import pandas as pd

NGS_PASSING_URL = "https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_passing.csv.gz"
NGS_RUSHING_URL = "https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_rushing.csv.gz"

# Same bands as game-overview.js GRADE_BANDS.
GRADE_BANDS = [(1.2, "A"), (0.4, "B"), (-0.4, "C"), (-1.2, "D")]

OL_POSITIONS = {"T", "G", "C", "OT", "OG", "OL", "LT", "LG", "RT", "RG"}
NGS_TEAM_FIXES = {"LAR": "LA", "AZ": "ARI", "JAC": "JAX", "WSH": "WAS", "OAK": "LV", "SD": "LAC", "STL": "LA"}

# key: (label, side group, weight within group, lower_is_better, prior k)
OL_METRICS = {
    # Pass protection (55% of overall)
    "pressure_4man": ("Pressure allowed vs 4-man rush", "pass_pro", 0.30, True, 60),
    "pressure_blitz": ("Pressure allowed vs blitz (5+)", "pass_pro", 0.15, True, 25),
    "sack_rate": ("Sack rate allowed (not QB-fault)", "pass_pro", 0.25, True, 80),
    "pressure_vs_ttt": ("Pressure vs time to throw", "pass_pro", 0.20, True, None),
    "clean_pocket": ("Clean-pocket rate", "pass_pro", 0.10, False, 60),
    # Run blocking (40%)
    "xry_per_carry": ("Expected rush yds/carry (NGS)", "run_block", 0.35, False, 40),
    "stuff_rate": ("Stuffed at/behind the line", "run_block", 0.20, True, 40),
    "short_yardage": ("3rd/4th & <=2 run conversion", "run_block", 0.15, False, 8),
    "ypc_vs_box": ("Yds/carry vs box count", "run_block", 0.15, False, 40),
    "rush_success": ("Designed-run success rate", "run_block", 0.15, False, 40),
    # Discipline (5%)
    "ol_penalties": ("OL penalties per game", "discipline", 1.00, True, 2),
}
OL_GROUP_WEIGHTS = {"pass_pro": 0.55, "run_block": 0.40, "discipline": 0.05}
# Defensive front: same metrics from the other side (what the front
# generated/allowed). No discipline group.
DL_GROUP_NAMES = {"pass_pro": "pass_rush", "run_block": "run_defense"}
DL_GROUP_WEIGHTS = {"pass_rush": 0.55, "run_defense": 0.45}


def _download(url: str, dest: Path):
    req = urllib.request.Request(url, headers={"User-Agent": "nfl-tool-build"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())


def load_ngs(data_dir: Path, season: int):
    """(passing, rushing) Next Gen Stats rows for one season, weekly rows
    only (week 0 is NGS's own season total). None for either on failure --
    the metrics that need them then just drop out of the grade."""
    out = []
    for name, url in (("passing", NGS_PASSING_URL), ("rushing", NGS_RUSHING_URL)):
        path = data_dir / f"ngs_{name}.csv.gz"
        try:
            _download(url, path)  # refreshed every build, like injuries
        except Exception as e:  # noqa: BLE001
            print(f"  NGS {name}: download failed ({e})", file=sys.stderr)
            if not path.exists():
                out.append(None)
                continue
        df = pd.read_csv(path, low_memory=False)
        df = df[(df["season"] == season) & (df["season_type"] == "REG") & (df["week"] >= 1)].copy()
        df["team_abbr"] = df["team_abbr"].map(lambda t: NGS_TEAM_FIXES.get(t, t))
        out.append(df)
    return tuple(out)


def _score(z):
    """0-100 companion to the letter (user, 2026-10-01): the team's
    percentile vs the league, assuming normal z (50 = average, 90 = better
    than 90% of lines). Same scale as the letters: A >= 88, B 66-87,
    C 35-65, D 12-34, F < 12 (the GRADE_BANDS cut points)."""
    if z is None or (isinstance(z, float) and math.isnan(z)):
        return None
    return max(1, min(99, round(50 * (1 + math.erf(z / math.sqrt(2))))))


def _grade(z):
    if z is None or (isinstance(z, float) and math.isnan(z)):
        return None
    for lo, g in GRADE_BANDS:
        if z >= lo:
            return g
    return "F"


def _zscores(values: dict, invert: bool) -> dict:
    vals = [v for v in values.values() if v is not None and not math.isnan(v)]
    if len(vals) < 3:
        return {t: None for t in values}
    mean = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals)) or 1.0
    sign = -1 if invert else 1
    return {t: (None if v is None or math.isnan(v) else sign * (v - mean) / sd) for t, v in values.items()}


def _restandardize(values: dict) -> dict:
    return _zscores(values, invert=False)


def _both_sides(df: pd.DataFrame, value_col: str, k: float):
    """Shrunk + opponent-adjusted team rates for one per-play metric, for
    the offense (posteam) and the defense (defteam). Returns
    (off_adj, def_adj, off_raw, def_raw, off_n, def_n, league)."""
    d = df[["posteam", "defteam", value_col]].dropna()
    if d.empty:
        return {}, {}, {}, {}, {}, {}, None
    league = float(d[value_col].mean())
    og = d.groupby("posteam")[value_col].agg(["sum", "count"])
    dg = d.groupby("defteam")[value_col].agg(["sum", "count"])
    off_raw = (og["sum"] / og["count"]).to_dict()
    def_raw = (dg["sum"] / dg["count"]).to_dict()
    off_shr = ((og["sum"] + k * league) / (og["count"] + k)).to_dict()
    def_shr = ((dg["sum"] + k * league) / (dg["count"] + k)).to_dict()
    # Opponent strength = the shrunk rate of whoever was across the line on
    # each play, averaged over this team's own plays.
    opp_for_off = d["defteam"].map(def_shr).groupby(d["posteam"]).mean().to_dict()
    opp_for_def = d["posteam"].map(off_shr).groupby(d["defteam"]).mean().to_dict()
    off_adj = {t: off_shr[t] - opp_for_off.get(t, league) + league for t in off_shr}
    def_adj = {t: def_shr[t] - opp_for_def.get(t, league) + league for t in def_shr}
    return off_adj, def_adj, off_raw, def_raw, og["count"].to_dict(), dg["count"].to_dict(), league


def _residual(y: dict, x: dict) -> dict:
    """y minus its least-squares fit on x across teams (both dicts by team)."""
    teams = [t for t in y if t in x and y[t] is not None and x[t] is not None]
    if len(teams) < 5:
        return {}
    mx = sum(x[t] for t in teams) / len(teams)
    my = sum(y[t] for t in teams) / len(teams)
    sxx = sum((x[t] - mx) ** 2 for t in teams)
    b = sum((x[t] - mx) * (y[t] - my) for t in teams) / sxx if sxx else 0.0
    return {t: y[t] - (my + b * (x[t] - mx)) for t in teams}


def compute_line_grades(pbp: pd.DataFrame, ftn, ngs_pass, ngs_rush, pos_lookup, teams) -> dict:
    p = pbp.copy()
    for col in ("qb_dropback", "qb_spike", "qb_kneel", "qb_scramble", "rush_attempt", "two_point_attempt", "sack", "qb_hit", "penalty"):
        if col in p.columns:
            p[col] = p[col].fillna(0)
    if ftn is not None and len(ftn):
        p = p.merge(
            ftn[["nflverse_game_id", "nflverse_play_id", "n_pass_rushers", "n_defense_box", "is_qb_fault_sack"]],
            left_on=["game_id", "play_id"], right_on=["nflverse_game_id", "nflverse_play_id"], how="left",
        )
    else:
        p = p.assign(n_pass_rushers=float("nan"), n_defense_box=float("nan"), is_qb_fault_sack=float("nan"))

    real = (p["two_point_attempt"] != 1) & p["posteam"].notna() & p["defteam"].notna()
    db = p[real & (p["qb_dropback"] == 1) & (p["qb_spike"] != 1)].copy()
    db["pressure"] = ((db["sack"] == 1) | (db["qb_hit"] == 1)).astype(float)
    db["clean"] = 1.0 - db["pressure"]
    qb_fault = db["is_qb_fault_sack"].fillna(False).astype(str).str.lower().isin(("true", "1", "1.0"))
    db["line_sack"] = ((db["sack"] == 1) & ~qb_fault).astype(float)
    db["pressure_4man"] = db["pressure"].where(db["n_pass_rushers"] <= 4)
    db["pressure_blitz"] = db["pressure"].where(db["n_pass_rushers"] >= 5)

    runs = p[real & (p["rush_attempt"] == 1) & (p["qb_scramble"] != 1) & (p["qb_kneel"] != 1)].copy()
    runs["stuffed"] = (runs["yards_gained"] <= 0).astype(float)
    runs["rush_success"] = runs["success"].astype(float)
    sy = (runs["down"].isin([3, 4])) & (runs["ydstogo"] <= 2)
    runs["short_yardage"] = ((runs["first_down"].fillna(0) == 1) | (runs["touchdown"].fillna(0) == 1)).astype(float).where(sy)
    box = runs["n_defense_box"]
    runs["box_bucket"] = pd.cut(box, [-1, 6, 7, 20], labels=["light", "base", "heavy"]).astype(str)
    clipped = runs["yards_gained"].clip(-10, 30)  # one 70-yarder shouldn't define a line
    runs["ypc_vs_box"] = clipped - clipped.groupby(runs["box_bucket"]).transform("mean")

    results = {"ol": {}, "dl": {}}  # metric -> {team: dict}
    adj_off, adj_def = {}, {}

    def add(key, frame, col):
        k = OL_METRICS[key][4]
        oa, da, orw, drw, on, dn, _ = _both_sides(frame, col, k)
        adj_off[key], adj_def[key] = oa, da
        results["ol"][key] = {t: {"value": orw.get(t), "n": int(on.get(t, 0))} for t in teams}
        results["dl"][key] = {t: {"value": drw.get(t), "n": int(dn.get(t, 0))} for t in teams}

    add("pressure_4man", db, "pressure_4man")
    add("pressure_blitz", db, "pressure_blitz")
    add("sack_rate", db, "line_sack")
    add("clean_pocket", db, "clean")
    add("stuff_rate", runs, "stuffed")
    add("short_yardage", runs, "short_yardage")
    add("ypc_vs_box", runs, "ypc_vs_box")
    add("rush_success", runs, "rush_success")

    # Pressure read against time to throw: overall pressure (opp-adjusted)
    # minus what a team's QB hold time predicts across the league. Defense
    # side uses the hold time of the QBs it faced.
    pr_off = {t: 1 - v for t, v in adj_off["clean_pocket"].items()}
    pr_def = {t: 1 - v for t, v in adj_def["clean_pocket"].items()}
    ttt_off, ttt_def = {}, {}
    if ngs_pass is not None and len(ngs_pass):
        g = ngs_pass.assign(w=ngs_pass["attempts"] * ngs_pass["avg_time_to_throw"]).groupby("team_abbr")[["w", "attempts"]].sum()
        ttt_off = (g["w"] / g["attempts"]).to_dict()
        faced = db.groupby(["defteam", "posteam"]).size().reset_index(name="n")
        faced["ttt"] = faced["posteam"].map(ttt_off)
        faced = faced.dropna(subset=["ttt"])
        ttt_def = (faced.assign(w=faced["n"] * faced["ttt"]).groupby("defteam")["w"].sum() / faced.groupby("defteam")["n"].sum()).to_dict()
    adj_off["pressure_vs_ttt"] = _residual(pr_off, ttt_off) if ttt_off else {}
    adj_def["pressure_vs_ttt"] = _residual(pr_def, ttt_def) if ttt_def else {}
    results["ol"]["pressure_vs_ttt"] = {t: {"value": ttt_off.get(t), "n": None} for t in teams}  # display: hold time (s)
    results["dl"]["pressure_vs_ttt"] = {t: {"value": ttt_def.get(t), "n": None} for t in teams}

    # Expected rush yards per carry (NGS), defense side = what the rushers it
    # faced were expected to gain. Opponent per team-week comes from pbp.
    if ngs_rush is not None and len(ngs_rush):
        opp = p[p["posteam"].notna()].groupby(["week", "posteam"])["defteam"].first().to_dict()
        r = ngs_rush[["week", "team_abbr", "expected_rush_yards", "rush_attempts"]].dropna().copy()
        r["defteam"] = [opp.get((w, t)) for w, t in zip(r["week"], r["team_abbr"])]
        r = r.dropna(subset=["defteam"])
        k = OL_METRICS["xry_per_carry"][4]
        league = r["expected_rush_yards"].sum() / r["rush_attempts"].sum()
        og = r.groupby("team_abbr")[["expected_rush_yards", "rush_attempts"]].sum()
        dg = r.groupby("defteam")[["expected_rush_yards", "rush_attempts"]].sum()
        off_shr = ((og["expected_rush_yards"] + k * league) / (og["rush_attempts"] + k)).to_dict()
        def_shr = ((dg["expected_rush_yards"] + k * league) / (dg["rush_attempts"] + k)).to_dict()
        r["opp_def"] = r["defteam"].map(def_shr) * r["rush_attempts"]
        r["opp_off"] = r["team_abbr"].map(off_shr) * r["rush_attempts"]
        opp_off_avg = (r.groupby("team_abbr")["opp_def"].sum() / r.groupby("team_abbr")["rush_attempts"].sum()).to_dict()
        opp_def_avg = (r.groupby("defteam")["opp_off"].sum() / r.groupby("defteam")["rush_attempts"].sum()).to_dict()
        adj_off["xry_per_carry"] = {t: off_shr[t] - opp_off_avg.get(t, league) + league for t in off_shr}
        adj_def["xry_per_carry"] = {t: def_shr[t] - opp_def_avg.get(t, league) + league for t in def_shr}
        results["ol"]["xry_per_carry"] = {t: {"value": (og.loc[t, "expected_rush_yards"] / og.loc[t, "rush_attempts"]) if t in og.index else None, "n": int(og.loc[t, "rush_attempts"]) if t in og.index else 0} for t in teams}
        results["dl"]["xry_per_carry"] = {t: {"value": (dg.loc[t, "expected_rush_yards"] / dg.loc[t, "rush_attempts"]) if t in dg.index else None, "n": int(dg.loc[t, "rush_attempts"]) if t in dg.index else 0} for t in teams}
    else:
        adj_off["xry_per_carry"], adj_def["xry_per_carry"] = {}, {}
        results["ol"]["xry_per_carry"] = {t: {"value": None, "n": 0} for t in teams}
        results["dl"]["xry_per_carry"] = {t: {"value": None, "n": 0} for t in teams}

    # OL penalties per game (offense only; no opponent adjustment -- the
    # other team doesn't make your guard hold).
    pen = p[(p["penalty"] == 1) & (p["penalty_team"] == p["posteam"]) & p["penalty_player_id"].notna()]
    pen = pen[[(pos_lookup(pid, wk)[0] or "") in OL_POSITIONS for pid, wk in zip(pen["penalty_player_id"], pen["week"])]]
    games = p[p["posteam"].notna()].groupby("posteam")["game_id"].nunique().to_dict()
    pcount = pen.groupby("posteam").size().to_dict()
    k = OL_METRICS["ol_penalties"][4]
    league_pg = (sum(pcount.values()) / sum(games.values())) if games else 0
    adj_off["ol_penalties"] = {t: (pcount.get(t, 0) + k * league_pg) / (games.get(t, 0) + k) for t in teams}
    results["ol"]["ol_penalties"] = {t: {"value": (pcount.get(t, 0) / games[t]) if games.get(t) else None, "n": int(games.get(t, 0))} for t in teams}

    def side_grades(adj, metric_results, group_weights, group_names, with_discipline):
        out = {t: {"metrics": {}} for t in teams}
        group_z = {}
        for key, (label, group, w, lower_better, _) in OL_METRICS.items():
            if group == "discipline" and not with_discipline:
                continue
            g = group_names.get(group, group)
            # Defense side: "lower is better" flips (a front WANTS to generate
            # pressure, stuffs, sacks; it wants LOW expected yards, success...).
            invert = lower_better if with_discipline else not lower_better
            zs = _zscores({t: adj.get(key, {}).get(t, float("nan")) for t in teams}, invert)
            for t in teams:
                z = zs.get(t)
                m = metric_results[key][t]
                out[t]["metrics"][key] = {
                    "label": label, "group": g, "value": None if m["value"] is None else round(float(m["value"]), 3),
                    "n": m["n"], "z": None if z is None else round(z, 2), "score": _score(z),
                }
                if z is not None:
                    acc = group_z.setdefault(g, {}).setdefault(t, [0.0, 0.0])
                    acc[0] += z * w
                    acc[1] += w
        groups = {}
        for g, per_team in group_z.items():
            raw = {t: (s / wsum if wsum else float("nan")) for t, (s, wsum) in per_team.items()}
            groups[g] = _restandardize({t: raw.get(t, float("nan")) for t in teams})
        overall_raw = {}
        for t in teams:
            s = wsum = 0.0
            for g, gw in group_weights.items():
                z = groups.get(g, {}).get(t)
                if z is not None:
                    s += z * gw
                    wsum += gw
            overall_raw[t] = s / wsum if wsum else float("nan")
        overall = _restandardize(overall_raw)
        for t in teams:
            for g in group_weights:
                z = groups.get(g, {}).get(t)
                out[t][g] = {"z": None if z is None else round(z, 2), "grade": _grade(z), "score": _score(z)}
            z = overall.get(t)
            out[t]["overall"] = {"z": None if z is None else round(z, 2), "grade": _grade(z), "score": _score(z)}
        return out

    ol = side_grades(adj_off, results["ol"], OL_GROUP_WEIGHTS, {}, True)
    dl = side_grades(adj_def, results["dl"], DL_GROUP_WEIGHTS, DL_GROUP_NAMES, False)
    return {t: {"ol": ol[t], "dl": dl[t]} for t in teams}
