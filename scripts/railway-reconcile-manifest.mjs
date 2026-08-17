import { createHash } from 'node:crypto';

import { canonicalJson } from './railway-reconcile-control-client.mjs';

export const INTENT_VERSION = 'railway-reconcile-intent/v1';
export const RESULT_VERSION = 'railway-reconcile-result/v1';

const ACTIONS = new Set(['DEPLOY', 'ADOPT', 'SKIP']);
const RESULT_OUTCOMES = new Set([
  'NO_MUTATION',
  'MUTATION_COMPLETED',
  'MUTATION_PARTIAL',
  'MUTATION_AMBIGUOUS',
]);
const ENTRY_OUTCOMES = new Set(['TRIGGERED', 'ALREADY_ACTIVE', 'SKIPPED', 'FAILED', 'AMBIGUOUS']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} violates its closed schema`);
  }
}

function safeIdentifier(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)
    || /(?:bearer|token|secret|gh[pousr]_)/i.test(value)) {
    throw new TypeError(`${label} must be a safe non-token identifier`);
  }
  return value;
}

function reasonCode(value, label) {
  if (typeof value !== 'string' || !REASON_CODE.test(value)) {
    throw new TypeError(`${label} must be a closed reason code`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function validateProducer(producer) {
  exactKeys(producer, ['repository', 'workflow', 'runId', 'runAttempt'], 'intent producer');
  safeIdentifier(producer.repository, 'producer repository');
  safeIdentifier(producer.workflow, 'producer workflow');
  safeIdentifier(producer.runId, 'producer runId');
  if (!Number.isInteger(producer.runAttempt) || producer.runAttempt < 1 || producer.runAttempt > 10_000) {
    throw new TypeError('producer runAttempt must be a positive integer');
  }
}

function validateAuthorization(authorization) {
  exactKeys(
    authorization,
    ['gateContext', 'gateState', 'gateObservedAt', 'mainObservedAt'],
    'intent authorization',
  );
  if (authorization.gateContext !== 'gate' || authorization.gateState !== 'success') {
    throw new TypeError('intent authorization requires the newest gate state to be success');
  }
  timestamp(authorization.gateObservedAt, 'gateObservedAt');
  timestamp(authorization.mainObservedAt, 'mainObservedAt');
}

function validatePlannedEntry(entry) {
  exactKeys(entry, ['service', 'serviceId', 'action', 'reason'], 'planned service');
  safeIdentifier(entry.service, 'planned service name');
  safeIdentifier(entry.serviceId, 'planned service ID');
  if (!ACTIONS.has(entry.action)) throw new TypeError('planned service action is unsupported');
  reasonCode(entry.reason, 'planned service reason');
}

function validateSortedUnique(entries, label) {
  if (!Array.isArray(entries)) throw new TypeError(`${label} must be an array`);
  const names = entries.map((entry) => entry.service);
  if (new Set(names).size !== names.length) throw new TypeError(`${label} contains a duplicate service`);
  const ids = entries.map((entry) => entry.serviceId);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} contains a duplicate service ID`);
  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  if (names.some((name, index) => name !== sorted[index])) {
    throw new TypeError(`${label} must be sorted by service`);
  }
}

function intentWithoutDigest(manifest) {
  const { intentDigest: _ignored, ...unsigned } = manifest;
  return unsigned;
}

export function createIntentManifest(input) {
  exactKeys(input, [
    'attemptId', 'producer', 'headSha', 'projectId', 'environmentId', 'owner',
    'recoveryAttemptId', 'plannedServices', 'authorization', 'createdAt',
  ], 'intent input');
  if (!Array.isArray(input.plannedServices)) throw new TypeError('planned services must be an array');
  const plannedServices = input.plannedServices
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.service.localeCompare(right.service));
  const manifest = {
    version: INTENT_VERSION,
    ...input,
    producer: { ...input.producer },
    plannedServices,
    authorization: { ...input.authorization },
  };
  manifest.intentDigest = digest(manifest);
  return validateIntentManifest(manifest);
}

export function validateIntentManifest(manifest) {
  exactKeys(manifest, [
    'version', 'attemptId', 'producer', 'headSha', 'projectId', 'environmentId',
    'owner', 'recoveryAttemptId', 'plannedServices', 'authorization', 'createdAt',
    'intentDigest',
  ], 'intent manifest');
  if (manifest.version !== INTENT_VERSION) throw new TypeError('intent manifest version is unsupported');
  safeIdentifier(manifest.attemptId, 'attemptId');
  validateProducer(manifest.producer);
  if (typeof manifest.headSha !== 'string' || !SHA.test(manifest.headSha)) {
    throw new TypeError('intent headSha must be a lowercase 40-character SHA');
  }
  safeIdentifier(manifest.projectId, 'projectId');
  safeIdentifier(manifest.environmentId, 'environmentId');
  safeIdentifier(manifest.owner, 'owner');
  if (manifest.owner !== `github-run:${manifest.producer.runId}:${manifest.producer.runAttempt}`) {
    throw new TypeError('intent owner must exactly match its producer run and attempt');
  }
  safeIdentifier(manifest.recoveryAttemptId, 'recoveryAttemptId', { nullable: true });
  for (const entry of manifest.plannedServices) validatePlannedEntry(entry);
  validateSortedUnique(manifest.plannedServices, 'planned services');
  validateAuthorization(manifest.authorization);
  timestamp(manifest.createdAt, 'intent createdAt');
  if (typeof manifest.intentDigest !== 'string' || !DIGEST.test(manifest.intentDigest)
    || digest(intentWithoutDigest(manifest)) !== manifest.intentDigest) {
    throw new TypeError('intent manifest digest mismatch');
  }
  return manifest;
}

