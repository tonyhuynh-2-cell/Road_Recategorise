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
    flocal: { label: 'Local Road — no higher category on available evidence', color: '#57534e' }
};

// Minimalist inline status icons for the Road Detail panel
const ICON = {
    pass: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#dcf2e3"/><path d="M4.6 8.2 7 10.5 11.4 5.6" fill="none" stroke="#16a34a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#fbe3e3"/><path d="M5.5 5.5 10.5 10.5 M10.5 5.5 5.5 10.5" fill="none" stroke="#dc2626" stroke-width="1.7" stroke-linecap="round"/></svg>',
    warn: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#f7ead1"/><path d="M5 8 H11" fill="none" stroke="#c79232" stroke-width="1.7" stroke-linecap="round"/></svg>',
    maybe: '<svg class="ci" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8" fill="#f7ead1"/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="#d9962a"/></svg>'
};

const CRITERIA_REFERENCE_PROMPT = '<br><br>Use criteria reference page to view TfNSW road recategorisation criteria.';

// Per-lens panel copy (title / stat labels / legend rows / note).
const NSW_VIEW_META = {
    nsr: {
        title: 'Nationally Significant Network', sub: 'National Land Transport Network roads (NLTN 2020), graded against the national criteria',
        gLabel: 'Nationally significant', oLabel: 'On network only', rLabel: '', hideRed: true,
        legend: [['#16a34a', 'Nationally significant — on the network and connects centres / a port·airport'], ['#f59e0b', 'On the National Land Transport Network only']],
        note: 'This view shows roads on the National Land Transport Network (NLTN Determination 2020, data.gov.au). Proposed corridors render translucent.' + CRITERIA_REFERENCE_PROMPT
    },
    state: {
        title: 'State Roads', sub: 'State roads not on the national network, graded against the State Road criteria',
        gLabel: 'Passes criteria', oLabel: 'Passes 1 of 2 criteria', rLabel: 'Fails criteria',
        legend: [['#16a34a', 'Passes State criteria (≥2 optional)'], ['#f59e0b', 'Passes 1 of 2 criteria'], ['#dc2626', 'Fails criteria — candidate to downgrade']],
        note: 'This view shows State Roads graded against the State Road criteria. Nationally significant roads are available in the Nat. Sig. view.' + CRITERIA_REFERENCE_PROMPT
    },
    regional: {
        title: 'Regional Roads', sub: 'Graded against the Regional Road criteria',
        gLabel: 'Passes criteria', oLabel: 'Passes 1 of 2 criteria', rLabel: 'Fails criteria',
        legend: [['#16a34a', 'Passes Regional criteria (≥2 optional)'], ['#f59e0b', 'Passes 1 of 2 criteria'], ['#dc2626', 'Fails criteria — candidate for Local']],
        note: 'This view shows Regional Roads graded against the Regional Road criteria.' + CRITERIA_REFERENCE_PROMPT
    }
};

// Cross-criteria (recategorisation) test modes for the State / Regional lens segmented control.
// Each mode names the TARGET category a lens's roads are re-graded against; the verdicts come from
// buildXtest() (grading.js) — asReg / asState re-run the shared optional criteria behind the other
// category's mandatory gate, asNat reads the per-road national-criteria verdict precomputed in
// data/nsw_criteria.json (nat / natCrit: NLTN membership S-01, metro/urban centres S-02·S-03,
// port / airport / intermodal S-04·S-05; green = passes ≥2, orange = 1, red = 0). Never forced.
const XT_MODES = {
    regional: { btn: 'Test as Regional',  short: 'Regional',   noun: 'Regional Road' },
    state:    { btn: 'Test as State',     short: 'State',      noun: 'State Road' },
    natsig:   { btn: 'Test as Nat. Sig.', short: 'Nat. Sig.',  noun: 'Nationally Significant' }
};
// The cross-tests each lens genuinely supports (data + machinery — see buildXtest).
const XT_LENS_MODES = { state: ['regional', 'natsig'], regional: ['state', 'natsig'] };
// Per-lens explainer under the segmented control.
const XT_LENS_FINE = {
    state: 'Each button re-grades the displayed roads against the selected category\'s criteria.',
    regional: 'Each button re-grades the displayed roads against the selected category\'s criteria.'
};
// Panel note per ACTIVE cross-test mode — describes the TARGET category's criteria (the ones the
// roads are being re-graded against), replacing the lens's own-criteria note while the mode is on.
const XT_MODE_NOTES = {
    regional: 'This scenario re-grades the displayed roads against the Regional Road criteria.' + CRITERIA_REFERENCE_PROMPT,
    state: 'This scenario re-grades the displayed roads against the State Road criteria.' + CRITERIA_REFERENCE_PROMPT,
    natsig: 'This scenario re-grades the displayed roads against the Nationally Significant criteria.' + CRITERIA_REFERENCE_PROMPT
};
// Map-legend verdict labels per active cross-test mode (the target category's tiers).
const XT_MODE_LEGEND = {
    regional: [['#16a34a', 'Passes Regional criteria'], ['#f59e0b', 'Likely passes Regional criteria'], ['#dc2626', 'Fails Regional criteria']],
    state:    [['#16a34a', 'Passes State criteria'], ['#f59e0b', 'Likely passes State criteria'], ['#dc2626', 'Fails State criteria']],
    natsig:   [['#16a34a', 'Would be nationally significant (PBS 2B + ≥2 criteria)'], ['#f59e0b', 'Passes 1 national criterion'], ['#dc2626', 'No national criterion, or fails the PBS 2B gate']]
};

// State roads the NLTN spatial join (nsw_nltn.json) over-attributes as nationally significant but which
// are, per review, ordinary State roads NOT on the National Land Transport Network Determination 2020.
// Keyed by road_number → reason. These are forced off _nsr so they show on the State Roads tab instead.
const NSR_EXCLUDE = {
    '0000005': 'A44 — The Northern Rd (not on the NLTN Determination 2020)',
};

// Town/locality labels, CARTO street labels, and the stored statewide LocalRoad geometry all appear once
// the bottom-right map scale reads this distance or closer. Keep this tied to displayed scale rather than
// a zoom level because metres-per-pixel varies with latitude and viewport size.
const TOWN_LABEL_SCALE_METRES = 2000;
