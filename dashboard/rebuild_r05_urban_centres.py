# -*- coding: utf-8 -*-
"""
R-05 re-scope: urban Regional centres connectivity must be *earned*.
====================================================================
R-05 reads "Connects Metropolitan Centres, Major Urban Centres and Major Towns
to each other" — connecting centres TO EACH OTHER needs at least two of them.
The legacy test passed opt.centres if the road touched a single qualifying
centre (usually just the Sydney Significant Urban Area), which over-credits
metropolitan Regional roads.

Rule applied here (urban Regional roads only — cls == 'Regional' AND
area == 'urban' in data/nsw_criteria.json):

  qualifying centres = the road's data/nsw_evidence.json centres[] entries with
      type in {'Significant Urban Area', 'Regional City', 'Major Town'}
      ('Town Centre' does NOT qualify), de-duplicated by name;
  new opt.centres    = (number of distinct qualifying names >= 2);
  EXCEPTION          - if the road's evidence centres list is empty or missing,
      opt.centres is left UNCHANGED (a data gap must not masquerade as a fail);
      such roads are counted and reported.

Then optMet = count of opt.* values === true, and the standard Regional verdict
rule (validated below to reproduce 100% of current verdicts before anything is
written): red if mand.bdouble is false, else green if optMet >= 2, orange if
optMet == 1, else red.

Cascade kept consistent (same precedent as rebuild_from_nhvr.py):
  nsw_criteria.json  - centres / optMet / verdict for changed roads
  nsw_recat.json     - per-segment verdict array (parallel to
                       nsw_assessment.geojson feature order, keyed by the
                       segment's road_number) -> changed roads' new verdict
  export_rows.json   - regional-tab cells for changed roads: the 'R-05 met/not
                       met (centres)' Why line, the '-> N of 2 optional' summary
                       line, the 'R-05 PASS/fail - connects centres' What line,
                       Categorisation and _v
  nsw_stats.json     - NOT touched: written only by the offline pipeline
                       (process_nsw.py / rebuild_from_nhvr.py), consumed by no
                       dashboard JS/HTML.
  summary_stats.json - NOT touched (Clarence Valley pilot).

Each written file is first backed up to <name>.preR05.bak (originals win on
re-runs: inputs are read from the .preR05.bak when present, so the script is
idempotent). State roads and rural Regional roads are never modified.

Run with --apply to write; default is a dry run (validate + impact matrix).
"""
import json
import shutil
import sys
from collections import Counter
from pathlib import Path

APPLY = "--apply" in sys.argv
DATA = Path(__file__).resolve().parent / "data"
QUALIFYING = {"Significant Urban Area", "Regional City", "Major Town"}
BAK = ".preR05.bak"


def log(*a):
    print(*a, flush=True)


def orig_path(name):
    """Pristine original: the *.preR05.bak if a prior run made one, else the live file."""
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    return bak if bak.exists() else p


def read_orig(name):
    return json.load(open(orig_path(name), encoding="utf-8"))


def write_json(name, obj):
    """Back up the live file to *.preR05.bak (first run only), then write single-line
    JSON exactly like the existing files (ensure_ascii=False, default separators)."""
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    if not bak.exists():
        shutil.copyfile(p, bak)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {bak.name})")


def verdict_of(c, opt_met):
    return ("red" if c["mand"].get("bdouble") is False
            else "green" if opt_met >= 2 else "orange" if opt_met == 1 else "red")


# ---------------------------------------------------------------- load
crit = read_orig("nsw_criteria.json")
evid = read_orig("nsw_evidence.json")

# ---------------------------------------------------------------- validation gate
# The verdict rule above must reproduce EVERY current Regional verdict from the
# current booleans before we recompute anything. Abort otherwise.
regional = {k: c for k, c in crit.items() if c["cls"] == "Regional"}
bad = [k for k, c in regional.items()
       if sum(1 for v in c["opt"].values() if v is True) != c["optMet"]
       or verdict_of(c, c["optMet"]) != c["verdict"]]
if bad:
    log(f"VALIDATION GATE FAILED — {len(bad)} Regional roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(regional)}/{len(regional)} current Regional verdicts")

