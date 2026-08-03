import type { FreshnessCheck } from './types';
// @ts-expect-error — JS module, no declaration file
import { buildContentFreshnessAssessment } from '../_content-freshness.js';

function parseFiniteRecordCount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// `activatedKeys` holds the content-freshness activation markers that were
// found present at read time (see FreshnessCheck.contentFreshnessActivationKey).
// Callers that declare no content contract can omit it. Omitting it while a
// check DOES declare one is the safe direction: the check reads as
// pre-activation, so an absent block is graced — but a present-and-broken block
// is still evaluated and still fails closed.
export function evaluateFreshness(
  checks: FreshnessCheck[],
  metas: unknown[],
  now = Date.now(),
  activatedKeys?: ReadonlySet<string>,
): { cached_at: string | null; stale: boolean } {
  let stale = false;
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
      const pendingActivation = Boolean(
        assessment
        && !assessment.fieldPresent
        && check.contentFreshnessActivationKey
        && !activatedKeys?.has(check.contentFreshnessActivationKey),
      );
      if (!pendingActivation) {
        stale ||= !assessment?.usable || assessment.contentStale;
      }
    }
  }

  return {
    cached_at: hasAnyValidMeta && hasAllValidMeta ? new Date(oldestFetchedAt).toISOString() : null,
    stale,
  };
}
