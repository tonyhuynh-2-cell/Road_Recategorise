// export.js — the scoped "Export to Excel…" menu + workbook builder.
//
// The sidebar-foot link opens a SCOPE menu (toggleExport): whole network, flagged (pinned) roads,
// any tab's group (Nat.Sig / State / Regional / Local / Sydney / Clarence Valley) or a CUSTOM
// hand-picked set — roads added via the typeahead in the menu (reusing search.js's ROAD_INDEX)
// or Shift+clicked on the map (toggleCustomRoad, wired in init.js's road click handlers).
// Every count is computed LIVE from the same predicates the tabs use (exportScopeKeys below);
// nothing is hardcoded. exportToExcel(scope, keys) filters which roads enter the EXISTING
// workbook generation.
//
// Builds a colour-coded .xlsx workbook — Nationally Significant / State Roads / Regional Roads
// sheets — from data/export_declared_rows.json (the same one-per-road verdicts the map shows, plus
// connections, criteria reasoning, road id, the LGA(s) it touches, and its length). Rows key to
// the live declared-road aggregate by the hidden `_key` field. `Road ID` remains the sourced TfNSW
// administrative number for users, while `Mapped Sections` discloses physical source breaks. The
// 'local' scope instead sheets the loaded suburb's council roads live (localExportRows, local.js).
//
// Styling: Categorisation cells are shaded green / amber / red to match the map legend; the Why and
// What columns lead every line with the criterion code (S-04, R-01, …) — the whole cell carries a
// light wash and ONLY the codes are bold-coloured, via rich text. ExcelJS (the rich-text + styling
// capable writer) is loaded lazily from a CDN the first time you export.

// --- Layout & palette -------------------------------------------------------
// Column order + width (chars). `wrap` wraps long text; `code` marks a criteria column whose
// leading codes get coloured.
const EXPORT_COLS = [
    { key: 'Road Name', w: 26 },
    { key: 'Connects To', w: 34, wrap: true },
    { key: 'Categorisation', w: 22, wrap: true },
    { key: 'Why', w: 40, wrap: true, code: true },
    { key: 'What (criteria tested)', w: 44, wrap: true, code: true },
    { key: 'HV Networks (NHVR)', w: 24, wrap: true },
    { key: 'AADT (TfNSW)', w: 20, wrap: true },
    { key: 'Zone', w: 22 },
    { key: 'Road ID', w: 12 },
    { key: 'LGA(s) Touched', w: 26, wrap: true },
    { key: 'Length (km)', w: 10 },
    { key: 'Mapped Sections', w: 14 }
];
const VERDICT_FILL = {            // Categorisation shading (Excel's good / neutral / bad palette)
    green:  { fill: 'FFC6EFCE', font: 'FF006100' },
    orange: { fill: 'FFFFEB9C', font: 'FF9C6500' },
    red:    { fill: 'FFFFC7CE', font: 'FF9C0006' }
};
const INK = 'FF1F2937';          // default dark text
const CODE_INK = 'FF1D4ED8';     // bold colour on JUST the S-0_/R-0_ codes
const CODE_WASH = 'FFFEF7E0';    // light wash behind the whole Why / What cell
const HEADER_FILL = 'FF1F2937';
const HAIRLINE = { style: 'thin', color: { argb: 'FFE5E7EB' } };
const CODE_RE = /^([SR]-\d+(?:·[SR]-\d+)?)([\s\S]*)$/;   // leading criterion code on a line

function solidFill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } }; }

// --- Lazy ExcelJS loader ----------------------------------------------------
let _excelLib = null;
function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (_excelLib) return _excelLib;
    _excelLib = new Promise(function (resolve, reject) {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
        s.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS failed to initialise'));
        s.onerror = () => reject(new Error('Could not load the Excel library (needs internet)'));
        document.head.appendChild(s);
    });
    return _excelLib;
}

// --- Worksheet building -----------------------------------------------------
// Multi-line criteria string -> rich text: bold-colour the leading code on each line, leave the
// rest plain, and preserve the line breaks inside the cell.
function codeRichText(value) {
    const lines = String(value == null ? '' : value).split('\n');
    const richText = [];
    lines.forEach(function (line, i) {
        const tail = i < lines.length - 1 ? '\n' : '';
        const m = line.match(CODE_RE);
        if (m) {
            richText.push({ text: m[1], font: { bold: true, color: { argb: CODE_INK } } });
            richText.push({ text: m[2] + tail, font: { color: { argb: INK } } });
        } else {
            richText.push({ text: line + tail, font: { color: { argb: INK } } });
        }
    });
    return { richText: richText };
}

