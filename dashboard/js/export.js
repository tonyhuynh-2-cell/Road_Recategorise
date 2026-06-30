// export.js — the "Export all data to Excel" button (exportToExcel, wired to the sidebar link).
//
// Builds a three-sheet, colour-coded .xlsx workbook — Nationally Significant / State Roads /
// Regional Roads — from data/export_rows.json (the same verdicts the map shows, plus each road's
// named connections, criteria reasoning, road id, the LGA(s) it touches, and its length).
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
    { key: 'Zone', w: 22 },
    { key: 'Road ID', w: 12 },
    { key: 'LGA(s) Touched', w: 26, wrap: true },
    { key: 'Length (km)', w: 10 }
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

// --- Entry point ------------------------------------------------------------
function exportToExcel(btn) {
    const original = btn ? btn.innerHTML : null;
    const setBusy = html => { if (btn) { btn.classList.add('is-busy'); btn.innerHTML = html; } };
    const restore = () => { if (btn) { btn.classList.remove('is-busy'); btn.innerHTML = original; } };
    setBusy('<span class="export-ico">⏳</span><span class="export-label">Preparing workbook…</span>');

    Promise.all([
        loadExcelJS(),
        fetch('data/export_rows.json?v=' + Date.now()).then(r => {
            if (!r.ok) throw new Error('export_rows.json ' + r.status);
            return r.json();
        })
    ]).then(function (parts) {
        const ExcelJS = parts[0], data = parts[1];
        const wb = new ExcelJS.Workbook();
        buildSheet(wb, 'Nat. Significant', data.natsig || []);
        buildSheet(wb, 'State Roads', data.state || []);
        buildSheet(wb, 'Regional Roads', data.regional || []);
        return wb.xlsx.writeBuffer();
    }).then(function (buf) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'NSW_Road_Recategorisation_Assessment.xlsx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        restore();
    }).catch(function (err) {
        console.error('Excel export failed:', err);
        if (btn) {
            btn.innerHTML = '<span class="export-ico">⚠</span><span class="export-label">Export failed — see console</span>';
            setTimeout(restore, 2600);
        }
    });
}
