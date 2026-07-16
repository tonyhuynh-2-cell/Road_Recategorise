# -*- coding: utf-8 -*-
"""
S-10 / R-05 re-score: urban centres connectivity at SUBURB (SAL) granularity.
=============================================================================
S-10 reads "Connects Metro Centres / Regional Cities / Major Urban Centres /
Major Towns"; R-05 reads "Connects Metropolitan Centres, Major Urban Centres
and Major Towns to each other". Connecting centres TO EACH OTHER needs at
least two distinct centres — but the previous evidence resolved urban centres
at Significant-Urban-Area granularity, so every road inside the metro saw ONE
centre ("Sydney") and could never earn the criterion, however many distinct
major centres it actually links (Parramatta <-> Chatswood etc.).

Rule applied here (urban roads only — area == 'urban' in nsw_criteria.json,
BOTH classes: State S-10 and Regional R-05):

  qualifying centre = an ABS Suburb/Locality (SAL 2021, ASGS Ed 3 Non-ABS
      Structures GeoPackage) whose 2021 Census population (G01, Tot_P_P)
      is >= 7,000 — the same Major Town floor the rest of the tool uses
      (Regional City >= 20k / Major Town >= 7k, process_nsw.py);
  connected         = the SAL polygon intersects any of the road's segments
      (the road runs through the suburb);
  new opt.centres   = (number of DISTINCT qualifying SALs intersected >= 2).

Evidence (nsw_evidence.json centres[]) for urban roads is replaced with the
qualifying SALs actually intersected (kind:'sal', centroid lon/lat, census
population) so the Road Detail card names the real suburbs and can never
contradict the verdict. Rural roads and every other criterion are untouched.
Verdicts are earned from the data, never forced.

Inputs (not in git — see dashboard/Newfile/):
  Newfile/ASGS_Ed3_Non_ABS_Structures_GDA2020_updated_2025.gpkg
      (auto-extracted from the .zip of the same name if missing),
      layer SAL_2021_AUST_GDA2020, filtered to STATE_CODE_2021 = '1';
  POI/Census_Population/2021Census_G01_NSW_SAL.csv (Tot_P_P by SAL code).

Cascade kept consistent (same precedent as rebuild_r05_urban_centres.py):
  nsw_criteria.json  - opt.centres / optMet / verdict for changed roads
  nsw_recat.json     - per-segment verdict array -> changed roads' new verdict
  export_rows.json   - state + regional tab cells for changed roads: the
                       'S-10/R-05 met/not met (centres)' Why line, the arrow
                       summary line (both '{n} of 2 optional' and
                       '{n} optional met' styles preserved), the
                       'S-10/R-05 PASS/fail - connects centres' What line,
                       Categorisation and _v
  nsw_evidence.json  - centres[] for ALL urban roads -> qualifying SALs
  nsw_stats.json / summary_stats.json - NOT touched (pipeline-only outputs).

Each written file is first backed up to <name>.preSAL.bak (originals win on
re-runs: inputs are read from the .preSAL.bak when present, so the script is
idempotent). Run with --apply to write; default is a dry run (validation gates
+ impact matrix only).
"""
import json
import shutil
import sys
import zipfile
from collections import Counter
from pathlib import Path

APPLY = "--apply" in sys.argv
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
NEWFILE = HERE / "Newfile"
POI = HERE.parent / "POI"
GPKG = NEWFILE / "ASGS_Ed3_Non_ABS_Structures_GDA2020_updated_2025.gpkg"
SAL_LAYER = "SAL_2021_AUST_GDA2020"
SAL_POP_CSV = POI / "Census_Population" / "2021Census_G01_NSW_SAL.csv"
QUALIFY_POP = 7000   # Major Town floor — matches the UCL tier system in process_nsw.py
BAK = ".preSAL.bak"


def log(*a):
    print(*a, flush=True)


def orig_path(name):
    """Pristine original: the *.preSAL.bak if a prior run made one, else the live file."""
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    return bak if bak.exists() else p


def read_orig(name):
    return json.load(open(orig_path(name), encoding="utf-8"))


def write_json(name, obj):
    """Back up the live file to *.preSAL.bak (first run only), then write single-line
    JSON exactly like the existing files (ensure_ascii=False, default separators)."""
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    if not bak.exists():
        shutil.copyfile(p, bak)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {bak.name})")


def verdict_of(c, opt_met):
    """Category verdict rule: mandatory gate first (State = PBS-1, Regional = 19m
    B-double), then >=2 optional green / 1 orange / 0 red."""
    gate = c["mand"].get("pbs1") if c["cls"] == "State" else c["mand"].get("bdouble")
    return ("red" if gate is False
            else "green" if opt_met >= 2 else "orange" if opt_met == 1 else "red")


# ---------------------------------------------------------------- load criteria
crit = read_orig("nsw_criteria.json")
evid = read_orig("nsw_evidence.json")

