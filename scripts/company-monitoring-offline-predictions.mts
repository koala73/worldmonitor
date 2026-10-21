#!/usr/bin/env node
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CompanyMonitoringOfflinePredictionError,
  assertCompanyMonitoringOfflineRuntimePermitted,
  computeOfflineProviderObservationDigest,
  createOfflinePredictionReconciliation,
  createOfflinePredictionBundle,
  createOfflinePredictionRunReceipt,
  validateOfflinePredictionBundle,
  runCompanyMonitoringOfflinePredictions,
  validateOfflineRetainedProviderResponse,
  type OfflineContinuationAuthorization,
  type OfflineProviderObservationManifest,
  type OfflinePredictionCheckpoint,
  type OfflinePredictionReconciliation,
  type OfflineRetainedProviderResponse,
} from '../shared/company-monitoring-offline-predictions.ts';
import {
  type BlindCorpus,
  type PredictionSet,
  type ScoreReport,
} from '../shared/company-monitoring-blind-evaluation.ts';
import type { CompanyMonitoringCurationManifest } from '../shared/company-monitoring-curation.ts';
import { canonicalJson, type JsonObject } from '../shared/company-monitoring-evaluation.ts';
import { loadEnvFile } from './_seed-utils.mjs';
import {
  CompanyMonitoringClassifierTransportError,
  parseCompanyMonitoringClassificationResponse,
  requestCompanyMonitoringClassification,
} from './lib/company-monitoring-classifier-client.mjs';

type Command = 'preflight' | 'run' | 'digest-observations' | 'reconcile' | 'extract-predictions';

class UsageError extends Error {}

function usage(): never {
  throw new UsageError([
    'usage:',
    '  company-monitoring:offline-predictions preflight --protocol FILE --approved-threshold-digest SHA256',
    '  company-monitoring:offline-predictions run --protocol FILE --approved-threshold-digest SHA256 --curation FILE --expected-curation-digest SHA256 --corpus FILE --observations FILE --expected-observations-digest SHA256 --checkpoint-directory DIR --output FILE [--reconciliation-directory DIR] [--previous-corpus FILE --expected-previous-corpus-digest SHA256 --previous-predictions FILE --expected-previous-predictions-digest SHA256 --previous-report FILE --expected-previous-report-digest SHA256 --continuation-authorization FILE]',
    '  company-monitoring:offline-predictions digest-observations --corpus FILE --observations FILE',
    '  company-monitoring:offline-predictions reconcile --checkpoint FILE --retained-provider-response FILE --expected-provider-response-digest SHA256 --output FILE',
    '  company-monitoring:offline-predictions extract-predictions --bundle FILE --bundle-verification-public-key FILE --protocol FILE --approved-threshold-digest SHA256 --curation FILE --expected-curation-digest SHA256 --corpus FILE --observations FILE --expected-observations-digest SHA256 --output FILE',
  ].join('\n'));
}

function parseOptions(values: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) usage();
    const name = flag.slice(2);
    if (options.has(name)) usage();
    options.set(name, value);
  }
  return options;
}

function exactOptions(options: Map<string, string>, names: string[]): void {
  if ([...options.keys()].some((name) => !names.includes(name))) usage();
}

function required(options: Map<string, string>, name: string): string {
  const result = options.get(name);
  if (!result) usage();
  return result;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new CompanyMonitoringOfflinePredictionError('offline_input_unreadable');
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new CompanyMonitoringOfflinePredictionError('offline_input_unreadable');
  }
}

function writeSealedArtifact(path: string, value: unknown): void {
  const outputPath = resolve(path);
  const temporary = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    linkSync(temporary, outputPath);
  } catch {
    throw new CompanyMonitoringOfflinePredictionError('offline_output_write_failed');
  } finally {
    try { unlinkSync(temporary); } catch { /* The final hard link owns the retained bytes. */ }
  }
}

