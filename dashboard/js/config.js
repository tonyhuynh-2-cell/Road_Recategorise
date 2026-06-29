// config.js — shared constants, palette, per-lens copy, icons.

// Recategorisation status palette (green = meets, orange = meets 1 of 2, red = does not meet).
const ROAD_COLORS = { green: '#16a34a', orange: '#f59e0b', red: '#dc2626' };

// Tab switching
const NSW_LENSES = ['nsr', 'state', 'regional'];   // share the #tab-nsw panel

const NSW_MAP_TABS = ['overview', 'nsr', 'state', 'regional'];   // all show the NSW road layer

// Minimalist inline status icons for the Road Detail panel
const ICON = {
    pass: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#dcf2e3"/><path d="M4.6 8.2 7 10.5 11.4 5.6" fill="none" stroke="#16a34a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#fbe3e3"/><path d="M5.5 5.5 10.5 10.5 M10.5 5.5 5.5 10.5" fill="none" stroke="#dc2626" stroke-width="1.7" stroke-linecap="round"/></svg>',
    warn: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#f7ead1"/><path d="M5 8 H11" fill="none" stroke="#c79232" stroke-width="1.7" stroke-linecap="round"/></svg>',
    maybe: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#f7ead1"/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="#d9962a"/></svg>'
};

// Per-lens panel copy (title / stat labels / legend rows / note).
const NSW_VIEW_META = {
    nsr: {
        title: 'Nationally Significant Roads', sub: 'National Land Transport Network — Road · Determination 2020',
        gLabel: 'On the National Network', oLabel: '', rLabel: '',
        legend: [],
        note: 'The nationally significant roads are the National Land Transport Network — Road, taken directly from the official NLTN Determination 2020 (data.gov.au) — the green corridors on the Department of Infrastructure map (Pacific, New England, Newell, Hume, Sturt, Great Western, Mitchell highways, etc.). Click any green line for its determination details. The figure above is the total length of the NSW national network.'
    },
    state: {
        title: 'State Roads', sub: 'Graded against the State Road criteria (excludes nationally significant)',
        gLabel: 'Meets criteria', oLabel: 'Meets 1 of 2', rLabel: 'Does not meet',
        legend: [['#16a34a', 'Meets State criteria (≥2 optional)'], ['#f59e0b', 'Meets 1 of 2 — may pass with ADT'], ['#dc2626', 'Meets none — candidate to downgrade']],
        note: 'State Roads must meet ≥2 optional criteria (connect centres; connect major hospitals / ports / airports / employment; long-distance rural route) plus the mandatory criteria. Orange roads meet 1 of 2 and would qualify if ADT exceeds the threshold; ADT is not available statewide.'
    },
    regional: {
        title: 'Regional Roads', sub: 'Graded against the Regional Road criteria',
        gLabel: 'Meets criteria', oLabel: 'Meets 1 of 2', rLabel: 'Does not meet',
        legend: [['#16a34a', 'Meets Regional criteria (≥2 optional)'], ['#f59e0b', 'Meets 1 of 2 — may pass with ADT'], ['#dc2626', 'Meets none — candidate for Local']],
        note: 'Regional Roads must meet ≥2 optional criteria (connect urban / town centres; connect hospitals / ports / airports / employment to centres) plus the mandatory 19m B-double access. Orange roads meet 1 of 2 and would qualify with sufficient ADT.'
    }
};

// Town markers turn into name text-boxes once zoomed in past this level
const LABEL_ZOOM = 9;
