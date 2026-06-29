// grading.js — criteria→colour styling and lens membership (nswStyle / cvStyle / nswInView).

// Style functions
// The NSW road layer is shown through lenses (tabs): 'state' (all State roads, State criteria),
// 'regional' (Regional roads, Regional criteria), 'all' (Overview, both). Each road is coloured by
// its category verdict; roads outside the active lens are hidden. The 'nsr' (Nationally Significant)
// lens hides the road overlay entirely — its subject is the NLTN network layer (see nltnFeatureStyle).
function nswInView(p) {
    if (nswView === 'all') return p.admin_class === 'S' || p.admin_class === 'R';
    if (nswView === 'nsr') return false;                    // Nat. Significant lens shows the NLTN network, not the road overlay
    if (nswView === 'state') return p.admin_class === 'S';  // ALL State roads (incl. those on the NLTN, e.g. A33)
    if (nswView === 'regional') return p.admin_class === 'R';
    return true;
}

const HIDDEN_STYLE = { stroke: false, opacity: 0, weight: 0 };

function nswStyle(feature) {
    const p = feature.properties;
    // setStyle() MERGES options, so `stroke` must be set explicitly in BOTH branches — otherwise a
    // road hidden in one lens (stroke:false) keeps stroke:false when it returns to view and vanishes.
    if (!nswInView(p)) return HIDDEN_STYLE;   // hidden in this lens
    // Every road grades by its own category criteria (State / Regional). National significance is a
    // property of the NLTN network (its own lens + green layer), not a re-grade of the road overlay.
    const v = p._roadStatus || p.status;
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

// NLTN 2020 network style, per feature — the SUBJECT of the Nationally Significant lens. Each line
// is coloured by its national-criteria grade (_natCat, precomputed): green = nationally significant
// (on the network + connects centres or a port/airport); orange = on the network only. Honours the
// green/orange legend toggles. Proposed corridors render translucent (still solid → clickable).
function nltnFeatureStyle(feature) {
    const p = (feature && feature.properties) || {};
    const v = p._natCat || 'orange';
    if (!legendToggles[v]) return HIDDEN_STYLE;          // green/orange verdict toggled off
    const s = { stroke: true, color: ROAD_COLORS[v] || '#16a34a', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', dashArray: null };
    if (p._proposed) s.opacity = 0.45;
    return s;
}
