// grading.js — criteria→colour styling and lens membership (nswStyle / cvStyle / nswInView).

// --- Criteria overrides ---
// When active, force specific criteria to pass for ALL roads, recomputing verdicts in real time.
var criteriaOverrides = {};

function openOverridesPanel() {
    var modal = document.getElementById('overrides-modal');
    if (!modal) return;
    if (!modal.hidden) { closeOverridesPanel(); return; }
    modal.hidden = false;
    var btn = document.getElementById('overrides-btn');
    if (btn) btn.classList.add('criteria-btn-active');
}
function closeOverridesPanel() {
    var modal = document.getElementById('overrides-modal');
    if (modal) modal.hidden = true;
    var btn = document.getElementById('overrides-btn');
    if (btn) btn.classList.remove('criteria-btn-active');
}
function resetCriteriaOverrides() {
    document.querySelectorAll('#overrides-modal input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
    // Reset sliders to defaults
    var defaults = { 'ov-bdouble-pct': 80, 'ov-adt-state': 10000, 'ov-adt-regional': 7000, 'ov-town-pop': 2000, 'ov-major-pop': 7000, 'ov-emp-urban': 40, 'ov-emp-regional': 15, 'ov-emp-remote': 5 };
    for (var id in defaults) {
        var el = document.getElementById(id);
        if (el) { el.value = defaults[id]; updateSliderLabel(el); }
    }
    // Restore original verdicts
    var crit = window.NSW_CRIT || {};
    var orig = window._ORIG_VERDICTS || {};
    for (var k in orig) {
        if (crit[k]) crit[k].verdict = orig[k];
    }
    applyCriteriaOverrides();
}

// Slider label formatter
function updateSliderLabel(el) {
    var val = Number(el.value);
    var labelEl = document.getElementById(el.id + '-val');
    if (!labelEl) return;
    if (el.id === 'ov-bdouble-pct') labelEl.textContent = val + '%';
    else if (el.id.indexOf('ov-emp') === 0) labelEl.textContent = val + ' ha';
    else labelEl.textContent = val.toLocaleString();
}

// Debounced apply — prevents lag while dragging sliders
var _overrideTimer = null;
function applyCriteriaOverridesDebounced() {
    if (_overrideTimer) clearTimeout(_overrideTimer);
    _overrideTimer = setTimeout(applyCriteriaOverrides, 80);
}
function applyCriteriaOverrides() {
    criteriaOverrides = {
        pbs1: !!document.getElementById('ov-pbs1').checked,
        bdouble: !!document.getElementById('ov-bdouble').checked,
        parallel: !!document.getElementById('ov-parallel').checked,
        traffic: !!document.getElementById('ov-traffic').checked,
        centres: !!document.getElementById('ov-centres').checked,
        dest: !!document.getElementById('ov-dest').checked,
        hv: !!document.getElementById('ov-hv').checked,
        ldr: !!document.getElementById('ov-ldr').checked,
        twostate: !!document.getElementById('ov-twostate').checked
    };
    // Read slider values
    var bdEl = document.getElementById('ov-bdouble-pct');
    var adtSEl = document.getElementById('ov-adt-state');
    var adtREl = document.getElementById('ov-adt-regional');
    var tpEl = document.getElementById('ov-town-pop');
    var mpEl = document.getElementById('ov-major-pop');
    window._overrideSliders = {
        bdoublePct: bdEl ? Number(bdEl.value) : 80,
        adtState: adtSEl ? Number(adtSEl.value) : 10000,
        adtRegional: adtREl ? Number(adtREl.value) : 7000,
        townPop: tpEl ? Number(tpEl.value) : 2000,
        majorPop: mpEl ? Number(mpEl.value) : 7000
    };
    // Recompute verdicts in NSW_CRIT so sidebar stats pick them up
    var crit = window.NSW_CRIT || {};
    var counts = { green: 0, orange: 0, red: 0 };
    for (var k in crit) {
        var c = crit[k];
        if (c.cls !== 'State' && c.cls !== 'Regional') continue;
        var v = computeOverriddenVerdict(c, k);
        c.verdict = v;
        counts[v] = (counts[v] || 0) + 1;
    }
    // Update _roadStatus on map features
    if (typeof nswLayer !== 'undefined' && nswLayer) {
        nswLayer.eachLayer(function(layer) {
            var p = layer.feature && layer.feature.properties;
            if (!p || (p.admin_class !== 'S' && p.admin_class !== 'R')) return;
            var ck = roadKeyOf(p);
            var cr = crit[ck];
            if (cr) p._roadStatus = cr.verdict;
        });
        nswLayer.setStyle(nswStyle);
    }
    // Invalidate cached cross-test / fresh / scope counts
    window.XTEST = null;
    window.FRESH = null;
    // Clear scope counts cache so sidebar refreshes with new verdicts
    var sc = window._scopeCountsRef;
    if (sc) { for (var key in sc) delete sc[key]; }
    // Refresh the active sidebar panel
    if (typeof currentTab !== 'undefined') {
        if (currentTab === 'overview' && typeof refreshOverview === 'function') refreshOverview();
        else if (currentTab === 'fresh' && typeof refreshFresh === 'function') refreshFresh();
        else if ((currentTab === 'state' || currentTab === 'regional' || currentTab === 'nsr') && typeof refreshNswView === 'function') refreshNswView();
        else if (currentTab === 'cv' && typeof refreshCV === 'function') refreshCV();
        else if (currentTab === 'sydney' && typeof refreshSydney === 'function') refreshSydney();
    }
    // Show impact summary
    var total = counts.green + counts.orange + counts.red;
    var el = document.getElementById('overrides-impact');
    if (el && total) {
        el.innerHTML = '<strong>Impact:</strong> ' +
            '<span style="color:#16a34a">' + counts.green + ' green (' + Math.round(counts.green/total*100) + '%)</span> · ' +
            '<span style="color:#f59e0b">' + counts.orange + ' orange (' + Math.round(counts.orange/total*100) + '%)</span> · ' +
            '<span style="color:#dc2626">' + counts.red + ' red (' + Math.round(counts.red/total*100) + '%)</span>';
    }
}

function computeOverriddenVerdict(c, roadKey) {
    var isState = c.cls === 'State';
    var sliders = window._overrideSliders || {};

    // Mandatory gates
    var mandPass = true;
    if (isState) {
        var pbs1 = criteriaOverrides.pbs1 || (c.mand && c.mand.pbs1 !== false);
        var parallel = criteriaOverrides.parallel || (c.mand && c.mand.parallel !== false);
        mandPass = pbs1 && parallel;
    } else {
        // B-double: use slider threshold against actual coverage
        var bdThreshold = (sliders.bdoublePct != null) ? sliders.bdoublePct / 100 : 0.8;
        var nhvrData = (window.NHVR || {})[roadKey] || {};
        var bdCov = nhvrData.bdouble_coverage;
        var bd;
        if (criteriaOverrides.bdouble) {
            bd = true;
        } else if (bdCov != null) {
            bd = bdCov >= bdThreshold;
        } else {
            bd = c.mand && c.mand.bdouble !== false;
        }
        mandPass = bd;
    }

    // Optional criteria count
    var opt = c.opt || {};
    var optMet = 0;

    // Centres: re-evaluate with population slider
    if (criteriaOverrides.centres || opt.centres === true) {
        // Check if population slider changes the result
        if (criteriaOverrides.centres) {
            optMet++;
        } else if (sliders.townPop !== 2000 || sliders.majorPop !== 7000) {
            // Re-filter centres from evidence
            var evid = (window.NSW_EVID || {})[roadKey] || {};
            var centres = evid.centres || [];
            var qualifying = centres.filter(function(ctr) {
                var pop = ctr.population || 0;
                if (ctr.kind === 'sua') return true; // SUAs always qualify
                if (pop >= (sliders.majorPop || 7000)) return true; // Major Town+
                if (pop >= (sliders.townPop || 2000)) return !isState || c.area === 'urban'; // Town Centre (not for rural State)
                return false;
            });
            var distinctNames = {};
            qualifying.forEach(function(ctr) { distinctNames[ctr.name] = 1; });
            if (Object.keys(distinctNames).length >= 2) optMet++;
        } else {
            optMet++;
        }
    } else if (sliders.townPop < 2000 || sliders.majorPop < 7000) {
        // Lower thresholds might make previously-failing roads pass
        var evid2 = (window.NSW_EVID || {})[roadKey] || {};
        var centres2 = evid2.centres || [];
        var qualifying2 = centres2.filter(function(ctr) {
            var pop = ctr.population || 0;
            if (ctr.kind === 'sua') return true;
            if (pop >= (sliders.majorPop || 7000)) return true;
            if (pop >= (sliders.townPop || 2000)) return !isState || c.area === 'urban';
            return false;
        });
        var distinctNames2 = {};
        qualifying2.forEach(function(ctr) { distinctNames2[ctr.name] = 1; });
        if (Object.keys(distinctNames2).length >= 2) optMet++;
    }

    // Facilities/employment
    if (criteriaOverrides.dest || opt.dest === true) optMet++;

    // Traffic: use AADT slider
    if (criteriaOverrides.traffic || opt.traffic === true) {
        optMet++;
    } else if (sliders.adtState || sliders.adtRegional) {
        var adtData = (window.ADT || {})[roadKey];
        if (adtData && adtData.adt != null) {
            var threshold = isState ? (sliders.adtState || 10000) : (sliders.adtRegional || 7000);
            if (adtData.adt >= threshold) optMet++;
        }
    }

    // Road train (Regional only)
    if (!isState) {
        if (criteriaOverrides.hv || opt.hv === true) optMet++;
        if (criteriaOverrides.twostate || opt.two_state === true) optMet++;
    } else {
        if (criteriaOverrides.ldr || opt.ldr === true) optMet++;
    }

    // Verdict
    if (!mandPass) return 'red';
    if (optMet >= 2) return 'green';
    if (optMet === 1) return 'orange';
    return 'red';
}

// --- Orange sub-filter ---
// Classifies each orange road by which single optional criterion it passes.
// Used by the legend's "Why orange?" toggle group to highlight/dim subsets.
// Returns: 'centres' | 'facilities' | 'other' | null (not orange or no criteria data).
function orangeReason(roadKey) {
    const c = (window.NSW_CRIT || {})[roadKey];
    if (!c || c.verdict !== 'orange') return null;
    const opt = c.opt || {};
    if (opt.centres === true) return 'centres';
    if (opt.dest === true) return 'facilities';
    // hv (road train), two_state, ldr — all grouped as 'other'
    if (opt.hv === true || opt.two_state === true || opt.ldr === true) return 'other';
    return null;
}

// Active orange sub-filter: null = show all orange equally (default),
// 'centres' | 'facilities' | 'other' = highlight that subset, dim the rest.
let orangeSubFilter = null;

function setOrangeSubFilter(value) {
    orangeSubFilter = (value === orangeSubFilter) ? null : value;   // toggle off if same
    // Re-style the map
    if (nswLayer) nswLayer.setStyle(nswStyle);
    if (cvClipLayer && map.hasLayer(cvClipLayer)) cvClipLayer.setStyle(nswStyle);
    renderMapLegend();   // update the toggle button active states
}

// Style functions
// The NSW road layer is shown through lenses (tabs): 'state' (all State roads, State criteria),
// 'regional' (Regional roads, Regional criteria), 'all' (Overview, both). Each road is coloured by
// its category verdict; roads outside the active lens are hidden. The 'nsr' (Nationally Significant)
// lens hides the road overlay entirely — its subject is the NLTN network layer (see nltnFeatureStyle).
function nswInView(p) {
    // The CV / Sydney tabs are an LGA FOCUS, not a lens: the category dropdown (nswView) keeps
    // filtering the roads while the LGA supplies the frame, the outline and the region stats — the
    // two dropdowns are orthogonal. The 'clip' toggle swaps the full road overlay for a copy clipped
    // to the LGA polygon (handled by the layer swap in applyLegend, not here); the clipped copy
    // styles through this same function, so the lens filter applies to it too.
    if (currentTab === 'cv' || currentTab === 'sydney') {
        if (nswView === 'state') return p.admin_class === 'S' && !p._nsr;
        if (nswView === 'regional') return p.admin_class === 'R';
        // Nat. Significant / Local lenses: their subjects are OTHER layers (the NLTN network layer /
        // the council-road machinery on the Local tab) — the S/R overlay hides (see applyLegend).
        if (nswView === 'nsr' || nswView === 'local') return false;
        return p.admin_class === 'S' || p.admin_class === 'R';   // Overview + Fresh: every candidate
    }
    // Flagged tab (and a Road Detail opened from it): ONLY the user-pinned roads — a pure UI filter
    // over the same overlay. Verdicts, criteria and every other tab's counts are untouched (flagged.js).
    if (inFlaggedScope()) return (p.admin_class === 'S' || p.admin_class === 'R') && isRoadFlagged(roadKeyOf(p));
    // Local tab shows ONLY the green council roads — the S/R overlay is removed entirely (see applyLegend).
    if (currentTab === 'local') return false;
    // Fresh assessment: EVERY State + Regional road is a candidate — current class only decides
    // membership of the overlay, never the colour (that comes from buildFresh, see nswStyle).
    if (nswView === 'fresh') return p.admin_class === 'S' || p.admin_class === 'R';
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
    // Fresh assessment lens: colour by the BLANK-SLATE category (buildFresh) — the road's current
    // class is ignored. Solid = meets that category's criteria outright; dashed = provisional (gate
    // passed, 1 of 2 optional). Category legend rows toggle whole bins. Applies inside an LGA focus
    // too (CV / Sydney keep the lens, per nswInView above); only the Flagged view overrides it (the
    // ⚑ pins keep verdict colours). A Road Detail opened FROM the fresh lens keeps the fresh colours.
    if (nswView === 'fresh' && !inFlaggedScope()) {
        const f = buildFresh()[roadKeyOf(p)];
        if (!f || !legendToggles[f.cat]) return HIDDEN_STYLE;
        return { stroke: true, color: FRESH_META[f.cat].color, weight: p._w || 2,
                 opacity: f.tier === 'likely' ? 0.9 : 1, lineCap: 'round', lineJoin: 'round',
                 dashArray: f.tier === 'likely' ? '6 5' : null };
    }
    // Every road grades by its own category criteria (State / Regional). National significance is a
    // property of the NLTN network (its own lens + green layer), not a re-grade of the road overlay.
    let v = p._roadStatus || p.status;
    // Cross-criteria test (State / Regional tabs only): re-grade this road AGAINST another category.
    // xLens holds the active MODE per lens (false = own criteria): State tab → 'regional' (asReg) or
    // 'natsig' (asNat, national criteria); Regional tab → 'state' (asState). See buildXtest().
    if (currentTab === 'state' && xLens.state) { const x = buildXtest()[roadKeyOf(p)]; if (x) v = xLens.state === 'natsig' ? x.asNat : x.asReg; }
    else if (currentTab === 'regional' && xLens.regional) { const x = buildXtest()[roadKeyOf(p)]; if (x) v = x.asState; }
    if (!legendToggles[v]) return HIDDEN_STYLE;                       // verdict colour toggled off
    if (isDashed(p) && !legendToggles.dashed) return HIDDEN_STYLE;    // route-numbered roads toggled off
    // Orange sub-filter: when active, dim orange roads that don't match the selected reason.
    let dimmed = false;
    if (v === 'orange' && orangeSubFilter) {
        const reason = orangeReason(roadKeyOf(p));
        if (reason && reason !== orangeSubFilter) dimmed = true;
    }
    // Flagged view: the pins keep their normal verdict colour, one weight bolder for focus.
    return { stroke: true, color: ROAD_COLORS[v] || '#a8a29e', weight: (p._w || 2) + (inFlaggedScope() ? 1 : 0), opacity: dimmed ? 0.2 : (v === 'red' ? 0.85 : 1), lineCap: 'round', lineJoin: 'round', dashArray: isDashed(p) ? '8 6' : null };
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
    // Flagged view: draw ONLY pinned national routes — the same UI-pin filter the road overlay uses.
    if (typeof inFlaggedScope === 'function' && inFlaggedScope() &&
        !(typeof isRoadFlagged === 'function' && isRoadFlagged('nltn:' + p._natGroup))) return HIDDEN_STYLE;
    const v = p._natCat || 'orange';
    if (!legendToggles[v]) return HIDDEN_STYLE;          // green/orange verdict toggled off
    const s = { stroke: true, color: ROAD_COLORS[v] || '#16a34a', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', dashArray: null };
    if (p._proposed) s.opacity = 0.45;
    return s;
}

// --- Cross-criteria (reclassification) test ---
// Re-grade a road against the OTHER category's criteria. The shared connectivity criteria stay shared,
// but category-specific options are counted only for their category: R-03 road-train access is Regional,
// while the long-distance route and traffic thresholds are State-style optional criteria.
// Verdict rule is the same everywhere: fail mandatory → red; else ≥2 optional → green, 1 → orange, 0 → red.
function xverdict(optMet, mandPass) { return !mandPass ? 'red' : optMet >= 2 ? 'green' : optMet === 1 ? 'orange' : 'red'; }

function buildXtest() {
    if (window.XTEST) return window.XTEST;
    const X = {}, crit = window.NSW_CRIT || {}, nhvr = window.NHVR || {}, roadExt = window.ROAD_EXT || {};
    const countOpt = (c, keys) => keys.reduce((n, key) => n + (c.opt && c.opt[key] === true ? 1 : 0), 0);
    for (const k in crit) {
        const c = crit[k]; if (!c || !c.opt) continue;
        const ldrOpt = c.area !== 'urban' && ((c.opt && c.opt.ldr === true) || (c.stateOpt && c.stateOpt.ldr === true));
        // S-08/S-11 is derived independently (rural: NSW Road Segment components; urban: SAL
        // evidence components). Regional roads use stateOpt.dest when cross-tested as State
        // rather than borrowing their R-02 result.
        const stateDestOpt = c.stateOpt && typeof c.stateOpt.dest === 'boolean'
            ? c.stateOpt.dest : c.opt.dest;
        const stateCentresOpt = c.stateOpt && typeof c.stateOpt.centres === 'boolean'
            ? c.stateOpt.centres : c.opt.centres;
        const asStateOptMet = countOpt(c, ['traffic']) + (stateCentresOpt === true ? 1 : 0) + (stateDestOpt === true ? 1 : 0) + (ldrOpt ? 1 : 0);
        // R-02/R-06 include employment centres that meet the road zone's client-approved size rule.
        // regionalOpt is computed independently so a State road can be tested as Regional without
        // borrowing the stricter State facility result in opt.dest.
        const regionalDestOpt = c.regionalOpt && typeof c.regionalOpt.dest === 'boolean'
            ? c.regionalOpt.dest : c.opt.dest;
        const twoStateOpt = c.area !== 'urban' && ((c.opt && c.opt.two_state === true) || (roadExt[k] && roadExt[k].two_state === true));
        const regionalCentresOpt = c.regionalOpt && typeof c.regionalOpt.centres === 'boolean'
            ? c.regionalOpt.centres : c.opt.centres;
        const asRegionalOptMet = countOpt(c, ['hv']) + (regionalCentresOpt === true ? 1 : 0) + (regionalDestOpt === true ? 1 : 0) + (twoStateOpt ? 1 : 0);
        const optMet = c.cls === 'Regional' ? asRegionalOptMet : asStateOptMet;
        const pbs1 = !!(c.mand && c.mand.pbs1 === true);        // PBS-1 access (State mandatory gate)
        const bd = !!(nhvr[k] && nhvr[k].bdouble19 === true);   // 19m B-double access (Regional gate)
        // Nationally Significant test — the per-road national-criteria verdict PRECOMPUTED by the
        // pipeline (nsw_criteria.json: nat / natOptMet / natCrit {nltn, metros, portair} = S-01
        // NLTN membership, S-02·S-03 metro/urban centres, S-04·S-05 port/airport/intermodal).
        // Green = meets ≥2 national criteria, orange = 1, red = 0 — the same rule the Nat. Sig.
        // lens grading uses, recomputed here only as a fallback when `nat` is absent. Earned from
        // the data, never forced.
        const natMet = (c.natOptMet != null) ? c.natOptMet
            : (c.natCrit ? Object.keys(c.natCrit).reduce((n, key) => n + (c.natCrit[key] === true ? 1 : 0), 0) : 0);
        // S-06 mandatory gate: PBS Level 2B access, rolled up from the road's segments (ANY segment
        // on the NHVR PBS 2B approved network — the same rollup rule the pipeline uses for pbs1).
        // A road meeting ≥2 national criteria but failing the gate is NOT nationally significant —
        // red, exactly like the PBS-1 (State) and 19m B-double (Regional) gates. Earned, not forced.
        const pbs2b = !!(typeof NSW_AGG !== 'undefined' && NSW_AGG[k] && NSW_AGG[k].has_pbs2b);
        const asNat = !pbs2b ? 'red' : (c.nat || (natMet >= 2 ? 'green' : natMet === 1 ? 'orange' : 'red'));
        X[k] = { cls: c.cls, optMet: optMet, asState: xverdict(asStateOptMet, pbs1), asReg: xverdict(asRegionalOptMet, bd), asNat: asNat, natMet: natMet, natGate: pbs2b, real: c.verdict };
    }
    window.XTEST = X;
    return X;
}

// --- Fresh assessment (blank-slate re-binning) ---
// Ignore each road's current administrative class entirely and ask: which category does the DATA
// earn? Waterfall, highest category first, everything from already-earned criteria (buildXtest +
// the precomputed national grades in nsw_criteria.json):
//   Nationally Significant — passes the PBS Level 2B gate (S-06, mandatory) + meets >=2 national
//     criteria (asNat green: NLTN S-01, metro/urban centres S-02·S-03, port/airport/intermodal
//     S-04·S-05);
//   State    — passes the PBS Level 1 gate + >=2 shared optional criteria (asState green);
//   Regional — passes the 19m B-double gate + >=2 optional (asReg green);
//   likely tier — no green anywhere but a gate passed with exactly 1 optional: prefer the LOWER
//     category (asReg orange), falling back to asState orange for PBS-1 roads without B-double
//     access. Drawn dashed — provisional, could confirm with traffic data;
//   Local    — earns nothing above. Verdicts earned from data, never forced.
function buildFresh() {
    if (window.FRESH) return window.FRESH;
    const F = {}, X = buildXtest();
    for (const k in X) {
        const x = X[k];
        let cat, tier = 'meets';
        if (x.asNat === 'green') cat = 'fnat';
        else if (x.asState === 'green') cat = 'fstate';
        else if (x.asReg === 'green') cat = 'freg';
        else if (x.asReg === 'orange') { cat = 'freg'; tier = 'likely'; }
        else if (x.asState === 'orange') { cat = 'fstate'; tier = 'likely'; }
        else cat = 'flocal';
        F[k] = { cat: cat, tier: tier };
    }
    window.FRESH = F;
    return F;
}
