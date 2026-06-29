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
    const evCent = evd.centres || [], evHosps = evd.hospitals || [], evDests = evd.dests || [];
    showConnections({ centres: evCent, hospitals: evHosps, dests: evDests });   // ring/outline + label on the map

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
    if (isState) {
        const pbs1 = c ? !!c.mand.pbs1 : !!p.has_pbs1;
        mandEl.innerHTML =
            critItem(pbs1, 'S-09: PBS Level 1 vehicle access', 'Facilitates movement of PBS Level 1 or equivalent') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant') +
            (urbanArea
                ? critItem(null, 'Does not closely parallel a State Road (unless similar traffic volumes)', 'Urban criterion — assumed compliant')
                : critItem(null, 'Does not parallel a rural State Road within 20km', 'Not assessed (rural criterion)'));
    } else {
        mandEl.innerHTML =
            critItem(!!p.has_bdouble, 'R-04: GML/CML 19m B-double access (50+ tonnes)', 'Facilitates movement of 19m B-double routes') +
            critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant');
    }

    // Optional criteria (must meet >=2) — each connectivity criterion lists the actual entities it
    // connects (the evidence) and, when it fails, why. Click an entity to pan to it on the map.
    const optEl = document.getElementById('detail-optional');
    const centresVal = function (pass, items) {
        if (pass) return items.length ? ('Connects ' + items.length + ' centre' + (items.length > 1 ? 's' : '') + ' (named below)') : 'Connects centres (per assessment)';
        return items.length ? (items.length + ' centre' + (items.length > 1 ? 's' : '') + ' nearby — needs ≥2 connected') : 'No qualifying centre within range';
    };
    const destVal = function (pass, ds, hs) {
        const n = ds.length + hs.length;
        if (pass) return n ? ('Connects ' + n + ' facilit' + (n > 1 ? 'ies' : 'y') + ' (named below)') : 'Connects a facility (per assessment)';
        return n ? (n + ' nearby — not a qualifying connection') : 'No hospital / port / airport / intermodal within range';
    };
    if (source === 'cv' && (p.criteria_met || p.criteria_failed)) {
        let html = '';
        if (p.criteria_met) p.criteria_met.split('; ').forEach(cc => { html += critItem(true, cc); });
        if (p.criteria_failed) p.criteria_failed.split('; ').forEach(cc => { html += critItem(false, cc); });
        html += evCentres(evCent) + evList(evDests, 'dest') + evList(evHosps, 'hosp');
        optEl.innerHTML = html;
    } else if (c && isState) {
        let html = '';
        const cLabel = urbanArea
            ? 'S-10: Connects Metro Centres / Regional Cities / Major Urban Centres / Major Towns'
            : 'S-07: Connects Metro Centres / Regional Cities / Major Towns to each other';
        html += critItem(!!c.opt.centres, cLabel, centresVal(!!c.opt.centres, evCent)) + evCentres(evCent);
        if (!urbanArea) html += critItem(!!c.opt.ldr, 'Connects a centre to town centres along a long-distance rural route');
        const dLabel = 'S-' + (urbanArea ? '11' : '08') + ': Connects Major Hospitals / Ports / Intermodals / Airports / Employment Centres';
        html += critItem(!!c.opt.dest, dLabel, destVal(!!c.opt.dest, evDests, evHosps)) + evList(evDests, 'dest') + evList(evHosps, 'hosp');
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
        html += critItem(!!c.opt.dest, rDest, destVal(!!c.opt.dest, evDests, evHosps)) + evList(evDests, 'dest') + evList(evHosps, 'hosp');
        html += critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', urbanArea ? 'Urban Regional threshold: >7,000 ADT' : 'Regional threshold: >2,000 ADT (rural)');
        optEl.innerHTML = html;
    } else {
        // Fallback when computed criteria are unavailable
        let html = '';
        if (isState) {
            html += critItem(!!p.connects_major_town, 'S-07/S-10: Connects centres to each other', centresVal(!!p.connects_major_town, evCent)) + evCentres(evCent);
            html += critItem(!!p.connects_hospital, 'S-08/S-11: Connects hospitals / ports / airports', destVal(!!p.connects_hospital, evDests, evHosps)) + evList(evDests, 'dest') + evList(evHosps, 'hosp');
        } else {
            html += critItem(!!p.connects_major_town, 'R-01/R-05: Connects Urban / Town Centres', centresVal(!!p.connects_major_town, evCent)) + evCentres(evCent);
            html += critItem(!!p.connects_hospital, 'R-02/R-06: Connects facilities to centres', destVal(!!p.connects_hospital, evDests, evHosps)) + evList(evDests, 'dest') + evList(evHosps, 'hosp');
        }
        html += critItem(null, 'Meets traffic volume thresholds', 'ADT not available');
        optEl.innerHTML = html;
    }

    // Vehicle access
    // PBS Level 2B is the Nationally Significant mandatory (S-06) and is shown only on that tab;
    // State/Regional vehicle access lists PBS Level 1 and 19m B-double (their relevant standards).
    document.getElementById('detail-vehicle-access').innerHTML =
        '<div class="criteria-item"><span class="criteria-icon">' + (p.has_pbs1 ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">PBS Level 1</div></div></div>' +
        '<div class="criteria-item"><span class="criteria-icon">' + (p.has_bdouble ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">GML/CML 19m B-double (50+ tonnes)</div></div></div>';

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
