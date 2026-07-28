#!/usr/bin/env node

import { loadEnvFile, readSeedSnapshot, runSeed } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import {
  CHINA_CORPORATE_DISCLOSURE_KEY,
  fetchChinaCorporateDisclosureSnapshot,
} from './china-corporate-disclosures/adapters.mjs';

loadEnvFile(import.meta.url);

export const CHINA_CORPORATE_DISCLOSURE_TTL_SECONDS = 3 * DAY_MIN * 60;
export const CHINA_CORPORATE_DISCLOSURE_MAX_STALE_MIN = 180;

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

export async function buildChinaCorporateDisclosureSeedSnapshot() {
  // History and per-source last-good state are part of the product contract.
  // A failed cache read must abort rather than silently replace that history.
  const previousSnapshot = await readSeedSnapshot(
    CHINA_CORPORATE_DISCLOSURE_KEY,
    { strict: true },
  );
  return fetchChinaCorporateDisclosureSnapshot({ previousSnapshot });
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
    },
  );
}