// Add one fully-styled worksheet for a category (frozen + filtered header, then a row per road).
function buildSheet(wb, name, rows) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = EXPORT_COLS.map(c => ({ header: c.key, key: c.key, width: c.w }));

    const head = ws.getRow(1);
    head.height = 28;
    head.eachCell(function (cell) {
        cell.fill = solidFill(HEADER_FILL);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10.5 };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        cell.border = { bottom: { style: 'medium', color: { argb: 'FF111827' } } };
    });

    rows.forEach(function (r) {
        const values = {};
        EXPORT_COLS.forEach(c => { values[c.key] = r[c.key]; });
        const row = ws.addRow(values);
        EXPORT_COLS.forEach(function (spec, i) {
            const cell = row.getCell(i + 1);
            cell.alignment = { vertical: 'top', horizontal: spec.key === 'Length (km)' ? 'right' : 'left', wrapText: !!spec.wrap, indent: 0 };
            cell.border = { bottom: HAIRLINE, right: HAIRLINE };
            if (spec.code) {                                   // criteria column: light wash + coloured codes
                cell.value = codeRichText(cell.value);
                cell.fill = solidFill(CODE_WASH);
            } else if (spec.key === 'Road Name') {
                cell.font = { bold: true, color: { argb: INK } };
            } else if (spec.key === 'Categorisation') {
                const v = VERDICT_FILL[r._v];
                if (v) { cell.fill = solidFill(v.fill); cell.font = { bold: true, color: { argb: v.font } }; }
            }
        });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLS.length } };
}

// --- Export scopes ------------------------------------------------------------
// One row per scope in the menu. Counts and key sets are computed LIVE from the very predicates
// the tabs use: NSW_AGG admin_class/_nsr/_inSyd/_inCV (grading.js/panels.js), the flaggedRoads
// pin set (flagged.js), NLTN_CAT_COUNTS (the Nat. Significant lens subject, init.js), the loaded
// suburb's road groups (local.js), and the hand-picked custom set below.
// Grouped so the nine scopes read as four short, scannable sections rather than one flat list.
// `group` drives the section headers in the menu (see _emBuildScopeRows); the dot echoes the
// scope's tab colour. Reordering here is safe — every count/key lookup is keyed by id, never order.
const EXPORT_SCOPE_DEFS = [
    { id: 'all',      label: 'All assessed roads',          group: 'Whole network',    dot: 'var(--ink)' },
    { id: 'natsig',   label: 'Nationally Significant',      group: 'By road category', dot: '#dc2626' },
    { id: 'state',    label: 'State Roads',                 group: 'By road category', dot: '#dc2626' },
    { id: 'regional', label: 'Regional Roads',              group: 'By road category', dot: '#dc2626' },
    { id: 'local',    label: 'Local roads (loaded suburb)', group: 'By road category', dot: '#dc2626' },
    { id: 'sydney',   label: 'Sydney urban area',           group: 'By area',          dot: '#16a34a' },
    { id: 'cv',       label: 'Clarence Valley LGA',         group: 'By area',          dot: '#16a34a' },
    { id: 'flagged',  label: 'Flagged (pinned) roads',      group: 'Your selections',  dot: '#dc2626' },
    { id: 'custom',   label: 'Custom selection',            group: 'Your selections',  dot: '#7c3aed' }
];

const exportCustom = new Set();   // the hand-picked road keys (typeahead + Shift+click)

