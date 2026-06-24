"""
Road Recategorisation Criteria Assessment Engine
================================================
Processes all available data to evaluate whether each road segment in
Clarence Valley LGA meets the criteria for its assigned category.

Outputs a GeoJSON file for the dashboard with pass/fail results.
"""

import json
import geopandas as gpd
import pandas as pd
import numpy as np
from shapely.geometry import shape, Point
from pathlib import Path
import ssl
import urllib.request

# Paths
BASE = Path("/Users/tony/Desktop/Road Recatergorise")
POI = BASE / "POI"
NHVR = BASE / "NHVR GeoPackages"
OUTPUT = BASE / "dashboard" / "data"
OUTPUT.mkdir(exist_ok=True)

print("=" * 60)
print("ROAD RECATEGORISATION CRITERIA ASSESSMENT")
print("Focus: Clarence Valley LGA")
print("=" * 60)


# ============================================================
# STEP 1: Load road network and filter to Clarence Valley LGA
# ============================================================
print("\n[1/7] Loading road network and LGA boundary...")

# Load road network
roads = gpd.read_file(BASE / "nsw_road_network_categorisation.geojson")
roads = roads.set_crs("EPSG:4326")

# Load LGA boundaries and get Clarence Valley
lga = gpd.read_file(POI / "LGA" / "LGA_2024_AUST_GDA2020.shp")
lga_name_col = [c for c in lga.columns if "NAME" in c.upper()][0]
clarence = lga[lga[lga_name_col].str.contains("Clarence Valley", case=False, na=False)]
if len(clarence) == 0:
    clarence = lga[lga[lga_name_col].str.contains("Clarence", case=False, na=False)]
print(f"  LGA found: {clarence[lga_name_col].values[0]}")

# Get roads that pass through Clarence Valley (not just clipped to boundary)
clarence_proj = clarence.to_crs("EPSG:4326")
cv_roads_clipped = gpd.clip(roads, clarence_proj)

# Find unique road numbers/names that pass through CV
cv_road_numbers = set(cv_roads_clipped["road_number"].dropna().unique())
cv_road_names = set(cv_roads_clipped["road_name"].dropna().unique())

# Get the FULL extent of those roads (beyond LGA boundary) for connectivity
cv_roads_extended = roads[
    roads["road_number"].isin(cv_road_numbers) | 
    roads["road_name"].isin(cv_road_names)
].copy()

# Mark which segments are inside CV vs extended
cv_roads_extended["in_lga"] = cv_roads_extended.intersects(clarence_proj.union_all())

# Use extended roads for assessment
cv_roads = cv_roads_extended.copy()
print(f"  Roads through Clarence Valley (extended): {len(cv_roads)}")
print(f"    Inside LGA: {cv_roads['in_lga'].sum()}")
print(f"    Extended beyond LGA: {(~cv_roads['in_lga']).sum()}")
print(f"    State Roads (S): {(cv_roads['admin_class'] == 'S').sum()}")
print(f"    Regional Roads (R): {(cv_roads['admin_class'] == 'R').sum()}")


# ============================================================
# STEP 2: Load traffic data and join to road segments
# ============================================================
print("\n[2/7] Loading ADT traffic data...")

traffic = pd.read_excel(BASE / "Traffic Counts Master File.xlsx")
traffic["AADT"] = pd.to_numeric(traffic["AADT"], errors="coerce")
traffic["%HV"] = pd.to_numeric(traffic["%HV"], errors="coerce")
traffic["Latitude"] = pd.to_numeric(traffic["Latitude"], errors="coerce")
traffic["Longitude"] = pd.to_numeric(traffic["Longitude"], errors="coerce")

# Filter to records with valid coords and AADT
traffic_valid = traffic[
    traffic["Latitude"].notna() & 
    traffic["Longitude"].notna() & 
    traffic["AADT"].notna()
].copy()
print(f"  Traffic records with coords + AADT: {len(traffic_valid)}")

# Get the most recent count per road number (use latest date)
traffic_valid["Date Start"] = pd.to_datetime(traffic_valid["Date Start"], errors="coerce")
traffic_latest = (
    traffic_valid
    .sort_values("Date Start", ascending=False)
    .groupby("Road Number", as_index=False)
    .first()
)
print(f"  Unique roads with traffic data: {len(traffic_latest)}")