# ---------------------------------------------------------------- validation gates
# The verdict rule must reproduce EVERY current State and Regional verdict from the
# current booleans before we recompute anything. Abort otherwise.
for cls in ("State", "Regional"):
    grp = {k: c for k, c in crit.items() if c["cls"] == cls}
    bad = [k for k, c in grp.items()
           if sum(1 for v in c["opt"].values() if v is True) != c["optMet"]
           or verdict_of(c, c["optMet"]) != c["verdict"]]
    if bad:
        log(f"VALIDATION GATE FAILED — {len(bad)} {cls} roads do not reproduce: {bad[:10]}")
        sys.exit(1)
    log(f"validation gate: verdict rule reproduces {len(grp)}/{len(grp)} current {cls} verdicts")

urban = {k for k, c in crit.items() if c["area"] == "urban"}
log(f"urban roads to re-score: {len(urban)} "
    f"(State {sum(1 for k in urban if crit[k]['cls'] == 'State')}, "
    f"Regional {sum(1 for k in urban if crit[k]['cls'] == 'Regional')})")

# ---------------------------------------------------------------- load SAL boundaries
import geopandas as gpd            # noqa: E402  (heavy imports after the fast gates)
import pandas as pd                # noqa: E402
from shapely.geometry import shape # noqa: E402

if not GPKG.exists():
    zp = GPKG.with_suffix(".zip")
    log(f"extracting {GPKG.name} from {zp.name}…")
    zipfile.ZipFile(zp).extract(GPKG.name, NEWFILE)

sal = gpd.read_file(GPKG, layer=SAL_LAYER, where="STATE_CODE_2021 = '1'")
pop = pd.read_csv(SAL_POP_CSV, usecols=["SAL_CODE_2021", "Tot_P_P"])
pop["SAL_CODE_2021"] = pop["SAL_CODE_2021"].astype(str).str.replace("SAL", "", regex=False)
sal = sal.merge(pop, on="SAL_CODE_2021", how="left")
missing_pop = int(sal["Tot_P_P"].isna().sum())
sal["Tot_P_P"] = sal["Tot_P_P"].fillna(0)            # no census record => cannot qualify
qual = sal[sal["Tot_P_P"] >= QUALIFY_POP].to_crs("EPSG:4326").copy()
# ABS special-purpose SALs ("No usual address", "Migratory - Offshore - Shipping") carry census
# population but no geometry — they are not places a road can connect.
no_geom = int((qual.geometry.isna() | qual.geometry.is_empty).sum())
qual = qual[qual.geometry.notna() & ~qual.geometry.is_empty].copy()
qual["pt"] = qual.geometry.representative_point()
log(f"NSW SALs: {len(sal)} (census pop missing on {missing_pop}); "
    f"qualifying (pop >= {QUALIFY_POP:,}): {len(qual)} (dropped {no_geom} geometry-less special SALs)")

# ---------------------------------------------------------------- intersect roads x SALs
asmt = json.load(open(DATA / "nsw_assessment.geojson", encoding="utf-8"))  # read-only
segs = [(str(f["properties"].get("road_number") or "").strip(), shape(f["geometry"]))
        for f in asmt["features"]
        if str(f["properties"].get("road_number") or "").strip() in urban]
roads_gdf = gpd.GeoDataFrame({"rn": [rn for rn, _ in segs]},
                             geometry=[g for _, g in segs], crs="EPSG:4326")
hits = gpd.sjoin(roads_gdf, qual[["SAL_CODE_2021", "SAL_NAME_2021", "Tot_P_P", "geometry"]],
                 predicate="intersects", how="inner")
road_sals = hits.groupby("rn")["SAL_CODE_2021"].agg(set).to_dict()
sal_meta = {r.SAL_CODE_2021: (r.SAL_NAME_2021, int(r.Tot_P_P), r.pt.x, r.pt.y)
            for r in qual.itertuples()}
log(f"urban road segments intersected: {len(roads_gdf)} segs -> "
    f"{sum(1 for k in urban if road_sals.get(k))} of {len(urban)} roads touch >=1 qualifying SAL")

# ---------------------------------------------------------------- recompute
changed = {}   # rn -> (new_centres, new_optMet, new_verdict)
for rn in sorted(urban):
    c = crit[rn]
    new_centres = len(road_sals.get(rn, ())) >= 2
    if new_centres == c["opt"]["centres"]:
        continue
    new_opt_met = sum(1 for k2, v in c["opt"].items()
                      if (new_centres if k2 == "centres" else v) is True)
    changed[rn] = (new_centres, new_opt_met, verdict_of(c, new_opt_met))

# ---------------------------------------------------------------- impact matrix
flips = Counter((crit[rn]["opt"]["centres"], nc) for rn, (nc, _, _) in changed.items())
trans = Counter((crit[rn]["cls"], crit[rn]["verdict"], nv) for rn, (_, _, nv) in changed.items())
def split(pred):
    old = Counter(c["verdict"] for k, c in crit.items() if pred(k, c))
    new = Counter(changed[k][2] if k in changed else c["verdict"]
                  for k, c in crit.items() if pred(k, c))
    return old, new
