import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalJson,
  hasExactKeys,
  isEvidenceDigest,
  type JsonObject,
} from './company-monitoring-evaluation.ts';
import {
  CompanyMonitoringOfflinePredictionError,
  type OfflineClassifierResult,
  type OfflinePredictionCheckpoint,
  type OfflinePredictionReconciliation,
  type OfflineProviderObservationManifest,
  type OfflineRetainedProviderResponse,
} from './company-monitoring-offline-prediction-contracts.ts';

const ATTEMPT_ID = /^cm_attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHECKPOINT_KEYS = new Set([
  'schemaVersion', 'protocolSha256', 'approvedThresholdDigest', 'corpusSha256',
  'curationSha256', 'providerObservationsSha256', 'runtime', 'state',
  'opaqueExampleId', 'attemptId', 'prediction', 'authenticationSha256',
]);
const RETAINED_PROVIDER_RESPONSE_KEYS = new Set([
  'schemaVersion', 'attemptId', 'providerResponseId', 'providerLatencyMs', 'response',
]);

function fail(code: string): never {
  throw new CompanyMonitoringOfflinePredictionError(code);
}

export function computeOfflineClassifierRuntimeDigest(
  runtime: OfflineProviderObservationManifest['runtime'],
): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 'cm_offline_classifier_runtime_v1',
    requestedModel: runtime.requestedModel,
    providerRoute: runtime.providerRoute,
    resolvedProvider: runtime.resolvedProvider,
  })).digest('hex');
}

function exact(value: unknown, keys: Set<string>, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  if (!hasExactKeys(value as JsonObject, keys)) fail(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, maximum = 2_048): string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(code);
  return value;
}

function finiteNonNegative(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

export function decodeOfflineCheckpointAuthenticationKey(value: unknown): Buffer {
  const encoded = text(value, 'offline_checkpoint_authentication_missing', 1_024);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    fail('offline_checkpoint_authentication_invalid');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 32 || key.toString('base64') !== encoded) {
    fail('offline_checkpoint_authentication_invalid');
  }
  return key;
}

export function authenticateOfflineArtifact(value: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson(value)).digest('hex');
}

export function verifyOfflineArtifactAuthentication(
  value: Record<string, unknown>,
  key: Buffer,
): void {
  if (!isEvidenceDigest(value.authenticationSha256)) {
    fail('offline_checkpoint_authentication_invalid');
  }
  const { authenticationSha256, ...body } = value;
  const expected = authenticateOfflineArtifact(body, key);
  if (!timingSafeEqual(Buffer.from(authenticationSha256), Buffer.from(expected))) {
    fail('offline_checkpoint_authentication_invalid');
  }
}

export function validateOfflineRetainedProviderResponse(
  value: unknown,
  expectedSha256: string,
): OfflineRetainedProviderResponse {
  const retained = exact(
    value,
    RETAINED_PROVIDER_RESPONSE_KEYS,
    'offline_retained_provider_response_invalid',
  );
  if (
    retained.schemaVersion !== 'cm_offline_retained_provider_response_v1' ||
    !ATTEMPT_ID.test(String(retained.attemptId)) ||
    typeof retained.providerResponseId !== 'string' ||
    retained.providerResponseId.length === 0 ||
    retained.providerResponseId !== retained.providerResponseId.trim() ||
    retained.providerResponseId.length > 200 ||
    !retained.response || typeof retained.response !== 'object' || Array.isArray(retained.response)
  ) fail('offline_retained_provider_response_invalid');
  finiteNonNegative(retained.providerLatencyMs, 'offline_retained_provider_response_invalid');
  const digest = createHash('sha256').update(canonicalJson(retained)).digest('hex');
  if (!isEvidenceDigest(expectedSha256) || digest !== expectedSha256) {
    fail('offline_retained_provider_response_digest_mismatch');
  }
  return retained as OfflineRetainedProviderResponse;
}

export function createOfflinePredictionReconciliation(input: {
  checkpoint: OfflinePredictionCheckpoint;
  retainedProviderResponse: OfflineRetainedProviderResponse;
  providerResponseSha256: string;
  classification: OfflineClassifierResult;
  checkpointAuthenticationKey: string;
}): OfflinePredictionReconciliation {
  const key = decodeOfflineCheckpointAuthenticationKey(input.checkpointAuthenticationKey);
  const retainedProviderResponse = validateOfflineRetainedProviderResponse(
    input.retainedProviderResponse,
    input.providerResponseSha256,
  );
  const checkpoint = exact(
    input.checkpoint,
    CHECKPOINT_KEYS,
    'offline_reconciliation_checkpoint_invalid',
  );
  verifyOfflineArtifactAuthentication(checkpoint, key);
  if (
    checkpoint.state !== 'started' || checkpoint.prediction !== null ||
    checkpoint.attemptId !== retainedProviderResponse.attemptId ||
    input.classification.providerResponseId !== retainedProviderResponse.providerResponseId
  ) fail('offline_reconciliation_checkpoint_invalid');
  const body = {
    schemaVersion: 'cm_offline_prediction_reconciliation_v1' as const,
    opaqueExampleId: String(checkpoint.opaqueExampleId),
    attemptId: String(checkpoint.attemptId),
    providerResponseSha256: input.providerResponseSha256,
    providerLatencyMs: retainedProviderResponse.providerLatencyMs,
    classification: input.classification,
  };
  return {
    ...body,
    authenticationSha256: authenticateOfflineArtifact(body, key),
  };
}
