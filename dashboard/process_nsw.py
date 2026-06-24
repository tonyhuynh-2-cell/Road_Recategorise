"""
NSW-Wide Road Recategorisation Assessment (without ADT)
=======================================================
Assesses all NSW roads against criteria that can be tested without ADT data.
Roads that pass all available criteria are marked orange (would pass if ADT met).
"""

import json
import geopandas as gpd
import pandas as pd
import numpy as np
from pathlib import Path

BASE = Path("/Users/tony/Desktop/Road Recatergorise")
POI = BASE / "POI"
NHVR = BASE / "NHVR GeoPackages"
OUTPUT = BASE / "dashboard" / "data"
OUTPUT.mkdir(exist_ok=True)

print("=" * 60)
print("NSW-WIDE CRITERIA ASSESSMENT (no ADT)")
print("=" * 60)

# ============================================================
# Load full NSW road network
# ============================================================
print("\n[1/5] Loading NSW road network...")
roads = gpd.read_file(BASE / "nsw_road_network_categorisation.geojson")
roads = roads.set_crs("EPSG:4326")
print(f"  Total roads: {len(roads)}")
print(f"  State (S): {(roads['admin_class'] == 'S').sum()}")
print(f"  Regional (R): {(roads['admin_class'] == 'R').sum()}")


# ============================================================
# Load PBS networks (check mandatory criteria)
# ============================================================
print("\n[2/5] Loading PBS/NHVR data...")

pbs1 = gpd.read_file(NHVR / "PBS_Level_1.gpkg", layer="hvn_road_segments")
pbs1 = pbs1[pbs1["access_code"].str.contains("Approved", case=False, na=False)]

pbs2b = gpd.read_file(NHVR / "PBS_2B.gpkg", layer="hvn_road_segments")
pbs2b = pbs2b[pbs2b["access_code"].str.contains("Approved", case=False, na=False)]

bdouble = gpd.read_file(NHVR / "GML_CML_19m_BDouble.gpkg", layer="hvn_road_segments")
bdouble = bdouble[bdouble["access_code"].str.contains("Approved", case=False, na=False)]

print(f"  PBS1: {len(pbs1)}, PBS2B: {len(pbs2b)}, B-double: {len(bdouble)}")

# Build spatial index unions for faster intersection
print("  Building spatial indexes...")
pbs1_union = pbs1.buffer(0.0005).union_all()
pbs2b_union = pbs2b.buffer(0.0005).union_all()
bdouble_union = bdouble.buffer(0.0005).union_all()

print("  Checking road access...")
roads["has_pbs1"] = roads.intersects(pbs1_union)
roads["has_pbs2b"] = roads.intersects(pbs2b_union)
roads["has_bdouble"] = roads.intersects(bdouble_union)

print(f"  Roads with PBS1: {roads['has_pbs1'].sum()}")
print(f"  Roads with PBS2B: {roads['has_pbs2b'].sum()}")
print(f"  Roads with B-double: {roads['has_bdouble'].sum()}")


# ============================================================
# Load key freight routes
# ============================================================
print("\n[3/5] Loading key freight routes...")

kfr = gpd.read_file(POI / "Key_Freight_Routes_NSW.geojson")
if len(kfr) > 0:
    kfr_union = kfr.buffer(0.001).union_all()
    roads["is_key_freight_route"] = roads.intersects(kfr_union)
else:
    roads["is_key_freight_route"] = False
print(f"  Roads on key freight network: {roads['is_key_freight_route'].sum()}")


# ============================================================
# Load POIs for connectivity (simplified for NSW-wide)
# ============================================================
print("\n[4/5] Loading POIs for connectivity...")

