# Criteria Issues and Interpretation Log

This register records gaps, ambiguities and implementation decisions in the
Transport for NSW *Approach to road recategorisation - Definitions and criteria*
guide (December 2025). It is a working reference for the assessment software;
it does not replace a road manager's judgement.

## How to use this log

For each issue, record:

- what the guide says;
- what it does not define;
- the software's current treatment; and
- what evidence or decision would resolve the ambiguity.

## CI-01: Meaning of "connects"

**Status:** Open interpretation

**Where it appears:** S-07, S-08, S-10, S-11, R-01, R-02, R-05 and R-06.

**What the guide says:**

The guide uses relationship wording such as:

- centres "to each other";
- facilities and employment centres "to Town Centres and Urban Centres"; and
- facilities and employment centres "to other centre types".

It also defines the qualifying kinds of centres, hospitals, ports, airports
and employment areas. See pages 1-4 of the December 2025 guide.

**What is not defined:**

The guide does not specify a technical meaning for "connects". In particular,
it does not say whether a qualifying place must be:

- at a route endpoint;
- passed through by the route;
- within a stated distance of the route; or
- on the same continuous geometry or road-network component as another
  qualifying place.

It also does not state whether all nearby qualifying places should be shown as
equal evidence, or whether the assessment should identify the particular
centre-to-centre or centre-to-facility relationship that earns the criterion.

**Current software treatment:**

The dashboard first divides overloaded TfNSW road numbers into connected,
class-consistent road units. Evidence, criteria and map selection are scoped to
that unit, preventing disconnected roads under one administrative ID from
combining their centres or facilities.

For S-08 and S-11, the scorer requires a qualifying facility or zone-threshold
employment area and another ABS centre type to occur on the same connected NSW
Road Segment component. Hospitals do not need to be different kinds from one
another; the tested relationship is between the facility evidence and an ABS
centre on that component. The panel selects the qualifying component that
contains the named road section the user clicked when one is available.

An employment polygon must intersect the selected categorisation geometry before
it can qualify. The 50 m tolerance used when attaching it to the matching physical
road network only accommodates source-line alignment and cannot turn a polygon
that visibly misses the selected road into a pass. The map draws the real zoning
polygon. For a near miss it also draws and labels the shortest boundary-to-road
gap, while keeping that polygon as contextual rather than qualifying evidence.

If a TfNSW road number contains several assessment units, the cached physical
road segments are partitioned between those units and this test is rerun for
each one. Urban roads are also rerun so S-11 uses the same network-backed test.
Matching ABS centres and facilities are then attached to the unit's evidence.
This prevents an eligible centre from disappearing during the split and prevents
one unit's pass from being copied to the others.

For the Regional facility criteria (R-02 and R-06), the scorer requires a
qualifying facility or size-qualified employment centre and a qualifying centre
on the same connected assessment unit. A size-qualified employment polygon may
connect through local access streets when it lies within 1.5 km of the assessed
road and the NSW Road Segment dataset proves a continuous access path no longer
than 2 km. The result stores and displays that measured path. These tests prevent
a disconnected road-number group from
combining unrelated evidence while avoiding the overly literal requirement that
the categorised road line enter every industrial estate polygon.

The current evidence list is still broader than a literal endpoint list. It
can include centres or facilities beside the road rather than only its ends.

**Why this matters:**

Without an agreed definition, two roads with similar nearby evidence may be
treated differently depending on route geometry, segmentation and how a road
manager reads the word "connects." A flat evidence list can also make it hard
to see which places form the actual assessed relationship.

**Suggested decision needed:**

TfNSW or the responsible road manager should confirm whether each criterion
requires endpoint-to-endpoint connectivity, continuous-route connectivity, a
proximity threshold, or another network-based test. The decision should also
say how the software should present primary qualifying connections separately
from incidental nearby evidence.

**Related implementation:**

- [State S-08/S-11 network rebuild](dashboard/rebuild_state_facility_optional.py)
- [Employment-centre polygon rebuild](dashboard/rebuild_employment_centres.py)
- [Regional facility rebuild](dashboard/rebuild_regional_facility_optional.py)
- [Regional employment access paths](dashboard/regional_employment_access.py)
- [Road detail panel](dashboard/js/detail.js)
- [Connected road-unit rebuild](dashboard/rebuild_road_units.py)
- Criteria guide: *Approach to road recategorisation - Definitions and criteria*
  (December 2025; user-supplied source, not stored in this repository)

## CI-02: Employment-centre importance without economic values

**Status:** Client interpretation adopted

**Where it appears:** S-08, S-11, R-02 and R-06.

**What is not available:**

The supplied criteria guide does not provide a complete, machine-readable
statewide economic-value measure for commercial, industrial and employment
centres. The available planning and ELDM polygon sources describe location,
zoning, precinct identity and land area, but not comparable economic output.

**Client decision:**

Employment-centre importance is assessed from land area only. The thresholds
are Urban 40 ha, Regional 15 ha and Remote 5 ha. Economic value, employment
density and the old Major/Regional/Local proxy labels do not contribute to the
score. The dashboard states that this is the client-approved size-only rule.

**Current software treatment:**

Current 2025 ELDM employment precincts are authoritative where they exist.
Overlapping EPI zoning is removed so one real precinct is not counted twice.
NSW Planning EPI commercial and industrial zoning remains the statewide
fallback outside ELDM coverage. Proposed or potential-future ELDM precincts are
excluded.

The exact source polygon is retained for scoring and display. S-08/S-11 require
that a size-qualified polygon intersect the selected road. R-02/R-06 may also
use a proved local-road access path under the connection treatment recorded in
CI-01.

**Why this matters:**

The result is reproducible and visually auditable, but area is a deliberate
policy simplification rather than proof of jobs, freight activity or economic
output. Any future change to an economic-value method should be treated as a
new client decision and revalidated against this baseline.

## CI-03: Assessment extent for roads with interrupted geometry

**Status:** Software interpretation adopted; confirmation recommended

**Where it appears:** Every criterion because the chosen assessment extent
controls which geometry and evidence contribute to the final result.

**What is not defined:**

The guide does not say whether a declared road must be split into separate
assessments where its mapped geometry is interrupted, overlaps another highway,
or is divided into several source-data components. It also does not distinguish
an official road identity from a connected geometry component.

**Current software treatment:**

One declared road receives one overall assessment. Connected geometry components
are retained as mapped sections for framing, evidence audit and diagnostic
results, but they do not produce competing final classifications for the same
road. Sections are grouped when they share an official classified road number
and current class. Common names alone do not combine unnumbered roads. Mandatory
network coverage is recomputed conservatively across the complete grouped road.

An administrative identifier is not enough by itself. Known reused identifier
`0000057` remains separated into West Wyalong-Condobolin, Tullamore-Nyngan and
Goldfields because these are different corridors. Mixed State/Regional groups
also remain separate unless an authoritative schedule mapping resolves them.

**Why this matters:**

Previously one declared road could appear several times with contradictory
verdicts, such as one Kamilaroi section meeting the criteria while another only
likely met. The two-level model gives the road one answer without hiding real
source gaps or weaker sections.

**Suggested decision needed:**

The responsible road manager should confirm that the classified road in the
Schedule, rather than every connected source geometry component, is the intended
assessment extent. A future authoritative Schedule-to-geometry table would allow
the remaining ambiguous reused or mixed-class identifiers to be resolved without
name-based interpretation.

**Related implementation:**

- [Declared-road and mapped-section rebuild](dashboard/rebuild_road_units.py)
- [Road identity selection](dashboard/js/utils.js)
- [Mapped-section detail control](dashboard/js/detail.js)