# Create GeoDataFrame of traffic points
traffic_gdf = gpd.GeoDataFrame(
    traffic_latest,
    geometry=gpd.points_from_xy(traffic_latest["Longitude"], traffic_latest["Latitude"]),
    crs="EPSG:4326"
)

# Spatial join: find nearest traffic count for each road segment
# Buffer roads slightly and join traffic points
cv_roads_buf = cv_roads.copy()
cv_roads_buf["road_idx"] = cv_roads_buf.index
# Use sjoin_nearest to match traffic to roads
try:
    joined = gpd.sjoin_nearest(cv_roads_buf, traffic_gdf, how="left", max_distance=0.005)
    # Take first match per road segment
    joined = joined.drop_duplicates(subset="road_idx")
    cv_roads["adt"] = joined.set_index("road_idx")["AADT"].values
    cv_roads["hv_pct"] = joined.set_index("road_idx")["%HV"].values
except Exception as e:
    print(f"  Warning: spatial join failed ({e}), trying road number match...")
    # Fallback: match by road number
    traffic_by_road = traffic_latest.set_index("Road Number")[["AADT", "%HV"]]
    cv_roads["adt"] = cv_roads["road_number"].map(
        traffic_by_road["AADT"].to_dict()
    )
    cv_roads["hv_pct"] = cv_roads["road_number"].map(
        traffic_by_road["%HV"].to_dict()
    )

roads_with_adt = cv_roads["adt"].notna().sum()
print(f"  Roads matched with ADT data: {roads_with_adt}/{len(cv_roads)}")


# ============================================================
# STEP 3: Load PBS/NHVR network data
# ============================================================
print("\n[3/7] Loading PBS/NHVR vehicle access data...")

# PBS Level 1 (State Roads mandatory)
pbs1 = gpd.read_file(NHVR / "PBS_Level_1.gpkg", layer="hvn_road_segments")
pbs1 = pbs1[pbs1["access_code"].str.contains("Approved", case=False, na=False)]

# PBS Level 2B (Nationally Significant State Roads mandatory)  
pbs2b = gpd.read_file(NHVR / "PBS_2B.gpkg", layer="hvn_road_segments")
pbs2b = pbs2b[pbs2b["access_code"].str.contains("Approved", case=False, na=False)]

# GML/CML 19m B-double (Regional Roads mandatory)
bdouble = gpd.read_file(NHVR / "GML_CML_19m_BDouble.gpkg", layer="hvn_road_segments")
bdouble = bdouble[bdouble["access_code"].str.contains("Approved", case=False, na=False)]

print(f"  PBS Level 1 approved segments: {len(pbs1)}")
print(f"  PBS Level 2B approved segments: {len(pbs2b)}")
print(f"  B-double approved segments: {len(bdouble)}")

# Clip to Clarence Valley area (with buffer for edge matching)
cv_bounds = clarence_proj.buffer(0.01).total_bounds  # slight buffer
bbox = tuple(cv_bounds)

pbs1_cv = pbs1.cx[bbox[0]:bbox[2], bbox[1]:bbox[3]]
pbs2b_cv = pbs2b.cx[bbox[0]:bbox[2], bbox[1]:bbox[3]]
bdouble_cv = bdouble.cx[bbox[0]:bbox[2], bbox[1]:bbox[3]]

print(f"  PBS1 in Clarence Valley area: {len(pbs1_cv)}")
print(f"  PBS2B in Clarence Valley area: {len(pbs2b_cv)}")
print(f"  B-double in Clarence Valley area: {len(bdouble_cv)}")

# Check each road segment against PBS networks (buffer intersection)
cv_roads["has_pbs1"] = False
cv_roads["has_pbs2b"] = False
cv_roads["has_bdouble"] = False

if len(pbs1_cv) > 0:
    pbs1_union = pbs1_cv.buffer(0.0005).union_all()
    cv_roads["has_pbs1"] = cv_roads.intersects(pbs1_union)

if len(pbs2b_cv) > 0:
    pbs2b_union = pbs2b_cv.buffer(0.0005).union_all()
    cv_roads["has_pbs2b"] = cv_roads.intersects(pbs2b_union)

if len(bdouble_cv) > 0:
    bdouble_union = bdouble_cv.buffer(0.0005).union_all()
    cv_roads["has_bdouble"] = cv_roads.intersects(bdouble_union)

