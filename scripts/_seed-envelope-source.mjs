// Single source of truth for the seed-envelope helpers.
//
// This file is hand-authored but its PUBLIC SHAPE is mirrored verbatim in:
//   - server/_shared/seed-envelope.ts  (imported from server/**/*.ts and scripts/**/*.mjs)
//   - api/_seed-envelope.js            (imported from api/*.js — edge-safe, per AGENTS.md
//                                       forbidding api/ → server/ imports)
//
// Parity is enforced by scripts/verify-seed-envelope-parity.mjs and covered by a
// test in tests/seed-envelope-parity.test.mjs.
//
// The seed envelope is the unified shape for every seeded Redis value once the
// contract migrates. See docs/plans/2026-04-14-002-fix-runseed-zero-record-lockout-plan.md
// for the full design.
//
//   {
//     _seed: {
//       fetchedAt: number,                           // ms since epoch
//       recordCount: number,                         // integer ≥ 0
//       sourceVersion: string,                       // seeder-declared
//       schemaVersion: number,                       // increments when `data` shape changes
//       state: 'OK' | 'OK_ZERO' | 'ERROR',
//       failedDatasets?: string[],                   // present when state === 'ERROR'
//       errorReason?: string,                        // present when state === 'ERROR'
//       groupId?: string,                            // for multi-key group writes
//     },
//     data: <the actual payload>,
//   }
//
// During the rollout, many Redis values are still in the LEGACY shape (no `_seed`
// wrapper). All helpers below treat legacy values as `{ _seed: null, data: raw }`
// so callers can adopt envelope-aware reads without breaking behavior. This is
// what makes PR 1 behavior-preserving.

/**
 * Parse a raw Redis value (already JSON.parse'd, or a string that needs parsing)
 * into the canonical `{ _seed, data }` pair.
 *
 * - Returns `{ _seed: null, data: null }` when the input is null/undefined.
 * - Returns `{ _seed, data }` when the input has a well-formed `_seed` block.
 * - Returns `{ _seed: null, data: raw }` for any other shape (legacy passthrough).
 *
 * Intentionally permissive: never throws. A seeder that publishes garbage is a
 * write-side bug; readers degrade to legacy semantics rather than crashing.
 */
export function unwrapEnvelope(raw) {
  if (raw == null) return { _seed: null, data: null };
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { _seed: null, data: raw };
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { _seed: null, data: value };
  }
  const seed = value._seed;
  if (seed && typeof seed === 'object' && typeof seed.fetchedAt === 'number') {
    return { _seed: seed, data: value.data };
  }
  return { _seed: null, data: value };
}

/**
 * Strip the envelope and return the inner `data` payload for public callers.
 * Legacy values pass through unchanged. Use this at any public boundary — RPC
 * responses, bootstrap payloads, MCP tool outputs — so `_seed` never leaves the
 * backend.
 */
export function stripSeedEnvelope(raw) {
  return unwrapEnvelope(raw).data;
}

/**
 * Build an envelope for a seeder's successful run. Does NOT validate the seed
 * meta fields beyond what the type expects; `validateDescriptor` in
 * scripts/_seed-contract.mjs handles pre-publish validation.
 *
 * Content-age fields (`newestItemAt`, `oldestItemAt`, `maxContentAgeMin`) are
 * the opt-in content-freshness contract from the 2026-05-04 health-readiness
 * plan. The presence of `maxContentAgeMin` is the opt-in signal: when set,
 * health classifies the entry against `newestItemAt`/`maxContentAgeMin`. The
 * other two tag along — `newestItemAt` may be explicit `null` when the
 * seeder's `contentMeta` returned null (no usable item timestamps), which
 * the classifier reads as STALE_CONTENT.
 */
export function buildEnvelope({ fetchedAt, recordCount, sourceVersion, schemaVersion, state, failedDatasets, errorReason, groupId, newestItemAt, oldestItemAt, maxContentAgeMin, data }) {
  const _seed = { fetchedAt, recordCount, sourceVersion, schemaVersion, state };
  if (failedDatasets != null) _seed.failedDatasets = failedDatasets;
  if (errorReason != null) _seed.errorReason = errorReason;
  if (groupId != null) _seed.groupId = groupId;
  if (maxContentAgeMin !== undefined) {
    _seed.newestItemAt = newestItemAt ?? null;
    _seed.oldestItemAt = oldestItemAt ?? null;
    _seed.maxContentAgeMin = maxContentAgeMin;
  }
  return { _seed, data };
}
