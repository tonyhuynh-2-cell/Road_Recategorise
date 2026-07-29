// criteria.js — criteria reference modal: open/close, deep-link to relevant section, split view.

let _criteriaLoaded = false;
let _criteriaSplit = false;

function openCriteriaModal(sectionId) {
    const modal = document.getElementById('criteria-modal');
    if (!modal) return;
    // Toggle: if already open, close it
    if (!modal.hidden) { closeCriteriaModal(); return; }
    // Keep the top-level overlays mutually exclusive and clear the previous button state.
    if (typeof closeOverridesPanel === 'function') closeOverridesPanel();
    modal.hidden = false;
    // Highlight the criteria button
    var btn = document.getElementById('criteria-btn');
    if (btn) btn.classList.add('criteria-btn-active');
    // Hide zoom controls when modal is open
    document.querySelectorAll('.leaflet-control-zoom').forEach(el => el.style.display = 'none');
    // Load the HTML content once
    if (!_criteriaLoaded) {
        fetch('data/criteria-reference.html?v=' + Date.now())
            .then(r => r.text())
            .then(html => {
                document.getElementById('criteria-modal-body').innerHTML = html;
                _criteriaLoaded = true;
                _annotateCriteria();
                if (sectionId) scrollToSection(sectionId);
                else autoScrollToRelevant();
            });
    } else {
        _annotateCriteria();
        if (sectionId) scrollToSection(sectionId);
        else autoScrollToRelevant();
    }
}

function closeCriteriaModal() {
    const modal = document.getElementById('criteria-modal');
    if (modal) modal.hidden = true;
    // Remove highlight from the criteria button
    var btn = document.getElementById('criteria-btn');
    if (btn) btn.classList.remove('criteria-btn-active');
    // Restore zoom controls
    document.querySelectorAll('.leaflet-control-zoom').forEach(el => el.style.display = '');
    // Exit split mode
    if (_criteriaSplit) toggleCriteriaSplit();
}

function toggleCriteriaSplit() {
    _criteriaSplit = !_criteriaSplit;
    const container = document.querySelector('.map-container');
    const modal = document.getElementById('criteria-modal');
    const btn = document.getElementById('cm-split-btn');
    if (container) container.classList.toggle('cm-split-active', _criteriaSplit);
    if (modal) modal.classList.toggle('cm-split', _criteriaSplit);
    if (btn) btn.classList.toggle('cm-action-active', _criteriaSplit);
    // Leaflet needs to know the map size changed
    setTimeout(function () { if (typeof map !== 'undefined') map.invalidateSize(); }, 350);
}