print(f"  Roads with PBS1 access: {cv_roads['has_pbs1'].sum()}")
print(f"  Roads with PBS2B access: {cv_roads['has_pbs2b'].sum()}")
print(f"  Roads with B-double access: {cv_roads['has_bdouble'].sum()}")


# ============================================================
# STEP 4: Load key freight routes (NLTN)
# ============================================================
print("\n[4/7] Loading key freight routes...")

kfr = gpd.read_file(POI / "Key_Freight_Routes_NSW.geojson")
kfr_cv = gpd.clip(kfr, clarence_proj)
print(f"  Key freight route segments in CV: {len(kfr_cv)}")

if len(kfr_cv) > 0:
    kfr_union = kfr_cv.buffer(0.001).union_all()
    cv_roads["is_key_freight_route"] = cv_roads.intersects(kfr_union)
else:
    cv_roads["is_key_freight_route"] = False

print(f"  Roads on key freight network: {cv_roads['is_key_freight_route'].sum()}")


# ============================================================
# STEP 5: Load POI data (towns, hospitals, ports, airports)
# ============================================================
print("\n[5/7] Loading points of interest...")

# Load UCL with population
ucl = gpd.read_file(POI / "UCL" / "UCL_2021_AUST_GDA2020.shp")
ucl_pop = pd.read_csv(POI / "Census_Population" / "2021Census_G01_NSW_UCL.csv")
ucl["UCL_CODE_2021"] = "UCL" + ucl["UCL_CODE21"].astype(str)
ucl_pop["UCL_CODE_2021"] = ucl_pop["UCL_CODE_2021"].astype(str)
ucl = ucl.merge(ucl_pop[["UCL_CODE_2021", "Tot_P_P"]], on="UCL_CODE_2021", how="left")
ucl = ucl.to_crs("EPSG:4326")

# Filter to Clarence Valley area
# Filter to NSW UCLs first, then get towns near the EXTENDED road network
ucl = ucl[ucl["STE_CODE21"] == "1"]  # NSW state code

# Get the bounding box of all extended roads (not just CV)
roads_bounds = cv_roads.total_bounds  # [minx, miny, maxx, maxy]
from shapely.geometry import box
roads_bbox = box(roads_bounds[0] - 0.1, roads_bounds[1] - 0.1, 
                 roads_bounds[2] + 0.1, roads_bounds[3] + 0.1)

# Clip UCLs to the extended roads area
ucl_cv = ucl[ucl.intersects(roads_bbox)]
ucl_cv = ucl_cv[ucl_cv["Tot_P_P"].notna()]
print(f"  UCLs in/near Clarence Valley: {len(ucl_cv)}")

# Classify towns by criteria (Regional zone thresholds)
ucl_cv["town_type"] = "Other"
ucl_cv.loc[ucl_cv["Tot_P_P"] >= 20000, "town_type"] = "Regional City"
ucl_cv.loc[(ucl_cv["Tot_P_P"] >= 7000) & (ucl_cv["Tot_P_P"] < 20000), "town_type"] = "Major Town"
ucl_cv.loc[(ucl_cv["Tot_P_P"] >= 2000) & (ucl_cv["Tot_P_P"] < 7000), "town_type"] = "Town Centre"

ucl_name_col = [c for c in ucl_cv.columns if "NAME" in c.upper() and "UCL" in c.upper()][0]
print("  Town classifications:")
for tt in ["Regional City", "Major Town", "Town Centre"]:
    towns = ucl_cv[ucl_cv["town_type"] == tt]
    if len(towns) > 0:
        print(f"    {tt}: {', '.join(towns[ucl_name_col].tolist())}")

# Load hospitals, airports, ports
hospitals = gpd.read_file(POI / "Major_Hospitals_NSW.geojson")
destinations = gpd.read_file(POI / "Key_Destinations_Ports_Intermodals_Airports.geojson")

# Check connectivity - does the ROUTE (whole road) connect to classified towns?
# Group by road_number and check if ANY segment of that road is near a qualifying town
# This implements the "bottleneck" principle: if endpoints qualify, whole route passes

# First build route-level connectivity
route_connects_regional_city = {}
route_connects_major_town = {}
route_connects_town_centre = {}