# Load towns with population
ucl = gpd.read_file(POI / "UCL" / "UCL_2021_AUST_GDA2020.shp")
ucl_pop = pd.read_csv(POI / "Census_Population" / "2021Census_G01_NSW_UCL.csv")
ucl["UCL_CODE_2021"] = "UCL" + ucl["UCL_CODE21"].astype(str)
ucl_pop["UCL_CODE_2021"] = ucl_pop["UCL_CODE_2021"].astype(str)
ucl = ucl.merge(ucl_pop[["UCL_CODE_2021", "Tot_P_P"]], on="UCL_CODE_2021", how="left")
ucl = ucl[ucl["STE_CODE21"] == "1"].to_crs("EPSG:4326")  # NSW only
ucl = ucl[ucl["Tot_P_P"].notna() & (ucl["Tot_P_P"] >= 2000)]  # Towns 2000+

# Classify
ucl["town_type"] = "Town Centre"
ucl.loc[ucl["Tot_P_P"] >= 20000, "town_type"] = "Regional City"
ucl.loc[(ucl["Tot_P_P"] >= 7000) & (ucl["Tot_P_P"] < 20000), "town_type"] = "Major Town"

# Exclude the "Remainder" catch-all UCL
ucl = ucl[~ucl["UCL_NAME21"].str.contains("Remainder", case=False, na=False)]

print(f"  Towns loaded: {len(ucl)}")
print(f"    Regional Cities: {(ucl['town_type'] == 'Regional City').sum()}")
print(f"    Major Towns: {(ucl['town_type'] == 'Major Town').sum()}")
print(f"    Town Centres: {(ucl['town_type'] == 'Town Centre').sum()}")

# Check connectivity using buffered town centroids
towns_union = ucl.geometry.centroid.buffer(0.02).union_all()  # ~2km buffer
major_towns_union = ucl[ucl["Tot_P_P"] >= 7000].geometry.centroid.buffer(0.02).union_all()

roads["connects_town"] = roads.intersects(towns_union)
roads["connects_major_town"] = roads.intersects(major_towns_union)

# Hospitals and key destinations
hospitals = gpd.read_file(POI / "Major_Hospitals_NSW.geojson")
destinations = gpd.read_file(POI / "Key_Destinations_Ports_Intermodals_Airports.geojson")

hosp_union = hospitals.geometry.buffer(0.01).union_all()
dest_union = destinations.geometry.buffer(0.02).union_all()

roads["connects_hospital"] = roads.intersects(hosp_union)
roads["connects_destination"] = roads.intersects(dest_union)

print(f"  Roads near towns: {roads['connects_town'].sum()}")
print(f"  Roads near major towns+: {roads['connects_major_town'].sum()}")
print(f"  Roads near hospitals: {roads['connects_hospital'].sum()}")
print(f"  Roads near key destinations: {roads['connects_destination'].sum()}")


# ============================================================
# Assess criteria (without ADT - mark as "would pass if ADT met")
# ============================================================
print("\n[5/5] Assessing criteria (no ADT)...")

def assess_state_nsw(row):
    """State Road criteria excluding ADT."""
    optional_met = 0
    details = []
    
    # Connectivity criteria
    if row["connects_major_town"] or row["is_key_freight_route"]:
        optional_met += 1
        details.append("Connects major towns/cities or on freight network")
    
    if row["connects_hospital"] or row["connects_destination"]:
        optional_met += 1
        details.append("Connects hospitals/ports/airports")
    
    if row["is_key_freight_route"]:
        optional_met += 1
        details.append("On National Land Transport Network")
    
    # Mandatory: PBS Level 1
    mandatory_pass = bool(row["has_pbs1"])
    
    # Would pass if ADT also met (needs 2 optional + mandatory)
    passes_without_adt = optional_met >= 2 and mandatory_pass
    might_pass_with_adt = optional_met >= 1 and mandatory_pass  # ADT could be the 2nd criterion
    
    return passes_without_adt, might_pass_with_adt, mandatory_pass, details


def assess_regional_nsw(row):
    """Regional Road criteria excluding ADT."""
    optional_met = 0
    details = []
    
    if row["connects_town"]:
        optional_met += 1
        details.append("Connects town centres")
    
    if row["connects_hospital"] or row["connects_destination"]:
        optional_met += 1
        details.append("Connects facilities to towns")
    
    # Mandatory: B-double
    mandatory_pass = bool(row["has_bdouble"])
    
    passes_without_adt = optional_met >= 2 and mandatory_pass
    might_pass_with_adt = optional_met >= 1 and mandatory_pass
    
    return passes_without_adt, might_pass_with_adt, mandatory_pass, details


