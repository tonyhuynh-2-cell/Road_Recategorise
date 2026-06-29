// grading.js — criteria→colour styling and lens membership (nswStyle / cvStyle / nswInView / natStatusOf).

// Style functions
// The NSW map is one layer shown through three lenses (tabs): 'nsr' (Nationally Significant
// State roads, graded by national criteria), 'state' (all State roads, State criteria),
// 'regional' (Regional roads, Regional criteria). Each road is coloured by the verdict for the
// active lens; roads outside the active lens are hidden.
// National grade for an NSR road = how many of {on NLTN, connects ≥2 centres, connects port/
// airport/intermodal} it meets. The NLTN part uses the SAME _nsr the lens filters on, so the
// filter and the grade can never disagree (an NSR road always meets ≥1 → never red).
function natStatusOf(k, nsr) {
    const nc = window.NSW_CRIT && window.NSW_CRIT[k] && window.NSW_CRIT[k].natCrit;
    const met = (nsr ? 1 : 0) + (nc && nc.metros ? 1 : 0) + (nc && nc.portair ? 1 : 0);
    return met >= 2 ? 'green' : met >= 1 ? 'orange' : 'red';
}

function nswInView(p) {
    if (nswView === 'all') return p.admin_class === 'S' || p.admin_class === 'R';
    if (nswView === 'nsr') return p.admin_class === 'S' && p._nsr;
    if (nswView === 'state') return p.admin_class === 'S' && !p._nsr;   // nationally significant get their own tab
    if (nswView === 'regional') return p.admin_class === 'R';
    return true;
}

const HIDDEN_STYLE = { stroke: false, opacity: 0, weight: 0 };

function nswStyle(feature) {
    const p = feature.properties;
    // setStyle() MERGES options, so `stroke` must be set explicitly in BOTH branches — otherwise a
    // road hidden in one lens (stroke:false) keeps stroke:false when it returns to view and vanishes.
    if (!nswInView(p)) return HIDDEN_STYLE;   // hidden in this lens
    // Nationally significant roads grade by the national verdict (_natStatus) — in their own lens AND
    // in the Overview, matching the group breakdown. State/Regional lenses use the category verdict.
    const useNat = (nswView === 'nsr') || (nswView === 'all' && p.admin_class === 'S' && p._nsr);
    const v = useNat ? (p._natStatus || 'red') : (p._roadStatus || p.status);
    if (!legendToggles[v]) return HIDDEN_STYLE;                       // verdict colour toggled off
    if (isDashed(p) && !legendToggles.dashed) return HIDDEN_STYLE;    // route-numbered roads toggled off
    return { stroke: true, color: ROAD_COLORS[v] || '#a8a29e', weight: p._w || 2, opacity: v === 'red' ? 0.85 : 1, lineCap: 'round', lineJoin: 'round', dashArray: isDashed(p) ? '8 6' : null };
}

function cvStyle(feature) {
    const p = feature.properties;
    const meets = (p._roadMeets !== undefined) ? p._roadMeets : p.meets_criteria;
    const v = meets ? 'green' : 'red';
    if (!legendToggles[v]) return HIDDEN_STYLE;
    if (isDashed(p) && !legendToggles.dashed) return HIDDEN_STYLE;
    return { stroke: true, color: meets ? '#16a34a' : '#dc2626', weight: meets ? 3.2 : 2.4, opacity: 1, lineCap: 'round', lineJoin: 'round', dashArray: isDashed(p) ? '8 6' : null };
}

// Green national-network style, per feature. This is the official NLTN 2020 determination shown as
// a faint REFERENCE underlay (on every NSW tab) — it does NOT set any road's grade; the graded
// roads draw on top. Proposed corridors (not yet built) render translucent + dashed.
function nltnFeatureStyle(feature) {
    const s = { color: '#3cb043', weight: 5, opacity: 0.5, lineCap: 'round', lineJoin: 'round', dashArray: null };
    const street = (feature && feature.properties && feature.properties.street) || '';
    if (/proposed/i.test(street)) { s.opacity = 0.22; s.dashArray = '5 6'; }
    return s;
}
