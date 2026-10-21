#!/usr/bin/env node

import {
  loadEnvFile,
  readSeedSnapshot,
  runSeed,
  writeFreshnessMetadata,
} from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import {
  CHINA_CORPORATE_DISCLOSURE_KEY,
  fetchChinaCorporateDisclosureSnapshot,
} from './china-corporate-disclosures/adapters.mjs';

loadEnvFile(import.meta.url);

export const CHINA_CORPORATE_DISCLOSURE_TTL_SECONDS = 3 * DAY_MIN * 60;
export const CHINA_CORPORATE_DISCLOSURE_MAX_STALE_MIN = 180;

const SZSE_FAILURE_RESOURCE = 'china-corporate-disclosures-szse-failure';
const SZSE_FAILURE_SOURCE_VERSION = 'china-official-exchange-szse-failure-v1';
export const CHINA_CORPORATE_DISCLOSURE_SZSE_FAILURE_META_KEY =
  `seed-meta:market:${SZSE_FAILURE_RESOURCE}`;

export function validateChinaCorporateDisclosureSnapshot(snapshot) {
  if (
    snapshot?.schemaVersion !== 1
    || snapshot?.countryCode !== 'CN'
    || !['healthy', 'degraded'].includes(snapshot?.status)
    || !Array.isArray(snapshot?.events)
    || !Array.isArray(snapshot?.sources)
    || !Array.isArray(snapshot?.unclassifiedRevisions)
  ) {
    return false;
  }
  const sourceIds = new Set(snapshot.sources.map((source) => source?.id));
  return sourceIds.has('sse') && sourceIds.has('szse') && sourceIds.has('hkex');
}

export function chinaCorporateDisclosureContentMeta(snapshot) {
  const tokens = (Array.isArray(snapshot?.events) ? snapshot.events : [])
    .map((event) => event?.publicationTime?.value);
  for (const revision of Array.isArray(snapshot?.unclassifiedRevisions)
    ? snapshot.unclassifiedRevisions
    : []) {
    tokens.push(revision?.publicationTime?.value);
  }
  // A successful official query establishes the quiet window's content-as-of
  // time even when it returns no owned-category events. Failed sources retain
  // only their prior lastSuccessAt, so their content age still advances.
  for (const source of Array.isArray(snapshot?.sources) ? snapshot.sources : []) {
    tokens.push(source?.lastSuccessAt);
  }
  if (snapshot?.status === 'healthy') tokens.push(snapshot?.coverageThrough);
  return tokensToContentMeta(tokens);
}

export function szseTransportFailureFromMarker(marker) {
  if (marker == null) return null;
  const failureAt = Number(marker.fetchedAt);
  if (!Number.isFinite(failureAt) || failureAt <= 0) {
    throw new Error('SZSE transport failure marker has an invalid fetchedAt');
  }
  return {
    checkedAt: new Date(failureAt).toISOString(),
    errorCode: typeof marker.errorCode === 'string'
      && /^[a-z0-9_]{1,80}$/iu.test(marker.errorCode)
      ? marker.errorCode
      : 'FETCH_FAILED',
    consecutiveFailures: Number.isInteger(marker.consecutiveFailures)
      && marker.consecutiveFailures > 0
      ? marker.consecutiveFailures
      : 1,
  };
}

export async function recordSzseTransportFailure(
  snapshot,
  writeMetadata = writeFreshnessMetadata,
) {
  const source = snapshot?.sources?.find((candidate) => candidate?.id === 'szse');
  if (source?.transportStatus !== 'error') return false;
  const failureAt = Date.parse(source.checkedAt);
  if (!Number.isFinite(failureAt)) {
    throw new Error('SZSE transport failure is missing a valid checkedAt');
  }
  const errorCode = typeof source.errorCode === 'string'
    && /^[a-z0-9_]{1,80}$/iu.test(source.errorCode)
    ? source.errorCode
    : 'FETCH_FAILED';
  const consecutiveFailures = Number.isInteger(
    source.transportReliability?.consecutiveFailures,
  ) && source.transportReliability.consecutiveFailures > 0
    ? source.transportReliability.consecutiveFailures
    : 1;
  await writeMetadata(
    'market',
    SZSE_FAILURE_RESOURCE,
    0,
    SZSE_FAILURE_SOURCE_VERSION,
    CHINA_CORPORATE_DISCLOSURE_TTL_SECONDS,
    failureAt,
    null,
    { errorCode, consecutiveFailures },
  );
  return true;
}

export async function buildChinaCorporateDisclosureSeedSnapshot({
  readSnapshot = readSeedSnapshot,
  fetchSnapshot = fetchChinaCorporateDisclosureSnapshot,
} = {}) {
  // History and per-source last-good state are part of the product contract.
  // A failed cache read must abort rather than silently replace that history.
  const [previousSnapshot, szseFailureMarker] = await Promise.all([
    readSnapshot(CHINA_CORPORATE_DISCLOSURE_KEY, { strict: true }),
    readSnapshot(CHINA_CORPORATE_DISCLOSURE_SZSE_FAILURE_META_KEY, { strict: true }),
  ]);
  const previousSzseFailure = szseTransportFailureFromMarker(szseFailureMarker);
  return fetchSnapshot({
    previousSnapshot,
    previousTransportFailures: previousSzseFailure
      ? { szse: previousSzseFailure }
      : {},
  });
}

if (process.argv[1]?.endsWith('seed-china-corporate-disclosures.mjs')) {
  runSeed(
    'market',
    'china-corporate-disclosures',
    CHINA_CORPORATE_DISCLOSURE_KEY,
    buildChinaCorporateDisclosureSeedSnapshot,
    {
      ttlSeconds: CHINA_CORPORATE_DISCLOSURE_TTL_SECONDS,
      lockTtlMs: 180_000,
      validateFn: validateChinaCorporateDisclosureSnapshot,
      declareRecords: (snapshot) => snapshot.events.length,
      zeroIsValid: true,
      sourceVersion: 'china-official-exchange-disclosures-sse-szse-v1',
      schemaVersion: 1,
      maxStaleMin: CHINA_CORPORATE_DISCLOSURE_MAX_STALE_MIN,
      contentMeta: chinaCorporateDisclosureContentMeta,
      maxContentAgeMin: 90 * DAY_MIN,
      afterValidationSkip: async (snapshot) =>
        recordSzseTransportFailure(snapshot),
    },
  );
}