# Apply to all roads
status_list = []  # "green", "orange", "red"
for idx, row in roads.iterrows():
    if row["admin_class"] == "S":
        passes, might_pass, mandatory, details = assess_state_nsw(row)
    else:
        passes, might_pass, mandatory, details = assess_regional_nsw(row)
    
    if passes:
        status_list.append("green")  # Meets criteria even without ADT
    elif might_pass:
        status_list.append("orange")  # Would meet if ADT threshold met
    else:
        status_list.append("red")  # Fails regardless of ADT

roads["status"] = status_list

green = (roads["status"] == "green").sum()
orange = (roads["status"] == "orange").sum()
red = (roads["status"] == "red").sum()

print(f"\n  === NSW-WIDE RESULTS ===")
print(f"  Green (meets criteria): {green} ({green/len(roads)*100:.1f}%)")
print(f"  Orange (would pass if ADT met): {orange} ({orange/len(roads)*100:.1f}%)")
print(f"  Red (fails criteria): {red} ({red/len(roads)*100:.1f}%)")

# By category
for cat, label in [("S", "State Road"), ("R", "Regional Road")]:
    subset = roads[roads["admin_class"] == cat]
    g = (subset["status"] == "green").sum()
    o = (subset["status"] == "orange").sum()
    r = (subset["status"] == "red").sum()
    print(f"  {label}: Green={g}, Orange={o}, Red={r}")

# ============================================================
# Export simplified GeoJSON (reduce file size for web)
# ============================================================
print("\n  Exporting NSW data...")

export = roads[["geometry", "road_name", "road_number", "admin_class", "status",
               "has_pbs1", "has_bdouble", "is_key_freight_route",
               "connects_major_town", "connects_hospital"]].copy()

# Convert bools to int
for col in export.select_dtypes(include="bool").columns:
    export[col] = export[col].astype(int)

# Simplify geometry to reduce file size
export["geometry"] = export["geometry"].simplify(0.001)

export.to_file(OUTPUT / "nsw_assessment.geojson", driver="GeoJSON")
print(f"  Saved: nsw_assessment.geojson ({len(export)} features)")

# Save NSW summary stats
nsw_stats = {
    "total_roads": int(len(roads)),
    "green": int(green),
    "orange": int(orange),
    "red": int(red),
    "by_category": {
        "State Road": {
            "total": int((roads["admin_class"] == "S").sum()),
            "green": int(((roads["admin_class"] == "S") & (roads["status"] == "green")).sum()),
            "orange": int(((roads["admin_class"] == "S") & (roads["status"] == "orange")).sum()),
            "red": int(((roads["admin_class"] == "S") & (roads["status"] == "red")).sum()),
        },
        "Regional Road": {
            "total": int((roads["admin_class"] == "R").sum()),
            "green": int(((roads["admin_class"] == "R") & (roads["status"] == "green")).sum()),
            "orange": int(((roads["admin_class"] == "R") & (roads["status"] == "orange")).sum()),
            "red": int(((roads["admin_class"] == "R") & (roads["status"] == "red")).sum()),
        }
    }
}

with open(OUTPUT / "nsw_stats.json", "w") as f:
    json.dump(nsw_stats, f, indent=2)
print(f"  Saved: nsw_stats.json")

# Export towns for overlay
towns_export = ucl[["UCL_NAME21", "Tot_P_P", "town_type", "geometry"]].copy()
towns_export = towns_export.rename(columns={"UCL_NAME21": "name", "Tot_P_P": "population"})
towns_export["geometry"] = towns_export.geometry.centroid
towns_export.to_file(OUTPUT / "nsw_towns.geojson", driver="GeoJSON")
print(f"  Saved: nsw_towns.geojson ({len(towns_export)} towns)")

print("\n" + "=" * 60)
print("NSW PROCESSING COMPLETE")
print("=" * 60)
