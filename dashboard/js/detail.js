// detail.js — the Road Detail panel (showRoadDetail).

function showRoadDetail(p, source) {
    switchTab('detail');
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'block';
    detailLayout('road');

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

    // Optional criteria (must meet >=2)
    const optEl = document.getElementById('detail-optional');
    if (source === 'cv' && (p.criteria_met || p.criteria_failed)) {
        let html = '';
        if (p.criteria_met) p.criteria_met.split('; ').forEach(cc => { html += critItem(true, cc); });
        if (p.criteria_failed) p.criteria_failed.split('; ').forEach(cc => { html += critItem(false, cc); });
        optEl.innerHTML = html;
    } else if (c && isState) {
        let html = '';
        if (urbanArea) {
            html += critItem(!!c.opt.centres, 'S-10: Connects Metro Centres / Regional Cities / Major Urban Centres / Major Towns');
            html += critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', 'ADT not available');
            html += critItem(!!c.opt.dest, 'S-11: Connects Major Hospitals / Ports / Intermodals / Airports / Employment Centres');
            html += critItem(null, 'Heavy vehicle bypass of towns', 'Not assessed');
        } else {
            html += critItem(!!c.opt.centres, 'S-07: Connects Metro Centres / Regional Cities / Major Towns to each other');
            html += critItem(!!c.opt.ldr, 'Connects a centre to town centres along a long-distance rural route');
            html += critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', 'ADT not available');
            html += critItem(!!c.opt.dest, 'S-08: Connects Major Hospitals / Ports / Intermodals / Airports / Employment Centres');
            html += critItem(null, 'Heavy vehicle bypass of towns', 'Not assessed');
        }
        optEl.innerHTML = html;
    } else if (c && !isState) {
        let html = '';
        html += critItem(!!c.opt.centres, 'R-01: Connects Urban Centres and Town Centres to each other');
        html += critItem(!!c.opt.dest, 'R-02: Connects Major/Regional Hospitals / Ports / Airports / Employment Centres');
        html += critItem(null, 'Meets traffic volume + heavy-vehicle thresholds', 'ADT not available');
        optEl.innerHTML = html;
    } else {
        // Fallback when computed criteria are unavailable
        let html = '';
        if (isState) {
            html += critItem(!!(p.connects_major_town), 'S-07/S-10: Connects centres to each other');
            html += critItem(!!p.connects_hospital, 'S-08/S-11: Connects hospitals / ports / airports');
            html += critItem(null, 'Meets traffic volume thresholds', 'ADT not available');
        } else {
            html += critItem(!!p.connects_major_town, 'R-01: Connects Town / Urban Centres');
            html += critItem(!!p.connects_hospital, 'R-02: Connects facilities to centres');
            html += critItem(null, 'Meets traffic volume thresholds', 'ADT not available');
        }
        optEl.innerHTML = html;
    }

    // Vehicle access
    document.getElementById('detail-vehicle-access').innerHTML =
        '<div class="criteria-item"><span class="criteria-icon">' + (p.has_pbs1 ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">PBS Level 1</div></div></div>' +
        '<div class="criteria-item"><span class="criteria-icon">' + (p.has_pbs2b ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">PBS Level 2B</div></div></div>' +
        '<div class="criteria-item"><span class="criteria-icon">' + (p.has_bdouble ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">GML/CML 19m B-double (50+ tonnes)</div></div></div>';

    // Connectivity
    document.getElementById('detail-connectivity').innerHTML =
        '<div class="criteria-item"><span class="criteria-icon">' + (p.is_key_freight_route ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">National Key Freight Route (NLTN)</div></div></div>' +
        '<div class="criteria-item"><span class="criteria-icon">' + (p.connects_major_town || p.connects_regional_city ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">Connects to Major Town / Regional City</div></div></div>' +
        '<div class="criteria-item"><span class="criteria-icon">' + (p.connects_hospital ? ICON.pass : ICON.fail) + '</span><div class="criteria-text"><div class="criteria-label">Near Major Hospital</div></div></div>';
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

    document.getElementById('detail-mandatory').innerHTML =
        critItem(true, 'S-01: Comprises the National Land Transport Network', 'On the NLTN 2020 determination network') +
        critItem(!!p._natMetros, 'S-02·S-03: Connects ≥2 metropolitan / urban centres') +
        critItem(!!p._natPortair, 'S-04·S-05: Connects a Major Port, International Airport or Major Intermodal');

    // Mandatory criteria for Nationally Significant State Roads: PBS Level 2B access (S-06) + no load
    // limits. PBS 2B is not loaded statewide (NHVR layer absent) → shown not-assessed, never forced to pass.
    document.getElementById('detail-optional').innerHTML =
        critItem(null, 'S-06: PBS Level 2B vehicle access', 'Higher Mass Limit freight access — NHVR PBS 2B network not loaded statewide, not assessed') +
        critItem(null, 'No load limits on assets', 'Data unavailable — assumed compliant');
}
