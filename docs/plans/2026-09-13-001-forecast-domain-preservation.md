# Forecast membership and domain preservation

## Problem

The September 13 12:00 UTC run published 14 forecasts across three domains from
67 candidates across five domains. Stored-run selection replays reproduced both
the 11:00 and 12:00 published ID sets exactly. The 12:00 state had 31 members but
retained only 16 IDs. All 12 cyber candidates lost state membership. A later
hard-resolution swap removed the last conflict forecast.

`forecastIds` is operational membership. A sample cannot implement that contract.
Domain coverage must survive selection when existing quality and capacity rules
allow it. The 80% hard-resolution preference must not erase an eligible domain.

## Usage

Existing callers and public payloads stay unchanged.

```js
const pool = selectPublishedForecastPool(predictions, { memoryIndex });
let artifacts = buildPublishedForecastArtifacts(pool, fullRunSituationClusters);
const next = selectDeferredForecastForPublishBackfill(
	pool.deferredCandidates, artifacts.publishedPredictions, pool.targetCount,
);
const telemetry = summarizePublishFiltering(predictions, pool, artifacts.publishedPredictions);
```

The production caller retains its existing deferred-backfill loop. No caller must
track a second coverage plan or coordinate a new publication service.

## Shape

All behavior remains in `scripts/seed-forecasts.mjs`.

```ts
// Existing internal group shape. forecastIds contains every member.
type ForecastMembership = { forecastIds: string[]; forecastCount: number };

// Sketch only. Implementations use the existing JavaScript prediction shape.
function isRealForecastForDomainCoverage(pred: Forecast): boolean {
	throw new Error('not implemented'); // Reuse NON_REAL_FUNNEL_ORIGINS.
}
function orderDomainRepresentativesFirst(predictions: Forecast[]): Forecast[] {
	throw new Error('not implemented'); // Stable partition, not a new score.
}
function selectPublishedForecastPool(predictions: Forecast[], options = {}): ForecastPool {
	throw new Error('not implemented');
	// Reserve real eligible domains before ranked fill, within existing capacities.
	// Hard swaps preserve real domains; same-domain hard replacements remain legal.
}
```

Remove the membership slices in actor registration, situation construction, state
construction, situation projection, and simulation construction. Actor and
simulation memberships also feed operational lookups; review found their 8-ID
and 12-ID slices would leave the same defect downstream. This expands the named
functions, not the design or module boundary. Keep unrelated title, narrative,
and domain-summary display samples bounded.
Canonical and dashboard projections already exclude full-run group membership.
This is the Model the Domain decision: keep the existing structure truthful.

Reuse the existing weak-fallback predicate at eligibility and final filtering.
Reserve one real eligible representative per domain before filling the remaining
slots. Rank and tie-break deterministically. Respect the existing group capacities.
Synthetic and shadow candidates do not earn a coverage reservation. Reservations
use existing backfill admission: a second distinct domain may share a state
without the leverage preference, but never bypasses the hard group capacities.

During hard-resolution rebalancing, replacing a sole real representative requires
a real replacement in the same domain. Preserve strategic supply-chain protection.
For final situation and family caps, consider real domain representatives before
additional members. Probability and weak-fallback rejection remain strict.
Duplicate suppression cannot discard real coverage in favor of synthetic or
shadow entries; duplicate handling between real peers stays unchanged. Deferred
backfill tries an absent real domain before adding more of a represented domain.

Derive eligible, selected, published, and missing real domains in existing publish
telemetry. Keep the hard target and actual hard count visible. No mutable coverage
plan is passed through helpers. This follows the Laziness Protocol and keeps one
source of truth in the actual prediction arrays.

## Synthesis decision

Two structurally distinct designs were compared. Candidate A reserves domains in
the existing selector. Candidate B moves all selection into the artifact builder
after filtering. Use a simplified A. B's early capacity filters can discard a
domain before selection, and changing artifact-builder ownership widens this fix.
Graft B's requirement to verify the final published set, not merely preselection.
Reject A's extra coverage-plan object, options threading, and representative map.
No new display field is needed because no consumer requires one.

## Tradeoffs accepted

- Preserve real domain breadth even if hard-resolution coverage remains below 80%.
- Keep bounded greedy selection. A reported miss is not proof of global infeasibility.
- Preserve candidates in trace data without publishing all candidates or renewing old forecasts.
- Keep the existing publication cap, quality rules, and source budgets.

## Alternatives considered

- A global solver adds optimization semantics and maintenance cost beyond this repair.
- A larger publication list changes the product contract and does not repair lost membership.
- Lowering the four-domain health threshold hides the selection defect.

## Acceptance criteria

1. Groups above 12 and 16 members retain every ID, including through projection.
2. A feasible five-domain fixture retains its real domains through publication.
3. Hard swaps retain sole domain representatives and permit same-domain upgrades.
4. Weak, synthetic-only, cap-blocked, and genuinely narrow inputs remain truthful.
5. Identical scored input in a different order selects the same IDs.
6. Existing forecast and reader regression suites pass. No production run is implied.

## Open questions and risks

Can complete membership change grouping-derived scoring in a natural production
run beyond the recorded replay? Yes. Verify source traces after deployment.
Can all domains and 80% hard coverage always coexist? No. Preserve breadth and
report the actual shortfall without inventing data or weakening caps.

## Verification and release boundary

The usage and signatures above document the design; production helpers contain
the implementation, not stubs. Regression fixtures exercise complete membership,
context attachment, selection, final caps, and honest missing-domain telemetry.

The stored 12:00 UTC snapshot replay, holding recorded selection scores fixed,
changes three published domains to five at the same 14-forecast size with 12 hard
outcomes. The 11:00 UTC replay retains the exact original published IDs. This is
selection counterfactual evidence, not a regeneration of provider or LLM output.
The natural post-deployment run still needs verification before claiming recovery.
