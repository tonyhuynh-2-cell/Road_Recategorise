// export.js — "Export all data to Excel" button. Builds a 3-sheet, colour-coded .xlsx workbook
// (Nationally Significant / State Roads / Regional Roads) from data/export_rows.json. Rows are
// shaded by verdict (green / amber / red, matching the map), and the verbose columns (Connects To,
// Why, What, LGA) wrap so long text flows downward and stays readable. Uses xlsx-js-style (a
// styling-capable drop-in for SheetJS), loaded lazily from a CDN on first use.

var _xlsxPromise = null;
function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (_xlsxPromise) return _xlsxPromise;
    _xlsxPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
        s.onload = function () { window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX failed to initialise')); };
        s.onerror = function () { reject(new Error('Could not load the Excel library (needs internet)')); };
        document.head.appendChild(s);
    });
    return _xlsxPromise;
}

// Column order -> width (chars) + whether the cell wraps. The wrapped columns are kept narrower so
// the text flows onto more lines (downward) instead of one very wide line.
var EXPORT_COLS = [
    { key: 'Road Name', w: 26, wrap: false },
    { key: 'Connects To', w: 34, wrap: true },
    { key: 'Categorisation', w: 22, wrap: true },
    { key: 'Why', w: 38, wrap: true },
    { key: 'What (criteria tested)', w: 40, wrap: true },
    { key: 'Zone', w: 22, wrap: false },
    { key: 'Road ID', w: 12, wrap: false },
    { key: 'LGA(s) Touched', w: 26, wrap: true },
    { key: 'Length (km)', w: 10, wrap: false }
];
var VERDICT_FILL = {
    green:  { fill: 'C6EFCE', font: '006100' },
    orange: { fill: 'FFEB9C', font: '9C6500' },
    red:    { fill: 'FFC7CE', font: '9C0006' }
};
var HEADER_STYLE = {
    font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1F2937' } },
    alignment: { wrapText: true, vertical: 'center', horizontal: 'left' },
    border: { bottom: { style: 'medium', color: { rgb: '111827' } } }
};
var THIN = { style: 'thin', color: { rgb: 'E5E7EB' } };

function exportToExcel(btn) {
    var label = btn ? btn.innerHTML : null;
    if (btn) { btn.classList.add('is-busy'); btn.innerHTML = '<span class="export-ico">⏳</span><span class="export-label">Preparing workbook…</span>'; }
    var restore = function () { if (btn) { btn.classList.remove('is-busy'); btn.innerHTML = label; } };

    Promise.all([
        loadSheetJS(),
        fetch('data/export_rows.json?v=' + Date.now()).then(function (r) {
            if (!r.ok) throw new Error('export_rows.json ' + r.status); return r.json();
        })
    ]).then(function (res) {
        var XLSX = res[0], data = res[1];
        var cols = EXPORT_COLS.map(function (c) { return c.key; });
        var wb = XLSX.utils.book_new();
        [['Nat. Significant', data.natsig || []], ['State Roads', data.state || []], ['Regional Roads', data.regional || []]]
        .forEach(function (pair) {
            buildSheet(XLSX, wb, pair[0], pair[1], cols);
        });
        XLSX.writeFile(wb, 'NSW_Road_Recategorisation_Assessment.xlsx');
        restore();
    }).catch(function (err) {
        console.error('Excel export failed:', err);
        if (btn) { btn.innerHTML = '<span class="export-ico">⚠</span><span class="export-label">Export failed — see console</span>'; setTimeout(restore, 2600); }
    });
}

function buildSheet(XLSX, wb, name, rows, cols) {
    // verdict per row drives the colour coding; strip the helper key before writing
    var verdicts = rows.map(function (r) { return r._v; });
    var clean = rows.map(function (r) { var o = {}; cols.forEach(function (c) { o[c] = r[c]; }); return o; });
    var ws = XLSX.utils.json_to_sheet(clean, { header: cols });
    ws['!cols'] = EXPORT_COLS.map(function (c) { return { wch: c.w }; });
    var range = XLSX.utils.decode_range(ws['!ref']);
    for (var R = range.s.r; R <= range.e.r; R++) {
        for (var C = range.s.c; C <= range.e.c; C++) {
            var ref = XLSX.utils.encode_cell({ r: R, c: C });
            var cell = ws[ref]; if (!cell) continue;
            if (R === 0) { cell.s = HEADER_STYLE; continue; }
            var spec = EXPORT_COLS[C] || {};
            var st = {
                alignment: { vertical: 'top', wrapText: !!spec.wrap, horizontal: (spec.key === 'Length (km)' ? 'right' : 'left') },
                border: { bottom: THIN, right: THIN }
            };
            if (spec.key === 'Road Name') st.font = { bold: true, color: { rgb: '1F2937' } };
            if (spec.key === 'Categorisation') {
                var v = VERDICT_FILL[verdicts[R - 1]];
                if (v) { st.fill = { fgColor: { rgb: v.fill } }; st.font = { bold: true, color: { rgb: v.font } }; }
            }
            cell.s = st;
        }
    }
    if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: cols.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
}