fmt = lambda ctr: f"{ctr['green']}/{ctr['orange']}/{ctr['red']} (g/o/r)"
all_old, all_new = split(lambda k, c: True)
st_old, st_new = split(lambda k, c: c["cls"] == "State")
rg_old, rg_new = split(lambda k, c: c["cls"] == "Regional")
log(f"opt.centres flips: true->false {flips[(True, False)]}, false->true {flips[(False, True)]}")
log("verdict transitions: " + (", ".join(f"{cls} {a}->{b}: {n}" for (cls, a, b), n in sorted(trans.items())) or "none"))
log(f"named-road split (892): {fmt(all_old)} -> {fmt(all_new)}")
log(f"State-only split:       {fmt(st_old)} -> {fmt(st_new)}")
log(f"Regional-only split:    {fmt(rg_old)} -> {fmt(rg_new)}")

if not APPLY:
    log("dry run only — re-run with --apply to write. No files were changed.")
    sys.exit(0)

# ---------------------------------------------------------------- 1. nsw_criteria.json
for rn, (nc, om, nv) in changed.items():
    crit[rn]["opt"]["centres"] = nc
    crit[rn]["optMet"] = om
    crit[rn]["verdict"] = nv
write_json("nsw_criteria.json", crit)

# ---------------------------------------------------------------- 2. nsw_recat.json
recat = read_orig("nsw_recat.json")
assert len(recat) == len(asmt["features"]), "recat/assessment length mismatch"
seg_changed = 0
for i, f in enumerate(asmt["features"]):
    rn = str(f["properties"].get("road_number") or "").strip()
    if rn in changed and recat[i] != changed[rn][2]:
        recat[i] = changed[rn][2]
        seg_changed += 1
write_json("nsw_recat.json", recat)
log(f"  recat segments changed: {seg_changed}")

# ---------------------------------------------------------------- 3. export_rows.json
exp = read_orig("export_rows.json")
CAT = {"green": "Meets criteria", "orange": "Likely meets (1 of 2 optional)", "red": "Does not meet"}
SUM = {"green": "Meets criteria", "orange": "Likely meets (1 of 2)", "red": "Does not meet"}
rows_changed = 0
for tab in ("state", "regional"):
    for row in exp[tab]:
        rn = str(row.get("Road ID", "")).strip()
        if rn not in changed:
            continue
        nc, om, nv = changed[rn]
        code = "S-10" if tab == "state" else "R-05"
        why, what, hit_why, hit_arrow, hit_what = [], [], False, False, False
        for ln in row["Why"].split("\n"):
            if ln.startswith(code) and "(centres)" in ln:
                why.append(f"{code}  {'met' if nc else 'not met'} (centres)")
                hit_why = True
            elif ln.lstrip().startswith("→"):
                # Two arrow styles exist in the data — preserve whichever the row uses.
                if "of 2 optional" in ln:
                    why.append(f"→ {om} of 2 optional — {SUM[nv]}")
                else:
                    why.append(f"→ {om} optional met — {SUM[nv]}")
                hit_arrow = True
            else:
                why.append(ln)
        for ln in row["What (criteria tested)"].split("\n"):
            if ln.startswith(code) and "connects centres" in ln:
                head, _, tail = ln.partition("—")
                what.append(f"{code}  {'PASS' if nc else 'fail'} —{tail}")
                hit_what = True
            else:
                what.append(ln)
        assert hit_why and hit_arrow and hit_what, f"export lines not matched for {rn} ({tab})"
        row["Why"], row["What (criteria tested)"] = "\n".join(why), "\n".join(what)
        row["Categorisation"], row["_v"] = CAT[nv], nv
        rows_changed += 1
assert rows_changed == len(changed), (rows_changed, len(changed))
assert not any(str(r.get("Road ID", "")).strip() in changed for r in exp["natsig"]), "natsig leak"
write_json("export_rows.json", exp)
log(f"  export rows changed: {rows_changed}")

# ---------------------------------------------------------------- 4. nsw_evidence.json
# Replace centres[] for EVERY urban road (changed or not) with the qualifying SALs it
# actually intersects, so the detail card's evidence always matches the new rule.
ev_changed = 0
for rn in sorted(urban):
    items = sorted(road_sals.get(rn, ()), key=lambda cde: -sal_meta[cde][1])
    new_list = [{"name": sal_meta[cde][0], "kind": "sal", "type": "Suburb / locality (SAL 2021)",
                 "pop": sal_meta[cde][1], "lon": round(sal_meta[cde][2], 5),
                 "lat": round(sal_meta[cde][3], 5), "km": 0.0}
                for cde in items]
    rec = evid.setdefault(rn, {})
    if rec.get("centres") != new_list:
        rec["centres"] = new_list
        ev_changed += 1
write_json("nsw_evidence.json", evid)
log(f"  evidence centres[] rewritten for {ev_changed} urban roads")

log("done.")
