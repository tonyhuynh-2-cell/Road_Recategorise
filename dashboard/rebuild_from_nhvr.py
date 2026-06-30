"""
Rebuild road assessment data from the real NHVR GeoPackages.
=============================================================
Replaces the blanket heavy-vehicle-access passes with values *earned* from the
NHVR Heavy Vehicle Network exports in data/geopackages/:

  PBS Level 1            (S-09, State mandatory)   -> has_pbs1
  19m B-Double Over 50t  (R-04, Regional mandatory)-> has_bdouble / bdouble19
  PBS Aggregate GML 2B   (S-06, Nat. Significant)  -> has_pbs2b / nltn_meta.pbs2b
  Road-train networks    (R-03, display)           -> roadtrain

Method matches the original process_*.py: a road is "on" a network if it runs
within ~50 m (0.0005 deg) of an *Approved* segment of that network.

Verdict rule (reverse-engineered + validated to reproduce 100% of the current
nsw_criteria.json): red if mandatory fails OR 0 optional met; orange if 1
optional met; green if >=2 optional met. Optional criteria are NOT touched
(connectivity/traffic do not come from the gpkgs) -- only the mandatory gate
flips, so only roads that genuinely lack the required access change.

Run with --apply to write; default is a dry run (compute + validate + diff).
"""
import sys, json, glob, os, shutil, re, warnings
from collections import defaultdict
from pathlib import Path
import geopandas as gpd
import pandas as pd
warnings.filterwarnings("ignore", message=".*geographic CRS.*")

APPLY = "--apply" in sys.argv
ROOT = Path(__file__).resolve().parent.parent          # project root
DATA = ROOT / "dashboard" / "data"
GPKG = DATA / "geopackages"
MASTER = ROOT / "nsw_road_network_categorisation.geojson"
BUF = 0.0005                                            # ~50 m, same as process_*.py
LAYER = "hvn_road_segments"

def log(*a): print(*a, flush=True)

def orig_path(relpath):
    """Path to the pristine original: the *.preNHVR.bak if a prior run made one,
    else the live file. Makes re-runs idempotent/deterministic."""
    p = DATA / relpath; bak = p.with_name(p.name + ".preNHVR.bak")
    return bak if bak.exists() else p

def read_orig(relpath):
    return json.load(open(orig_path(relpath), encoding="utf-8"))

# ---------------------------------------------------------------- classify gpkgs
def classify(network_name):
    n = network_name.lower()
    if "pbs" in n and "level 1" in n: return "pbs1"
    if "pbs" in n and "2b" in n:      return "pbs2b"
    if "b-double" in n or "b double" in n: return "bdouble"   # "19m B-Double Over 50t"
    if n.startswith("nsw- rt") or " rt " in n or "road train" in n: return "roadtrain"
    return None

def load_networks():
    roles = {"pbs1": [], "pbs2b": [], "bdouble": [], "roadtrain": []}
    import sqlite3
    for f in sorted(glob.glob(str(GPKG / "*.gpkg"))):
        con = sqlite3.connect(f)
        try:
            nm = con.execute(f'SELECT network_name FROM "{LAYER}" LIMIT 1').fetchone()
        except Exception:
            nm = None
        con.close()
        if not nm: continue
        role = classify(nm[0])
        if role:
            roles[role].append((f, nm[0]))
    return roles

def read_approved(files):
    parts = []
    for f, nm in files:
        g = gpd.read_file(f, layer=LAYER)
        g = g[g["access_code"].str.contains("Approved", case=False, na=False)]
        parts.append(g[["geometry"]])
        log(f"    {os.path.basename(f):28} {nm:38} approved={len(g)}")
    if not parts: return None
    out = pd.concat(parts, ignore_index=True)
    return gpd.GeoDataFrame(out, geometry="geometry", crs="EPSG:4326")

