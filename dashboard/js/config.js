// config.js — shared constants, palette, per-lens copy, icons.

// Recategorisation status palette (green = meets, orange = one optional pass, red = does not meet).
const ROAD_COLORS = { green: '#16a34a', orange: '#f59e0b', red: '#dc2626' };

// Tab switching
const NSW_LENSES = ['nsr', 'state', 'regional'];   // share the #tab-nsw panel

const NSW_MAP_TABS = ['overview', 'nsr', 'state', 'regional', 'fresh'];   // all show the NSW road layer

// Fresh assessment lens: blank-slate categories (NOT the verdict palette — green/orange/red stay
// reserved for criteria verdicts). Keys double as legendToggles keys; the map encodes CATEGORY here.
// COMPLEMENTARY scheme: State (royal blue) vs Regional (golden yellow) are true colour-wheel
// opposites — the two most-compared bins oppose maximally — and fuchsia (Nat.Sig) sits across from
// the yellow too; Local is a dark neutral that recedes. The gold is deliberately YELLOWER than the
// amber verdict tier (#f59e0b) so the two never read as one across tabs, and nothing shares the
// blue selection-highlight (#2563eb, state.js). The stat cards in #tab-fresh (index.html) carry
// the same colours inline — keep them in step.
const FRESH_CATS = ['fnat', 'fstate', 'freg', 'flocal'];
const FRESH_META = {
    fnat:   { label: 'Nationally Significant — PBS 2B + ≥2 national criteria', color: '#c026d3' },
    fstate: { label: 'State Road — PBS-1 + ≥2 optional', color: '#1d4ed8' },
    freg:   { label: 'Regional Road — 19m B-double + ≥2 optional', color: '#eab308' },
    flocal: { label: 'Local Road — meets no higher category', color: '#57534e' }
};

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
        gLabel: 'Meets criteria', oLabel: 'Meets 1 optional', rLabel: 'Does not meet',
        legend: [['#16a34a', 'Meets State criteria (≥2 optional)'], ['#f59e0b', 'Meets 1 optional — may pass with ADT'], ['#dc2626', 'Meets none — candidate to downgrade']],
        note: 'State Roads must meet ≥2 optional criteria (connect centres; unnumbered long-distance rural centre-to-town route; connect major hospitals / Major Ports / Intermodals / International Airports / employment centres TO other centre types; traffic volume + heavy-vehicle threshold) plus the mandatory criteria. Nationally significant State roads (predominantly on the National Land Transport Network — M1, M4, M5, Hume, etc.) are shown on the Nat. Significant tab, not here.'
    },
    regional: {
        title: 'Regional Roads', sub: 'Graded against the Regional Road criteria',
        gLabel: 'Meets criteria', oLabel: 'Meets 1 optional', rLabel: 'Does not meet',
        legend: [['#16a34a', 'Meets Regional criteria (≥2 optional)'], ['#f59e0b', 'Meets 1 optional — may pass with ADT'], ['#dc2626', 'Meets none — candidate for Local']],
        note: 'Regional Roads must meet ≥2 optional criteria (connect urban / town centres; connect hospitals / ports / airports / employment to centres; road-train access for regional/remote roads) plus the mandatory 19m B-double access. Orange roads meet 1 optional criterion and would qualify with sufficient ADT.'
    }
};

