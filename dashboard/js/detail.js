// detail.js — the Road Detail panel (showRoadDetail).

function showRoadDetail(p, source) {
    switchTab('detail');
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'block';
    detailLayout('road');

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
    document.getElementById('detail-admin-class').innerHTML = 'Current Classification: <strong>' + (isState ? 'State Road' : 'Regional Road') + '</strong>' + (p._nsr ? ' <span style="color:var(--muted)">· on the National Land Transport Network</span>' : '');

    // Result — graded by the road's own category criteria (no forced pass for being on the NLTN).
    const resultEl = document.getElementById('detail-result');
    const reasonEl = document.getElementById('detail-result-reason');
    if (source === 'nsw') {
        if (p.status === 'green') { resultEl.innerHTML = '<span class="result-line">' + ICON.pass + '<span style="color:#16a34a">MEETS CRITERIA</span></span>'; reasonEl.textContent = 'Passes all testable criteria even without ADT data'; }
        else if (p.status === 'orange') { resultEl.innerHTML = '<span class="result-line">' + ICON.maybe + '<span style="color:#d97706">LIKELY MEETS</span></span>'; reasonEl.textContent = 'Would meet criteria if ADT exceeds the relevant threshold'; }
        else { resultEl.innerHTML = '<span class="result-line">' + ICON.fail + '<span style="color:#dc2626">DOES NOT MEET</span></span>'; reasonEl.textContent = 'Fails mandatory criteria or insufficient connectivity'; }
    } else {
        if (p.meets_criteria) { resultEl.innerHTML = '<span class="result-line">' + ICON.pass + '<span style="color:#16a34a">MEETS CRITERIA</span></span>'; reasonEl.textContent = 'Meets ≥2 optional criteria and all mandatory'; }
        else { resultEl.innerHTML = '<span class="result-line">' + ICON.fail + '<span style="color:#dc2626">DOES NOT MEET</span></span>'; reasonEl.textContent = p.mandatory_pass === 0 ? 'Fails mandatory criteria' : 'Does not meet ≥2 optional criteria'; }
    }

    // Traffic
    const trafficEl = document.getElementById('detail-traffic');
    if (source === 'cv' && p.adt) {
        const thr = isState ? 7000 : 2000;
        const hvThr = isState ? 8 : 6;
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + (p.adt > thr ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">ADT: ' + Math.round(p.adt).toLocaleString() + ' vehicles/day</div><div class="criteria-value">Threshold: >' + thr.toLocaleString() + '</div></div></div>' +
            '<div class="criteria-item"><span class="criteria-icon">' + (p.hv_pct && p.hv_pct > hvThr ? ICON.pass : p.hv_pct ? ICON.fail : ICON.warn) + '</span><div class="criteria-text"><div class="criteria-label">Heavy Vehicles: ' + (p.hv_pct ? p.hv_pct.toFixed(1) + '%' : 'No data') + '</div><div class="criteria-value">Threshold: >' + hvThr + '%</div></div></div>';
    } else {
        trafficEl.innerHTML = '<div class="criteria-item"><span class="criteria-icon">' + ICON.warn + '</span><div class="criteria-text"><div class="criteria-label">ADT data not available</div><div class="criteria-value">' + (isState ? 'State Road threshold: >7,000 rural / >10,000 urban' : 'Regional Road threshold: >2,000 rural') + '</div></div></div>';
    }

    // Computed, area-aware criteria for this road (data/nsw_criteria.json), keyed like the map rollup.
    const c = (source === 'nsw' && window.NSW_CRIT) ? window.NSW_CRIT[roadKeyOf(p)] : null;
    const urbanArea = c ? c.area === 'urban' : !!p._urban;

    // Mandatory
    const mandEl = document.getElementById('detail-mandatory');
    const par = rx.parallel_state_20;   // true = a State Road closely parallels this one (geometry test)
    if (isState) {
        const pbs1 = c ? !!c.mand.pbs1 : !!p.has_pbs1;
        // "Does not parallel a State Road" — PASS when it does NOT parallel one. Now tested (not assumed).
        const parPass = par === true ? false : par === false ? true : null;
        mandEl.innerHTML =
            critItem(pbs1, 'S-09: PBS Level 1 vehicle access', 'Facilitates movement of PBS Level 1 or equivalent') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant') +
            critItem(parPass, 'Does not closely parallel another State Road within 20km',
                par === true ? 'A State Road runs parallel nearby — candidate to review'
                    : par === false ? 'No State Road runs parallel within range' : 'Not assessed');
    } else {
        // R-04 now uses the real NHVR 19m B-double network (falls back to the prior flag if unknown).
        const bd = nh.bdouble19;
        const bdPass = bd === true ? true : bd === false ? false : !!p.has_bdouble;
        mandEl.innerHTML =
            critItem(bdPass, 'R-04: GML/CML 19m B-double access (50+ tonnes)',
                bd === true ? 'NHVR-approved 19m B-double route' : bd === false ? 'Not on the NHVR 19m B-double network' : 'Facilitates movement of 19m B-double routes') +
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
        nh.roadtrain === true ? 'NHVR Road Train (32m) approved route' : nh.roadtrain === false ? 'Not on the NHVR road train network' : 'NHVR status unavailable');
    // Links two State Roads — real geometry topology (a Regional road that joins two State Roads).
    const twoStateRow = critItem(rx.two_state === true ? true : rx.two_state === false ? false : null,
        'Links two State Roads', rx.two_state === true ? 'Both ends meet a State Road' : rx.two_state === false ? 'Does not link two State Roads' : 'Not assessed');
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
        html += critItem(!!c.opt.centres, cLabel, centresVal(!!c.opt.centres, evCent)) + evCentres(evCent);
        if (!urbanArea) html += critItem(!!c.opt.ldr, 'Connects a centre to town centres along a long-distance rural route');
        const dLabel = 'S-' + (urbanArea ? '11' : '08') + ': Connects Major Hospitals / Ports / Intermodals / Airports / Employment Centres';
        html += critItem(!!c.opt.dest, dLabel, destVal(!!c.opt.dest, evDests, evHosps, evEmploy)) + facilityRows;
        html += critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', 'ADT not available statewide');
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
        html += critItem(!!c.opt.centres, rCentres, centresVal(!!c.opt.centres, evCent)) + evCentres(evCent);
        html += critItem(!!c.opt.dest, rDest, destVal(!!c.opt.dest, evDests, evHosps, evEmploy)) + facilityRows;
        html += roadTrainRow + twoStateRow;
        html += critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', urbanArea ? 'Urban Regional threshold: >7,000 ADT' : 'Regional threshold: >2,000 ADT (rural)');
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
        html += critItem(null, 'Meets traffic volume thresholds', 'ADT not available');
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
    switchTab('detail');
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'block';
    detailLayout('nltn');

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