async function main(): Promise<void> {
  const [commandValue, ...values] = process.argv.slice(2);
  const command = commandValue as Command | undefined;
  if (!command) usage();
  const options = parseOptions(values);

  if (command === 'preflight') {
    exactOptions(options, ['protocol', 'approved-threshold-digest']);
    assertCompanyMonitoringOfflineRuntimePermitted(
      readJson<JsonObject>(required(options, 'protocol')),
      required(options, 'approved-threshold-digest'),
    );
    process.stdout.write(`${canonicalJson({ status: 'continue' })}\n`);
    return;
  }

  if (command === 'digest-observations') {
    exactOptions(options, ['corpus', 'observations']);
    const corpus = readJson<BlindCorpus>(required(options, 'corpus'));
    const digest = computeOfflineProviderObservationDigest(
      readJson<OfflineProviderObservationManifest>(required(options, 'observations')),
      corpus,
    );
    process.stdout.write(`${digest}\n`);
    return;
  }

  if (command === 'reconcile') {
    exactOptions(options, [
      'checkpoint', 'retained-provider-response', 'expected-provider-response-digest', 'output',
    ]);
    loadEnvFile(import.meta.url, {
      only: ['COMPANY_MONITORING_OFFLINE_CHECKPOINT_HMAC_KEY'],
    });
    const checkpointAuthenticationKey = process.env.COMPANY_MONITORING_OFFLINE_CHECKPOINT_HMAC_KEY;
    if (!checkpointAuthenticationKey) {
      throw new CompanyMonitoringOfflinePredictionError('offline_checkpoint_authentication_missing');
    }
    const checkpoint = readJson<OfflinePredictionCheckpoint>(required(options, 'checkpoint'));
    const providerResponseSha256 = required(options, 'expected-provider-response-digest');
    const retainedProviderResponse = validateOfflineRetainedProviderResponse(
      readJson<OfflineRetainedProviderResponse>(required(options, 'retained-provider-response')),
      providerResponseSha256,
    );
    const response = new Response(canonicalJson(retainedProviderResponse.response));
    const classification = await parseCompanyMonitoringClassificationResponse({
      response,
      model: checkpoint.runtime.requestedModel,
      providerRoute: checkpoint.runtime.providerRoute,
      expectedResolvedProvider: checkpoint.runtime.resolvedProvider,
    });
    const reconciliation = createOfflinePredictionReconciliation({
      checkpoint,
      retainedProviderResponse,
      providerResponseSha256,
      classification,
      checkpointAuthenticationKey,
    });
    writeSealedArtifact(required(options, 'output'), reconciliation);
    return;
  }

  if (command === 'extract-predictions') {
    exactOptions(options, [
      'bundle', 'bundle-verification-public-key', 'protocol', 'approved-threshold-digest', 'curation',
      'expected-curation-digest', 'corpus', 'observations',
      'expected-observations-digest', 'output',
    ]);
    const predictions = validateOfflinePredictionBundle({
      bundle: readJson<unknown>(required(options, 'bundle')),
      verificationPublicKeyPem: readText(required(options, 'bundle-verification-public-key')),
      protocol: readJson<JsonObject>(required(options, 'protocol')),
      approvedThresholdDigest: required(options, 'approved-threshold-digest'),
      curation: readJson<CompanyMonitoringCurationManifest>(required(options, 'curation')),
      expectedCurationSha256: required(options, 'expected-curation-digest'),
      corpus: readJson<BlindCorpus>(required(options, 'corpus')),
      observations: readJson<OfflineProviderObservationManifest>(required(options, 'observations')),
      expectedObservationsSha256: required(options, 'expected-observations-digest'),
    });
    writeSealedArtifact(required(options, 'output'), predictions);
    return;
  }

  if (command !== 'run') usage();
  exactOptions(options, [
    'protocol', 'approved-threshold-digest', 'curation', 'expected-curation-digest',
    'corpus', 'observations',
    'expected-observations-digest', 'previous-corpus', 'checkpoint-directory',
    'reconciliation-directory', 'output',
    'expected-previous-corpus-digest', 'previous-predictions',
    'expected-previous-predictions-digest', 'previous-report', 'expected-previous-report-digest',
    'continuation-authorization',
  ]);
  const protocol = readJson<JsonObject>(required(options, 'protocol'));
  const approvedThresholdDigest = required(options, 'approved-threshold-digest');
  // This check deliberately precedes credential loading and every provider call.
  assertCompanyMonitoringOfflineRuntimePermitted(protocol, approvedThresholdDigest);

  loadEnvFile(import.meta.url, {
    only: [
      'OPENROUTER_API_KEY',
      'COMPANY_MONITORING_CLASSIFIER_MODEL',
      'COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE',
      'COMPANY_MONITORING_OFFLINE_CHECKPOINT_HMAC_KEY',
      'COMPANY_MONITORING_OFFLINE_BUNDLE_SIGNING_PRIVATE_KEY',
      'COMPANY_MONITORING_CONTINUATION_PUBLIC_KEY',
    ],
  });
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.COMPANY_MONITORING_CLASSIFIER_MODEL;
  const providerRoute = process.env.COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE;
  const checkpointAuthenticationKey = process.env.COMPANY_MONITORING_OFFLINE_CHECKPOINT_HMAC_KEY;
  const bundleSigningPrivateKey = process.env.COMPANY_MONITORING_OFFLINE_BUNDLE_SIGNING_PRIVATE_KEY;
  const continuationPublicKey = process.env.COMPANY_MONITORING_CONTINUATION_PUBLIC_KEY;
  if (!apiKey || !model || !providerRoute || !checkpointAuthenticationKey || !bundleSigningPrivateKey) {
    throw new CompanyMonitoringOfflinePredictionError('offline_classifier_configuration_missing');
  }
  const previousNames = [
    'previous-corpus', 'expected-previous-corpus-digest', 'previous-predictions',
    'expected-previous-predictions-digest', 'previous-report', 'expected-previous-report-digest',
    'continuation-authorization',
  ];
  const previousCount = previousNames.filter((name) => options.has(name)).length;
  if (previousCount !== 0 && previousCount !== previousNames.length) usage();
  if (previousCount !== 0 && !continuationPublicKey) {
    throw new CompanyMonitoringOfflinePredictionError('offline_continuation_public_key_missing');
  }

  const curation = readJson<CompanyMonitoringCurationManifest>(required(options, 'curation'));
  const corpus = readJson<BlindCorpus>(required(options, 'corpus'));
  const observations = readJson<OfflineProviderObservationManifest>(required(options, 'observations'));
  const checkpointDirectory = resolve(required(options, 'checkpoint-directory'));
  try {
    mkdirSync(checkpointDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw new CompanyMonitoringOfflinePredictionError('offline_checkpoint_directory_unavailable');
  }
  const checkpoints = readdirSync(checkpointDirectory)
    .filter((name) => /^cm_example_[a-f0-9]{6}\.(started|completed)\.json$/.test(name))
    .sort()
    .map((name) => readJson<OfflinePredictionCheckpoint>(join(checkpointDirectory, name)));
  const reconciliationDirectory = options.get('reconciliation-directory');
  const reconciliations = reconciliationDirectory === undefined
    ? []
    : readdirSync(reconciliationDirectory)
      .filter((name) => /^cm_example_[a-f0-9]{6}\.reconciliation\.json$/.test(name))
      .sort()
      .map((name) => readJson<OfflinePredictionReconciliation>(join(reconciliationDirectory, name)));
  const result = await runCompanyMonitoringOfflinePredictions({
    protocol,
    approvedThresholdDigest,
    curation,
    expectedCurationSha256: required(options, 'expected-curation-digest'),
    corpus,
    observations,
    expectedObservationsSha256: required(options, 'expected-observations-digest'),
    runtime: { requestedModel: model, providerRoute },
    checkpointAuthenticationKey,
    checkpoints,
    reconciliations,
    onCheckpoint: (checkpoint) => writeSealedArtifact(
      join(checkpointDirectory, `${checkpoint.opaqueExampleId}.${checkpoint.state}.json`),
      checkpoint,
    ),
    previous: previousCount === 0 ? undefined : {
      corpus: readJson<BlindCorpus>(required(options, 'previous-corpus')),
      expectedCorpusSha256: required(options, 'expected-previous-corpus-digest'),
      predictions: readJson<PredictionSet>(required(options, 'previous-predictions')),
      expectedPredictionSetSha256: required(options, 'expected-previous-predictions-digest'),
      report: readJson<ScoreReport>(required(options, 'previous-report')),
      expectedReportSha256: required(options, 'expected-previous-report-digest'),
      authorization: readJson<OfflineContinuationAuthorization>(
        required(options, 'continuation-authorization'),
      ),
      authorizationPublicKeyPem: continuationPublicKey!,
    },
    classify: ({ candidate, evidence, attemptId }) => requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      providerRoute,
      expectedResolvedProvider: observations.runtime.resolvedProvider,
      attemptId,
    }),
  });
  const receipt = createOfflinePredictionRunReceipt({
    protocol,
    approvedThresholdDigest,
    curation,
    corpus,
    observations,
    predictions: result,
  });
  writeSealedArtifact(required(options, 'output'), createOfflinePredictionBundle({
    predictions: result,
    receipt,
    signingPrivateKeyPem: bundleSigningPrivateKey,
  }));
}

function errorMessage(error: unknown): string {
  if (error instanceof CompanyMonitoringOfflinePredictionError) return error.code;
  if (error instanceof CompanyMonitoringClassifierTransportError) {
    const codes = new Set(['configuration', 'timeout', 'network', 'http', 'provider_response']);
    return codes.has(error.code)
      ? `offline_classifier_${error.code}`
      : 'offline_classifier_transport_error';
  }
  if (error instanceof UsageError) return error.message;
  return 'offline_prediction_unexpected_error';
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
