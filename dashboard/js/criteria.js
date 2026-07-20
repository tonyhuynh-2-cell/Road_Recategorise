// criteria.js — criteria reference modal: open/close, deep-link to relevant section, split view.

let _criteriaLoaded = false;
let _criteriaSplit = false;

function openCriteriaModal(sectionId) {
    const modal = document.getElementById('criteria-modal');
    if (!modal) return;
    // Toggle: if already open, close it
    if (!modal.hidden) { closeCriteriaModal(); return; }
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
                if (sectionId) scrollToSection(sectionId);
                else autoScrollToRelevant();
            });
    } else {
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

// Deep-link: when a road is selected, scroll to the relevant criteria section automatically.
function autoScrollToRelevant() {
    const p = (typeof _lastDetailP !== 'undefined') ? _lastDetailP : null;
    if (!p) return;
    const key = roadKeyOf(p);
    const isState = p.admin_class === 'S';
    const zone = (typeof window.ZONE !== 'undefined' && window.ZONE) ? window.ZONE[key] : null;
    const isUrban = zone === 'urban' || (p._urban === true);
    const isNsr = p._nsr === true;

    let sectionId;
    if (isNsr) {
        sectionId = 'cref-natsig';
    } else if (isState && isUrban) {
        sectionId = 'cref-state-urban';
    } else if (isState) {
        sectionId = 'cref-state-regional';
    } else if (!isState && isUrban) {
        sectionId = 'cref-regional-urban';
    } else {
        sectionId = 'cref-regional-regional';
    }
    scrollToSection(sectionId);
}
