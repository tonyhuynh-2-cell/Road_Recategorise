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
        title: 'Nationally Significant Network', sub: 'National Land Transport Network roads (NLTN 2020), graded against the national criteria',
        gLabel: 'Nationally significant', oLabel: 'On network only', rLabel: '', hideRed: true,
        legend: [['#16a34a', 'Nationally significant — on the network and connects centres / a port·airport'], ['#f59e0b', 'On the National Land Transport Network only']],
        note: 'These are the roads of the National Land Transport Network (NLTN Determination 2020, data.gov.au) — the authoritative national network. Each line is graded by how many national criteria the road it runs along meets: comprises the NLTN (S-01, met by definition); connects ≥2 metropolitan/urban centres (S-02·S-03); connects a Major Port, International Airport or Major Intermodal (S-04·S-05). Green = meets ≥2 (on the network plus at least one connection, inherited from the road criteria — earned from data); orange = on the network only. Proposed corridors render translucent.'
    },
    state: {
        title: 'State Roads', sub: 'State roads not on the national network, graded against the State Road criteria',
        gLabel: 'Meets criteria', oLabel: 'Meets 1 of 2', rLabel: 'Does not meet',
        legend: [['#16a34a', 'Meets State criteria (≥2 optional)'], ['#f59e0b', 'Meets 1 of 2 — may pass with ADT'], ['#dc2626', 'Meets none — candidate to downgrade']],
        note: 'State Roads must meet ≥2 optional criteria (connect centres; connect major hospitals / ports / airports / employment; long-distance rural route) plus the mandatory criteria. Nationally significant State roads (predominantly on the National Land Transport Network) are shown on the Nat. Significant tab, not here. Orange roads meet 1 of 2 and would qualify if ADT exceeds the threshold; ADT is not available statewide.'
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
