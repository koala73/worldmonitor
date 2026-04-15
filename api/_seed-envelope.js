// DO NOT EDIT DIRECTLY. This file mirrors scripts/_seed-envelope-source.mjs.
// Parity is enforced by scripts/verify-seed-envelope-parity.mjs.
//
// AGENTS.md:80 forbids `api/*.js` from importing `../server/` — this file exists
// so edge handlers (api/bootstrap.js, api/health.js, api/mcp.ts, ...) have a
// same-directory envelope helper.

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

export function stripSeedEnvelope(raw) {
  return unwrapEnvelope(raw).data;
}

export function buildEnvelope({ fetchedAt, recordCount, sourceVersion, schemaVersion, state, failedDatasets, errorReason, groupId, data }) {
  const _seed = { fetchedAt, recordCount, sourceVersion, schemaVersion, state };
  if (failedDatasets != null) _seed.failedDatasets = failedDatasets;
  if (errorReason != null) _seed.errorReason = errorReason;
  if (groupId != null) _seed.groupId = groupId;
  return { _seed, data };
}