for road_num in cv_roads["road_number"].unique():
    road_segments = cv_roads[cv_roads["road_number"] == road_num]
    connects_rc = False
    connects_mt = False
    connects_tc = False
    for _, seg in road_segments.iterrows():
        for _, town in ucl_cv.iterrows():
            if seg.geometry.distance(town.geometry) < 0.01:  # ~1km
                if town["town_type"] == "Regional City":
                    connects_rc = True
                if town["town_type"] == "Major Town":
                    connects_mt = True
                if town["town_type"] == "Town Centre":
                    connects_tc = True
    route_connects_regional_city[road_num] = connects_rc
    route_connects_major_town[road_num] = connects_mt
    route_connects_town_centre[road_num] = connects_tc

# Apply route-level connectivity to all segments of that road
cv_roads["connects_regional_city"] = cv_roads["road_number"].map(
    lambda x: route_connects_regional_city.get(x, False)
)
cv_roads["connects_major_town"] = cv_roads["road_number"].map(
    lambda x: route_connects_major_town.get(x, False)
)
cv_roads["connects_town_centre"] = cv_roads["road_number"].map(
    lambda x: route_connects_town_centre.get(x, False)
)

# Check hospital/airport connectivity at ROUTE level
route_connects_hospital = {}
route_connects_airport = {}

for road_num in cv_roads["road_number"].unique():
    road_segments = cv_roads[cv_roads["road_number"] == road_num]
    road_union = road_segments.geometry.union_all()
    
    near_hosp = any(road_union.distance(h) < 0.02 for h in hospitals.geometry)
    near_dest = any(road_union.distance(d) < 0.05 for d in destinations.geometry)
    
    route_connects_hospital[road_num] = near_hosp
    route_connects_airport[road_num] = near_dest

cv_roads["connects_hospital"] = cv_roads["road_number"].map(
    lambda x: route_connects_hospital.get(x, False)
)
cv_roads["connects_airport"] = cv_roads["road_number"].map(
    lambda x: route_connects_airport.get(x, False)
)

print(f"  Roads connecting Regional Cities: {cv_roads['connects_regional_city'].sum()}")
print(f"  Roads connecting Major Towns: {cv_roads['connects_major_town'].sum()}")
print(f"  Roads connecting Town Centres: {cv_roads['connects_town_centre'].sum()}")
print(f"  Roads connecting hospitals: {cv_roads['connects_hospital'].sum()}")


# ============================================================
# STEP 6: Apply criteria and determine pass/fail
# ============================================================
print("\n[6/7] Applying recategorisation criteria...")

# Clarence Valley is in REGIONAL zone
ZONE = "Regional"

# --- STATE ROAD CRITERIA (Remote and Regional Areas) ---
# Must meet at least 2 of:
#   - Connects Metro Centres, Regional Cities, Major Towns, Major Urban Centres (S-07)
#   - Connects from Metro/Regional City/Major Town to Town Centres on long route
#   - Meets traffic thresholds (Urban >10000, Rural >7000 for Regional zone)
#   - Connects hospitals/ports/airports/employment centres to other centres (S-08)
#   - Heavy vehicle bypass
# Mandatory:
#   - No load limits (assume true - data unavailable)
#   - Does not parallel existing State Road within 20km (assume true)
#   - PBS Level 1 access (S-09)

def assess_state_road(row):
    criteria_met = []
    criteria_failed = []
    
    # Criterion: Connectivity (S-07)
    if row.get("connects_regional_city") or row.get("connects_major_town"):
        criteria_met.append("S-07: Connects Regional Cities/Major Towns")
    else:
        criteria_failed.append("S-07: Connects Regional Cities/Major Towns")
    
    # Criterion: Traffic thresholds
    adt = row.get("adt")
    hv = row.get("hv_pct")
    if pd.notna(adt):
        # Regional zone: Urban >10000, Rural >7000
        if adt > 7000:
            criteria_met.append(f"Traffic: ADT {adt:.0f} > 7000 threshold")
        else:
            criteria_failed.append(f"Traffic: ADT {adt:.0f} < 7000 threshold")
    else:
        criteria_failed.append("Traffic: No ADT data available")
    
    # HV percentage (>8% for State)
    if pd.notna(hv) and hv > 8:
        criteria_met.append(f"HV: {hv:.1f}% > 8% threshold")
    elif pd.notna(hv):
        criteria_failed.append(f"HV: {hv:.1f}% < 8% threshold")
    
    # Criterion: Connects key facilities (S-08)
    if row.get("connects_hospital") or row.get("connects_airport"):
        criteria_met.append("S-08: Connects hospitals/airports")
    else:
        criteria_failed.append("S-08: Does not connect hospitals/airports")
    
    # Criterion: Key freight route
    if row.get("is_key_freight_route"):
        criteria_met.append("NLTN: On key freight network")
    
    # MANDATORY: PBS Level 1
    mandatory_pass = True
    mandatory_detail = []
    if row.get("has_pbs1"):
        mandatory_detail.append("S-09: PBS Level 1 ✓")
    else:
        mandatory_pass = False
        mandatory_detail.append("S-09: PBS Level 1 ✗")
    
    # Assessment: needs 2+ criteria AND all mandatory
    meets_criteria = len(criteria_met) >= 2 and mandatory_pass
    
    return {
        "meets_category": meets_criteria,
        "criteria_met": criteria_met,
        "criteria_failed": criteria_failed,
        "mandatory": mandatory_detail,
        "mandatory_pass": mandatory_pass,
        "score": len(criteria_met),
    }