def on_network(roads, seg_gdf):
    """True per road where the road runs within BUF of any segment."""
    if seg_gdf is None or len(seg_gdf) == 0:
        return pd.Series(False, index=roads.index)
    rb = gpd.GeoDataFrame(geometry=roads.geometry.buffer(BUF), crs=roads.crs)
    j = gpd.sjoin(rb, seg_gdf, predicate="intersects", how="inner")
    return roads.index.isin(j.index.unique())

# ---------------------------------------------------------------- verdict rule
def verdict_of(cls, opt_met, mand_pass):
    if not mand_pass: return "red"
    if opt_met >= 2:  return "green"
    if opt_met == 1:  return "orange"
    return "red"

def opt_true(c):
    return sum(1 for v in c["opt"].values() if v is True)

def old_mand_pass(c):                                   # for validation only
    m = c["mand"]
    return all(m.get(k) is not False for k in ("load", "pbs1", "parallel"))

# ================================================================ main
log("="*64); log("REBUILD FROM NHVR GEOPACKAGES", "(APPLY)" if APPLY else "(DRY RUN)"); log("="*64)

log("\n[1] Classifying GeoPackages by network_name...")
roles = load_networks()
for r in roles: log(f"  {r:10} <- {len(roles[r])} file(s)")

log("\n[2] Loading approved segments per network...")
nets = {}
for r in ("pbs1", "pbs2b", "bdouble", "roadtrain"):
    log(f"  {r}:")
    nets[r] = read_approved(roles[r])

log("\n[3] Loading master road network (full geometry)...")
roads = gpd.read_file(MASTER).set_crs("EPSG:4326", allow_override=True)
roads["rn"] = roads["road_number"].apply(lambda v: str(v).strip() if v not in (None, "") else None)
log(f"  segments={len(roads)}  distinct road_numbers={roads['rn'].nunique()}")

log("\n[4] Computing per-segment network membership (buffer={}deg)...".format(BUF))
for r in ("pbs1", "pbs2b", "bdouble", "roadtrain"):
    roads[r] = on_network(roads, nets[r])
    log(f"  segments on {r:10}: {int(roads[r].sum()):>6} / {len(roads)}")

log("\n[5] Rolling up to road_number (a road is on a network if ANY segment is)...")
roll = roads.dropna(subset=["rn"]).groupby("rn")[["pbs1","pbs2b","bdouble","roadtrain"]].any()
log(f"  road_numbers: {len(roll)}")
for r in ("pbs1","pbs2b","bdouble","roadtrain"):
    log(f"    on {r:10}: {int(roll[r].sum()):>4} / {len(roll)} roads")

log("\n[6] Validating verdict rule against current nsw_criteria.json...")
crit = read_orig("nsw_criteria.json")
bad = 0
for k, c in crit.items():
    if verdict_of(c["cls"], opt_true(c), old_mand_pass(c)) != c["verdict"]:
        bad += 1
log(f"  reproduced {len(crit)-bad}/{len(crit)} current verdicts" + (" -- OK" if bad==0 else f" -- {bad} MISMATCH (ABORT)"))
if bad:
    log("  Verdict rule does not reproduce current data; refusing to proceed."); sys.exit(1)

log("\n[7] Re-deriving verdicts with EARNED mandatory gates "
    "(State=PBS1, Regional=19m B-double)...")
from collections import Counter
before = Counter(c["verdict"] for c in crit.values())
changed = []
new_verdicts = {}
for k, c in crit.items():
    on = roll.loc[k] if k in roll.index else None
    pbs1 = bool(on["pbs1"]) if on is not None else False
    bd   = bool(on["bdouble"]) if on is not None else False
    if c["cls"] == "State":
        mand_pass = pbs1
    else:
        mand_pass = bd
    nv = verdict_of(c["cls"], opt_true(c), mand_pass)
    new_verdicts[k] = nv
    if nv != c["verdict"]:
        changed.append((k, c["cls"], c["verdict"], nv, opt_true(c), pbs1, bd))
after = Counter(new_verdicts.values())
log(f"  before: {dict(before)}")
log(f"  after : {dict(after)}")
log(f"  roads changed: {len(changed)}")
cc = Counter((cls, o, n) for _,cls,o,n,_,_,_ in changed)
for (cls,o,n),v in sorted(cc.items()):
    log(f"    {cls:8} {o:6} -> {n:6}: {v}")