// Cross-criteria (reclassification) test modes for the State / Regional lens segmented control.
// Each mode names the TARGET category a lens's roads are re-graded against; the verdicts come from
// buildXtest() (grading.js) — asReg / asState re-run the shared optional criteria behind the other
// category's mandatory gate, asNat reads the per-road national-criteria verdict precomputed in
// data/nsw_criteria.json (nat / natCrit: NLTN membership S-01, metro/urban centres S-02·S-03,
// port / airport / intermodal S-04·S-05; green = meets ≥2, orange = 1, red = 0). Never forced.
const XT_MODES = {
    regional: { btn: 'Test as Regional',  short: 'Regional',   noun: 'Regional Road' },
    state:    { btn: 'Test as State',     short: 'State',      noun: 'State Road' },
    natsig:   { btn: 'Test as Nat. Sig.', short: 'Nat. Sig.',  noun: 'Nationally Significant' }
};
// The cross-tests each lens genuinely supports (data + machinery — see buildXtest).
const XT_LENS_MODES = { state: ['regional', 'natsig'], regional: ['state'] };
// Per-lens explainer under the segmented control.
const XT_LENS_FINE = {
    state: 'Regional swaps the mandatory gate (19m B-double access instead of PBS-1) and re-grades the shared connectivity criteria. Nat. Sig. counts the national criteria — NLTN membership (S-01), metro/urban centre connections (S-02·S-03) and port / airport / intermodal links (S-04·S-05) — behind the mandatory PBS Level 2B gate (S-06). Verdicts are earned from the data, not forced.',
    regional: 'Swaps the mandatory gate — State needs PBS-1 access instead of 19m B-double — and re-grades the shared connectivity criteria against the State thresholds. Verdicts are earned from the data, not forced.'
};
// Panel note per ACTIVE cross-test mode — describes the TARGET category's criteria (the ones the
// roads are being re-graded against), replacing the lens's own-criteria note while the mode is on.
const XT_MODE_NOTES = {
    regional: 'Reclassification test — each road re-graded against the Regional Road criteria: connects urban / town centres (R-01·R-05); connects major hospitals / ports / airports / employment centres (R-02·R-06); behind the mandatory 19m B-double gate (R-04, NHVR network). Green = would meet ≥2 optional. Verdicts are earned from the data, not forced.',
    state: 'Reclassification test — each road re-graded against the State Road criteria: connects Metro Centres / Regional Cities / Major Towns (S-07·S-10); unnumbered long-distance rural centre-to-town route; connects major hospitals / Major Ports / Intermodals / International Airports / employment centres to other centre types (S-08·S-11); behind the mandatory PBS Level 1 gate (S-09). Green = would meet ≥2 optional. Verdicts are earned from the data, not forced.',
    natsig: 'Reclassification test — each road graded against the Nationally Significant criteria: comprises the NLTN (S-01), connects ≥2 metropolitan / urban centres (S-02·S-03), connects a Major Port, International Airport or Major Intermodal (S-04·S-05); behind the mandatory PBS Level 2B gate (S-06, NHVR network). Green = passes the gate and meets ≥2 national criteria; orange = 1; red = none, or fails the gate. Verdicts are earned from the data, not forced.'
};
// Map-legend verdict labels per active cross-test mode (the target category's tiers).
const XT_MODE_LEGEND = {
    regional: [['#16a34a', 'Would meet Regional (≥2 optional)'], ['#f59e0b', 'Meets 1 optional — may pass with ADT'], ['#dc2626', 'Would not meet Regional']],
    state:    [['#16a34a', 'Would meet State (≥2 optional)'], ['#f59e0b', 'Meets 1 optional — may pass with ADT'], ['#dc2626', 'Would not meet State']],
    natsig:   [['#16a34a', 'Would be nationally significant (PBS 2B + ≥2 criteria)'], ['#f59e0b', 'Meets 1 national criterion'], ['#dc2626', 'No national criterion, or fails the PBS 2B gate']]
};

// State roads the NLTN spatial join (nsw_nltn.json) over-attributes as nationally significant but which
// are, per review, ordinary State roads NOT on the National Land Transport Network Determination 2020.
// Keyed by road_number → reason. These are forced off _nsr so they show on the State Roads tab instead.
const NSR_EXCLUDE = {
    '0000005': 'A44 — The Northern Rd (not on the NLTN Determination 2020)',
};

// Local roads surface two ways (see local.js): street NAMES via a CARTO label overlay that switches on
// at/after this zoom (instant, no queries), and — on the Local tab — the actual council roads as green
// vectors fetched live from OpenStreetMap / Overpass (~5s/viewport). The authoritative TfNSW RoadSegment
// service is ~28s per viewport (verified) — far too slow for live use, which is why we don't use it.
const LOCAL_ZOOM = 14;

// Town and locality names appear once the bottom-right map scale reads this distance or closer.
// Keep this tied to the displayed scale rather than a zoom level because metres-per-pixel varies
// with latitude and viewport size.
const TOWN_LABEL_SCALE_METRES = 2000;
