import { runSeed } from '../_seed-utils.mjs';
import {
  TPS_CALLS_KEY,
  TPS_CALLS_MAX_CONTENT_AGE_MIN,
  TPS_MAX_STALE_MIN,
  TPS_MCI_KEY,
  TPS_MCI_MAX_CONTENT_AGE_MIN,
  TPS_SOURCE_VERSION,
  TPS_TTL_SECONDS,
  declareTpsRecords,
  fetchTpsCallsAttended,
  fetchTpsMci,
  tpsContentMeta,
  validateTpsCallsSnapshot,
  validateTpsMciSnapshot,
} from './tps-open-data.mjs';

function unavailableSnapshot(semantic, result) {
  return {
    sourceUnavailable: true,
    sourceState: 'degraded',
    sourceReason: result?.reason || 'fetch_failed',
    semantic,
    records: [],
  };
}

export function tpsSeedFreshnessPatch(snapshot, sourceState = 'ok') {
  const content = tpsContentMeta(snapshot);
  return {
    freshnessMetaPatch: {
      sourceState,
      ...(snapshot?.sourceReason ? { sourceReason: snapshot.sourceReason } : {}),
      ...(content ? {
        dataLastEditDate: content.dataLastEditDate,
        newestContentAt: content.newestContentAt,
        newestContentYear: content.newestContentYear,
      } : {}),
    },
  };
}

export function tpsSeedDefinition(kind, { fetchMci = fetchTpsMci, fetchCalls = fetchTpsCallsAttended } = {}) {
  if (kind === 'mci') {
    return {
      domain: 'safety',
      resource: 'tps-mci',
      canonicalKey: TPS_MCI_KEY,
      fetchSnapshot: async () => {
        const result = await fetchMci();
        return result.ok ? result.snapshot : unavailableSnapshot('reported_occurrence', result);
      },
      validateFn: validateTpsMciSnapshot,
      maxContentAgeMin: TPS_MCI_MAX_CONTENT_AGE_MIN,
    };
  }
  if (kind === 'calls') {
    return {
      domain: 'safety',
      resource: 'tps-calls-attended',
      canonicalKey: TPS_CALLS_KEY,
      fetchSnapshot: async () => {
        const result = await fetchCalls();
        return result.ok ? result.snapshot : unavailableSnapshot('annual_aggregate', result);
      },
      validateFn: validateTpsCallsSnapshot,
      maxContentAgeMin: TPS_CALLS_MAX_CONTENT_AGE_MIN,
    };
  }
  throw new TypeError(`unknown TPS seed kind: ${kind}`);
}

export function tpsSeedArguments(kind, { fetchMci, fetchCalls } = {}) {
  const definition = tpsSeedDefinition(kind, { fetchMci, fetchCalls });
  return [
    definition.domain,
    definition.resource,
    definition.canonicalKey,
    definition.fetchSnapshot,
    {
      validateFn: definition.validateFn,
      ttlSeconds: TPS_TTL_SECONDS,
      sourceVersion: TPS_SOURCE_VERSION,
      declareRecords: declareTpsRecords,
      zeroIsValid: true,
      schemaVersion: 1,
      maxStaleMin: TPS_MAX_STALE_MIN,
      contentMeta: tpsContentMeta,
      maxContentAgeMin: definition.maxContentAgeMin,
      afterValidationSkip: async (snapshot) => tpsSeedFreshnessPatch(snapshot, 'degraded'),
      afterPublish: async (snapshot) => tpsSeedFreshnessPatch(snapshot, 'ok'),
    },
  ];
}

export async function runTpsSeed(kind, {
  runSeedImpl = runSeed,
  fetchMci,
  fetchCalls,
} = {}) {
  return runSeedImpl(...tpsSeedArguments(kind, { fetchMci, fetchCalls }));
}