log("  examples (road, cls, old->new, optMet, pbs1, bdouble):")
for row in changed[:12]:
    log(f"    {row[0]:9} {row[1]:8} {row[2]:6}->{row[3]:6} optMet={row[4]} pbs1={row[5]} bd={row[6]}")

if not APPLY:
    log("\nDRY RUN complete -- no files written. Re-run with --apply to write.")
    sys.exit(0)

# ================================================================ WRITE STAGE
log("\n[8] Writing outputs (backups -> *.preNHVR.bak)...")

def backup(p):
    p = Path(p); bak = p.with_name(p.name + ".preNHVR.bak")
    if p.exists() and not bak.exists(): shutil.copy2(p, bak)

def write_json(relpath, obj, **kw):
    p = DATA / relpath
    backup(p)
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, **kw)
    log(f"  wrote {relpath}")

# per-road rollup lookups
RT = {k: dict(zip(roll.index, roll[k])) for k in ("pbs1","pbs2b","bdouble","roadtrain")}
def g(rn, k): return bool(RT[k].get(rn, False))

# ---- 8a. nsw_criteria.json: earned mandatory gates + verdict ----
for k, c in crit.items():
    pbs1, bd = g(k,"pbs1"), g(k,"bdouble")
    c["mand"]["pbs1"] = pbs1
    if c["cls"] != "State":
        c["mand"]["bdouble"] = bd          # Regional gate (R-04)
    c["verdict"] = new_verdicts[k]
write_json("nsw_criteria.json", crit)

# ---- 8b. nsw_recat.json: per-segment verdict (= road's new verdict) ----
old_recat = read_orig("nsw_recat.json")
seg_rn = roads["rn"].tolist()
assert len(seg_rn) == len(old_recat), "recat/master length mismatch"
new_recat = [new_verdicts.get(rn, old_recat[i]) for i, rn in enumerate(seg_rn)]
write_json("nsw_recat.json", new_recat)
log(f"     recat segments changed: {sum(a!=b for a,b in zip(old_recat,new_recat))}")

# ---- 8c. nsw_assessment.geojson: factual flags + status (geometry untouched) ----
asmt = read_orig("nsw_assessment.geojson")
pbs1_seg = roads["pbs1"].tolist(); bd_seg = roads["bdouble"].tolist(); pbs2b_seg = roads["pbs2b"].tolist()
for i, f in enumerate(asmt["features"]):
    pr = f["properties"]
    pr["has_pbs1"] = int(pbs1_seg[i]); pr["has_bdouble"] = int(bd_seg[i]); pr["has_pbs2b"] = int(pbs2b_seg[i])
    pr["status"] = new_recat[i]
write_json("nsw_assessment.geojson", asmt)

# ---- 8d. nhvr_networks.json: roadtrain + bdouble19 (keep bypass) ----
nh = read_orig("nhvr_networks.json")
for rn in roll.index:
    e = nh.get(rn, {})
    e["roadtrain"] = g(rn,"roadtrain"); e["bdouble19"] = g(rn,"bdouble")
    e.setdefault("bypass", False)
    nh[rn] = e
write_json("nhvr_networks.json", nh)

# ---- 8e. NLTN PBS 2B membership (S-06): verify against refreshed gpkg ----
# The boolean drives S-06; pbs2bCount is an opaque legacy figure whose original
# counting semantics aren't reproducible, so we only re-verify membership and
# leave nltn_meta.json untouched unless a route's membership actually flips.
log("  verifying NLTN PBS 2B membership (S-06) against refreshed gpkg...")
nltn_geo = gpd.read_file(DATA/"nltn_2020_road.geojson").set_crs("EPSG:4326", allow_override=True)
meta = read_orig("nltn_meta.json")
assert len(nltn_geo) == len(meta), "nltn meta/geo length mismatch"
nltn_buf = gpd.GeoDataFrame(geometry=nltn_geo.geometry.buffer(BUF), crs=nltn_geo.crs)
pj = gpd.sjoin(nltn_buf, nets["pbs2b"], predicate="intersects", how="inner")
on2b = set(pj.index)
# pbs2b is a per-ROUTE property: a determination route is on PBS 2B if ANY of its
# segments is (same any-segment rollup used for roads). Apply uniformly per group.
groups = defaultdict(list)
for i, m in enumerate(meta): groups[m.get("group") or f"seg{i}"].append(i)
flips = 0
for grp, idxs in groups.items():
    gon = any(i in on2b for i in idxs)
    for i in idxs:
        if bool(meta[i].get("pbs2b")) != gon:
            flips += 1; meta[i]["pbs2b"] = gon
