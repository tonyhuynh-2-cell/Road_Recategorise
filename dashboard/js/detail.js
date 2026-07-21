// detail.js — the Road Detail panel (showRoadDetail).

// Store last shown road properties + source for cross-test re-rendering
let _lastDetailP = null, _lastDetailSource = null;

// Cross-test: re-render the current road detail against a different category's criteria
// _detailCrossMode stores the active per-road cross-test: 'natsig', 'state', 'regional', or null (own)
let _detailCrossMode = null;
let _crossTestRerender = false;

// Named-sections dropdown context: the open road's key (set by showRoadDetail).
let _sectionCtx = null;

// Sections dropdown pick: re-open the SAME road titled by the chosen section, and frame that
// section's segments on the map. Road-level data (verdict, criteria, evidence) is unchanged —
// only the title and the map framing follow the section.
function selectRoadSection(name) {
    if (!_sectionCtx || typeof NSW_AGG === 'undefined') return;
    const aggRec = NSW_AGG[_sectionCtx.key];
    if (!aggRec) return;
    if (typeof traceCode === 'function') traceCode(
        'Section picked: ' + titleCase(name),
        'The sections dropdown swaps which named section of the same gazetted road titles the panel, then frames that stretch on the map. Nothing is re-assessed.',
        "function selectRoadSection(name) {\n  const agg = Object.assign({}, NSW_AGG[key], { road_name: name });\n  fitBounds(segments named `name`);\n  showRoadDetail(agg, 'nsw');\n}",
        'road=' + _sectionCtx.key + ', section=' + name
    );
    // Frame AND highlight the chosen section's segments (whole road if none match).
    const allSegs = (window.NSW_ROAD_LAYERS || {})[_sectionCtx.key] || [];
    const segs = allSegs.filter(l => String(l.feature.properties.road_name || '').trim() === name);
    if (segs.length && typeof map !== 'undefined') {
        let b = segs[0].getBounds();
        segs.forEach(l => { b = b.extend(l.getBounds()); });
        map.fitBounds(b.pad(0.25), { maxZoom: 13 });   // short sections must not zoom to street level
    }
    if (typeof highlightSection === 'function')
        highlightSection(name);
    // The route shield belongs to the SECTION being shown, not to the segment originally clicked —
    // a road can carry a shield on one stretch only (e.g. the motorway overlap of a Main Road).
    const secRef = segs.length ? (segs[0].feature.properties.ref || null) : null;
    showRoadDetail(Object.assign({}, aggRec, { ref: secRef, road_name: name }), 'nsw');
}

function applyCrossTest(mode) {
    if (!_lastDetailP || !_lastDetailSource) return;
    // '' = the "(current)" entry — pin own criteria explicitly so a lens-driven test (Best fit
    // bin, State/Regional cross-test) doesn't resurface over the user's pick. Reset per road open.
    _detailCrossMode = mode || 'own';
    _crossTestRerender = true;
    showRoadDetail(_lastDetailP, _lastDetailSource);
    _crossTestRerender = false;
    // Restore dropdown selection
    const sel = document.getElementById('detail-crosstest-select');
    if (sel) sel.value = mode || '';
}

