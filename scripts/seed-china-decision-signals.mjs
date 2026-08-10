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
      // An unavailable source cannot expose an item. Every other state asserts
      // that at least one bounded public item is available.
      && (candidate.state === 'unavailable'
        ? candidate.items.length === 0
        : candidate.items.length >= 1 && candidate.items.length <= 4)
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

// #6060: a healthy quiet window is not an operational source failure. The
// exchanges answered and simply had nothing qualifying to report, so the group
// is covered even though its public state stays `unavailable` with zero items —
// no disclosure event is invented and the product surface is unchanged.
//
// Every other unavailable cause (insufficient_data, provenance_rejected,
// upstream_unavailable, unknown) IS a real failure and stays uncovered. The
// comparison is deliberately strict-equality against the canonical cause
// string: an absent, malformed, or differently-cased cause has not PROVEN a
// healthy window, and unproven must never be the branch that certifies
// coverage.
export const CHINA_DECISION_SIGNAL_COVERED_UNAVAILABLE_CAUSE = 'healthy_quiet_window';

function unavailableCauseOf(group) {
  const cause = group?.metadata?.unavailableCause;
  return typeof cause === 'string' && cause.length > 0 ? cause : 'unknown';
}

export function isChinaDecisionGroupOperationallyCovered(group) {
  if (!group) return false;
  if (group.state !== 'unavailable') return true;
  return unavailableCauseOf(group) === CHINA_DECISION_SIGNAL_COVERED_UNAVAILABLE_CAUSE;
}

export function declareChinaDecisionSignalRecords(snapshot) {
  return Array.isArray(snapshot?.groups)
    ? snapshot.groups.filter(isChinaDecisionGroupOperationallyCovered).length
    : 0;
}

export function summarizeChinaDecisionGroups(groups) {
  const candidates = Array.isArray(groups) ? groups : [];
  const unavailable = candidates.filter((group) => group?.state === 'unavailable');
  return {
    populated: candidates.filter((group) => Array.isArray(group?.items) && group.items.length > 0).length,
    partial: candidates.filter((group) => group?.state === 'partial').length,
    stale: candidates.filter((group) => group?.state === 'stale').length,
    // The raw public state, unchanged — a quiet group is still `unavailable`
    // on the wire. `healthyQuiet` breaks out the subset of those that are
    // operationally covered, so operators can tell a quiet window from an
    // outage without either count lying about the other.
    unavailable: unavailable.length,
    healthyQuiet: unavailable.filter(
      (group) => unavailableCauseOf(group) === CHINA_DECISION_SIGNAL_COVERED_UNAVAILABLE_CAUSE,
    ).length,
    operationallyCovered: candidates.filter(isChinaDecisionGroupOperationallyCovered).length,
  };
}

export function chinaDecisionSignalGroupDiagnostics(snapshot) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  const byId = (groupId) => groups.find((group) => group?.id === groupId);
  return {
    groupStates: Object.fromEntries(
      CHINA_DECISION_SIGNAL_GROUP_IDS.map((groupId) => [
        groupId,
        byId(groupId)?.state ?? 'unavailable',
      ]),
    ),
    // Cause per unavailable group so health names the stale or quiet source
    // family instead of emitting a generic N/6 warning. A group the snapshot
    // omits entirely defaults to `unknown` rather than dropping out of the map.
    unavailableCauses: Object.fromEntries(
      CHINA_DECISION_SIGNAL_GROUP_IDS
        .filter((groupId) => (byId(groupId)?.state ?? 'unavailable') === 'unavailable')
        .map((groupId) => [groupId, unavailableCauseOf(byId(groupId))]),
    ),
    groupCounts: summarizeChinaDecisionGroups(groups),
  };
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

/**
 * Diagnostics are returned from afterPublish so runSeed can write them with
 * seed-meta before alert delivery. Delivery remains durable and visible: an
 * outbox error rejects afterFreshness rather than silently swallowing it.
 */
export function createChinaDecisionSignalSeedHooks({
  prepareAlerts = prepareChinaDecisionSignalAlertEvents,
  deliverAlerts = deliverChinaDecisionSignalAlertOutbox,
  diagnosticsFor = chinaDecisionSignalGroupDiagnostics,
  log = console.log,
} = {}) {
  let preparedAlertEvents = [];
  return {
    beforePublish: async (snapshot) => {
      preparedAlertEvents = await prepareAlerts(snapshot);
    },
    afterPublish: async (snapshot) => {
      const diagnostics = diagnosticsFor(snapshot);
      log(`[china-decision-signals] group diagnostics ${JSON.stringify(diagnostics)}`);
      return { freshnessMetaPatch: diagnostics };
    },
    afterFreshness: async () => deliverAlerts(preparedAlertEvents),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const hooks = createChinaDecisionSignalSeedHooks();
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
      ...hooks,
    },
  ).catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
