// Evidence → public badge derivation for the pipeline registry.
//
// Core design: we ship the evidence, not our opinion. `publicBadge` is a
// deterministic function of the raw evidence bundle, versioned so consumers
// can pin a reader to a classifier version and reproduce results.
//
// See docs/methodology/pipelines.mdx §"How public badges move".

import type { PipelineEvidence } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

export const DERIVER_VERSION = 'badge-deriver-v1';

// Days after which evidence is considered stale and confidence decays.
// Registry fields (geometry, operator, capacity) are refreshed weekly by
// seed-pipelines-{gas,oil}.mjs; evidence fields inherit the same cadence
// from the same curated JSON. So the decay window intentionally matches
// the seed-health maxStaleMin (14d) — anything older means the cron is
// broken, not that the asset's state has actually drifted.
const EVIDENCE_STALENESS_DAYS = 14;

export type PublicBadge = 'flowing' | 'reduced' | 'offline' | 'disputed';

/**
 * Derive the public badge for a single pipeline from its evidence bundle.
 *
 * Rules (applied in order; first match wins):
 *   1. physical_state = "offline" AND (sanctionRefs.length > 0 OR commercial_state ∈ {expired, suspended})
 *      → "offline" (high-confidence offline with paperwork)
 *   2. physical_state = "offline" AND operator_statement != null
 *      → "offline" (operator-disclosed outage)
 *   3. physical_state = "offline" AND physical_state_source ∈ {press, ais-relay, satellite}
 *      → "disputed" (external-signal offline without operator/sanction confirmation)
 *   4. physical_state = "reduced"
 *      → "reduced"
 *   5. physical_state = "flowing"
 *      → "flowing"
 *   6. physical_state = "unknown" OR evidence missing
 *      → "disputed"
 *
 * Freshness guard: if lastEvidenceUpdate is older than EVIDENCE_STALENESS_DAYS,
 * a non-"flowing" badge drops to "disputed" (we don't claim a pipeline is
 * offline on 3-week-old evidence; we say we're unsure).
 */
export function derivePublicBadge(
  evidence: PipelineEvidence | undefined,
  nowMs: number = Date.now(),
): PublicBadge {
  if (!evidence) return 'disputed';

  const stale = isStale(evidence.lastEvidenceUpdate, nowMs);

  const physical = evidence.physicalState;
  if (physical === 'offline') {
    const hasSanctionEvidence = (evidence.sanctionRefs?.length ?? 0) > 0;
    const hasCommercialHalt =
      evidence.commercialState === 'expired' || evidence.commercialState === 'suspended';
    const hasOperatorStatement = evidence.operatorStatement != null &&
      (evidence.operatorStatement.text?.length ?? 0) > 0;
    const hasExternalSignal = ['press', 'ais-relay', 'satellite'].includes(
      evidence.physicalStateSource ?? '',
    );

    // Rule 1: paperwork + physical
    if (hasSanctionEvidence || hasCommercialHalt) {
      return stale ? 'disputed' : 'offline';
    }
    // Rule 2: operator-disclosed
    if (hasOperatorStatement) {
      return stale ? 'disputed' : 'offline';
    }
    // Rule 3: external signal only — always "disputed", regardless of staleness
    // (single-source offline claims don't clear the bar for an "offline" public
    // badge; the asset may have resumed flow and the classifier hasn't caught up)
    if (hasExternalSignal) return 'disputed';

    // Rule 6 fallthrough: offline without any supporting evidence → disputed
    return 'disputed';
  }

  if (physical === 'reduced') {
    return stale ? 'disputed' : 'reduced';
  }
  if (physical === 'flowing') {
    // Even on stale data, "flowing" is the safe default — we only demote to
    // disputed when the claim is a negative one we can't substantiate.
    return 'flowing';
  }

  // physical === "unknown" or malformed
  return 'disputed';
}

function isStale(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  const ageDays = (nowMs - t) / (1000 * 60 * 60 * 24);
  return ageDays > EVIDENCE_STALENESS_DAYS;
}