function showRoadDetail(p, source) {
    _lastDetailP = p;
    _lastDetailSource = source;
    // Reset cross-test mode when a new road is clicked (not when re-rendering from dropdown)
    if (!_crossTestRerender) _detailCrossMode = null;
    if (typeof traceCode === 'function') traceCode(
        'Open road detail: ' + roadName(p),
        '`p` is the road object passed in by the click handler. `source` is the string passed beside it, usually "nsw", telling the detail panel which evidence collection to read.',
        "layer.on('click', function(e) {\n  const agg = nswRoadAgg[k];       // this becomes p\n  showRoadDetail(agg, 'nsw');      // 'nsw' becomes source\n});\n\nfunction showRoadDetail(p, source) {\n  const key = roadKeyOf(p);\n  const evd = (source === 'cv' ? window.CV_EVID : window.NSW_EVID)[key] || {};\n  const c = window.NSW_CRIT[key];\n  const nh = window.NHVR[key] || {};\n  const ad = window.ADT[key];\n  switchTab('detail');\n}",
        'p.road_name=' + roadName(p) + ', road key=' + roadKeyOf(p) + ', source=' + source + ', status=' + (p.status || p._roadStatus || p.meets_criteria)
    );
    switchTab('detail');
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'block';
    detailLayout('road');
    // Reset cross-test dropdown when opening a new road — show the road's own category as default
    const _xtSel = document.getElementById('detail-crosstest-select');
    if (_xtSel) {
        _xtSel.value = '';
        // Update the default option text to show the road's actual category
        const ownLabel = p.admin_class === 'S' ? 'State Road (current)' : 'Regional Road (current)';
        _xtSel.options[0].textContent = ownLabel;
        // Hide the option that duplicates the road's own category (it's already the first entry)
        const ownValue = p.admin_class === 'S' ? 'state' : 'regional';
        for (let i = 1; i < _xtSel.options.length; i++) {
            _xtSel.options[i].hidden = (_xtSel.options[i].value === ownValue);
        }
    }
    // Selected-road distance readout (bottom-right, above the scale). _len is the road length in km.
    if (typeof showRoadDistance === 'function') showRoadDistance(typeof p._len === 'number' ? p._len : null);

    // Connectivity evidence for this road (named centres / hospitals / destinations it connects).
    // Centres mix town points and Significant Urban Areas (kind:'sua') — the urban area a road runs
    // through is how city roads "connect centres". Route termini are tagged endpoint:true.
    const evd = (((source === 'cv') ? window.CV_EVID : window.NSW_EVID) || {})[roadKeyOf(p)] || {};
    const evCent = evd.centres || [], evHosps = evd.hospitals || [], evDests = evd.dests || [], evEmploy = evd.employment || [];
    // Real network membership (NHVR spatial intersect) + geometry-derived topology for this road.
    const nh = (window.NHVR || {})[roadKeyOf(p)] || {};
    const rx = (window.ROAD_EXT || {})[roadKeyOf(p)] || {};
    showConnections({ centres: evCent, hospitals: evHosps, dests: evDests, employment: evEmploy });   // ring/outline + label on the map

    document.getElementById('detail-road-name').innerHTML = roadLabel(p);
    // Road number line: the gazetted series label only (HW/MR/SR/TO/RR per the Schedule's numbering
    // key), with the source ID shown when it distinguishes several connected assessment units.
    const noLbl = roadNoLabel(p);
    const numBits = [];
    if (noLbl && noLbl !== roadName(p)) numBits.push(noLbl);
    if (isHighSpeed(p)) numBits.push('Motorway / freeway');
    if (p.unit_count > 1 && p.road_number) numBits.push('administrative ID ' + p.road_number);
    if (p.unit_count > 1) numBits.push('connected assessment unit ' + (p.unit_ordinal || '?') + ' of ' + p.unit_count);
    document.getElementById('detail-road-number').textContent = numBits.join(' · ');
    // Named-sections dropdown — one gazetted road can run through several named roads (e.g. MR152:
    // Grafton · Maclean · Lawrence-Yamba · Yamba…). The clicked segment's section is pre-selected;
    // picking another re-titles the card and frames that stretch (selectRoadSection below). Hidden
    // for single-name roads. NSW_AGG is a top-level `let` (state.js) — a LEXICAL global, not window.*
    const secWrap = document.getElementById('detail-sections-wrap');
    if (secWrap) {
        const aggRec = (source === 'nsw' && typeof NSW_AGG !== 'undefined') ? NSW_AGG[roadKeyOf(p)] : null;
        const rawNames = (aggRec && aggRec._names) ? aggRec._names : [];
        if (rawNames.length > 1) {
            _sectionCtx = { key: roadKeyOf(p) };
            const secSel = document.getElementById('detail-sections-select');
            const curName = roadName(p);
            secSel.innerHTML = rawNames.map(n =>
                '<option value="' + String(n).replace(/"/g, '&quot;') + '"' + (titleCase(n) === curName ? ' selected' : '') + '>' +
                titleCase(n) + '</option>').join('');
            secWrap.style.display = 'flex';
        } else {
            secWrap.style.display = 'none';
            _sectionCtx = null;
        }
    }
    const isState = p.admin_class === 'S';
    const zone = (source === 'nsw' && window.ZONE) ? window.ZONE[roadKeyOf(p)] : null;
    const zoneLabel = { urban: 'Urban', regional: 'Regional', remote: 'Remote (west of Newell Hwy)' }[zone];
    // Under the Best fit lens the map colours by earned bin — say which bin this road earned,
    // right next to the current class it would move from. FRESH_META labels are "Name — rule";
    // only the name belongs here.
    const freshBin = detailFreshBin(p, source);
    const freshLine = freshBin
        ? ' · Best fit: <strong style="color:' + FRESH_META[freshBin.cat].color + '">' + FRESH_META[freshBin.cat].label.split(' — ')[0] + '</strong>' +
          (freshBin.tier === 'likely' ? ' <span style="color:var(--muted)">(provisional)</span>' : '')
        : '';
    document.getElementById('detail-admin-class').innerHTML = 'Current Classification: <strong>' + (isState ? 'State Road' : 'Regional Road') + '</strong>' +
        (zoneLabel ? ' <span style="color:var(--muted)">· ' + zoneLabel + ' zone</span>' : '') +
        (p._nsr ? ' <span style="color:var(--muted)">· on the National Land Transport Network</span>' : '') +
        freshLine;

    // ⚑ Flag/pin toggle (flagged.js) — a UI pin only: flagging never alters the verdict below, the
    // criteria, or any tab's counts. Only NSW-overlay roads (the ones the Flagged tab can draw) get it.
    const flagWrap = document.getElementById('detail-flag-wrap');
    if (flagWrap) flagWrap.innerHTML = (source === 'nsw' && typeof flagButtonHTML === 'function') ? flagButtonHTML(roadKeyOf(p)) : '';

    // Cross-criteria lens context (cross-mode criteria display): when this detail was opened from
    // the State/Regional lens with a cross-test mode active, the map is showing the roads
    // re-coloured against the TARGET category — so the assessment + criteria cards below describe
    // that target category's criteria, populated with the road's REAL cross values (never
    // fabricated; unknowns render as "not assessed"). false = own criteria (original rendering).
    const xtMode = detailXtMode(source);
    const xtX = xtMode ? (buildXtest()[roadKeyOf(p)] || null) : null;
    const xtShort = xtMode ? XT_MODES[xtMode].short : '';
    const xtNoun = xtMode ? XT_MODES[xtMode].noun : '';
    // Keep the per-road Criteria dropdown honest: it must show the test the cards below actually
    // render (a lens-driven cross-test / Best fit bin, not always "own"). Skipped on the dropdown's
    // own re-render — applyCrossTest restores the picked value itself.
    if (_xtSel && !_crossTestRerender) _xtSel.value = xtMode || '';

    // Computed, area-aware criteria for this connected road unit, keyed like the map rollup.
    const c = (source === 'nsw' && window.NSW_CRIT) ? window.NSW_CRIT[roadKeyOf(p)] : null;
    const stateCentresPass = (c && c.stateOpt && typeof c.stateOpt.centres === 'boolean')
        ? c.stateOpt.centres : !!(c && c.opt && c.opt.centres);
    const regionalCentresPass = (c && c.regionalOpt && typeof c.regionalOpt.centres === 'boolean')
        ? c.regionalOpt.centres : !!(c && c.opt && c.opt.centres);
    const urbanArea = c ? c.area === 'urban' : !!p._urban;
    // Real AADT + %HV for this road from the TfNSW Traffic Volume Counts (data/nsw_adt.json), spatially
    // joined to the busiest count station on the road. Threshold depends on category + urban/rural —
    // under a State/Regional cross-test the TARGET category's thresholds apply (effState).
    const ad = (source === 'nsw' && window.ADT) ? window.ADT[roadKeyOf(p)] : null;
    const effState = xtMode === 'state' ? true : xtMode === 'regional' ? false : isState;
    const adtThr = effState ? (urbanArea ? 10000 : 7000) : (urbanArea ? 7000 : 2000);
    const hvThr = effState ? 8 : 6;
    const par = rx.parallel_state_20;   // true = a State Road closely parallels this one (geometry test)
    const bd = nh.bdouble19;
    const pbs1 = c ? !!c.mand.pbs1 : !!p.has_pbs1;
    // Parallel-State mandatory, with the guidance exception: "Road does not closely parallel an
    // existing State Road unless it has similar traffic volumes." 'Similar' is implemented as this
    // road's AADT >= 0.5 × the parallel State Road's AADT. nsw_road_ext.json stores
    // parallel_state_20 as a bare boolean — the geometry test does not record WHICH State Road is
    // the parallel partner — so the partner's AADT cannot be looked up in window.ADT and the
    // similarity exception is never assessable from the current data. Both branches below therefore
    // resolve to null (tri-state "not assessable"): absence of traffic data must not hard-fail the
    // road. If a partner road key is ever added to nsw_road_ext.json, replace the second branch
    // with: parPass = ad.aadt >= 0.5 * (window.ADT[partnerKey] || {}).aadt.
    let parPass;
    if (par === true) {
        const ownAadt = (ad && typeof ad.aadt === 'number') ? ad.aadt : null;
        if (ownAadt === null) parPass = null;   // this road's AADT unknown — similarity untestable
        else parPass = null;                    // own AADT known, but no partner key → partner AADT unavailable
    } else parPass = par === false ? true : null;
    const bdPass = bd === true ? true : bd === false ? false : !!p.has_bdouble;
    const aadtPass = ad ? ad.aadt > adtThr : null;
    const hvPass = ad && ad.hv_pct != null ? ad.hv_pct > hvThr : null;
    const trafficPass = ad
        ? (aadtPass === true && hvPass === true ? true : (aadtPass === false || hvPass === false ? false : null))
        : null;
    const roadTrainPass = nh.roadtrain === true ? true : nh.roadtrain === false ? false : null;
    const twoStatePass = (c && c.opt && c.opt.two_state === true) ? true
        : (c && c.opt && c.opt.two_state === false) ? false
            : rx.two_state === true ? true : rx.two_state === false ? false : null;
    const stateLdrPass = (c && c.opt && c.opt.ldr === true) ? true
        : (c && c.opt && c.opt.ldr === false) ? false
            : (c && c.stateOpt && c.stateOpt.ldr === true) ? true
                : (c && c.stateOpt && c.stateOpt.ldr === false) ? false : null;
    const stateLdrInfo = (c && c.stateOpt) || {};
    const stateDestPass = (c && c.stateOpt && typeof c.stateOpt.dest === 'boolean')
        ? c.stateOpt.dest
        : (c && c.opt && typeof c.opt.dest === 'boolean') ? c.opt.dest : null;
    const stateDestInfo = (c && c.stateOpt) || {};
    const selectedRoadName = String(p.road_name || '').trim().toUpperCase();
    const stateDestComponents = stateDestInfo.dest_qualifying_components || [];
    const selectedStateDestComponent = stateDestComponents.find(function (component) {
        return (component.road_names || []).some(function (name) {
            return String(name).trim().toUpperCase() === selectedRoadName;
        });
    }) || null;
    const regionalDestPass = (c && c.regionalOpt && c.regionalOpt.dest === true) ? true
        : (c && c.regionalOpt && c.regionalOpt.dest === false) ? false
            : (c && c.opt && c.opt.dest === true) ? true
                : (c && c.opt && c.opt.dest === false) ? false : null;
    const regionalDestInfo = (c && c.regionalOpt) || {};
    const ldrLabel = 'Unnumbered State criterion: Long-distance rural centre-to-town route';
    const fmtKm = function (km) {
        return typeof km === 'number' ? km.toLocaleString() + ' km' : null;
    };
    const nameList = function (items, fallback) {
        if (!items || !items.length) return fallback;
        const shown = items.slice(0, 3).join(', ');
        return shown + (items.length > 3 ? ' +' + (items.length - 3) + ' more' : '');
    };
    const regionalDestValue = function () {
        const componentKm = fmtKm(regionalDestInfo.dest_component_km);
        const centres = regionalDestInfo.dest_centre_names || [];
        const facilities = regionalDestInfo.dest_facility_names || [];
        const allCentres = regionalDestInfo.dest_all_centre_names || centres;
        const allFacilities = regionalDestInfo.dest_all_facility_names || facilities;
        const components = regionalDestInfo.dest_component_count || 0;
        const target = urbanArea ? 'Major Urban Centre or Major Town' : 'Town/Urban Centre';
        const bits = [];
        if (regionalDestPass === true) {
            bits.push('Connected component' + (componentKm ? ' ' + componentKm : ''));
            bits.push(nameList(facilities, 'qualifying facility/employment centre') + ' to ' + nameList(centres, target));
            if (components > 1) bits.push(components + ' disconnected geometry components in source data');
            return bits.join(' · ');
        }
        if (regionalDestPass === false) {
            if (allFacilities.length && allCentres.length) {
                bits.push('No connected component contains both a qualifying facility/employment centre and a ' + target);
            } else {
                if (!allFacilities.length) bits.push('needs a named facility or Regional/Major employment centre');
                if (!allCentres.length) bits.push('needs a ' + target + ' connection');
            }
            if (components > 1) bits.push(components + ' disconnected geometry components in source data');
            return bits.join(' · ');
        }
        return 'Not assessed under this test — Regional facility connectivity has not been derived for this road';
    };
    const stateDestValue = function () {
        const displayComponent = selectedStateDestComponent || stateDestComponents[0] || null;
        const componentKm = fmtKm(displayComponent ? displayComponent.component_km : stateDestInfo.dest_component_km);
        const centres = displayComponent ? (displayComponent.centre_names || []) : (stateDestInfo.dest_centre_names || []);
        const facilities = displayComponent ? (displayComponent.facility_names || []) : (stateDestInfo.dest_facility_names || []);
        const allCentres = stateDestInfo.dest_all_centre_names || centres;
        const allFacilities = stateDestInfo.dest_all_facility_names || facilities;
        const components = stateDestInfo.dest_component_count || 0;
        const networkMethod = stateDestInfo.dest_method === 'nsw_road_segment_network';
        const networkCoverage = stateDestInfo.dest_network_coverage;
        const bits = [];
        if (stateDestPass === true) {
            bits.push('Connected ' + (networkMethod ? 'NSW road-network ' : '') + 'component' + (componentKm ? ' ' + componentKm : ''));
            bits.push(nameList(facilities, 'qualifying facility/employment area') + ' to ' + nameList(centres, 'another centre type'));
            if ((displayComponent && displayComponent.employment_only === true) || (!displayComponent && stateDestInfo.dest_employment_only === true)) {
                bits.push('employment land-area threshold used; economic value unavailable');
            }
            if (networkMethod && typeof networkCoverage === 'number' && networkCoverage < 0.9) {
                bits.push('NSW road-network match ' + Math.round(networkCoverage * 100) + '%');
            }
            return bits.join(' · ');
        }
        if (stateDestPass === false) {
            if (allFacilities.length && allCentres.length) {
                bits.push('No connected ' + (networkMethod ? 'NSW road-network ' : '') + 'component contains both qualifying facility/employment evidence and another centre type');
                if (components > 1) bits.push('evidence is split across ' + components + ' road-network components');
            } else {
                if (!allFacilities.length && evEmploy.length) {
                    const minimumHa = urbanArea ? 40 : zone === 'remote' ? 5 : 15;
                    bits.push('No employment polygon both intersects the road and meets the ' + minimumHa + ' ha threshold');
                } else if (!allFacilities.length) bits.push('needs a qualifying hospital, port, intermodal, international airport or employment area');
                if (!allCentres.length) bits.push('needs a connection to another centre type');
            }
            if (networkMethod && typeof networkCoverage === 'number' && networkCoverage < 0.9) {
                bits.push('NSW road-network match ' + Math.round(networkCoverage * 100) + '%');
            }
            return bits.join(' · ');
        }
        return 'Not assessed under this test — State facility connectivity has not been derived for this road';
    };
    const stateLdrValue = function () {
        const totalKm = fmtKm(stateLdrInfo.ldr_km);
        const compKm = fmtKm(stateLdrInfo.ldr_component_km);
        const sources = stateLdrInfo.ldr_source_centres || [];
        const towns = stateLdrInfo.ldr_town_centres || [];
        const allSources = stateLdrInfo.ldr_all_source_centres || sources;
        const allTowns = stateLdrInfo.ldr_all_town_centres || towns;
        const components = stateLdrInfo.ldr_component_count || 0;
        const networkMethod = stateLdrInfo.ldr_method === 'nsw_road_segment_network';
        const networkCoverage = stateLdrInfo.ldr_network_coverage;
        const bits = [];
        if (stateLdrPass === true) {
            bits.push('Connected component ' + (compKm || totalKm || 'unknown length') + ' vs ≥25 km');
            if (totalKm && compKm && totalKm !== compKm) bits.push('total road geometry ' + totalKm);
            bits.push(nameList(sources, 'qualifying centre') + ' to ' + nameList(towns, 'Town Centre'));
            if (networkMethod && typeof networkCoverage === 'number' && networkCoverage < 0.9) {
                bits.push('NSW road-network match ' + Math.round(networkCoverage * 100) + '%');
            }
            return bits.join(' · ');
        }
        if (stateLdrPass === false) {
            if (totalKm) bits.push('Total route length ' + totalKm + '; length alone is not enough');
            if (allSources.length && allTowns.length) {
                bits.push('No connected ' + (networkMethod ? 'NSW road-network ' : '') + 'component contains both a qualifying centre and a Town Centre');
                if (components > 1) bits.push('centre evidence is split across ' + components + ' road-network components');
            }
            else {
                if (!allSources.length) bits.push('needs a Metro / Regional City / Major Town / Major Urban Centre');
                if (!allTowns.length) bits.push('needs a Town Centre connection');
            }
            if (networkMethod && typeof networkCoverage === 'number' && networkCoverage < 0.9) {
                bits.push('NSW road-network match ' + Math.round(networkCoverage * 100) + '%');
            }
            return bits.join(' · ');
        }
        return 'Not assessed under this test — LDR criterion has not been derived for this road';
    };
    // Clickable criterion shortcuts (own-criteria view): each non-passing criterion becomes a chip
    // that scrolls to its row below (scrollToCriterion, utils.js). Own-criteria only — under a
    // cross-test the cards re-render against the target category, so the anchors don't apply.
    const mandatoryRefs = [], optionalRefs = [];
    let ownOptionalPasses = null;
    const addCriterionRef = function (refs, state, code, anchor, label) {
        if (state === true) return;
        refs.push({ state: state, code: code, anchor: anchor, label: label });
    };
    const countPasses = function (states) {
        return states.reduce(function (n, state) { return n + (state === true ? 1 : 0); }, 0);
    };
    const chipsHtml = function (heading, refs) {
        if (!refs.length) return '';
        return '<div class="criteria-jump">' + (heading ? '<span class="criteria-jump-label">' + heading + '</span>' : '') +
            refs.map(function (r) {
                return '<button type="button" class="criteria-chip ' + (r.state === false ? 'is-fail' : 'is-warn') +
                    '" onclick="scrollToCriterion(\'' + r.anchor + '\')" title="' + r.label + '">' + r.code + '</button>';
            }).join('') + '</div>';
    };
    if (source === 'nsw' && c && !xtMode) {
        if (isState) {
            const optionalStates = [c.opt.centres, stateDestPass, trafficPass];
            if (!urbanArea) optionalStates.push(stateLdrPass);
            ownOptionalPasses = countPasses(optionalStates);
            addCriterionRef(mandatoryRefs, pbs1, 'S-09', 'crit-mand-pbs1', 'PBS Level 1 vehicle access');
            addCriterionRef(mandatoryRefs, parPass, 'Parallel', 'crit-mand-parallel', 'Does not closely parallel an existing State Road unless it has similar traffic volumes');
            addCriterionRef(optionalRefs, stateCentresPass, urbanArea ? 'S-10' : 'S-07', 'crit-opt-centres', 'Connects qualifying centres');
            if (!urbanArea) addCriterionRef(optionalRefs, stateLdrPass, 'LDR', 'crit-opt-ldr', 'Unnumbered State long-distance rural centre-to-town route');
            addCriterionRef(optionalRefs, stateDestPass, urbanArea ? 'S-11' : 'S-08', 'crit-opt-dest', 'Connects major facilities / employment centres');
            addCriterionRef(optionalRefs, trafficPass, 'Traffic', 'crit-opt-traffic', 'Meets traffic volume + heavy-vehicle thresholds');
        } else {
            const optionalStates = [c.opt.centres, regionalDestPass, trafficPass];
            addCriterionRef(mandatoryRefs, bdPass, 'R-04', 'crit-mand-bdouble', 'GML/CML 19m B-double access');
            addCriterionRef(optionalRefs, regionalCentresPass, urbanArea ? 'R-05' : 'R-01', 'crit-opt-centres', 'Connects qualifying centres');
            addCriterionRef(optionalRefs, regionalDestPass, urbanArea ? 'R-06' : 'R-02', 'crit-opt-dest', 'Connects facilities / employment centres');
            // R-03 (road train) and Links-two-State-Roads apply to regional & remote Regional roads
            // only — urban / metropolitan Regional roads are assessed on the R-05 / R-06 set instead.
            if (!urbanArea) {
                optionalStates.push(roadTrainPass, twoStatePass);
                addCriterionRef(optionalRefs, roadTrainPass, 'R-03', 'crit-opt-roadtrain', 'On the road train network');
                addCriterionRef(optionalRefs, twoStatePass, 'Two State', 'crit-opt-two-state', 'Links two State Roads');
            }
            ownOptionalPasses = countPasses(optionalStates);
            addCriterionRef(optionalRefs, trafficPass, 'Traffic', 'crit-opt-traffic', 'Meets traffic volume + heavy-vehicle thresholds');
        }
    }
    const optionalQuotaMet = ownOptionalPasses !== null && ownOptionalPasses >= 2;
    const criterionRefs = mandatoryRefs.concat(optionalQuotaMet ? [] : optionalRefs);

    // Result — graded by the road's own category criteria (no forced pass for being on the NLTN);
    // under an active cross-test, by the road's REAL verdict against the target category (buildXtest).
    const resultEl = document.getElementById('detail-result');
    const reasonEl = document.getElementById('detail-result-reason');
    const resultTitle = resultEl.closest('.stat-card').querySelector('h3');
    if (resultTitle) resultTitle.textContent = xtMode ? ('Assessment result — tested as ' + xtShort) : 'Assessment result';
    if (xtMode) {
        const xv = xtX ? (xtMode === 'natsig' ? xtX.asNat : xtMode === 'regional' ? xtX.asReg : xtX.asState) : null;
        if (xv === 'green') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.pass + '<span style="color:#16a34a">WOULD MEET ' + xtShort.toUpperCase() + '</span></span>';
            reasonEl.textContent = xtMode === 'natsig'
                ? 'Meets ≥2 national criteria (NLTN membership · centre connections · port / airport / intermodal) and the mandatory PBS Level 2B gate (S-06)'
                : 'Meets ≥2 optional criteria and the ' + (xtMode === 'state' ? 'PBS Level 1' : '19m B-double') + ' mandatory gate — reclassification test';
        } else if (xv === 'orange') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.maybe + '<span style="color:#d97706">' + (xtMode === 'natsig' ? 'MEETS 1 NATIONAL CRITERION' : 'WOULD MEET 1 OF 2') + '</span></span>';
            reasonEl.textContent = xtMode === 'natsig'
                ? 'Meets 1 of the 3 national criteria — not nationally significant on this data'
                : 'Passes the ' + (xtMode === 'state' ? 'PBS Level 1' : '19m B-double') + ' gate but meets only 1 optional criterion — would qualify with sufficient ADT';
        } else if (xv === 'red') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.fail + '<span style="color:#dc2626">WOULD NOT MEET ' + xtShort.toUpperCase() + '</span></span>';
            if (xtMode === 'natsig') reasonEl.textContent = (xtX && xtX.natGate === false)
                ? 'Fails the mandatory PBS Level 2B gate (S-06)' + (xtX.natMet >= 1 ? ' — meets ' + xtX.natMet + ' national criteri' + (xtX.natMet > 1 ? 'a' : 'on') + ' otherwise' : '')
                : 'Meets none of the national criteria in the assessment data';
            else {
                const gateOk = xtMode === 'state' ? !!(c && c.mand && c.mand.pbs1) : nh.bdouble19 === true;
                reasonEl.textContent = gateOk ? 'Meets no optional criterion at the ' + xtNoun + ' thresholds'
                    : 'Fails the mandatory ' + (xtMode === 'state' ? 'PBS Level 1 (S-09)' : '19m B-double (R-04)') + ' gate';
            }
        } else {
            resultEl.innerHTML = '<span class="result-line">' + ICON.warn + '<span style="color:#b45309">NOT ASSESSED UNDER THIS TEST</span></span>';
            reasonEl.textContent = 'No cross-test data exists for this road';
        }
    } else if (source === 'nsw') {
        if (p.status === 'green') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.pass + '<span style="color:#16a34a">MEETS CRITERIA</span></span>';
            reasonEl.innerHTML = 'Passes all testable criteria even without ADT data';
        }
        else if (p.status === 'orange') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.maybe + '<span style="color:#d97706">LIKELY MEETS</span></span>';
            const reason = optionalQuotaMet && mandatoryRefs.length
                ? 'Would fully meet if the mandatory review below were satisfied.'
                : criterionRefs.length
                    ? 'Would fully meet if enough missing criteria below were satisfied.'
                    : 'Would fully meet if the remaining unavailable assessment data confirmed the result.';
            reasonEl.innerHTML = reason + chipsHtml('To fully meet', criterionRefs);
        }
        else {
            resultEl.innerHTML = '<span class="result-line">' + ICON.fail + '<span style="color:#dc2626">DOES NOT MEET</span></span>';
            reasonEl.innerHTML = 'Fails criteria: ' + (criterionRefs.length ? '' : 'not enough criteria passed') + chipsHtml('', criterionRefs);
        }
    } else {
        if (p.meets_criteria) { resultEl.innerHTML = '<span class="result-line">' + ICON.pass + '<span style="color:#16a34a">MEETS CRITERIA</span></span>'; reasonEl.textContent = 'Meets ≥2 optional criteria and all mandatory'; }
        else { resultEl.innerHTML = '<span class="result-line">' + ICON.fail + '<span style="color:#dc2626">DOES NOT MEET</span></span>'; reasonEl.textContent = p.mandatory_pass === 0 ? 'Fails mandatory criteria' : 'Does not meet ≥2 optional criteria'; }
    }

    // Traffic
    const trafficEl = document.getElementById('detail-traffic');
    if (xtMode === 'natsig') {
        // Traffic volume is not one of the national significance criteria — factual display only.
        trafficEl.innerHTML = ad
            ? critItem(null, 'AADT: ' + ad.aadt.toLocaleString() + ' vehicles/day (TfNSW, ' + ad.year + ')', 'Traffic volume is not part of the national significance criteria')
            : critItem(null, 'ADT data not available', 'Traffic volume is not part of the national significance criteria');
    } else if (source === 'cv' && p.adt) {
        const thr = isState ? 7000 : 2000;
        const cvHvThr = isState ? 8 : 6;
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + (p.adt > thr ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">ADT: ' + Math.round(p.adt).toLocaleString() + ' vehicles/day</div><div class="criteria-value">Threshold: >' + thr.toLocaleString() + '</div></div></div>' +
            '<div class="criteria-item"><span class="criteria-icon">' + (p.hv_pct && p.hv_pct > cvHvThr ? ICON.pass : p.hv_pct ? ICON.fail : ICON.warn) + '</span><div class="criteria-text"><div class="criteria-label">Heavy Vehicles: ' + (p.hv_pct ? p.hv_pct.toFixed(1) + '%' : 'No data') + '</div><div class="criteria-value">Threshold: >' + cvHvThr + '%</div></div></div>';
    } else if (ad) {
        // Statewide AADT now available for this road (TfNSW count station).
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + (aadtPass ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">AADT: ' + ad.aadt.toLocaleString() + ' vehicles/day</div><div class="criteria-value">Threshold: >' + adtThr.toLocaleString() + ' (' + (urbanArea ? 'urban' : 'rural') + ' ' + (effState ? 'State' : 'Regional') + (xtMode ? ' — cross-test' : '') + ') · TfNSW count, ' + ad.year + '</div></div></div>' +
            '<div class="criteria-item"><span class="criteria-icon">' + (hvPass === true ? ICON.pass : hvPass === false ? ICON.fail : ICON.warn) + '</span><div class="criteria-text"><div class="criteria-label">Heavy Vehicles: ' + (ad.hv_pct != null ? ad.hv_pct + '%' : 'Not classified at this station') + '</div><div class="criteria-value">Threshold: >' + hvThr + '%' + (ad.stations > 1 ? ' · busiest of ' + ad.stations + ' stations' : '') + '</div></div></div>';
    } else {
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + ICON.warn + '</span><div class="criteria-text"><div class="criteria-label">ADT data not available</div><div class="criteria-value">No TfNSW count station on this road · ' + (effState ? 'State threshold >' + adtThr.toLocaleString() : 'Regional threshold >' + adtThr.toLocaleString()) + (xtMode ? ' (cross-test)' : '') + '</div></div></div>';
    }
    // Shared traffic-volume criterion row — real AADT vs threshold when we have it, else "not available".
    const trafficCrit = ad
        ? critItem(trafficPass, 'Meets traffic volume + heavy-vehicle thresholds',
            'AADT ' + ad.aadt.toLocaleString() + ' (' + ad.year + ') vs >' + adtThr.toLocaleString() +
            (ad.hv_pct != null ? ' · HV ' + ad.hv_pct + '% vs >' + hvThr + '%' : ' · HV% not classified at this station (needs >' + hvThr + '%)'), 'crit-opt-traffic')
        : critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', 'ADT not available for this road', 'crit-opt-traffic');

    // Mandatory — under a cross-test these are the TARGET category's gates, populated with the
    // road's REAL data (PBS-1 from the criteria table, 19m B-double from the NHVR network). The
    // natsig mode shows the national significance criteria (S-01–S-05) from natCrit instead;
    // values that don't exist for this road render as "not assessed", never fabricated.
    const mandEl = document.getElementById('detail-mandatory');
    const mandTitle = document.querySelector('#detail-card-mandatory h3');
    const optTitle = document.querySelector('#detail-card-optional h3');
    if (mandTitle) mandTitle.textContent = xtMode === 'natsig' ? 'National significance criteria (S-01–S-05)'
        : xtMode ? ('Mandatory criteria — ' + xtNoun + ' test') : 'Mandatory criteria';
    if (optTitle) optTitle.textContent = xtMode === 'natsig' ? 'Mandatory criteria — Nat. Sig. test'
        : xtMode ? ('Optional criteria (must meet ≥2) — ' + xtNoun + ' test') : 'Optional criteria (must meet ≥2)';
    // Which category's gate rows to render: the target's under a State/Regional cross-test,
    // otherwise the road's own (natsig renders its own national block instead).
    const mandAsState = xtMode === 'state' ? true : xtMode === 'regional' ? false : isState;
    if (xtMode === 'natsig') {
        const nc = c && c.natCrit;
        const natRow = (v, label, on, off) => critItem(v === true ? true : v === false ? false : null, label,
            v === true ? on : v === false ? off : 'Not assessed under this test — data unavailable');
        mandEl.innerHTML = nc
            ? (natRow(nc.nltn, 'S-01: Comprises the National Land Transport Network', 'Predominantly on the NLTN 2020 network', 'Not on the NLTN 2020 network')
                + natRow(nc.metros, 'S-02·S-03: Connects ≥2 metropolitan / urban centres', 'Connects ≥2 qualifying centres', 'Does not connect ≥2 qualifying centres')
                + natRow(nc.portair, 'S-04·S-05: Connects a Major Port, International Airport or Major Intermodal', 'Connects a qualifying port / airport / intermodal', 'No qualifying port / airport / intermodal connection'))
            : critItem(null, 'National criteria', 'Not assessed under this test — no national-criteria data for this road');
    } else if (mandAsState) {
        // "Does not parallel a State Road unless similar traffic" — PASS when it does NOT parallel
        // one, or when it does but carries similar traffic volumes (exception, see parPass above).
        mandEl.innerHTML =
            critItem(pbs1, 'S-09: PBS Level 1 vehicle access', 'Facilitates movement of PBS Level 1 or equivalent', 'crit-mand-pbs1') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant') +
            critItem(parPass, 'Does not closely parallel an existing State Road unless it has similar traffic volumes',
                par === true ? (parPass === true ? 'Parallels a State Road but carries similar traffic volumes'
                    : parPass === false ? 'A State Road runs parallel nearby — candidate to review'
                        : 'Parallels a State Road — traffic similarity not assessable (AADT unavailable)')
                    : par === false ? 'No State Road runs parallel within range' : 'Not assessed', 'crit-mand-parallel');
    } else {
        // R-04 now uses the real NHVR 19m B-double network (falls back to the prior flag if unknown).
        mandEl.innerHTML =
            critItem(bdPass, 'R-04: GML/CML 19m B-double access (50+ tonnes)',
                bd === true ? 'NHVR-approved 19m B-double route' : bd === false ? 'Not on the NHVR 19m B-double network' : 'Facilitates movement of 19m B-double routes', 'crit-mand-bdouble') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant');
    }

    // Optional criteria (must meet >=2) — each connectivity criterion lists the actual entities it
    // connects (the evidence) and, when it fails, why. Click an entity to pan to it on the map.
    const optEl = document.getElementById('detail-optional');
    const centresVal = function (pass, items) {
        if (pass) return items.length ? ('Connects ' + items.length + ' centre' + (items.length > 1 ? 's' : '') + ' (named below)') : 'Connects centres (per assessment)';
        return items.length ? (items.length + ' centre' + (items.length > 1 ? 's' : '') + ' nearby — needs ≥2 connected') : 'No qualifying centre within range';
    };
    const destVal = function (pass, ds, hs, em) {
        const n = ds.length + hs.length + (em ? em.length : 0);
        if (pass) return n ? ('Connects ' + n + ' facilit' + (n > 1 ? 'ies' : 'y') + ' (named below)') : 'Connects a facility (per assessment)';
        return n ? (n + ' nearby — not a qualifying connection') : 'No hospital / port / airport / intermodal / employment centre within range';
    };
    const facilityRows = evList(evDests, 'dest') + evList(evHosps, 'hosp') + evList(evEmploy, 'employ');
    const stateFacilityNames = new Set(
        selectedStateDestComponent
            ? (selectedStateDestComponent.facility_names || [])
            : (stateDestInfo.dest_facility_names || [])
    );
    const stateCentreNames = new Set(
        selectedStateDestComponent
            ? (selectedStateDestComponent.centre_names || [])
            : (stateDestInfo.dest_centre_names || [])
    );
    const stateCentreRows = evCentres(evCent.filter(function (item) { return stateCentreNames.has(item.name); }));
    const statePointFacilityRows =
        evList(evDests.filter(function (item) { return stateFacilityNames.has(item.name); }), 'dest') +
        evList(evHosps.filter(function (item) { return stateFacilityNames.has(item.name); }), 'hosp');
    const stateEmploymentRows = evEmploymentReview(evEmploy, urbanArea ? 40 : zone === 'remote' ? 5 : 15);
    const stateEvidenceRows = stateCentreRows + statePointFacilityRows + stateEmploymentRows;
    // Road train (R-03) — real NHVR membership; shown for Regional roads.
    const roadTrainRow = critItem(nh.roadtrain === true ? true : nh.roadtrain === false ? false : null,
        'R-03: On the road train network',
        nh.roadtrain === true ? 'NHVR Road Train (32m) approved route' : nh.roadtrain === false ? 'Not on the NHVR road train network' : 'NHVR status unavailable', 'crit-opt-roadtrain');
    // Links two State Roads — real geometry topology (a Regional road that joins two State Roads).
    const twoStateRow = critItem(twoStatePass,
        'Links two State Roads', twoStatePass === true ? 'Both ends meet a State Road' : twoStatePass === false ? 'Does not link two State Roads' : 'Not assessed', 'crit-opt-two-state');
    if (xtMode === 'natsig') {
        // Nat. Sig. mandatory block (mirrors the NLTN detail): S-06 is the MANDATORY gate of this
        // test, so it is tested for real — the road's segment rollup against the NHVR PBS Level 2B
        // approved network (has_pbs2b, ANY segment — the pipeline's pbs1/pbs2b rule). buildXtest
        // gates asNat on the same value, so this row can never contradict the verdict above.
        const pbs2b = p.has_pbs2b === undefined ? null : !!p.has_pbs2b;
        optEl.innerHTML =
            critItem(pbs2b, 'S-06: PBS Level 2B vehicle access',
                pbs2b === true ? 'On the NHVR PBS Level 2B approved network — mandatory gate passed'
                    : pbs2b === false ? 'Not on the NHVR PBS Level 2B approved network — mandatory gate failed'
                        : 'NHVR PBS 2B status unavailable') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant');
    } else if (xtMode && !c) {
        optEl.innerHTML = critItem(null, xtNoun + ' optional criteria', 'Not assessed under this test — no criteria data for this road');
    } else if (source === 'cv' && (p.criteria_met || p.criteria_failed)) {
        let html = '';
        if (p.criteria_met) p.criteria_met.split('; ').forEach(cc => { html += critItem(true, cc); });
        if (p.criteria_failed) p.criteria_failed.split('; ').forEach(cc => { html += critItem(false, cc); });
        html += evCentres(evCent) + facilityRows;
        optEl.innerHTML = html;
    } else if (c && mandAsState) {
        let html = '';
        const cLabel = urbanArea
            ? 'S-10: Connects Metro Centres / Regional Cities / Major Urban Centres / Major Towns'
            : 'S-07: Connects Metro Centres / Regional Cities / Major Towns to each other';
        html += critItem(stateCentresPass, cLabel, centresVal(stateCentresPass, evCent), 'crit-opt-centres') + evCentres(evCent);
        // LDR is an unnumbered State optional criterion. It needs a connected long-distance
        // component joining a State-tier centre to a Town Centre, not just route length.
        if (!urbanArea) html += xtMode
            ? critItem(stateLdrPass,
                ldrLabel,
                stateLdrValue())
            : critItem(stateLdrPass, ldrLabel, stateLdrValue(), 'crit-opt-ldr');
        const dLabel = 'S-' + (urbanArea ? '11' : '08') + ': Connects Major Hospitals / Ports / Intermodals / International Airports / Employment Centres to other centre types';
        html += critItem(stateDestPass, dLabel, stateDestValue(), 'crit-opt-dest') + stateEvidenceRows;
        html += trafficCrit;
        optEl.innerHTML = html;
    } else if (c && !mandAsState) {
        // Regional roads use the Sydney-Metropolitan criteria set (R-05 / R-06) in urban areas and the
        // Regional & Remote set (R-01 / R-02) elsewhere — mirroring the State urban/rural split above.
        let html = '';
        const rCentres = urbanArea
            ? 'R-05: Connects Metropolitan Centres, Major Urban Centres and Major Towns to each other'
            : 'R-01: Connects Urban Centres and Town Centres to each other';
        const rDest = urbanArea
            ? 'R-06: Connects Major/Regional Hospitals / Major Ports / Intermodals / Airports / Employment Centres to Major Urban Centres or Major Towns'
            : 'R-02: Connects Major/Regional Hospitals / Ports / Airports / Employment Centres to Town/Urban Centres';
        html += critItem(regionalCentresPass, rCentres, centresVal(regionalCentresPass, evCent), 'crit-opt-centres') + evCentres(evCent);
        html += critItem(regionalDestPass, rDest, regionalDestValue(), 'crit-opt-dest') + facilityRows;
        // Rural-only optional criteria — hidden for urban Regional roads (R-05/R-06 set).
        if (!urbanArea) html += roadTrainRow + twoStateRow;
        html += trafficCrit;
        optEl.innerHTML = html;
    } else {
        // Fallback when computed criteria are unavailable
        let html = '';
        if (isState) {
            html += critItem(!!p.connects_major_town, 'S-07/S-10: Connects centres to each other', centresVal(!!p.connects_major_town, evCent)) + evCentres(evCent);
            html += critItem(!!p.connects_hospital, 'S-08/S-11: Connects hospitals / ports / airports', destVal(!!p.connects_hospital, evDests, evHosps, evEmploy)) + facilityRows;
        } else {
            html += critItem(!!p.connects_major_town, 'R-01/R-05: Connects Urban / Town Centres', centresVal(!!p.connects_major_town, evCent)) + evCentres(evCent);
            html += critItem(!!p.connects_hospital, 'R-02/R-06: Connects facilities to centres', destVal(!!p.connects_hospital, evDests, evHosps, evEmploy)) + facilityRows;
            if (!urbanArea) html += roadTrainRow + twoStateRow;
        }
        html += trafficCrit;
        optEl.innerHTML = html;
    }

    // Vehicle access — road train, 19m B-double and HV bypass come from the real NHVR networks
    // (data/nhvr_networks.json, spatial intersect). PBS Level 2B (S-06) stays on the Nat. Significant tab.
    const va = function (ok, label, on, off) {
        const icon = ok === true ? ICON.pass : ok === false ? ICON.fail : ICON.warn;
        const val = ok === true ? on : ok === false ? off : 'NHVR status unavailable';
        return '<div class="criteria-item"><span class="criteria-icon">' + icon + '</span><div class="criteria-text"><div class="criteria-label">' + label + '</div><div class="criteria-value">' + val + '</div></div></div>';
    };
    document.getElementById('detail-vehicle-access').innerHTML =
        va(!!p.has_pbs1, 'PBS Level 1', 'Facilitates PBS Level 1 access', 'No PBS Level 1 access') +
        va(nh.bdouble19 === undefined ? !!p.has_bdouble : nh.bdouble19, 'GML/CML 19m B-double (50+ tonnes)', 'NHVR-approved 19m B-double route', 'Not on the 19m B-double network') +
        va(nh.roadtrain, 'Road train (32m)', 'NHVR-approved road train route', 'Not on the road train network') +
        va(nh.bypass, 'Heavy-vehicle bypass', 'On an NHVR heavy-vehicle bypass', 'Not on a bypass route');

    // Connectivity — a plain-language summary derived from the SAME source as the optional criteria
    // above (c.opt) so the two cards can never contradict. NLTN membership is a separate factual tag.
    const connCentres = c ? (isState ? stateCentresPass : regionalCentresPass) : (!!p.connects_major_town || !!p.connects_regional_city);
    const connDest = c ? (isState ? stateDestPass === true : regionalDestPass === true) : !!p.connects_hospital;
    const nFac = evDests.length + evHosps.length;
    document.getElementById('detail-connectivity').innerHTML =
        critItem(!!p._nltn, 'On the National Land Transport Network', p._nltn ? 'Carries segment(s) of the national freight network' : 'Not on the NLTN') +
        critItem(connCentres, 'Connects centres', evCent.length ? (evCent.length + ' named above') : (connCentres ? 'Per assessment' : 'None within range')) +
        critItem(connDest, 'Connects hospitals / ports / airports', nFac ? (nFac + ' named above') : (connDest ? 'Per assessment' : 'None within range'));

    // Copy traffic data into the collapsible "Additional data" section
    const extraTraffic = document.getElementById('detail-traffic-extra');
    if (extraTraffic) extraTraffic.innerHTML = document.getElementById('detail-traffic').innerHTML;

    // Keep the criteria reference modal in sync with this road's assessment (criteria.js)
    if (typeof refreshCriteriaModal === 'function') refreshCriteriaModal();
}

// The active cross-test mode for a Road Detail: the lens this detail was opened from (or the
// lens on screen right now) with its cross-criteria mode, if any. The Best fit lens assesses each
// road against its EARNED bin; the State / Regional lenses carry the cross-test control; a detail
// opened from anywhere else (Overview, Sydney, CV, Flagged, search on another tab) renders the
// road's own criteria. false = own criteria.
function detailXtMode(source) {
    // Per-road cross-test dropdown takes priority over the tab-level lens ('own' pins own criteria)
    if (_detailCrossMode) return _detailCrossMode === 'own' ? false : _detailCrossMode;
    if (source !== 'nsw' || typeof xLens === 'undefined') return false;
    // Best fit lens: assess against the bin the road earned (buildFresh) — fnat runs the national
    // test, fstate / freg the State / Regional test. flocal shows the Regional test (the lowest
    // classified tier — the card then explains why the road holds no category). A bin matching the
    // road's own class renders the own-criteria view — same criteria, and it mirrors how the
    // dropdown treats the own-category entry.
    const f = detailFreshBin(_lastDetailP, source);
    if (f) {
        const mode = f.cat === 'fnat' ? 'natsig' : f.cat === 'fstate' ? 'state' : 'regional';
        return mode === (_lastDetailP.admin_class === 'S' ? 'state' : 'regional') ? false : mode;
    }
    const lens = (currentTab === 'detail') ? lastViewTab : currentTab;
    if (lens === 'state') return xLens.state || false;
    if (lens === 'regional') return xLens.regional || false;
    return false;
}

// Best fit lens context for a Road Detail: the lens tab itself, or an LGA focus (CV / Sydney)
// with the Best fit lens picked in the category dropdown. Returns the road's blank-slate record
// { cat, tier } from buildFresh, or null when the detail is not under that lens.
function detailFreshBin(p, source) {
    if (!p || source !== 'nsw' || typeof buildFresh !== 'function') return null;
    const lens = (currentTab === 'detail') ? lastViewTab : currentTab;
    const on = lens === 'fresh' || ((lens === 'cv' || lens === 'sydney') && typeof nswView !== 'undefined' && nswView === 'fresh');
    return on ? (buildFresh()[roadKeyOf(p)] || null) : null;
}

// Configure which detail-panel sections show + their headings: 'road' (full criteria set) vs
// 'nltn' (national criteria only). Lets the road and NLTN detail views share the same DOM.
function detailLayout(mode) {
    const set = (id, show, title) => {
        const card = document.getElementById(id);
        if (!card) return;
        card.style.display = show ? '' : 'none';
        if (title) { const h = card.querySelector('h3'); if (h) h.textContent = title; }
    };
    const nltn = mode === 'nltn';
    window._detailIsNltn = nltn;   // criteria.js: NLTN details always map to the Nat.Sig criteria section
    // For regular roads: hide standalone traffic/vehicle/connectivity (they're in the collapsible card)
    // For NLTN: show traffic (as "Determination route") and hide the collapsible extra card
    set('detail-card-traffic', nltn, nltn ? 'Determination route' : 'Traffic data');
    set('detail-card-mandatory', true, nltn ? 'National significance criteria (S-01–S-05)' : 'Mandatory criteria');
    set('detail-card-optional', true, nltn ? 'Mandatory criteria' : 'Optional criteria (must meet ≥2)');
    set('detail-card-vehicle', false);
    set('detail-card-connectivity', false);
    set('detail-card-extra', !nltn, 'Additional data');
}

// Road Detail for an NLTN 2020 line (the Nationally Significant lens). Graded by the national
// criteria of the road it runs along: S-01 on the NLTN (met by definition), S-02·S-03 connects
// ≥2 centres, S-04·S-05 connects a port/airport/intermodal. Green = meets ≥2; orange = on-network-only.
function showNltnDetail(p) {
    if (typeof traceCode === 'function') traceCode(
        'Open Nat. Sig. detail: ' + nltnLabel(p).replace(/<[^>]*>/g, ''),
        'National-network clicks use the NLTN route record instead of the normal State/Regional road detail. It shows national criteria and PBS 2B status.',
        "function showNltnDetail(p) {\n  const nev = window.NLTN_EVID[p._natGroup] || {};\n  const green = p._natCat === 'green';\n  detailLayout('nltn');\n  // Render NLTN criteria, connected centres,\n  // ports/airports/intermodals and PBS Level 2B.\n}",
        'NLTN group=' + (p._natGroup || 'unknown') + ', category=' + (p._natCat || 'orange')
    );
    switchTab('detail');
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'block';
    detailLayout('nltn');
    // Distance readout — national routes are the long roads; length is summed per _natGroup (see init.js).
    if (typeof showRoadDistance === 'function') showRoadDistance((window.NLTN_LEN || {})[p._natGroup]);

    document.getElementById('detail-road-name').innerHTML = nltnLabel(p);
    document.getElementById('detail-road-number').textContent = p._proposed ? 'Proposed corridor — not yet built' : 'National Land Transport Network — Road';
    document.getElementById('detail-admin-class').innerHTML = 'Source: <strong>NLTN Determination 2020</strong> <span style="color:var(--muted)">· data.gov.au</span>';
    // ⚑ Flag/pin toggle — national routes CAN be pinned now: flagged.js draws them on the Flagged tab
    // via the NLTN layer, filtered to the pinned routes. The flag key is namespaced 'nltn:<group>'.
    // UI pin only: flagging never changes the national grade, the criteria, or any tab's counts.
    const nFlagWrap = document.getElementById('detail-flag-wrap');
    if (nFlagWrap) nFlagWrap.innerHTML = (typeof flagButtonHTML === 'function') ? flagButtonHTML('nltn:' + p._natGroup) : '';

    const green = p._natCat === 'green';
    document.getElementById('detail-result').innerHTML = '<span class="result-line">' + (green ? ICON.pass : ICON.maybe) + '<span style="color:' + (green ? '#16a34a' : '#d97706') + '">' + (green ? 'NATIONALLY SIGNIFICANT' : 'ON NETWORK ONLY') + '</span></span>';
    document.getElementById('detail-result-reason').textContent = green
        ? 'Meets ≥2 national criteria — on the National Land Transport Network and connects centres and/or a port, airport or intermodal.'
        : 'On the National Land Transport Network (S-01), but the road it runs along connects neither ≥2 centres nor a port/airport in the assessment data.';

    document.getElementById('detail-traffic').innerHTML =
        '<div class="criteria-value" style="line-height:1.5">' + (p.desc ? (p.desc + '…') : 'Route description unavailable.') +
        (p.part ? '<div style="margin-top:6px; color:var(--faint)">' + p.part + '</div>' : '') + '</div>';

    const nev = (window.NLTN_EVID && window.NLTN_EVID[p._natGroup]) || {};
    const ncent = nev.centres || [];
    const ndests = (nev.dests || []).filter(function (d) { return /major port|international airport|major intermodal/i.test(d.ftype || ''); });
    document.getElementById('detail-mandatory').innerHTML =
        critItem(true, 'S-01: Comprises the National Land Transport Network', 'On the NLTN 2020 determination network') +
        critItem(!!p._natMetros, 'S-02·S-03: Connects ≥2 metropolitan / urban centres',
            p._natMetros ? (ncent.length ? 'Connects ' + ncent.length + ' centre' + (ncent.length > 1 ? 's' : '') : 'Connects centres (per assessment)')
                : (ncent.length ? 'Only ' + ncent.length + ' centre nearby' : 'No centre within range')) +
        evCentres(ncent) +
        critItem(!!p._natPortair, 'S-04·S-05: Connects a Major Port, International Airport or Major Intermodal',
            p._natPortair ? (ndests.length ? 'Connects ' + ndests.length : 'Connects (per assessment)')
                : (ndests.length ? 'Nearby only' : 'None within range')) +
        evList(ndests, 'dest');
    showConnections({ centres: ncent, dests: ndests });

    // Mandatory criteria for Nationally Significant State Roads: PBS Level 2B access (S-06) + no load
    // limits. S-06 is tested live against the NHVR "PBS Level 2B Approved Routes" network (spatial
    // intersect, data/nltn_meta.json) — pass only where the road genuinely carries approved access.
    const pbs2b = p._natPbs2b;
    document.getElementById('detail-optional').innerHTML =
        critItem(pbs2b === true ? true : pbs2b === false ? false : null,
            'S-06: PBS Level 2B vehicle access',
            pbs2b === true ? 'Approved route on the NHVR PBS Level 2B network'
                : pbs2b === false ? 'Not on the NHVR PBS Level 2B approved network'
                : 'NHVR PBS 2B status unavailable') +
        critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant');
}
