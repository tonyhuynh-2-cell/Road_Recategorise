// utils.js — pure helpers: road keys/lengths/labels, predicates, criteria-row + town-icon builders.

// A road is many segments; group them so a click/hover affects the whole road.
function roadKeyOf(p) {
    const n = (p.road_number != null && String(p.road_number).trim() !== '') ? String(p.road_number).trim() : '';
    return n || (p.road_name ? 'n:' + String(p.road_name).trim().toLowerCase() : '');
}

function roadLenKm(g) {
    let L = 0;
    const run = c => { for (let i = 1; i < c.length; i++) { const a = c[i - 1], b = c[i]; const m = (a[1] + b[1]) / 2 * Math.PI / 180; const dx = (b[0] - a[0]) * Math.cos(m), dy = b[1] - a[1]; L += Math.sqrt(dx * dx + dy * dy) * 111.32; } };
    if (!g) return 0;
    if (g.type === 'LineString') run(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(run);
    return L;
}

function weightForKm(km) { return Math.max(1.0, Math.min(4.0, 0.75 + Math.log10(1 + km) * 1.05)); }

function titleCase(s) { return String(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }

function isHighSpeed(p) {
    const n = String(p.road_name || '');
    return /\b(MOTORWAY|FREEWAY|EXPRESSWAY|TOLLWAY)\b/i.test(n) || /^M\d/i.test(n);
}

// Dash any route-numbered road (A / B / D / M shield) as well as motorways/freeways.
function isDashed(p) { return !!(p.ref) || isHighSpeed(p); }

// Render one criteria row. state: true=pass, false=fail, null/undefined=not assessed (warn).
function critItem(state, label, value) {
    const icon = state === true ? ICON.pass : state === false ? ICON.fail : ICON.warn;
    return '<div class="criteria-item"><span class="criteria-icon">' + icon + '</span><div class="criteria-text"><div class="criteria-label">' + label + '</div>' + (value ? '<div class="criteria-value">' + value + '</div>' : '') + '</div></div>';
}

function roadName(p) {
    if (p.road_name && String(p.road_name).trim()) return titleCase(p.road_name);
    return p.admin_class === 'S' ? 'State road' : 'Regional road';
}

function roadRef(p) { return p.ref || null; }

function roadLabel(p) {
    const ref = roadRef(p);
    if (!ref) return roadName(p);
    return '<span class="rl-shield rl-' + ref[0] + '">' + ref + '</span> ' + roadName(p);
}

// Motorway/highway exit ramps & connectors clutter interchanges — hide them.
function isRamp(p) {
    const n = String(p.road_name || '').toUpperCase();
    return /\b(RAMP|EXIT|ENTRY|ENTRANCE|SLIP|INTERCHANGE|PRELIM|DEVIATION|CONNECTOR)\b/.test(n) || /MOTORWAY LINK/.test(n) || /\bFR\b/.test(n) || /HILLS (TO|FR)\b/.test(n) || /BOUND BYPASS/.test(n);
}

// Minimalist pin marker (teardrop with a transparent centre) for towns/cities
function townIcon(size, accent) {
    const svg = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" fill="${accent}" d="M12 1.5C7.31 1.5 3.5 5.31 3.5 10c0 6 8.5 12.5 8.5 12.5S20.5 16 20.5 10C20.5 5.31 16.69 1.5 12 1.5ZM12 5.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6Z"/></svg>`;
    return L.divIcon({
        className: 'town-icon',
        html: `<span class="town-pin">${svg}</span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, Math.round(size * 0.9375)]
    });
}
// Popup shown when a town/city pin is clicked: name, type, and population.
function townPopup(p) {
    const pop = (typeof p.population === 'number' && p.population > 0) ? Math.round(p.population).toLocaleString() : null;
    let h = '<div class="town-popup"><strong>' + (p.name || 'Unnamed') + '</strong>';
    if (p.town_type) h += '<div class="tp-meta">' + p.town_type + '</div>';
    h += '<div class="tp-meta">Population ' + (pop || 'n/a') + '</div></div>';
    return h;
}
