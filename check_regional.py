import json

crit = json.load(open(r"c:\Users\leonh\Road_Recategorise\dashboard\data\nsw_criteria.json"))

# Count regional roads and their verdicts
reg = {k: v for k, v in crit.items() if v.get("cls") == "Regional"}
print(f"Regional roads in criteria: {len(reg)}")
print(f"  green: {sum(1 for v in reg.values() if v['verdict'] == 'green')}")
print(f"  orange: {sum(1 for v in reg.values() if v['verdict'] == 'orange')}")
print(f"  red: {sum(1 for v in reg.values() if v['verdict'] == 'red')}")

# Check why reds fail
reds = {k: v for k, v in reg.items() if v["verdict"] == "red"}
no_bdouble = sum(1 for v in reds.values() if not v["mand"].get("bdouble"))
no_centres = sum(1 for v in reds.values() if not v["opt"].get("centres"))
no_dest = sum(1 for v in reds.values() if not v["opt"].get("dest"))
zero_opt = sum(1 for v in reds.values() if v["optMet"] == 0)

print(f"\nRed regionals ({len(reds)} roads):")
print(f"  Fails B-double (R-04): {no_bdouble}")
print(f"  No centre connectivity (R-01): {no_centres}")
print(f"  No facility connectivity (R-02): {no_dest}")
print(f"  0 optional criteria met: {zero_opt}")

# Check oranges too
oranges = {k: v for k, v in reg.items() if v["verdict"] == "orange"}
print(f"\nOrange regionals ({len(oranges)} roads):")
print(f"  Has B-double: {sum(1 for v in oranges.values() if v['mand'].get('bdouble'))}")
print(f"  optMet=1: {sum(1 for v in oranges.values() if v['optMet'] == 1)}")
print(f"  Centres pass: {sum(1 for v in oranges.values() if v['opt'].get('centres'))}")
print(f"  Dest pass: {sum(1 for v in oranges.values() if v['opt'].get('dest'))}")