# --- REGIONAL ROAD CRITERIA (Remote and Regional Areas) ---
# Must meet at least 2 of:
#   - Connects at least two State Roads (boost freight productivity)
#   - Connects Urban/Town Centres to each other (R-01)
#   - Meets traffic thresholds (Urban >7000, Rural >2000 for Regional zone)
#   - Connects facilities to Town/Urban Centres (R-02)
#   - Emergency evacuation / resilience route
#   - Road train network (R-03)
# Mandatory:
#   - No load limits (assume true)
#   - GML & CML 19m B-double access (R-04)

def assess_regional_road(row):
    criteria_met = []
    criteria_failed = []
    
    # Criterion: Connects town centres (R-01)
    if row.get("connects_town_centre") or row.get("connects_major_town"):
        criteria_met.append("R-01: Connects Town/Urban Centres")
    else:
        criteria_failed.append("R-01: Does not connect Town/Urban Centres")
    
    # Criterion: Traffic thresholds
    adt = row.get("adt")
    hv = row.get("hv_pct")
    if pd.notna(adt):
        # Regional zone: Urban >7000, Rural >2000
        if adt > 2000:
            criteria_met.append(f"Traffic: ADT {adt:.0f} > 2000 threshold")
        else:
            criteria_failed.append(f"Traffic: ADT {adt:.0f} < 2000 threshold")
    else:
        criteria_failed.append("Traffic: No ADT data available")
    
    # HV percentage (>6% for Regional)
    if pd.notna(hv) and hv > 6:
        criteria_met.append(f"HV: {hv:.1f}% > 6% threshold")
    elif pd.notna(hv):
        criteria_failed.append(f"HV: {hv:.1f}% < 6% threshold")
    
    # Criterion: Connects facilities (R-02)
    if row.get("connects_hospital") or row.get("connects_airport"):
        criteria_met.append("R-02: Connects hospitals/airports to centres")
    else:
        criteria_failed.append("R-02: Does not connect facilities")
    
    # MANDATORY: B-double access (R-04)
    mandatory_pass = True
    mandatory_detail = []
    if row.get("has_bdouble"):
        mandatory_detail.append("R-04: B-double access ✓")
    else:
        mandatory_pass = False
        mandatory_detail.append("R-04: B-double access ✗")
    
    meets_criteria = len(criteria_met) >= 2 and mandatory_pass
    
    return {
        "meets_category": meets_criteria,
        "criteria_met": criteria_met,
        "criteria_failed": criteria_failed,
        "mandatory": mandatory_detail,
        "mandatory_pass": mandatory_pass,
        "score": len(criteria_met),
    }


# Apply assessment to each road
results = []
for idx, row in cv_roads.iterrows():
    if row["admin_class"] == "S":
        assessment = assess_state_road(row)
        assessment["category"] = "State Road"
    else:
        assessment = assess_regional_road(row)
        assessment["category"] = "Regional Road"
    
    results.append(assessment)

cv_roads["meets_criteria"] = [r["meets_category"] for r in results]
cv_roads["criteria_met"] = ["; ".join(r["criteria_met"]) for r in results]
cv_roads["criteria_failed"] = ["; ".join(r["criteria_failed"]) for r in results]
cv_roads["mandatory_status"] = ["; ".join(r["mandatory"]) for r in results]
cv_roads["mandatory_pass"] = [r["mandatory_pass"] for r in results]
cv_roads["criteria_score"] = [r["score"] for r in results]
cv_roads["assessed_category"] = [r["category"] for r in results]