// The road keys a scope covers — the SAME membership tests the tabs run (nswInView / scopeCounts).
function exportScopeKeys(scope) {
    const agg = (typeof NSW_AGG !== 'undefined' && NSW_AGG) || {};
    const keys = [];
    const sr = a => a.admin_class === 'S' || a.admin_class === 'R';
    if (scope === 'flagged') {
        if (typeof flaggedRoads !== 'undefined') flaggedRoads.forEach(k => { if (agg[k]) keys.push(k); });
    } else if (scope === 'custom') {
        exportCustom.forEach(k => { if (agg[k]) keys.push(k); });
    } else {
        for (const k in agg) {
            const a = agg[k];
            if (!sr(a)) continue;
            if (scope === 'all') keys.push(k);
            else if (scope === 'state' && a.admin_class === 'S' && !a._nsr) keys.push(k);        // the State lens predicate
            else if (scope === 'regional' && a.admin_class === 'R') keys.push(k);                // the Regional lens predicate
            else if (scope === 'sydney' && a._inSyd) keys.push(k);                               // the Sydney tab predicate
            else if (scope === 'cv' && a._inCV) keys.push(k);                                    // the Clarence Valley tab predicate
        }
    }
    return keys;
}

// Live scope count. Nat. Significant counts NLTN determination routes (the lens's subject);
// Local counts the loaded suburb's roads; everything else counts its key set.
function exportScopeCount(scope) {
    if (scope === 'natsig') return (window.NLTN_CAT_COUNTS || { total: 0 }).total;
    if (scope === 'local') return (typeof localLoadedInfo === 'function') ? localLoadedInfo().count : 0;
    return exportScopeKeys(scope).length;
}

// --- Scope menu ---------------------------------------------------------------
let _emOpen = false;
let _emScopeSel = 'all';