n_true = sum(1 for m in meta if m["pbs2b"])
log(f"     routes on PBS 2B now: {n_true}/{len(meta)} segments; membership flips: {flips}")
if flips:
    write_json("nltn_meta.json", meta)
else:
    log("     (no membership change -> nltn_meta.json left as-is)")

# ---- 8f. export_rows.json: patch verdict / mandatory / HV-network fields ----
log("  patching export_rows.json...")
exp = read_orig("export_rows.json")
CAT = {"green":"Meets criteria","orange":"Likely meets (1 of 2 optional)","red":"Does not meet"}
SUM = {"green":"Meets criteria","orange":"Likely meets (1 of 2)","red":"Does not meet"}
def yn(b): return "yes" if b else "no"
def hv_text(rn): return f"B-double 19m: {yn(g(rn,'bdouble'))}\nRoad train (32m): {yn(g(rn,'roadtrain'))}\nHV bypass: {yn(bool(nh.get(rn,{}).get('bypass')))}"
def patch_lines(text, mand_pass, is_state, optMet, nv):
    out = []
    for ln in text.split("\n"):
        if "(mandatory)" in ln:                                   # Why mandatory line
            code = ln.split()[0]
            out.append(f"{code}  {'met' if mand_pass else 'not met'} (mandatory)")
        elif ln.lstrip().startswith("→"):                    # Why summary line
            out.append(f"→ {optMet} of 2 optional — {SUM[nv]}")
        elif " PBS Level 1" in ln or " 19m B-double" in ln:       # What mandatory line
            head, _, tail = ln.partition("—")
            verb = "PASS" if mand_pass else "fail"
            code = ln.split()[0]
            out.append(f"{code}  {verb} —{tail}")
        else:
            out.append(ln)
    return "\n".join(out)

for sect in ("state", "regional"):
    for row in exp[sect]:
        rn = str(row.get("Road ID","")).strip()
        if rn not in crit: continue
        is_state = (sect == "state")
        optMet = opt_true(crit[rn])
        mand_pass = g(rn,"pbs1") if is_state else g(rn,"bdouble")
        nv = new_verdicts[rn]
        row["_v"] = nv
        row["Categorisation"] = CAT[nv]
        row["Why"] = patch_lines(row["Why"], mand_pass, is_state, optMet, nv)
        row["What (criteria tested)"] = patch_lines(row["What (criteria tested)"], mand_pass, is_state, optMet, nv)
        row["HV Networks (NHVR)"] = hv_text(rn)
# natsig: refresh S-06 (PBS 2B) line only; national grade is connectivity-based (unchanged)
for row in exp["natsig"]:
    rn = str(row.get("Road ID","")).strip()
    p2 = g(rn,"pbs2b")
    def fix_s06(text):
        out=[]
        for ln in text.split("\n"):
            if ln.strip().startswith("S-06"):
                if "—" in ln:  # What line
                    out.append(f"S-06  {'PASS' if p2 else 'fail'} — PBS Level 2B")
                else:               # Why line
                    out.append(f"S-06  PBS 2B {'approved' if p2 else 'not approved'}")
            else: out.append(ln)
        return "\n".join(out)
    row["Why"] = fix_s06(row["Why"]); row["What (criteria tested)"] = fix_s06(row["What (criteria tested)"])
write_json("export_rows.json", exp)

