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

function unavailableSnapshot(semantic, result, startedAt) {
  const [category, , detail] = String(result?.reason || '').split(':');
  const knownReasons = new Set([
    'timeout', 'fetch_failed', 'shape_break', 'host_not_allowlisted',
    'malformed_json', 'payload_too_large', 'upstream_error', 'schema_drift',
    'service_item_mismatch', 'package_name_mismatch', 'pagination_incomplete',
    'partial_page', 'page_exceeds_cap',
  ]);
  console.warn(JSON.stringify({
    event: 'tps_source_failure',
    source: semantic === 'annual_aggregate' ? 'calls' : 'mci',
    reason: knownReasons.has(category) || /^http_[1-5]\d{2}$/.test(category)
      ? category : 'fetch_failed',
    stage: detail === 'package' || detail === 'ids' ? detail : 'source',
    status: Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599
      ? result.status : null,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  }));
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
        const startedAt = Date.now();
        const result = await fetchMci();
        return result.ok ? result.snapshot : unavailableSnapshot('reported_occurrence', result, startedAt);
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
        const startedAt = Date.now();
        const result = await fetchCalls();
        return result.ok ? result.snapshot : unavailableSnapshot('annual_aggregate', result, startedAt);
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
