#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  loadEnvFile,
  readCanonicalValue,
  readSeedSnapshot,
  runSeed,
  writeExtraKey,
} from './_seed-utils.mjs';
import {
  buildChinaDecisionAlertEvents,
  emitChinaDecisionAlerts,
  publishChinaDecisionAlertEvents,
} from './china-decision-alerts.mjs';

// Kept literal because the Railway scripts container cannot import outside its
// rootDirectory. Registry parity is enforced by audit-china-decision-parity.
export const CHINA_DECISION_SIGNALS_KEY = 'intelligence:china-decision-signals:v1';
export const CHINA_DECISION_SIGNALS_ROUTE =
  '/api/intelligence/v1/get-china-decision-signals';
export const CHINA_DECISION_SIGNAL_GROUP_IDS = Object.freeze([
  'macro',
  'policy-enforcement',
  'cross-strait-activity',
  'corporate-disclosures',
  'corridor-conditions',
  'activity-nowcast',
]);
export const CHINA_DECISION_SIGNAL_ALERT_OUTBOX_KEY =
  'intelligence:china-decision-alert-outbox:v1';
const CHINA_DECISION_SIGNAL_ALERT_OUTBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

loadEnvFile(import.meta.url);

export function validateChinaDecisionSignalSnapshot(value) {
  return value?.schemaVersion === 1
    && typeof value?.generatedAt === 'string'
    && value?.access?.anonymous === 'bounded_public_summary'
    && value?.access?.pro === 'same_provenance_via_mcp'
    && value?.access?.operator === 'source_health_only'
    && Array.isArray(value?.groups)
    && value.groups.length === CHINA_DECISION_SIGNAL_GROUP_IDS.length
    && value.groups.every((candidate, index) => (
      candidate?.id === CHINA_DECISION_SIGNAL_GROUP_IDS[index]
      && ['available', 'partial', 'stale', 'unavailable'].includes(candidate?.state)
      && Array.isArray(candidate?.items)
      && candidate.items.length <= 4
      && candidate.items.every((item) => (
        typeof item?.id === 'string'
        && typeof item?.lineageId === 'string'
        && typeof item?.publisherType === 'string'
        && typeof item?.stale === 'boolean'
        && item?.provenance?.contractVersion === 'decision-signal-provenance/v1'
        && item?.provenance?.signalId === item.id
      ))
    ));
}

export async function fetchChinaDecisionSignals({
  fetchImpl = fetch,
  apiBaseUrl = process.env.API_BASE_URL || 'https://api.worldmonitor.app',
} = {}) {
  const response = await fetchImpl(`${apiBaseUrl}${CHINA_DECISION_SIGNALS_ROUTE}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'worldmonitor-china-decision-signals-seed/1.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`China decision-signal RPC returned HTTP ${response.status}`);
  }
  const wire = await response.json();
  const encoded = wire?.payloadJson ?? wire?.payload_json;
  if (typeof encoded !== 'string') {
    throw new Error('China decision-signal RPC omitted payload_json');
  }
  const snapshot = JSON.parse(encoded);
  if (!validateChinaDecisionSignalSnapshot(snapshot)) {
    throw new Error('China decision-signal RPC failed the canonical six-group contract');
  }
  return snapshot;
}

export function declareChinaDecisionSignalRecords(snapshot) {
  return Array.isArray(snapshot?.groups)
    ? snapshot.groups.filter((group) => group?.state !== 'unavailable').length
    : 0;
}

export async function publishChinaDecisionSignalAlerts(
  snapshot,
  {
    readPrevious = () => readSeedSnapshot(CHINA_DECISION_SIGNALS_KEY),
    publishEvent,
  } = {},
) {
  try {
    const previous = await readPrevious();
    return await emitChinaDecisionAlerts(previous, snapshot, { publishEvent });
  } catch (error) {
    console.warn(`[china-decision-alerts] best-effort alert phase failed: ${error?.message ?? error}`);
    return { events: [], enqueued: 0 };
  }
}

export async function prepareChinaDecisionSignalAlertEvents(
  snapshot,
  {
    readPrevious = () => readSeedSnapshot(CHINA_DECISION_SIGNALS_KEY),
  } = {},
) {
  try {
    return buildChinaDecisionAlertEvents(await readPrevious(), snapshot);
  } catch (error) {
    console.error(`[china-decision-alerts] alert preparation failed: ${error?.message ?? error}`);
    throw error;
  }
}

function alertIdentity(event) {
  return `${event?.eventType ?? ''}:${event?.payload?.dedupe_key ?? ''}`;
}

export async function deliverChinaDecisionSignalAlertOutbox(
  events,
  {
    readOutbox = () => readCanonicalValue(CHINA_DECISION_SIGNAL_ALERT_OUTBOX_KEY),
    writeOutbox = (pending) => writeExtraKey(
      CHINA_DECISION_SIGNAL_ALERT_OUTBOX_KEY,
      pending,
      CHINA_DECISION_SIGNAL_ALERT_OUTBOX_TTL_SECONDS,
    ),
    publishEvents = publishChinaDecisionAlertEvents,
  } = {},
) {
  let previous = [];
  try {
    const stored = await readOutbox();
    if (Array.isArray(stored)) previous = stored;
  } catch (error) {
    console.error(`[china-decision-alerts] outbox read failed: ${error?.message ?? error}`);
    throw error;
  }
  const combined = [...previous, ...(Array.isArray(events) ? events : [])];
  const unique = [...new Map(combined.map((event) => [alertIdentity(event), event])).values()]
    .filter((event) => alertIdentity(event) !== ':');
  const result = await publishEvents(unique);
  await writeOutbox(result.pending);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let preparedAlertEvents = [];
  runSeed(
    'intelligence',
    'china-decision-signals',
    CHINA_DECISION_SIGNALS_KEY,
    fetchChinaDecisionSignals,
    {
      validateFn: validateChinaDecisionSignalSnapshot,
      ttlSeconds: 24 * 60 * 60,
      lockTtlMs: 90_000,
      fetchPhaseTimeoutMs: 45_000,
      sourceVersion: 'china-decision-signals-public-rpc-v1',
      schemaVersion: 1,
      declareRecords: declareChinaDecisionSignalRecords,
      zeroIsValid: true,
      maxStaleMin: 60,
      // Prepare against the previous canonical value without sending anything.
      // runSeed publishes the validated snapshot between this callback and
      // afterPublish, preventing phantom alerts for a state that never landed.
      beforePublish: async (snapshot) => {
        preparedAlertEvents = await prepareChinaDecisionSignalAlertEvents(snapshot);
      },
      // Delivery is post-commit and durable: failures remain in a bounded
      // outbox and are retried on the next seed even though canonical state has
      // advanced.
      afterPublish: async () => {
        await deliverChinaDecisionSignalAlertOutbox(preparedAlertEvents);
      },
    },
  ).catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