# ---------------------------------------------------------------- recompute
changed = {}          # rn -> (new_centres, new_optMet, new_verdict)
empty_evidence = []   # urban Regional roads skipped for lack of centres evidence
urban_regional = 0
for rn, c in crit.items():
    if c["cls"] != "Regional" or c["area"] != "urban":
        continue
    urban_regional += 1
    centres = (evid.get(rn) or {}).get("centres") or []
    if not centres:
        empty_evidence.append(rn)
        continue
    names = {e["name"] for e in centres if e.get("type") in QUALIFYING}
    new_centres = len(names) >= 2
    if new_centres == c["opt"]["centres"]:
        continue
    new_opt_met = sum(1 for k2, v in c["opt"].items()
                      if (new_centres if k2 == "centres" else v) is True)
    changed[rn] = (new_centres, new_opt_met, verdict_of(c, new_opt_met))

# ---------------------------------------------------------------- impact matrix
flips = Counter((crit[rn]["opt"]["centres"], nc) for rn, (nc, _, _) in changed.items())
trans = Counter((crit[rn]["verdict"], nv) for rn, (_, _, nv) in changed.items())
def split(pred):
    old = Counter(c["verdict"] for k, c in crit.items() if pred(c))
    new = Counter(changed[k][2] if k in changed else c["verdict"]
                  for k, c in crit.items() if pred(c))
    return old, new
all_old, all_new = split(lambda c: True)
reg_old, reg_new = split(lambda c: c["cls"] == "Regional")
gv_old = sum(1 for c in regional.values() if c["verdict"] == "red" and c["optMet"] >= 2)
gv_new = sum(1 for k, c in regional.items()
             if (changed[k][2] if k in changed else c["verdict"]) == "red"
             and (changed[k][1] if k in changed else c["optMet"]) >= 2)
fmt = lambda ctr: f"{ctr['green']}/{ctr['orange']}/{ctr['red']} (g/o/r)"
log(f"urban Regional roads: {urban_regional}; empty/missing centres evidence (left unchanged): {len(empty_evidence)}")
log(f"opt.centres flips: true->false {flips[(True, False)]}, false->true {flips[(False, True)]}")
log("verdict transitions: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(trans.items())) or "none"))
log(f"named-road split (892): {fmt(all_old)} -> {fmt(all_new)}")
log(f"Regional-only split:    {fmt(reg_old)} -> {fmt(reg_new)}")
log(f"gate-veto stat (Regional red with optMet>=2): {gv_old} -> {gv_new}")

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
# Per-segment verdict array consumed by js/init.js (f.properties._roadStatus =
# recat[i] || ...), parallel to nsw_assessment.geojson feature order.
recat = read_orig("nsw_recat.json")
asmt = json.load(open(DATA / "nsw_assessment.geojson", encoding="utf-8"))  # read-only
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
for row in exp["regional"]:
    rn = str(row.get("Road ID", "")).strip()
    if rn not in changed:
        continue
    nc, om, nv = changed[rn]
    why, what = [], []
    for ln in row["Why"].split("\n"):
        if ln.startswith("R-05") and "(centres)" in ln:
            why.append(f"R-05  {'met' if nc else 'not met'} (centres)")
        elif ln.lstrip().startswith("→"):
            why.append(f"→ {om} of 2 optional — {SUM[nv]}")
        else:
            why.append(ln)
    for ln in row["What (criteria tested)"].split("\n"):
        if ln.startswith("R-05") and "connects centres" in ln:
            head, _, tail = ln.partition("—")
            what.append(f"R-05  {'PASS' if nc else 'fail'} —{tail}")
        else:
            what.append(ln)
    new_why, new_what = "\n".join(why), "\n".join(what)
    assert new_why != row["Why"], f"no Why centres/summary line matched for {rn}"
    row["Why"], row["What (criteria tested)"] = new_why, new_what
    row["Categorisation"], row["_v"] = CAT[nv], nv
    rows_changed += 1
assert rows_changed == len(changed), (rows_changed, len(changed))
# changed roads are Regional-tab only; make sure they never leak into other tabs
for tab in ("natsig", "state"):
    assert not any(str(r.get("Road ID", "")).strip() in changed for r in exp[tab]), tab
write_json("export_rows.json", exp)
log(f"  export regional rows changed: {rows_changed}")

log("done.")