function toggleExport(open) {
    const menu = document.getElementById('export-menu');
    const link = document.getElementById('export-toggle');
    if (!menu) return;
    _emOpen = (open === undefined) ? !_emOpen : !!open;
    menu.classList.toggle('em-open', _emOpen);
    if (link) link.setAttribute('aria-expanded', String(_emOpen));
    if (_emOpen) {
        updateExportMenu();
        // The menu opens UPWARD from a trigger at the very bottom of the (scrollable) sidebar. If the
        // trigger sits under the fold, the menu spills past the viewport bottom — pull the trigger
        // fully into view first so the whole menu (incl. the Download button) is always reachable.
        const wrap = document.getElementById('export-wrap');
        if (wrap && wrap.scrollIntoView) { try { wrap.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch (e) { wrap.scrollIntoView(false); } }
    } else emHideSuggest();
}

function _emBuildScopeRows() {
    const box = document.getElementById('em-scope');
    if (!box || box.childElementCount) return;
    let html = '', lastGroup = null;
    EXPORT_SCOPE_DEFS.forEach(function (d) {
        if (d.group !== lastGroup) { html += '<div class="em-group">' + d.group + '</div>'; lastGroup = d.group; }
        html += '<label class="em-opt" data-scope="' + d.id + '">' +
            '<input type="radio" name="em-scope" value="' + d.id + '"' + (d.id === _emScopeSel ? ' checked' : '') +
            ' onchange="emScopeChanged(this.value)">' +
            '<span class="em-dot" style="background:' + d.dot + '"></span>' +
            '<span class="em-opt-label">' + d.label + '</span>' +
            '<span class="em-count" data-count="' + d.id + '">–</span></label>';
    });
    box.innerHTML = html;
}

// Recompute every count from its live predicate and sync the disabled/label states.
function updateExportMenu() {
    _emBuildScopeRows();
    EXPORT_SCOPE_DEFS.forEach(function (d) {
        const n = exportScopeCount(d.id);
        const cEl = document.querySelector('#em-scope .em-count[data-count="' + d.id + '"]');
        const row = document.querySelector('#em-scope .em-opt[data-scope="' + d.id + '"]');
        // Local roads only become exportable once a suburb is loaded.
        const dis = d.id === 'local' && !n;
        if (cEl) cEl.textContent = dis ? '—' : n.toLocaleString();
        if (row) {
            row.classList.toggle('em-disabled', dis);
            const inp = row.querySelector('input');
            if (inp) inp.disabled = dis;
        }
    });
    if (_emScopeSel === 'local' && !exportScopeCount('local')) emScopeChanged('all', true);
    emRenderChips();
    emSyncFoot();
}

function emScopeChanged(scope, forceCheck) {
    _emScopeSel = scope;
    if (forceCheck) { const inp = document.querySelector('#em-scope input[value="' + scope + '"]'); if (inp) inp.checked = true; }
    const cust = document.getElementById('em-custom');
    if (cust) cust.hidden = scope !== 'custom';
    emSyncFoot();
}

// The Download button carries the LIVE count of the selected scope; empty scopes can't download.
function emSyncFoot() {
    const btn = document.getElementById('em-download');
    if (!btn || btn.dataset.busy === '1') return;
    const n = exportScopeCount(_emScopeSel);
    btn.textContent = 'Download ' + n.toLocaleString() + ' road' + (n === 1 ? '' : 's') + ' (.xlsx)';
    btn.disabled = !n;
}

// --- Custom selection: typeahead (reuses search.js's ROAD_INDEX + scoring) + chips + map picks ---

// One-shot "keep the menu open through the next bubbling click". Menu-internal actions that mutate
// the DOM — a map pick (Shift+click add/remove) OR removing a chip / picking a suggestion (both
// rebuild their list via innerHTML, which DETACHES the very element that was clicked) — leave the
// click-away handler below with a target that's no longer inside the menu, so it would wrongly close.
// Setting this flag right before the mutation makes that one bubbling click a no-op. It's also more
// robust than the old e.shiftKey guard, which could miss a shift lost in Leaflet's canvas hit-testing.
// Self-clears next tick if no click follows (e.g. keyboard-driven add).
let _emKeepOpenForPick = false;
function _emSuppressNextDocClick() {
    _emKeepOpenForPick = true;
    setTimeout(function () { _emKeepOpenForPick = false; }, 0);
}

let _emSg = [];        // current suggestion keys, in rendered order
let _emSgIdx = -1;     // keyboard-highlighted suggestion (Tab / arrows walk this); -1 = none
function emSearchInput(val) {
    const box = document.getElementById('em-suggest');
    if (!box) return;
    const q = String(val || '').trim().toLowerCase();
    if (!q || typeof ROAD_INDEX === 'undefined' || !ROAD_INDEX.length) { emHideSuggest(); _emSg = []; return; }
    const scored = [];
    for (let i = 0; i < ROAD_INDEX.length; i++) {
        const s = _scoreRoad(ROAD_INDEX[i], q);
        if (s >= 0) scored.push([s, ROAD_INDEX[i]]);
    }
    scored.sort((a, b) => b[0] - a[0] || ((b[1].pri ? 1 : 0) - (a[1].pri ? 1 : 0)) || a[1].name.localeCompare(b[1].name));
    const seen = {}, top = [];
    for (let i = 0; i < scored.length && top.length < 8; i++) {
        const e = scored[i][1];
        if (seen[e.key] || exportCustom.has(e.key)) continue;   // one row per road, already-picked hidden
        seen[e.key] = 1;
        top.push(e);
    }
    _emSg = top.map(e => e.key);
    _emSgIdx = -1;   // fresh results — nothing highlighted until the user Tabs/arrows in
    if (!top.length) { box.innerHTML = '<div class="em-sg"><div class="em-sg-meta">No matching road</div></div>'; box.classList.add('on'); return; }
    box.innerHTML = top.map(function (e) {
        const key = e.key.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return '<div class="em-sg" data-key="' + key + '" role="option" aria-selected="false"' +
            ' onmousedown="event.preventDefault(); emAddCustom(this.getAttribute(\'data-key\'))">' +
            '<div class="em-sg-name">' + roadLabel({ road_name: e.name, ref: e.ref, admin_class: e.cls }) + '</div>' +
            '<div class="em-sg-meta">' + (e.num ? 'ID ' + e.num : 'no ID') + ' · ' + (e.cls === 'S' ? 'State' : 'Regional') + '</div></div>';
    }).join('');
    box.classList.add('on');
}

// Highlight suggestion #idx (wraps), sync aria, and scroll it into view within the dropdown.
function _emSgHighlight(idx) {
    const box = document.getElementById('em-suggest');
    if (!box) return;
    const opts = box.querySelectorAll('.em-sg[data-key]');
    opts.forEach(function (el, i) {
        const on = i === idx;
        el.classList.toggle('em-on', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
}

// Keyboard within the search field: Tab / ArrowDown walk DOWN the suggestions (Shift+Tab / ArrowUp
// walk up), wrapping around; Enter adds the highlighted one (or the top match if none highlighted);
// Escape closes the dropdown. Tab is intercepted (preventDefault) so focus stays in the field.
function emSearchKey(ev) {
    const n = _emSg.length;
    if (ev.key === 'Escape') { emHideSuggest(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); if (n) emAddCustom(_emSg[_emSgIdx >= 0 && _emSgIdx < n ? _emSgIdx : 0]); return; }
    if (!n) return;
    let dir = 0;
    if (ev.key === 'ArrowDown') dir = 1;
    else if (ev.key === 'ArrowUp') dir = -1;
    else if (ev.key === 'Tab') dir = ev.shiftKey ? -1 : 1;
    if (!dir) return;
    ev.preventDefault();   // keep focus in the field; move the highlight instead of tabbing away
    _emSgIdx = _emSgIdx < 0 ? (dir > 0 ? 0 : n - 1) : (_emSgIdx + dir + n) % n;
    _emSgHighlight(_emSgIdx);
}
function emHideSuggest() {
    const box = document.getElementById('em-suggest');
    if (box) { box.classList.remove('on'); box.innerHTML = ''; }
    _emSgIdx = -1;
}

// Purple accent on the picked roads — the SAME setStyle/resetStyle idiom the hover/selection
// paths already use on the shared overlay (no new mechanism). Purely informative: any lens
// restyle sweeps it; the chips below stay the source of truth for the selection.
function _emPickStyle(key, on) {
    const layers = (window.NSW_ROAD_LAYERS || {})[key] || [];
    layers.forEach(function (l) {
        if (typeof isSelected === 'function' && isSelected(l)) return;   // never fight the blue selection
        if (on) l.setStyle({ color: '#7c3aed', weight: 5, opacity: 1 });
        else if (typeof nswLayer !== 'undefined' && nswLayer) nswLayer.resetStyle(l);
    });
}

function emAddCustom(key) {
    if (!key || typeof NSW_AGG === 'undefined' || !NSW_AGG[key]) return;
    _emSuppressNextDocClick();   // picking a suggestion rebuilds the list mid-click — don't let that close the menu
    exportCustom.add(key);
    _emPickStyle(key, true);
    const inp = document.getElementById('em-search-input');
    if (inp) { inp.value = ''; inp.focus(); }
    emHideSuggest();
    emRenderChips();
    emAfterCustomChange();
}
function emRemoveCustom(key) {
    _emSuppressNextDocClick();   // the × rebuilds the chip list, detaching this button mid-click — keep the menu open
    exportCustom.delete(key);
    _emPickStyle(key, false);
    emRenderChips();
    emAfterCustomChange();
}
function emAfterCustomChange() {
    const cEl = document.querySelector('#em-scope .em-count[data-count="custom"]');
    if (cEl) cEl.textContent = exportCustom.size.toLocaleString();
    emSyncFoot();
}
function emRenderChips() {
    const box = document.getElementById('em-chips');
    if (!box) return;
    const agg = (typeof NSW_AGG !== 'undefined' && NSW_AGG) || {};
    let h = '';
    exportCustom.forEach(function (k) {
        const a = agg[k] || {};
        const esc = String(k).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        h += '<span class="em-chip">' + roadLabel(a) +
            '<button type="button" data-key="' + esc + '" aria-label="Remove ' + roadName(a) + ' from the selection"' +
            ' onclick="emRemoveCustom(this.dataset.key)">×</button></span>';
    });
    box.innerHTML = h || '<span class="em-empty">No roads picked yet — search above or Shift+click roads on the map.</span>';
}

// Shift+click on a map road (init.js routes the shiftKey branch of the existing click handlers
// here): toggle the road in/out of the custom set, select the Custom scope, surface the menu.
function toggleCustomRoad(k) {
    if (!k || typeof NSW_AGG === 'undefined' || !NSW_AGG[k]) return;
    const adding = !exportCustom.has(k);
    if (adding) exportCustom.add(k); else exportCustom.delete(k);
    _emPickStyle(k, adding);
    _emScopeSel = 'custom';
    _emSuppressNextDocClick();   // keep the menu open through this pick's bubbling click (add or remove)
    if (!_emOpen) toggleExport(true); else updateExportMenu();
    emScopeChanged('custom', true);
    if (typeof showMapRefresh === 'function')
        showMapRefresh((adding ? 'Added to export: ' : 'Removed from export: ') + roadName(NSW_AGG[k]) + ' (' + exportCustom.size + ' picked)', 1500);
}

// Click-away + Escape close. A map pick (Shift+click add/remove) sets _emKeepOpenForPick so its
// bubbling click is ignored here; genuine outside clicks still close. The e.shiftKey check stays as
// a second line of defence for shift-clicks that don't resolve to a road (empty map, hidden lens).
document.addEventListener('click', function (e) {
    if (_emKeepOpenForPick) { _emKeepOpenForPick = false; return; }
    if (!_emOpen || e.shiftKey) return;
    const wrap = document.getElementById('export-wrap');
    if (wrap && !wrap.contains(e.target)) toggleExport(false);
});
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _emOpen) toggleExport(false);
});

// --- Entry point ------------------------------------------------------------
// scope filters which roads enter the EXISTING workbook generation: 'all' = the original
// three-sheet workbook; 'natsig' = the national sheet; 'local' = the loaded suburb's roads
// (built live); anything else filters the State/Regional sheets to the scope's key set
// ('flagged' = the pin set, 'custom' = the picked keys). `keys` overrides the key set.
const EXPORT_FILE_TAG = {
    all: 'Assessment', flagged: 'Flagged_Roads', natsig: 'Nationally_Significant',
    state: 'State_Roads', regional: 'Regional_Roads', local: 'Local_Roads',
    sydney: 'Sydney_Urban_Area', cv: 'Clarence_Valley', custom: 'Custom_Selection'
};
function runExport() { exportToExcel(_emScopeSel || 'all'); }

function exportToExcel(scope, keys, fbBtn) {
    scope = scope || 'all';
    // Progress shows on the button that triggered it: the menu's Download button, or (for the split
    // button's one-click "export all") its primary half. innerHTML is snapshotted so that button's
    // icon + label come back intact on restore.
    const btn = fbBtn || document.getElementById('em-download');
    const originalHTML = btn ? btn.innerHTML : null;
    const setBusy = t => { if (btn) { btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = t; } };
    const restore = () => { if (btn) { btn.dataset.busy = ''; btn.disabled = false; btn.innerHTML = originalHTML; if (btn.id === 'em-download') emSyncFoot(); } };
    setBusy('Preparing workbook…');

    Promise.all([
        loadExcelJS(),
        fetch('data/export_declared_rows.json?v=' + Date.now()).then(r => {
            if (!r.ok) throw new Error('export_declared_rows.json ' + r.status);
            return r.json();
        })
    ]).then(function (parts) {
        const ExcelJS = parts[0], data = parts[1];
        const wb = new ExcelJS.Workbook();
        if (scope === 'all') {
            buildSheet(wb, 'Nat. Significant', data.natsig || []);
            buildSheet(wb, 'State Roads', data.state || []);
            buildSheet(wb, 'Regional Roads', data.regional || []);
        } else if (scope === 'natsig') {
            buildSheet(wb, 'Nat. Significant', data.natsig || []);
        } else if (scope === 'local') {
            const info = (typeof localLoadedInfo === 'function') ? localLoadedInfo() : { suburb: '' };
            const rows = (typeof localExportRows === 'function') ? localExportRows() : [];
            buildSheet(wb, 'Local roads' + (info.suburb ? ' — ' + info.suburb.slice(0, 18) : ''), rows);
        } else {
            // Key-set scopes: rows key 1:1 to the live per-road aggregate via 'Road ID'
            // (roadKeyOf), with a name-derived fallback for any keyless road.
            const set = {};
            (keys || exportScopeKeys(scope)).forEach(k => { set[k] = 1; });
            const match = r => set[r._key || r['Road ID']] === 1 || set['n:' + String(r['Road Name'] || '').trim().toLowerCase()] === 1;
            const st = (data.state || []).filter(match);
            const rg = (data.regional || []).filter(match);
            if (st.length) buildSheet(wb, 'State Roads', st);
            if (rg.length) buildSheet(wb, 'Regional Roads', rg);
            if (!st.length && !rg.length) buildSheet(wb, 'Roads', []);   // never an invalid zero-sheet workbook
        }
        return wb.xlsx.writeBuffer();
    }).then(function (buf) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'NSW_Road_Recategorisation_' + (EXPORT_FILE_TAG[scope] || 'Assessment') + '.xlsx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        restore();
        if (_emOpen) toggleExport(false);
    }).catch(function (err) {
        console.error('Excel export failed:', err);
        if (btn) {
            btn.textContent = 'Export failed — see console';
            setTimeout(restore, 2600);
        }
    });
}
