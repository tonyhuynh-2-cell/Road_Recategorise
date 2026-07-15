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

The dashboard identifies qualifying evidence near a road and displays it in
the criterion panel. For the Regional facility criteria (R-02 and R-06), the
scorer additionally requires a qualifying facility or Regional/Major
employment centre and a qualifying centre to be on the same connected road
geometry component. This prevents a disconnected road-number group from
combining unrelated evidence.

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

- [Regional facility rebuild](dashboard/rebuild_regional_facility_optional.py)
- [Road detail panel](dashboard/js/detail.js)
- Criteria guide: *Approach to road recategorisation - Definitions and criteria*
  (December 2025; user-supplied source, not stored in this repository)
