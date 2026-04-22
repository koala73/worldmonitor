// Evidence → public badge derivation for the pipeline registry.
//
// Core design: we ship the evidence, not our opinion. `publicBadge` is a
// deterministic function of the raw evidence bundle, versioned so consumers
// can pin a reader to a classifier version and reproduce results.
//
// Shared between the server handler (server/worldmonitor/supply-chain/v1/
// list-pipelines.ts — attaches the derived badge to the RPC response) AND
// the client panel's bootstrap path (src/components/PipelineStatusPanel.ts —
// runs the same deriver client-side on bootstrap-hydrated raw registries
// that don't carry publicBadge). Identical output in both paths is the
// whole point — a bootstrap-first-paint badge must match the post-RPC badge
// or the UI flickers from one color to another on hydration.
//
// Duck-typed input: the shared interface here intentionally does NOT import
// from src/generated so it stays dependency-free; server + client both
// assign their proto-typed evidence bundles to it by structural subtyping.
//
// See docs/methodology/pipelines.mdx §"How public badges move".

export const PIPELINE_BADGE_DERIVER_VERSION = 'badge-deriver-v1';

export type PipelinePublicBadge = 'flowing' | 'reduced' | 'offline' | 'disputed';

export interface PipelineEvidenceInput {
  physicalState?: string;               // 'flowing'|'reduced'|'offline'|'unknown'
  physicalStateSource?: string;         // 'operator'|'regulator'|'press'|'satellite'|'ais-relay'
  operatorStatement?: { text?: string; url?: string; date?: string } | null;
  commercialState?: string;             // 'under_contract'|'expired'|'suspended'|'unknown'
  sanctionRefs?: ReadonlyArray<{ authority?: string; listId?: string; date?: string; url?: string }>;
  lastEvidenceUpdate?: string;
  classifierVersion?: string;
  classifierConfidence?: number;
}

// Days after which evidence is considered stale and confidence decays.
// Registry fields (geometry, operator, capacity) are refreshed weekly by
// seed-pipelines-{gas,oil}.mjs; evidence fields inherit the same cadence
// from the same curated JSON. So the decay window intentionally matches
// the seed-health maxStaleMin (14d) — anything older means the cron is
// broken, not that the asset's state has actually drifted.
const EVIDENCE_STALENESS_DAYS = 14;

/**
 * Derive the public badge for a single pipeline from its evidence bundle.
 *
 * Rules (applied in order; first match wins):
 *   1. physical_state = "offline" AND (sanctionRefs.length > 0 OR commercialState ∈ {expired, suspended})
 *      → "offline" (high-confidence offline with paperwork)
 *   2. physical_state = "offline" AND operatorStatement != null
 *      → "offline" (operator-disclosed outage)
 *   3. physical_state = "offline" AND physicalStateSource ∈ {press, ais-relay, satellite}
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
export function derivePipelinePublicBadge(
  evidence: PipelineEvidenceInput | null | undefined,
  nowMs: number = Date.now(),
): PipelinePublicBadge {
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

    // Rule 1: paperwork + physical
    if (hasSanctionEvidence || hasCommercialHalt) {
      return stale ? 'disputed' : 'offline';
    }
    // Rule 2: operator-disclosed
    if (hasOperatorStatement) {
      return stale ? 'disputed' : 'offline';
    }
    // Rule 3: external signal only — always "disputed", regardless of staleness.
    // Single-source offline claims don't clear the bar for an "offline" public
    // badge; the asset may have resumed flow and the classifier hasn't caught up.
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

  // physical === 'unknown' or malformed
  return 'disputed';
}

function isStale(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  const ageDays = (nowMs - t) / (1000 * 60 * 60 * 24);
  return ageDays > EVIDENCE_STALENESS_DAYS;
}

/**
 * Picks the newest classifier version across two registries. Gas and oil
 * are now seeded by separate Railway cron processes (seed-pipelines-gas.mjs
 * + seed-pipelines-oil.mjs), so mixed-version rollout windows are a real
 * expected state — saying "v1/v2" or picking the higher version is
 * correct; always preferring gas over oil is wrong. Versions are expected
 * to look like "v1", "v2", etc.; falls back to lexicographic for anything
 * else so odd data still returns SOMETHING deterministic.
 */
export function pickNewerClassifierVersion(
  a: string | undefined,
  b: string | undefined,
): string {
  const va = (a || '').trim();
  const vb = (b || '').trim();
  if (!va) return vb || 'v1';
  if (!vb) return va;
  if (va === vb) return va;
  const numA = parseVNum(va);
  const numB = parseVNum(vb);
  if (numA != null && numB != null) {
    return numA >= numB ? va : vb;
  }
  // Fallback: lexicographic; stable and deterministic if not numeric.
  return va >= vb ? va : vb;
}

function parseVNum(v: string): number | null {
  const m = v.match(/^v(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Picks the newer ISO8601 timestamp between two candidates. Returns an
 * ISO string (or empty). Used for aggregate fetchedAt across gas + oil
 * registries — the two seeders cron independently so the newer cycle
 * should be the reported timestamp, not whichever arbitrarily comes first.
 */
export function pickNewerIsoTimestamp(
  a: string | undefined,
  b: string | undefined,
): string {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return ta >= tb ? (a || '') : (b || '');
  }
  if (Number.isFinite(ta)) return a || '';
  if (Number.isFinite(tb)) return b || '';
  return a || b || '';
}
