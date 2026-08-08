// Evidence → public badge derivation for the strategic storage registry.
//
// Same design as src/shared/pipeline-evidence.ts: we ship the evidence, not
// our opinion. `publicBadge` is a deterministic function of the raw evidence
// bundle, versioned so consumers can pin a reader to a classifier version.
//
// Shared between the server handler (server/worldmonitor/supply-chain/v1/
// list-storage-facilities.ts — attaches the derived badge to the RPC
// response) AND the client panel's bootstrap path
// (src/components/StorageFacilityMapPanel.ts — runs the same deriver
// client-side on bootstrap-hydrated raw registries that don't carry
// publicBadge). Identical output in both paths is the whole point —
// first-paint badge must match post-RPC badge or the UI flickers.
//
// Duck-typed input: the shared interface here intentionally does NOT
// import from src/generated so it stays dependency-free; server + client
// both assign their proto-typed evidence bundles to it by structural
// subtyping.
//
// See docs/methodology/storage.mdx §"How public badges move".

export const STORAGE_BADGE_DERIVER_VERSION = 'storage-badge-deriver-v1';

export type StoragePublicBadge = 'operational' | 'reduced' | 'offline' | 'disputed';

export interface StorageEvidenceInput {
  physicalState?: string;               // 'operational'|'reduced'|'offline'|'under_construction'|'unknown'
  physicalStateSource?: string;         // 'operator'|'regulator'|'press'|'satellite'|'ais-relay'
  operatorStatement?: { text?: string; url?: string; date?: string } | null;
  commercialState?: string;             // 'under_contract'|'expired'|'suspended'|'unknown'
  sanctionRefs?: ReadonlyArray<{ authority?: string; listId?: string; date?: string; url?: string }>;
  fillDisclosed?: boolean;
  fillSource?: string | null;
  lastEvidenceUpdate?: string;
  classifierVersion?: string;
  classifierConfidence?: number;
}

// Same 14-day staleness window as pipelines — registry fields refreshed
// weekly by seed-storage-facilities.mjs, anything older means the cron is
// broken rather than the asset's state has drifted.
const EVIDENCE_STALENESS_DAYS = 14;

/**
 * Derive the public badge for a single storage facility.
 *
 * Rules (first match wins):
 *   1. physical_state = "offline" AND (sanctionRefs.length > 0 OR commercialState ∈ {expired, suspended})
 *      → "offline" (high-confidence offline with paperwork)
 *   2. physical_state = "offline" AND operatorStatement != null
 *      → "offline" (operator-disclosed outage)
 *   3. physical_state = "offline" AND physicalStateSource ∈ {press, ais-relay, satellite}
 *      → "disputed" (external-signal offline without operator/sanction confirmation)
 *   4. physical_state = "reduced"
 *      → "reduced"
 *   5. physical_state = "operational"
 *      → "operational"
 *   6. physical_state = "under_construction" OR "unknown" OR evidence missing
 *      → "disputed"
 *
 * Freshness guard: if lastEvidenceUpdate is older than EVIDENCE_STALENESS_DAYS,
 * a non-"operational" badge drops to "disputed".
 */
export function deriveStoragePublicBadge(
  evidence: StorageEvidenceInput | null | undefined,
  nowMs: number = Date.now(),
): StoragePublicBadge {
  if (!evidence) return 'disputed';

  const stale = isStale(evidence.lastEvidenceUpdate, nowMs);
  const physical = evidence.physicalState;

  if (physical === 'offline') {
    const hasSanctionEvidence = (evidence.sanctionRefs?.length ?? 0) > 0;
    const hasCommercialHalt =
      evidence.commercialState === 'expired' || evidence.commercialState === 'suspended';
    const hasOperatorStatement = evidence.operatorStatement != null &&
      ((evidence.operatorStatement.text?.length ?? 0) > 0);
    const hasExternalSignal = ['press', 'ais-relay', 'satellite'].includes(
      evidence.physicalStateSource ?? '',
    );

    if (hasSanctionEvidence || hasCommercialHalt) {
      return stale ? 'disputed' : 'offline';
    }
    if (hasOperatorStatement) {
      return stale ? 'disputed' : 'offline';
    }
    if (hasExternalSignal) return 'disputed';

    return 'disputed';
  }

  if (physical === 'reduced') {
    return stale ? 'disputed' : 'reduced';
  }
  if (physical === 'operational') {
    return 'operational';
  }

  // 'under_construction' | 'unknown' | malformed
  return 'disputed';
}

function isStale(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  const ageDays = (nowMs - t) / (1000 * 60 * 60 * 24);
  return ageDays > EVIDENCE_STALENESS_DAYS;
}
