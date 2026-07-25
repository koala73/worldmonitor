#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  loadEnvFile,
  readSeedSnapshot,
  runSeed,
} from './_seed-utils.mjs';
import { tokensToContentMeta } from './_content-age-helpers.mjs';
import { fetchAllChinaPolicyDocuments } from './china-policy/adapters.mjs';
import {
  normalizePolicyDocument,
  reconcilePolicyEvents,
  validateChinaPolicyPayload,
} from './china-policy/normalize.mjs';

export const CHINA_POLICY_EVENTS_KEY = 'china:policy-events:v1';
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 120;

loadEnvFile(import.meta.url);

function asPreviousPayload(value) {
  return validateChinaPolicyPayload(value) ? value : null;
}

function lastGoodTransport(event, assessedAt) {
  const previousClaim = event?.provenance?.claims?.transport_freshness;
  const lastSuccessAt = previousClaim?.status === 'known'
    ? previousClaim.value.lastSuccessAt ?? previousClaim.value.assessedAt
    : event.retrievedAt;
  return {
    ...event,
    provenance: {
      ...event.provenance,
      claims: {
        ...event.provenance.claims,
        transport_freshness: {
          status: 'known',
          value: {
            state: 'error',
            assessedAt,
            ...(lastSuccessAt ? { lastSuccessAt } : {}),
          },
        },
      },
    },
  };
}

function withinRetention(event, now) {
  const published = Date.parse(event.publicationDate);
  return Number.isFinite(published) && now - published <= RETENTION_MS;
}

function eventTransportFailed(event, agencyState) {
  return agencyState?.status === 'error'
    || agencyState?.failures?.some((failure) => (
      failure.canonicalUrl === event.canonicalUrl
      || event.mirrorUrls?.includes(failure.canonicalUrl)
    ));
}

export function capEventsByLineage(events, maxEvents = MAX_EVENTS) {
  const lineages = new Map();
  for (const event of events) {
    const byId = lineages.get(event.lineageId) ?? new Map();
    byId.set(event.id, event);
    lineages.set(event.lineageId, byId);
  }
  const groups = [...lineages.values()]
    .map((byId) => [...byId.values()].sort((a, b) => (
      Date.parse(b.publicationDate) - Date.parse(a.publicationDate)
      || (b.revision?.sequence ?? 1) - (a.revision?.sequence ?? 1)
    )))
    .sort((a, b) => Date.parse(b[0].publicationDate) - Date.parse(a[0].publicationDate));
  const retained = [];
  for (const group of groups) {
    if (retained.length + group.length > maxEvents) break;
    retained.push(...group);
  }
  return retained;
}

export async function buildChinaPolicyEvents({
  fetchImpl,
  sleep,
  now = Date.now(),
  previousPayload,
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const previous = asPreviousPayload(
    previousPayload === undefined
      ? await readSeedSnapshot(CHINA_POLICY_EVENTS_KEY, { strict: true })
      : previousPayload,
  );
  const fetched = await fetchAllChinaPolicyDocuments({ fetchImpl, sleep });
  const previousEvents = previous?.events ?? [];
  const normalized = fetched.documents.map((document) => normalizePolicyDocument({
    ...document,
    retrievedAt: document.retrievedAt ?? generatedAt,
    extractionConfidence: document.originalText ? 0.95 : 0.7,
  }));
  const successfulAgencies = new Set(
    Object.entries(fetched.agencies)
      .filter(([, state]) => state.status !== 'error')
      .map(([agency]) => agency),
  );
  const reconciled = reconcilePolicyEvents(
    normalized,
    previousEvents.filter((event) => successfulAgencies.has(event.agency)),
  );
  const representedLineages = new Set(reconciled.map((event) => event.lineageId));
  const preserved = previousEvents
    .filter((event) => withinRetention(event, now))
    .filter((event) => (
      fetched.agencies[event.agency]?.status === 'error'
      || !representedLineages.has(event.lineageId)
    ))
    .map((event) => (
      eventTransportFailed(event, fetched.agencies[event.agency])
        ? lastGoodTransport(event, generatedAt)
        : event
    ));
  const events = capEventsByLineage([...reconciled, ...preserved]).map((event) => (
    eventTransportFailed(event, fetched.agencies[event.agency])
      ? lastGoodTransport(event, generatedAt)
      : event
  ));

  const payload = {
    schemaVersion: 1,
    generatedAt,
    agencies: fetched.agencies,
    events,
  };
  if (!validateChinaPolicyPayload(payload)) {
    throw new Error('China policy payload failed the typed-event publication contract');
  }
  return payload;
}

export function declareChinaPolicyRecords(payload) {
  return payload?.events?.length ?? 0;
}

export function chinaPolicyContentMeta(payload) {
  const published = (payload?.events ?? [])
    .map((event) => event.publicationDate)
    .filter(Boolean);
  return tokensToContentMeta(published);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSeed(
    'china',
    'policy-events',
    CHINA_POLICY_EVENTS_KEY,
    buildChinaPolicyEvents,
    {
      validateFn: validateChinaPolicyPayload,
      ttlSeconds: 7 * 24 * 60 * 60,
      lockTtlMs: 240_000,
      fetchPhaseTimeoutMs: 220_000,
      sourceVersion: 'china-official-policy-adapters-v1',
      schemaVersion: 1,
      declareRecords: declareChinaPolicyRecords,
      maxStaleMin: 2_160,
      contentMeta: chinaPolicyContentMeta,
      maxContentAgeMin: 180 * 24 * 60,
    },
  ).catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