function scrollToSection(id) {
    const body = document.getElementById('criteria-modal-body');
    const el = body && body.querySelector('#' + id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The criteria section a Road Detail is ACTUALLY being assessed under right now: the road's
// class + zone by default, redirected by the active cross-test / Best-fit lens (detailXtMode).
function _crefSectionFor() {
    const p = (typeof _lastDetailP !== 'undefined') ? _lastDetailP : null;
    if (!p) return null;
    if (window._detailIsNltn || p._nsr === true) return 'cref-natsig';
    const key = roadKeyOf(p);
    const zone = (window.ZONE || {})[key];
    const isUrban = zone === 'urban' || (p._urban === true);
    let cls = p.admin_class === 'S' ? 'state' : 'regional';
    const mode = (typeof detailXtMode === 'function') ? detailXtMode(_lastDetailSource || 'nsw') : false;
    if (mode === 'natsig') return 'cref-natsig';
    if (mode === 'state' || mode === 'regional') cls = mode;
    return 'cref-' + cls + '-' + (isUrban ? 'urban' : 'regional');
}

// Deep-link: when a road is selected, scroll to the relevant criteria section automatically.
function autoScrollToRelevant() {
    const sectionId = _crefSectionFor();
    if (sectionId) scrollToSection(sectionId);
}

// ─── Road-aware criteria reference ───────────────────────────────────────────────────────────
// With a Road Detail open, the reference modal narrows to the criteria set that road is being
// assessed under (own class+zone, or the cross-test / Best-fit lens set), mirrors each
// criterion's pass/fail from the detail panel, and explains WHY under every row — including the
// road's connected POIs with the tier / population thresholds they pass or fail.
let _criteriaShowAll = false;

function refreshCriteriaModal() {
    const modal = document.getElementById('criteria-modal');
    if (!modal || modal.hidden || !_criteriaLoaded) return;
    _annotateCriteria();
}

function _crefClearAnnotations(body) {
    body.querySelectorAll('.cref-why-row, #cref-road-banner').forEach(el => el.remove());
    body.querySelectorAll('.cref-pass, .cref-fail, .cref-warn').forEach(el =>
        el.classList.remove('cref-pass', 'cref-fail', 'cref-warn'));
    body.querySelectorAll('.cref-row-badge').forEach(el => el.remove());
    body.querySelectorAll('[data-cref-hidden]').forEach(el => { el.style.display = ''; el.removeAttribute('data-cref-hidden'); });
}

// The detail panel's already-computed criteria rows (label, value = the "why", verdict).
function _crefDetailRows() {
    const rows = [];
    document.querySelectorAll('#detail-mandatory .criteria-item, #detail-optional .criteria-item').forEach(el => {
        const label = (el.querySelector('.criteria-label') || { textContent: '' }).textContent.trim();
        const value = (el.querySelector('.criteria-value') || { textContent: '' }).textContent.trim();
        const code = (label.match(/^([SR]-\d\d)\b/) || [])[1] || null;
        rows.push({ code, label, value, state: el.getAttribute('data-crit-state'), used: false });
    });
    return rows;
}

// Match a reference-table row to a detail row: by criterion code first, else by keyword overlap
// (the reference lists some optional criteria — LDR, traffic — without an ID of their own).
function _crefMatchRow(code, text, rows) {
    if (code) { const r = rows.find(r => !r.used && r.code === code); if (r) { r.used = true; return r; } }
    const words = String(text).toLowerCase().match(/[a-z]{4,}/g) || [];
    let best = null, bestScore = 1;
    rows.forEach(r => {
        if (r.used) return;
        const hay = r.label.toLowerCase();
        const score = words.reduce((s, w) => s + (hay.indexOf(w) !== -1 ? 1 : 0), 0);
        if (score > bestScore) { best = r; bestScore = score; }
    });
    if (best) best.used = true;
    return best;
}

const _CREF_FMT = n => (n == null || isNaN(+n)) ? '?' : (+n).toLocaleString();

// Per-POI breakdown for a criterion: every connected centre / facility with the tier +
// population threshold it passes or fails (the guide's zone-eased tiers included).
function _crefPoiBreakdown(code, rowLabel) {
    const p = _lastDetailP; if (!p) return '';
    const key = roadKeyOf(p);
    const ev = (window.NSW_EVID || {})[key] || {};
    const zone = (window.ZONE || {})[key];
    const remote = zone === 'remote';
    const label = (rowLabel || '').toLowerCase();
    const out = [];
    const centreish = /centre|centres|town|suburb/.test(label);
    const facilityish = /hospital|port|airport|intermodal|employment|freight/.test(label);
    if (centreish && (ev.centres || []).length) {
        const thr = { 'Regional City': remote ? 15000 : 20000, 'Major Town': remote ? 5000 : 7000, 'Town Centre': remote ? 1000 : 2000 };
        // Which centre tiers this criterion counts: Regional-road criteria (R-xx) accept Town
        // Centres; State-level criteria need Major Town or above. Suburbs (SAL) are the urban form.
        const regionalTest = /^R-/.test(code || '') || /town centre/.test(label);
        let qualifying = 0;
        const seen = new Set();
        (ev.centres || []).forEach(e => {
            const name = String(e.name || '?');
            if (seen.has(name)) return; seen.add(name);
            let ok, why;
            if (e.kind === 'sua') { ok = true; why = 'Significant Urban Area'; }
            else if (e.kind === 'sal') { ok = true; why = 'Suburb (SAL 2021) · pop ' + _CREF_FMT(e.pop) + ' (≥7,000 floor)'; }
            else {
                const tier = e.type || 'Town';
                const need = thr[tier];
                ok = regionalTest ? (tier in thr || tier === 'Significant Urban Area') : (tier !== 'Town Centre');
                why = tier + ' · pop ' + _CREF_FMT(e.pop) +
                    (need ? ' (' + (remote ? 'remote' : 'regional') + ' tier floor ' + _CREF_FMT(need) + '+)' : '');
                if (!ok) why += ' — a ' + tier + ' does not qualify for ' + (code || 'this criterion') + ' (needs Major Town or above)';
            }
            if (ok) qualifying++;
            out.push('<span class="cref-poi ' + (ok ? 'cref-poi-pass' : 'cref-poi-fail') + '">' + (ok ? '✓' : '✗') + ' ' + name + ' — ' + why + '</span>');
        });
        if (out.length) out.unshift('<span class="cref-poi-head">Connected centres (' + qualifying + ' qualifying · pass needs ≥2 distinct):</span>');
    }
    if (facilityish) {
        const pois = [];
        (ev.dest || []).forEach(e => pois.push([e.name, e.ftype || 'destination']));
        (ev.hosp || []).forEach(e => pois.push([e.name, 'Major Hospital']));
        (ev.employ || []).forEach(e => pois.push([e.name, 'Employment centre' + (e.relation === 'intersects' ? ' · intersects road' : '')]));
        if (pois.length) {
            out.push('<span class="cref-poi-head">Connected facilities:</span>');
            pois.forEach(([n, t]) => out.push('<span class="cref-poi cref-poi-pass">✓ ' + n + ' — ' + t + '</span>'));
        }
    }
    return out.join('');
}

function _annotateCriteria() {
    const body = document.getElementById('criteria-modal-body');
    if (!body) return;
    _crefClearAnnotations(body);
    const active = (typeof currentTab !== 'undefined' && currentTab === 'detail') &&
        (typeof _lastDetailP !== 'undefined' && _lastDetailP);
    const sectionId = active ? _crefSectionFor() : null;
    if (!sectionId) return;

    // Banner: what is being assessed, under which criteria set, with a show-all escape hatch.
    const sec = body.querySelector('#' + sectionId);
    const secTitle = sec ? (sec.querySelector('h2') || { textContent: sectionId }).textContent : sectionId;
    const name = (typeof roadName === 'function') ? roadName(_lastDetailP).replace(/<[^>]*>/g, '') : (_lastDetailP.road_name || 'Selected road');
    const mode = (typeof detailXtMode === 'function') ? detailXtMode(_lastDetailSource || 'nsw') : false;
    const modeNote = mode ? ' (re-assessed under this set — not its current category)' : '';
    const banner = document.createElement('div');
    banner.id = 'cref-road-banner';
    banner.innerHTML = '<div class="cref-banner-text"><strong>' + name + '</strong> — assessed against: <em>' +
        secTitle + '</em>' + modeNote + '</div>' +
        '<button type="button" class="cref-banner-btn" onclick="_criteriaShowAll=!_criteriaShowAll;_annotateCriteria();">' +
        (_criteriaShowAll ? 'Focus assessed criteria' : 'Show all criteria') + '</button>';
    body.prepend(banner);

    // Narrow the reference to the assessed set (definitions/thresholds stay — the rows cite them).
    // NB: the tinted wrapper divs each hold BOTH sections of a zone, so hide individual <section>s
    // and only collapse a wrapper once every section inside it is hidden.
    if (!_criteriaShowAll) {
        ['cref-natsig', 'cref-state-regional', 'cref-regional-regional', 'cref-state-urban', 'cref-regional-urban', 'cref-local']
            .filter(id => id !== sectionId)
            .forEach(id => {
                const s = body.querySelector('#' + id);
                if (!s) return;
                s.style.display = 'none';
                s.setAttribute('data-cref-hidden', '1');
            });
        body.querySelectorAll('div[class*="cref-section"]').forEach(w => {
            const secs = w.querySelectorAll('section');
            if (secs.length && Array.from(secs).every(s => s.style.display === 'none')) {
                w.style.display = 'none';
                w.setAttribute('data-cref-hidden', '1');
            }
        });
    }

    // Mirror each criterion row's verdict + inject the "why" under it.
    if (!sec) return;
    const rows = _crefDetailRows();
    sec.querySelectorAll('table.cref-table tbody tr').forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) return;
        const code = (tds[0].textContent.trim().match(/^[SR]-\d\d$/) || [])[0] || null;
        const m = _crefMatchRow(code, tds[1].textContent, rows);
        if (!m || !m.state) return;
        const cls = m.state === 'pass' ? 'cref-pass' : m.state === 'fail' ? 'cref-fail' : 'cref-warn';
        tr.classList.add(cls);
        const badge = document.createElement('span');
        badge.className = 'cref-row-badge';
        badge.textContent = m.state === 'pass' ? '✓ PASSES' : m.state === 'fail' ? '✗ FAILS' : '— N/A';
        tds[0].appendChild(badge);
        const why = document.createElement('tr');
        why.className = 'cref-why-row ' + cls;
        const poi = _crefPoiBreakdown(m.code || code, m.label);
        why.innerHTML = '<td></td><td class="cref-why-cell">' +
            (m.value ? '<span class="cref-why-main">' + m.value + '</span>' : '') + poi + '</td>';
        tr.parentNode.insertBefore(why, tr.nextSibling);
    });
    body.scrollTop = 0;
}
