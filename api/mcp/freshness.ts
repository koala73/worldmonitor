import type { FreshnessCheck } from './types';
// @ts-expect-error — JS module, no declaration file
import { buildContentFreshnessAssessment, getActiveContentFreshnessActivationWindow } from '../_content-freshness.js';
// @ts-expect-error — JS module, no declaration file
import { assessContentAge } from '../_content-age.js';

function parseFiniteRecordCount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// `activationStates` maps a content-freshness activation key (see
// FreshnessCheck.contentFreshnessActivationKey) to whether that marker exists.
// It is deliberately THREE-valued: an entry is present only when the marker was
// actually read. `false` means "read, and the producer has never published" —
// the only state that earns deployment-order grace. A missing entry means
// unknown (never read, or the read failed) and earns nothing, so a caller that
// cannot supply the state, or a Redis blip on the marker key, fails closed
// instead of granting a grace that never expires.
export function evaluateFreshness(
  checks: FreshnessCheck[],
  metas: unknown[],
  now = Date.now(),
  activationStates?: ReadonlyMap<string, boolean>,
): {
  cached_at: string | null;
  stale: boolean;
  contentFreshnessPendingUntil?: string;
} {
  let stale = false;
  let contentFreshnessPendingUntil: string | undefined;
  let oldestFetchedAt = Number.POSITIVE_INFINITY;
  let hasAnyValidMeta = false;
  let hasAllValidMeta = true;

  for (const [i, check] of checks.entries()) {
    const meta = metas[i];
    const fetchedAt = meta && typeof meta === 'object' && 'fetchedAt' in meta
      ? Number((meta as { fetchedAt: unknown }).fetchedAt)
      : Number.NaN;

    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      hasAllValidMeta = false;
      stale = true;
      continue;
    }

    hasAnyValidMeta = true;
    oldestFetchedAt = Math.min(oldestFetchedAt, fetchedAt);
    stale ||= (now - fetchedAt) / 60_000 > check.maxStaleMin;

    if (check.minRecordCount != null) {
      const recordCount = meta && typeof meta === 'object' && 'recordCount' in meta
        ? parseFiniteRecordCount((meta as { recordCount: unknown }).recordCount)
        : null;
      stale ||= recordCount == null || recordCount < check.minRecordCount;
    }

    if (check.honorContentAge) {
      // House-standard content-age contract (#3845 / #7141). Same shared
      // assessor api/health.js classifyKey uses, so the two surfaces cannot
      // drift on parsing, on the future-dated rule, or on re-aging: a fresh
      // fetchedAt with stale observations is stale on both. Without this MCP
      // answers stale:false for the exact key health calls STALE_CONTENT —
      // the #6080 divergence on this simpler newestItemAt clock.
      //
      // A key that declares honorContentAge but whose seed-meta carries no
      // maxContentAgeMin gets `null` back — the producer has not opted into
      // the contract, so there is nothing to age and the check is a no-op.
      const contentAge = assessContentAge(meta, now);
      stale ||= contentAge?.contentStale === true;
    }

    if (check.requireContentFreshness) {
      // Same assessor api/health.js uses, so the two surfaces cannot drift on
      // parsing, on the fail-closed rules, or on re-aging: the producer's
      // counts are a measurement taken at seeder-run time, and this recomputes
      // the critical observation's age against `now`.
      const assessment = buildContentFreshnessAssessment(
        meta,
        check.requireContentFreshness,
        now,
      );
      // Grace requires positive proof the producer has never published: the
      // marker was read AND came back absent. Anything else — unread, errored,
      // or present — evaluates the block normally.
      const pendingWindow = assessment && !assessment.fieldPresent && check.contentFreshnessActivationKey
        ? getActiveContentFreshnessActivationWindow(
          check.contentFreshnessActivationKey,
          activationStates?.get(check.contentFreshnessActivationKey),
          now,
        )
        : null;
      const pendingActivation = pendingWindow !== null;
      if (pendingWindow !== null) {
        const deadline = new Date(pendingWindow.untilMs).toISOString();
        if (contentFreshnessPendingUntil === undefined || deadline < contentFreshnessPendingUntil) {
          contentFreshnessPendingUntil = deadline;
        }
      }
      if (!pendingActivation) {
        stale ||= !assessment?.usable || assessment.contentStale;
      }
    }
  }

  return {
    cached_at: hasAnyValidMeta && hasAllValidMeta ? new Date(oldestFetchedAt).toISOString() : null,
    stale,
    ...(contentFreshnessPendingUntil === undefined ? {} : { contentFreshnessPendingUntil }),
  };
}