# ---- 8g. nsw_stats.json (legacy NSW summary by admin_class) ----
seg_status = new_recat
admin = [f["properties"].get("admin_class") for f in asmt["features"]]
def cnt(cls, v): return sum(1 for i in range(len(admin)) if admin[i]==cls and seg_status[i]==v)
nsw_stats = {
    "total_roads": len(asmt["features"]),
    "green": seg_status.count("green"), "orange": seg_status.count("orange"), "red": seg_status.count("red"),
    "by_category": {
        "State Road": {"total": admin.count("S"), "green": cnt("S","green"), "orange": cnt("S","orange"), "red": cnt("S","red")},
        "Regional Road": {"total": admin.count("R"), "green": cnt("R","green"), "orange": cnt("R","orange"), "red": cnt("R","red")},
    },
}
write_json("nsw_stats.json", nsw_stats, indent=2)

# ---- 8h. Clarence Valley assessment (geometry untouched; flags + verdict) ----
log("  recomputing Clarence Valley assessment...")
cvf = DATA/"clarence_valley_assessment.geojson"
cv = read_orig("clarence_valley_assessment.geojson")
cvg = gpd.read_file(orig_path("clarence_valley_assessment.geojson")).set_crs("EPSG:4326", allow_override=True)
for r in ("pbs1","pbs2b","bdouble"):
    cvg[r] = on_network(cvg, nets[r])
cv_before = sum(int(f["properties"].get("meets_criteria",0)) for f in cv["features"])
for i, f in enumerate(cv["features"]):
    pr = f["properties"]
    pbs1, pbs2b, bd = bool(cvg["pbs1"].iloc[i]), bool(cvg["pbs2b"].iloc[i]), bool(cvg["bdouble"].iloc[i])
    pr["has_pbs1"], pr["has_pbs2b"], pr["has_bdouble"] = int(pbs1), int(pbs2b), int(bd)
    is_state = (pr.get("assessed_category") == "State Road") or (pr.get("admin_class") == "S")
    mand = pbs1 if is_state else bd
    score = int(pr.get("criteria_score", 0))
    pr["mandatory_pass"] = int(mand)
    pr["meets_criteria"] = int(score >= 2 and mand)
    pr["mandatory_status"] = ("S-09: PBS Level 1 " if is_state else "R-04: B-double access ") + ("✓" if mand else "✗")
write_json("clarence_valley_assessment.geojson", cv)
cv_after = sum(int(f["properties"]["meets_criteria"]) for f in cv["features"])
log(f"     CV roads meeting criteria: {cv_before} -> {cv_after} / {len(cv['features'])}")

# summary_stats.json (CV) — patch numeric fields, keep lga/zone
ss = read_orig("summary_stats.json")
total = len(cv["features"])
ss["total_roads"] = total
ss["roads_meeting_criteria"] = cv_after
ss["roads_not_meeting"] = total - cv_after
ss["accuracy_pct"] = round(cv_after / total * 100, 1) if total else 0
def cv_cat(cat):
    sub = [f["properties"] for f in cv["features"] if f["properties"].get("assessed_category") == cat]
    m = sum(p["meets_criteria"] for p in sub)
    return {"total": len(sub), "meeting": m, "not_meeting": len(sub)-m,
            "accuracy_pct": round(m/len(sub)*100,1) if sub else 0}
ss["by_category"] = {"State Road": cv_cat("State Road"), "Regional Road": cv_cat("Regional Road")}
cb = ss.get("criteria_breakdown", {})
cb["with_pbs1"]    = sum(int(f["properties"]["has_pbs1"]) for f in cv["features"])
cb["with_pbs2b"]   = sum(int(f["properties"]["has_pbs2b"]) for f in cv["features"])
cb["with_bdouble"] = sum(int(f["properties"]["has_bdouble"]) for f in cv["features"])
ss["criteria_breakdown"] = cb
write_json("summary_stats.json", ss, indent=2)

log("\n[done] NSW + Clarence Valley data rebuilt from NHVR GeoPackages.")

