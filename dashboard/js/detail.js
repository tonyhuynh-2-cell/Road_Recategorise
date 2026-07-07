// detail.js — the Road Detail panel (showRoadDetail).

function showRoadDetail(p, source) {
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
    document.getElementById('detail-road-number').textContent = isHighSpeed(p) ? 'Motorway / freeway' : '';
    const isState = p.admin_class === 'S';
    const zone = (source === 'nsw' && window.ZONE) ? window.ZONE[roadKeyOf(p)] : null;
    const zoneLabel = { urban: 'Urban', regional: 'Regional', remote: 'Remote (west of Newell Hwy)' }[zone];
    document.getElementById('detail-admin-class').innerHTML = 'Current Classification: <strong>' + (isState ? 'State Road' : 'Regional Road') + '</strong>' +
        (zoneLabel ? ' <span style="color:var(--muted)">· ' + zoneLabel + ' zone</span>' : '') +
        (p._nsr ? ' <span style="color:var(--muted)">· on the National Land Transport Network</span>' : '');

    // Computed, area-aware criteria for this road (data/nsw_criteria.json), keyed like the map rollup.
    const c = (source === 'nsw' && window.NSW_CRIT) ? window.NSW_CRIT[roadKeyOf(p)] : null;
    const urbanArea = c ? c.area === 'urban' : !!p._urban;
    // Real AADT + %HV for this road from the TfNSW Traffic Volume Counts (data/nsw_adt.json), spatially
    // joined to the busiest count station on the road. Threshold depends on category + urban/rural.
    const ad = (source === 'nsw' && window.ADT) ? window.ADT[roadKeyOf(p)] : null;
    const adtThr = isState ? (urbanArea ? 10000 : 7000) : (urbanArea ? 7000 : 2000);
    const hvThr = isState ? 8 : 6;
    const par = rx.parallel_state_20;   // true = a State Road closely parallels this one (geometry test)
    const bd = nh.bdouble19;
    const pbs1 = c ? !!c.mand.pbs1 : !!p.has_pbs1;
    const parPass = par === true ? false : par === false ? true : null;
    const bdPass = bd === true ? true : bd === false ? false : !!p.has_bdouble;
    const trafficPass = ad ? ad.aadt > adtThr : null;
    const roadTrainPass = nh.roadtrain === true ? true : nh.roadtrain === false ? false : null;
    const twoStatePass = rx.two_state === true ? true : rx.two_state === false ? false : null;
    const criterionRefs = [];
    const addCriterionRef = function (state, code, anchor, label) {
        if (state === true) return;
        criterionRefs.push({ state: state, code: code, anchor: anchor, label: label });
    };
    const chipsHtml = function (heading, refs) {
        if (!refs.length) return '';
        return '<div class="criteria-jump">' + (heading ? '<span class="criteria-jump-label">' + heading + '</span>' : '') +
            refs.map(function (r) {
                return '<button type="button" class="criteria-chip ' + (r.state === false ? 'is-fail' : 'is-warn') +
                    '" onclick="scrollToCriterion(\'' + r.anchor + '\')" title="' + r.label + '">' + r.code + '</button>';
            }).join('') + '</div>';
    };
    if (source === 'nsw' && c) {
        if (isState) {
            addCriterionRef(pbs1, 'S-09', 'crit-mand-pbs1', 'PBS Level 1 vehicle access');
            addCriterionRef(parPass, 'Parallel', 'crit-mand-parallel', 'Does not closely parallel another State Road within 20km');
            addCriterionRef(c.opt.centres, urbanArea ? 'S-10' : 'S-07', 'crit-opt-centres', 'Connects qualifying centres');
            if (!urbanArea) addCriterionRef(c.opt.ldr, 'LDR', 'crit-opt-ldr', 'Long-distance rural route');
            addCriterionRef(c.opt.dest, urbanArea ? 'S-11' : 'S-08', 'crit-opt-dest', 'Connects major facilities / employment centres');
            addCriterionRef(trafficPass, 'Traffic', 'crit-opt-traffic', 'Meets traffic volume + heavy-vehicle thresholds');
        } else {
            addCriterionRef(bdPass, 'R-04', 'crit-mand-bdouble', 'GML/CML 19m B-double access');
            addCriterionRef(c.opt.centres, urbanArea ? 'R-05' : 'R-01', 'crit-opt-centres', 'Connects qualifying centres');
            addCriterionRef(c.opt.dest, urbanArea ? 'R-06' : 'R-02', 'crit-opt-dest', 'Connects facilities / employment centres');
            addCriterionRef(roadTrainPass, 'R-03', 'crit-opt-roadtrain', 'On the road train network');
            addCriterionRef(twoStatePass, 'Two State', 'crit-opt-two-state', 'Links two State Roads');
            addCriterionRef(trafficPass, 'Traffic', 'crit-opt-traffic', 'Meets traffic volume + heavy-vehicle thresholds');
        }
    }

    // Result — graded by the road's own category criteria (no forced pass for being on the NLTN).
    const resultEl = document.getElementById('detail-result');
    const reasonEl = document.getElementById('detail-result-reason');
    if (source === 'nsw') {
        if (p.status === 'green') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.pass + '<span style="color:#16a34a">MEETS CRITERIA</span></span>';
            reasonEl.innerHTML = 'Passes all testable criteria even without ADT data';
        }
        else if (p.status === 'orange') {
            resultEl.innerHTML = '<span class="result-line">' + ICON.maybe + '<span style="color:#d97706">LIKELY MEETS</span></span>';
            reasonEl.innerHTML = 'Would fully meet if enough missing criteria below were satisfied.' + chipsHtml('To fully meet', criterionRefs);
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
    if (source === 'cv' && p.adt) {
        const thr = isState ? 7000 : 2000;
        const cvHvThr = isState ? 8 : 6;
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + (p.adt > thr ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">ADT: ' + Math.round(p.adt).toLocaleString() + ' vehicles/day</div><div class="criteria-value">Threshold: >' + thr.toLocaleString() + '</div></div></div>' +
            '<div class="criteria-item"><span class="criteria-icon">' + (p.hv_pct && p.hv_pct > cvHvThr ? ICON.pass : p.hv_pct ? ICON.fail : ICON.warn) + '</span><div class="criteria-text"><div class="criteria-label">Heavy Vehicles: ' + (p.hv_pct ? p.hv_pct.toFixed(1) + '%' : 'No data') + '</div><div class="criteria-value">Threshold: >' + cvHvThr + '%</div></div></div>';
    } else if (ad) {
        // Statewide AADT now available for this road (TfNSW count station).
        const hvOk = ad.hv_pct != null ? ad.hv_pct > hvThr : null;
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + (ad.aadt > adtThr ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">AADT: ' + ad.aadt.toLocaleString() + ' vehicles/day</div><div class="criteria-value">Threshold: >' + adtThr.toLocaleString() + ' (' + (urbanArea ? 'urban' : 'rural') + ' ' + (isState ? 'State' : 'Regional') + ') · TfNSW count, ' + ad.year + '</div></div></div>' +
            '<div class="criteria-item"><span class="criteria-icon">' + (hvOk === true ? ICON.pass : hvOk === false ? ICON.fail : ICON.warn) + '</span><div class="criteria-text"><div class="criteria-label">Heavy Vehicles: ' + (ad.hv_pct != null ? ad.hv_pct + '%' : 'Not classified at this station') + '</div><div class="criteria-value">Threshold: >' + hvThr + '%' + (ad.stations > 1 ? ' · busiest of ' + ad.stations + ' stations' : '') + '</div></div></div>';
    } else {
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + ICON.warn + '</span><div class="criteria-text"><div class="criteria-label">ADT data not available</div><div class="criteria-value">No TfNSW count station on this road · ' + (isState ? 'State threshold >' + adtThr.toLocaleString() : 'Regional threshold >' + adtThr.toLocaleString()) + '</div></div></div>';
    }
    // Shared traffic-volume criterion row — real AADT vs threshold when we have it, else "not available".
    const trafficCrit = ad
        ? critItem(ad.aadt > adtThr, 'Meets traffic volume + heavy-vehicle thresholds',
            'AADT ' + ad.aadt.toLocaleString() + ' (' + ad.year + ')' + (ad.hv_pct != null ? ' · ' + ad.hv_pct + '% HV' : '') + ' vs >' + adtThr.toLocaleString(), 'crit-opt-traffic')
        : critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', 'ADT not available for this road', 'crit-opt-traffic');

    // Mandatory
    const mandEl = document.getElementById('detail-mandatory');
    if (isState) {
        // "Does not parallel a State Road" — PASS when it does NOT parallel one. Now tested (not assumed).
        mandEl.innerHTML =
            critItem(pbs1, 'S-09: PBS Level 1 vehicle access', 'Facilitates movement of PBS Level 1 or equivalent', 'crit-mand-pbs1') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant') +
            critItem(parPass, 'Does not closely parallel another State Road within 20km',
                par === true ? 'A State Road runs parallel nearby — candidate to review'
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
    // Road train (R-03) — real NHVR membership; shown for Regional roads.
    const roadTrainRow = critItem(nh.roadtrain === true ? true : nh.roadtrain === false ? false : null,
        'R-03: On the road train network',
        nh.roadtrain === true ? 'NHVR Road Train (32m) approved route' : nh.roadtrain === false ? 'Not on the NHVR road train network' : 'NHVR status unavailable', 'crit-opt-roadtrain');
    // Links two State Roads — real geometry topology (a Regional road that joins two State Roads).
    const twoStateRow = critItem(rx.two_state === true ? true : rx.two_state === false ? false : null,
        'Links two State Roads', rx.two_state === true ? 'Both ends meet a State Road' : rx.two_state === false ? 'Does not link two State Roads' : 'Not assessed', 'crit-opt-two-state');
    if (source === 'cv' && (p.criteria_met || p.criteria_failed)) {
        let html = '';
        if (p.criteria_met) p.criteria_met.split('; ').forEach(cc => { html += critItem(true, cc); });
        if (p.criteria_failed) p.criteria_failed.split('; ').forEach(cc => { html += critItem(false, cc); });
        html += evCentres(evCent) + facilityRows;
        optEl.innerHTML = html;
    } else if (c && isState) {
        let html = '';
        const cLabel = urbanArea
            ? 'S-10: Connects Metro Centres / Regional Cities / Major Urban Centres / Major Towns'
            : 'S-07: Connects Metro Centres / Regional Cities / Major Towns to each other';
        html += critItem(!!c.opt.centres, cLabel, centresVal(!!c.opt.centres, evCent), 'crit-opt-centres') + evCentres(evCent);
        if (!urbanArea) html += critItem(!!c.opt.ldr, 'Connects a centre to town centres along a long-distance rural route', null, 'crit-opt-ldr');
        const dLabel = 'S-' + (urbanArea ? '11' : '08') + ': Connects Major Hospitals / Ports / Intermodals / Airports / Employment Centres';
        html += critItem(!!c.opt.dest, dLabel, destVal(!!c.opt.dest, evDests, evHosps, evEmploy), 'crit-opt-dest') + facilityRows;
        html += trafficCrit;
        optEl.innerHTML = html;
    } else if (c && !isState) {
        // Regional roads use the Sydney-Metropolitan criteria set (R-05 / R-06) in urban areas and the
        // Regional & Remote set (R-01 / R-02) elsewhere — mirroring the State urban/rural split above.
        let html = '';
        const rCentres = urbanArea
            ? 'R-05: Connects Metropolitan / Strategic Centres and Urban Centres to each other'
            : 'R-01: Connects Urban Centres and Town Centres to each other';
        const rDest = urbanArea
            ? 'R-06: Connects Major Hospitals / Ports / Airports / Intermodals / Employment Centres'
            : 'R-02: Connects Major/Regional Hospitals / Ports / Airports / Employment Centres';
        html += critItem(!!c.opt.centres, rCentres, centresVal(!!c.opt.centres, evCent), 'crit-opt-centres') + evCentres(evCent);
        html += critItem(!!c.opt.dest, rDest, destVal(!!c.opt.dest, evDests, evHosps, evEmploy), 'crit-opt-dest') + facilityRows;
        html += roadTrainRow + twoStateRow;
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
            html += roadTrainRow + twoStateRow;
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
    const connCentres = c ? !!c.opt.centres : (!!p.connects_major_town || !!p.connects_regional_city);
    const connDest = c ? !!c.opt.dest : !!p.connects_hospital;
    const nFac = evDests.length + evHosps.length;
    document.getElementById('detail-connectivity').innerHTML =
        critItem(!!p._nltn, 'On the National Land Transport Network', p._nltn ? 'Carries segment(s) of the national freight network' : 'Not on the NLTN') +
        critItem(connCentres, 'Connects centres', evCent.length ? (evCent.length + ' named above') : (connCentres ? 'Per assessment' : 'None within range')) +
        critItem(connDest, 'Connects hospitals / ports / airports', nFac ? (nFac + ' named above') : (connDest ? 'Per assessment' : 'None within range'));
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
    set('detail-card-traffic', true, nltn ? 'Determination route' : 'Traffic data');
    set('detail-card-mandatory', true, nltn ? 'National significance criteria (S-01–S-05)' : 'Mandatory criteria');
    set('detail-card-optional', true, nltn ? 'Mandatory criteria' : 'Optional criteria (must meet ≥2)');
    set('detail-card-vehicle', !nltn, 'Vehicle access');
    set('detail-card-connectivity', !nltn, 'Connectivity');
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
