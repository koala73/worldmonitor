#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { readArgument } from './railway-cli.mjs';
import {
  ControlPlaneError,
  RailwayReconcileControlClient,
} from './railway-reconcile-control-client.mjs';
import { validateResultManifest } from './railway-reconcile-manifest.mjs';
import {
  ConvergenceError,
  verifyRailwayManifest,
} from './wait-railway-deploy-convergence.mjs';
import {
  ReconcileAuthorizationError,
  readCurrentMainLineageAuthorization,
} from './trigger-railway-deploys.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const VERIFIER_CONVERGENCE_BUDGET_MS = 35 * 60 * 1_000;
export const VERIFIER_FINALIZATION_BUDGET_MS = 39 * 60 * 1_000;
export const VERIFIER_CONTROL_POLL_MS = 15 * 1_000;

export function verifierFailureReason(error, manifest) {
  if (manifest?.outcome === 'MUTATION_PARTIAL') return 'PARTIAL_MUTATION';
  if (manifest?.outcome === 'MUTATION_AMBIGUOUS') return 'AMBIGUOUS_MUTATION';
  if (error instanceof ReconcileAuthorizationError
    && ['MAIN_DIVERGED', 'MAIN_MOVED', 'GATE_NOT_GREEN'].includes(error.code)) {
    return 'STALLED';
  }
  if (!(error instanceof ConvergenceError)) return null;
  if (error.code === 'CONVERGENCE_TIMEOUT') return 'CONVERGENCE_TIMEOUT';
  if (['DEPLOYMENT_TERMINAL_FAILURE', 'STRICT_DRIFT_FAILED'].includes(error.code)) {
    return 'TERMINAL_FAILURE';
  }
  if (error.code === 'DEPLOYMENT_STATUS_UNKNOWN') return 'UNKNOWN_STATUS';
  if (['DEPLOYMENT_QUERY_FAILED', 'DEPLOYMENT_MISSING', 'STRICT_DRIFT_QUERY_FAILED'].includes(error.code)) {
    return 'UNREADABLE_HISTORY';
  }
  if (error.code === 'MANIFEST_MUTATION_UNRESOLVED') {
    return manifest?.outcome === 'MUTATION_PARTIAL' ? 'PARTIAL_MUTATION' : 'AMBIGUOUS_MUTATION';
  }
  // A typed convergence failure is part of the verifier contract. If it is
  // not one of the retryable history/query cases above, close the durable
  // attempt instead of leaving a verifier lease stranded for manual expiry.
  return 'VERIFIER_CONTRACT_FAILURE';
}

export async function finalizeAfterLease({
  decide,
  deadlineAt,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let ambiguousRetries = 0;
  while (true) {
    try {
      return await decide();
    } catch (error) {
      const activeLease = error instanceof ControlPlaneError
        && error.definitive
        && error.code === 'LEASE_STILL_ACTIVE';
      const idempotentAmbiguity = error instanceof ControlPlaneError
        && error.code.endsWith('_AMBIGUOUS')
        && ambiguousRetries < 1;
      if (idempotentAmbiguity) ambiguousRetries += 1;
      if (!activeLease && !idempotentAmbiguity) throw error;
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) throw error;
      await sleep(Math.min(VERIFIER_CONTROL_POLL_MS, remainingMs));
    }
  }
}

export function assertManifestProvenance(
  manifest,
  expectedHead,
  env,
  expectedProducerRunAttempt = Number(env.GITHUB_RUN_ATTEMPT),
) {
  if (manifest.intent.headSha !== expectedHead) throw new Error('manifest head does not match --head');
  if (manifest.intent.producer.repository !== env.GITHUB_REPOSITORY
    || manifest.intent.producer.workflow !== 'railway-deploy-trigger.yml'
    || manifest.intent.producer.runId !== env.GITHUB_RUN_ID
    || manifest.intent.producer.runAttempt !== expectedProducerRunAttempt) {
    throw new Error('manifest producer does not match the exact verifier workflow run');
  }
}

export async function finalizeRailwayReconcile({
  manifest: uncheckedManifest,
  expectedHead,
  environment = 'production',
  env = process.env,
  control,
  verify = verifyRailwayManifest,
  authorizeCurrent = readCurrentMainLineageAuthorization,
  expectedProducerRunAttempt = Number(env.GITHUB_RUN_ATTEMPT),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const startedAt = now();
  const manifest = validateResultManifest(uncheckedManifest);
  assertManifestProvenance(manifest, expectedHead, env, expectedProducerRunAttempt);
  if (!control || typeof control.accept !== 'function' || typeof control.fail !== 'function') {
    throw new TypeError('verifier control client must provide accept and fail');
  }
  const decisionBody = {
    attemptId: manifest.intent.attemptId,
    headSha: manifest.intent.headSha,
    intentDigest: manifest.intentDigest,
    resultDigest: manifest.resultDigest,
  };

  try {
    await verify({
      manifest,
      expectedHead,
      environment,
      deadlineMs: VERIFIER_CONVERGENCE_BUDGET_MS,
    });
    await authorizeCurrent({
      repository: env.GITHUB_REPOSITORY,
      headSha: expectedHead,
      env,
    });
    const accepted = await finalizeAfterLease({
      decide: () => control.accept(decisionBody),
      deadlineAt: startedAt + VERIFIER_FINALIZATION_BUDGET_MS,
      now,
      sleep,
    });
    return {
      outcome: accepted.outcome,
      attemptId: manifest.intent.attemptId,
      headSha: expectedHead,
      intentDigest: manifest.intentDigest,
      resultDigest: manifest.resultDigest,
    };
  } catch (error) {
    const reason = verifierFailureReason(error, manifest);
    if (reason) {
      await finalizeAfterLease({
        decide: () => control.fail({ ...decisionBody, reason }),
        deadlineAt: startedAt + VERIFIER_FINALIZATION_BUDGET_MS,
        now,
        sleep,
      });
    }
    throw error;
  }
}

async function main() {
  const manifestPath = readArgument(process.argv, '--manifest', null);
  const expectedHead = readArgument(process.argv, '--head', null);
  const environment = readArgument(process.argv, '--environment', 'production');
  const expectedProducerRunAttempt = Number(readArgument(
    process.argv,
    '--producer-run-attempt',
    process.env.GITHUB_RUN_ATTEMPT,
  ));
  if (!manifestPath || !expectedHead) throw new Error('--manifest and --head are required');
  if (!Number.isInteger(expectedProducerRunAttempt) || expectedProducerRunAttempt < 1) {
    throw new Error('--producer-run-attempt must be a positive integer');
  }
  const control = new RailwayReconcileControlClient({
    role: 'verifier',
    secret: process.env.RAILWAY_RECONCILE_VERIFIER_HMAC,
  });
  const result = await finalizeRailwayReconcile({
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    expectedHead,
    environment,
    expectedProducerRunAttempt,
    control,
  });
  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
