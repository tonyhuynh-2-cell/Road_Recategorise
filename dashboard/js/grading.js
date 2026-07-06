// grading.js — criteria→colour styling and lens membership (nswStyle / cvStyle / nswInView).

// Style functions
// The NSW road layer is shown through lenses (tabs): 'state' (all State roads, State criteria),
// 'regional' (Regional roads, Regional criteria), 'all' (Overview, both). Each road is coloured by
// its category verdict; roads outside the active lens are hidden. The 'nsr' (Nationally Significant)
// lens hides the road overlay entirely — its subject is the NLTN network layer (see nltnFeatureStyle).
function nswInView(p) {
    // The CV tab is the Overview, geographically focused on the Clarence Valley LGA (+ its outline).
    // The 'clip' toggle swaps the full road overlay for a copy clipped to the LGA polygon (so nothing
    // leaks past the outline) — handled by the layer swap in applyLegend, not here.
    // CV and Sydney tabs show the full State + Regional network (they add a region outline on top).
    if (currentTab === 'cv' || currentTab === 'sydney') return p.admin_class === 'S' || p.admin_class === 'R';
    // Flagged tab (and a Road Detail opened from it): ONLY the user-pinned roads — a pure UI filter
    // over the same overlay. Verdicts, criteria and every other tab's counts are untouched (flagged.js).
    if (inFlaggedScope()) return (p.admin_class === 'S' || p.admin_class === 'R') && isRoadFlagged(roadKeyOf(p));
    // Local tab shows ONLY the green council roads — the S/R overlay is removed entirely (see applyLegend).
    if (currentTab === 'local') return false;
    // Overview: show EVERY State + Regional road. Nationally significant routes get the green/orange
    // NLTN network drawn ON TOP (see applyLegend), so M5 etc. read as nationally significant — WITHOUT
    // hiding any road. (Hiding by _nsr deleted State roads the drawn NLTN layer doesn't cover, e.g. A44
    // Northern Rd: _nsr comes from the nsw_nltn spatial join, which is a different set from the drawn
    // nltn_2020_road layer.)
    if (nswView === 'all') return p.admin_class === 'S' || p.admin_class === 'R';
    // Nat. Significant lens: its subject is the NLTN national network layer (see nltnFeatureStyle /
    // applyLegend), NOT the road overlay. Route-numbered roads (A/B/M prefixes) are State roads and are
    // shown on the State + Overview tabs — they are not moved onto this tab.
    if (nswView === 'nsr') return false;
    // State lens = State roads NOT on the national network. Nationally significant State roads (_nsr —
    // M1, M4, M5, M8, Hume, etc.) live on the Nat. Significant tab, not here. Route-numbered roads that
    // are NOT nat-sig (e.g. A44, excluded via NSR_EXCLUDE) are ordinary State roads and stay here.
    if (nswView === 'state') return p.admin_class === 'S' && !p._nsr;
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
    let v = p._roadStatus || p.status;
    // Cross-criteria toggle (State / Regional tabs only): re-grade this road AGAINST the other category.
    // State tab → grade as Regional (asReg); Regional tab → grade as State (asState). See buildXtest().
    if (currentTab === 'state' && xLens.state) { const x = buildXtest()[roadKeyOf(p)]; if (x) v = x.asReg; }
    else if (currentTab === 'regional' && xLens.regional) { const x = buildXtest()[roadKeyOf(p)]; if (x) v = x.asState; }
    if (!legendToggles[v]) return HIDDEN_STYLE;                       // verdict colour toggled off
    if (isDashed(p) && !legendToggles.dashed) return HIDDEN_STYLE;    // route-numbered roads toggled off
    // Flagged view: the pins keep their normal verdict colour, one weight bolder for focus.
    return { stroke: true, color: ROAD_COLORS[v] || '#a8a29e', weight: (p._w || 2) + (inFlaggedScope() ? 1 : 0), opacity: v === 'red' ? 0.85 : 1, lineCap: 'round', lineJoin: 'round', dashArray: isDashed(p) ? '8 6' : null };
}

function cvStyle(feature) {
    const p = feature.properties;
    const meets = (p._roadMeets !== undefined) ? p._roadMeets : p.meets_criteria;
    const v = meets ? 'green' : 'red';
    if (!legendToggles[v]) return HIDDEN_STYLE;
    if (isDashed(p) && !legendToggles.dashed) return HIDDEN_STYLE;
    // Same visual treatment as nswStyle (length-based weight, '8 6' dash, round caps) so a road looks
    // identical on the CV tab and the main map — only the colour source differs (pass/fail vs verdict).
    return { stroke: true, color: meets ? '#16a34a' : '#dc2626', weight: p._w || 2, opacity: meets ? 1 : 0.85, lineCap: 'round', lineJoin: 'round', dashArray: isDashed(p) ? '8 6' : null };
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

// --- Cross-criteria (reclassification) test ---
// Re-grade a road against the OTHER category's criteria. The optional connectivity criteria (opt) are
// shared; only the mandatory gate swaps — State needs PBS-1 access, Regional needs 19m B-double access.
// Verdict rule is the same everywhere: fail mandatory → red; else ≥2 optional → green, 1 → orange, 0 → red.
function xverdict(optMet, mandPass) { return !mandPass ? 'red' : optMet >= 2 ? 'green' : optMet === 1 ? 'orange' : 'red'; }

function buildXtest() {
    if (window.XTEST) return window.XTEST;
    const X = {}, crit = window.NSW_CRIT || {}, nhvr = window.NHVR || {};
    for (const k in crit) {
        const c = crit[k]; if (!c || !c.opt) continue;
        const optMet = Object.keys(c.opt).reduce((n, key) => n + (c.opt[key] === true ? 1 : 0), 0);
        const pbs1 = !!(c.mand && c.mand.pbs1 === true);        // PBS-1 access (State mandatory gate)
        const bd = !!(nhvr[k] && nhvr[k].bdouble19 === true);   // 19m B-double access (Regional gate)
        X[k] = { cls: c.cls, optMet: optMet, asState: xverdict(optMet, pbs1), asReg: xverdict(optMet, bd), real: c.verdict };
    }
    window.XTEST = X;
    return X;
}
