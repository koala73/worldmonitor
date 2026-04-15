// Mirror of scripts/_seed-envelope-source.mjs.
//
// DO NOT EDIT function behavior here independently — keep implementations in
// lockstep with the JS source (same control flow, same field access, same
// return shapes). Runtime parity between this file and
// scripts/_seed-envelope-source.mjs / api/_seed-envelope.js is the contract.
// TS-only narrowing/casting is tolerated, but the runtime effect must match.
//
// The JS source ↔ edge copy are diffed programmatically by
// scripts/verify-seed-envelope-parity.mjs. The TS copy is reviewed manually
// and validated by `tsc --noEmit`.

export type SeedState = 'OK' | 'OK_ZERO' | 'ERROR';

export interface SeedMeta {
  fetchedAt: number;
  recordCount: number;
  sourceVersion: string;
  schemaVersion: number;
  state: SeedState;
  failedDatasets?: string[];
  errorReason?: string;
  groupId?: string;
}

export interface SeedEnvelope<T = unknown> {
  _seed: SeedMeta;
  data: T;
}

export interface UnwrapResult<T = unknown> {
  _seed: SeedMeta | null;
  data: T | null;
}

export function unwrapEnvelope(raw: unknown): UnwrapResult {
  if (raw == null) return { _seed: null, data: null };
  let value: any = raw;
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

export function stripSeedEnvelope(raw: unknown): unknown {
  return unwrapEnvelope(raw).data;
}

export function buildEnvelope(input: {
  fetchedAt: number;
  recordCount: number;
  sourceVersion: string;
  schemaVersion: number;
  state: SeedState;
  failedDatasets?: string[];
  errorReason?: string;
  groupId?: string;
  data: unknown;
}): SeedEnvelope {
  const { fetchedAt, recordCount, sourceVersion, schemaVersion, state, failedDatasets, errorReason, groupId, data } = input;
  const _seed: SeedMeta = { fetchedAt, recordCount, sourceVersion, schemaVersion, state };
  if (failedDatasets != null) _seed.failedDatasets = failedDatasets;
  if (errorReason != null) _seed.errorReason = errorReason;
  if (groupId != null) _seed.groupId = groupId;
  return { _seed, data };
}