function validateResultEntry(entry) {
  exactKeys(entry, [
    'service', 'serviceId', 'action', 'outcome', 'deploymentId',
    'observedDeploymentId', 'reason',
  ], 'result entry');
  safeIdentifier(entry.service, 'result service name');
  safeIdentifier(entry.serviceId, 'result service ID');
  if (!ACTIONS.has(entry.action)) throw new TypeError('result entry action is unsupported');
  if (!ENTRY_OUTCOMES.has(entry.outcome)) throw new TypeError('result entry outcome is unsupported');
  safeIdentifier(entry.deploymentId, 'deploymentId', { nullable: true });
  safeIdentifier(entry.observedDeploymentId, 'observedDeploymentId', { nullable: true });
  reasonCode(entry.reason, 'result entry reason');
  if (entry.outcome === 'TRIGGERED' && entry.deploymentId === null) {
    throw new TypeError('triggered result entry requires a deployment ID');
  }
  if (entry.outcome === 'ALREADY_ACTIVE' && entry.observedDeploymentId === null) {
    throw new TypeError('already-active result entry requires an observed deployment ID');
  }
  if (entry.outcome === 'TRIGGERED' && entry.observedDeploymentId !== null) {
    throw new TypeError('triggered result entry cannot claim an observed deployment ID');
  }
  if (entry.outcome === 'ALREADY_ACTIVE' && entry.deploymentId !== null) {
    throw new TypeError('already-active result entry cannot claim a triggered deployment ID');
  }
  if (['SKIPPED', 'FAILED', 'AMBIGUOUS'].includes(entry.outcome)
    && (entry.deploymentId !== null || entry.observedDeploymentId !== null)) {
    throw new TypeError(`${entry.outcome} result entry cannot claim a deployment ID`);
  }
}

function resultWithoutDigest(manifest) {
  const { resultDigest: _ignored, ...unsigned } = manifest;
  return unsigned;
}

export function createResultManifest(input) {
  exactKeys(input, ['intent', 'outcome', 'entries', 'createdAt'], 'result input');
  const intent = validateIntentManifest(input.intent);
  if (!Array.isArray(input.entries)) throw new TypeError('result entries must be an array');
  const entries = input.entries
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.service.localeCompare(right.service));
  const manifest = {
    version: RESULT_VERSION,
    intent,
    intentDigest: intent.intentDigest,
    outcome: input.outcome,
    entries,
    createdAt: input.createdAt,
  };
  manifest.resultDigest = digest(manifest);
  return validateResultManifest(manifest);
}

export function validateResultManifest(manifest) {
  exactKeys(manifest, [
    'version', 'intent', 'intentDigest', 'outcome', 'entries', 'createdAt', 'resultDigest',
  ], 'result manifest');
  if (manifest.version !== RESULT_VERSION) throw new TypeError('result manifest version is unsupported');
  const intent = validateIntentManifest(manifest.intent);
  if (manifest.intentDigest !== intent.intentDigest) throw new TypeError('result intent digest mismatch');
  if (!RESULT_OUTCOMES.has(manifest.outcome)) throw new TypeError('result outcome is unsupported');
  for (const entry of manifest.entries) validateResultEntry(entry);
  validateSortedUnique(manifest.entries, 'result entries');
  timestamp(manifest.createdAt, 'result createdAt');

  const planned = new Map(intent.plannedServices.map((entry) => [entry.service, entry]));
  if (manifest.entries.length !== intent.plannedServices.length) {
    throw new TypeError('result entries must cover the exact planned services');
  }
  for (const entry of manifest.entries) {
    const expected = planned.get(entry.service);
    if (!expected || expected.serviceId !== entry.serviceId || expected.action !== entry.action) {
      throw new TypeError('result entry does not match its planned service');
    }
  }
  const entryOutcomes = new Set(manifest.entries.map((entry) => entry.outcome));
  if (manifest.outcome === 'NO_MUTATION'
    && [...entryOutcomes].some((outcome) => !['ALREADY_ACTIVE', 'SKIPPED'].includes(outcome))) {
    throw new TypeError('NO_MUTATION may include only already-active or skipped entries');
  }
  if (manifest.outcome === 'MUTATION_COMPLETED'
    && (!entryOutcomes.has('TRIGGERED')
      || [...entryOutcomes].some((outcome) => ['FAILED', 'AMBIGUOUS'].includes(outcome)))) {
    throw new TypeError('MUTATION_COMPLETED requires a trigger and cannot include failed or ambiguous entries');
  }
  if (manifest.outcome === 'MUTATION_PARTIAL'
    && (!entryOutcomes.has('TRIGGERED') || !entryOutcomes.has('FAILED') || entryOutcomes.has('AMBIGUOUS'))) {
    throw new TypeError('MUTATION_PARTIAL requires both triggered and failed entries without ambiguity');
  }
  if (manifest.outcome === 'MUTATION_AMBIGUOUS' && !entryOutcomes.has('AMBIGUOUS')) {
    throw new TypeError('MUTATION_AMBIGUOUS requires an ambiguous entry');
  }
  if (typeof manifest.resultDigest !== 'string' || !DIGEST.test(manifest.resultDigest)
    || digest(resultWithoutDigest(manifest)) !== manifest.resultDigest) {
    throw new TypeError('result manifest digest mismatch');
  }
  return manifest;
}