# Summary
total = len(cv_roads)
passing = cv_roads["meets_criteria"].sum()
print(f"\n  === RESULTS ===")
print(f"  Total roads assessed: {total}")
print(f"  Roads MEETING criteria (green): {passing} ({passing/total*100:.1f}%)")
print(f"  Roads NOT meeting criteria (red): {total-passing} ({(total-passing)/total*100:.1f}%)")
print(f"\n  By category:")
for cat in ["State Road", "Regional Road"]:
    subset = cv_roads[cv_roads["assessed_category"] == cat]
    cat_pass = subset["meets_criteria"].sum()
    print(f"    {cat}: {cat_pass}/{len(subset)} meet criteria ({cat_pass/len(subset)*100:.1f}%)")


# ============================================================
# STEP 7: Export GeoJSON for dashboard
# ============================================================
print("\n[7/7] Exporting dashboard data...")

# Prepare output GeoJSON with relevant properties
output_cols = [
    "geometry", "road_name", "road_number", "admin_class", "link_length",
    "adt", "hv_pct", "has_pbs1", "has_pbs2b", "has_bdouble",
    "is_key_freight_route", "connects_regional_city", "connects_major_town",
    "connects_town_centre", "connects_hospital", "connects_airport",
    "meets_criteria", "criteria_met", "criteria_failed",
    "mandatory_status", "mandatory_pass", "criteria_score", "assessed_category"
]

export = cv_roads[[c for c in output_cols if c in cv_roads.columns]].copy()

# Convert booleans to int for JSON compatibility
bool_cols = [c for c in export.columns if export[c].dtype == bool]
for col in bool_cols:
    export[col] = export[col].astype(int)

# Save main assessment GeoJSON
export.to_file(OUTPUT / "clarence_valley_assessment.geojson", driver="GeoJSON")
print(f"  Saved: {OUTPUT / 'clarence_valley_assessment.geojson'}")

# Save summary statistics as JSON
stats = {
    "lga": "Clarence Valley",
    "zone": ZONE,
    "total_roads": int(total),
    "roads_meeting_criteria": int(passing),
    "roads_not_meeting": int(total - passing),
    "accuracy_pct": round(passing / total * 100, 1),
    "by_category": {},
    "criteria_breakdown": {
        "with_adt_data": int(cv_roads["adt"].notna().sum()),
        "with_hv_data": int(cv_roads["hv_pct"].notna().sum()),
        "with_pbs1": int(cv_roads["has_pbs1"].sum()),
        "with_pbs2b": int(cv_roads["has_pbs2b"].sum()),
        "with_bdouble": int(cv_roads["has_bdouble"].sum()),
        "on_freight_network": int(cv_roads["is_key_freight_route"].sum()),
    }
}

for cat in ["State Road", "Regional Road"]:
    subset = cv_roads[cv_roads["assessed_category"] == cat]
    cat_pass = int(subset["meets_criteria"].sum())
    stats["by_category"][cat] = {
        "total": int(len(subset)),
        "meeting": cat_pass,
        "not_meeting": int(len(subset) - cat_pass),
        "accuracy_pct": round(cat_pass / len(subset) * 100, 1) if len(subset) > 0 else 0
    }

with open(OUTPUT / "summary_stats.json", "w") as f:
    json.dump(stats, f, indent=2)
print(f"  Saved: {OUTPUT / 'summary_stats.json'}")

# Also save POI data for dashboard overlay
# Towns
if len(ucl_cv) > 0:
    ucl_name_col2 = [c for c in ucl_cv.columns if "NAME" in c.upper() and "UCL" in c.upper()][0]
    towns_export = ucl_cv[ucl_cv["town_type"] != "Other"][[ucl_name_col2, "Tot_P_P", "town_type", "geometry"]].copy()
    towns_export = towns_export.rename(columns={ucl_name_col2: "name", "Tot_P_P": "population"})
    # Use centroids instead of polygons for map display
    towns_export["geometry"] = towns_export.geometry.centroid
    towns_export.to_file(OUTPUT / "towns_cv.geojson", driver="GeoJSON")
    print(f"  Saved: towns_cv.geojson ({len(towns_export)} towns)")

# LGA boundary
clarence_proj.to_file(OUTPUT / "clarence_valley_boundary.geojson", driver="GeoJSON")
print(f"  Saved: clarence_valley_boundary.geojson")

print("\n" + "=" * 60)
print("PROCESSING COMPLETE")
print("=" * 60)
