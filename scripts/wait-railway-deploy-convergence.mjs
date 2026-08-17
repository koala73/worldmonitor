#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';
import {
  createRailwayCliEnv,
  readArgument,
  readDeployments,
  readRepositoryServices,
  resolveEnvironmentId,
} from './railway-cli.mjs';
import {
  FAILED_STATUSES,
  IN_FLIGHT_STATUSES,
  REJECTED_STATUS,
  RUNNING_STATUSES,
} from './railway-deployments.mjs';
import { validateResultManifest } from './railway-reconcile-manifest.mjs';

export const DEFAULT_CONVERGENCE_DEADLINE_MS = 35 * 60 * 1_000;
export const DEFAULT_CONVERGENCE_POLL_MS = 15 * 1_000;
export const CONVERGENCE_READ_CONCURRENCY = 8;

const FAILED_TERMINAL_STATUSES = new Set([...FAILED_STATUSES, REJECTED_STATUS]);

export class ConvergenceError extends Error {
  constructor(code, message, { disposition = 'UNCHANGED', cause } = {}) {
    super(message, { cause });
    this.name = 'ConvergenceError';
    this.code = code;
    this.disposition = disposition;
  }
}

export function assertRailwayManifestContext(manifest, { projectId, environmentId }) {
  if (projectId !== manifest.intent.projectId) {
    throw new ConvergenceError(
      'MANIFEST_PROJECT_MISMATCH',
      'manifest project does not match RAILWAY_PROJECT_ID',
    );
  }
  if (environmentId !== manifest.intent.environmentId) {
    throw new ConvergenceError(
      'MANIFEST_ENVIRONMENT_MISMATCH',
      'manifest environment does not match the resolved Railway environment',
    );
  }
}

export function classifyRelevantDeployment(status) {
  if (RUNNING_STATUSES.includes(status)) return 'ACCEPTED';
  if (IN_FLIGHT_STATUSES.includes(status)) return 'WAIT';
  if (FAILED_TERMINAL_STATUSES.has(status)) return 'FAILED';
  return 'UNKNOWN';
}

function relevantDeploymentId(entry) {
  if (entry.outcome === 'TRIGGERED') return entry.deploymentId;
  if (entry.outcome === 'ALREADY_ACTIVE') return entry.observedDeploymentId;
  return null;
}

function failureDisposition(manifest) {
  return manifest.outcome === 'NO_MUTATION' ? 'PRE_MUTATION_ABORTED' : 'MANUAL_REQUIRED';
}

export async function waitForRailwayDeployConvergence({
  manifest: uncheckedManifest,
  expectedHead,
  readDeployment,
  verifyStrictDrift,
  deadlineMs = DEFAULT_CONVERGENCE_DEADLINE_MS,
  pollIntervalMs = DEFAULT_CONVERGENCE_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (['MUTATION_PARTIAL', 'MUTATION_AMBIGUOUS'].includes(uncheckedManifest?.outcome)) {
    throw new ConvergenceError(
      'MANIFEST_MUTATION_UNRESOLVED',
      'partial or ambiguous mutation evidence requires manual resolution',
      { disposition: 'MANUAL_REQUIRED' },
    );
  }
  const manifest = validateResultManifest(uncheckedManifest);
  if (expectedHead !== manifest.intent.headSha) {
    throw new ConvergenceError('EXACT_HEAD_MISMATCH', 'manifest head does not match the verifier head');
  }
  if (typeof readDeployment !== 'function' || typeof verifyStrictDrift !== 'function') {
    throw new TypeError('convergence requires deployment and strict-drift readers');
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1
    || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('convergence timing bounds must be positive integers');
  }
  const relevant = manifest.entries
    .map((entry) => ({ entry, deploymentId: relevantDeploymentId(entry) }))
    .filter(({ deploymentId }) => deploymentId !== null);
  if (manifest.entries.some((entry) => ['FAILED', 'AMBIGUOUS'].includes(entry.outcome))) {
    throw new ConvergenceError(
      'MANIFEST_MUTATION_UNRESOLVED',
      'failed or ambiguous mutation evidence requires manual resolution',
      { disposition: failureDisposition(manifest) },
    );
  }

  const accepted = new Set();
  const queryFailures = new Map();
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  while (now() < deadlineAt && accepted.size < relevant.length) {
    const unresolved = relevant.filter(({ deploymentId }) => !accepted.has(deploymentId));
    for (let index = 0; index < unresolved.length; index += CONVERGENCE_READ_CONCURRENCY) {
      const batch = unresolved.slice(index, index + CONVERGENCE_READ_CONCURRENCY);
      const reads = await Promise.allSettled(batch.map(({ entry }) => readDeployment(entry)));
      for (let offset = 0; offset < batch.length; offset += 1) {
        const { entry, deploymentId } = batch[offset];
        const read = reads[offset];
        if (read.status === 'rejected') {
          queryFailures.set(deploymentId, { entry, cause: read.reason });
          continue;
        }
        queryFailures.delete(deploymentId);
        const deployment = read.value;
        if (!deployment || deployment.id !== deploymentId) {
          throw new ConvergenceError(
            'DEPLOYMENT_MISSING',
            `the bound deployment was not found for ${entry.service}`,
          );
        }
        const classification = classifyRelevantDeployment(deployment.status);
        if (classification === 'ACCEPTED') {
          accepted.add(deploymentId);
        } else if (classification === 'FAILED') {
          throw new ConvergenceError(
            'DEPLOYMENT_TERMINAL_FAILURE',
            `${entry.service} reached a non-accepted terminal deployment state`,
            { disposition: failureDisposition(manifest) },
          );
        } else if (classification === 'UNKNOWN') {
          throw new ConvergenceError(
            'DEPLOYMENT_STATUS_UNKNOWN',
            `${entry.service} returned an unsupported deployment state`,
          );
        }
      }
      if (now() >= deadlineAt) {
        const unresolvedFailure = [...queryFailures.entries()]
          .find(([deploymentId]) => !accepted.has(deploymentId));
        if (unresolvedFailure) {
          throw new ConvergenceError(
            'DEPLOYMENT_QUERY_FAILED',
            `deployment history could not be read for ${unresolvedFailure[1].entry.service}`,
            { cause: unresolvedFailure[1].cause },
          );
        }
        throw new ConvergenceError(
          'CONVERGENCE_TIMEOUT',
          'deployment reads crossed the exact convergence deadline',
          { disposition: failureDisposition(manifest) },
        );
      }
    }
    if (accepted.size < relevant.length) await sleep(Math.min(pollIntervalMs, Math.max(1, deadlineAt - now())));
  }
  if (accepted.size !== relevant.length) {
    const unresolvedFailure = [...queryFailures.entries()]
      .find(([deploymentId]) => !accepted.has(deploymentId));
    if (unresolvedFailure) {
      throw new ConvergenceError(
        'DEPLOYMENT_QUERY_FAILED',
        `deployment history could not be read for ${unresolvedFailure[1].entry.service}`,
        { cause: unresolvedFailure[1].cause },
      );
    }
    throw new ConvergenceError(
      'CONVERGENCE_TIMEOUT',
      'relevant deployments did not reach accepted terminal states before the deadline',
      { disposition: failureDisposition(manifest) },
    );
  }

  let strict;
  try {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      throw new ConvergenceError(
        'CONVERGENCE_TIMEOUT',
        'no convergence budget remained for strict fleet drift',
        { disposition: failureDisposition(manifest) },
      );
    }
    strict = await verifyStrictDrift({
      headSha: manifest.intent.headSha,
      manifest,
      remainingMs,
    });
    if (now() >= deadlineAt) {
      throw new ConvergenceError(
        'CONVERGENCE_TIMEOUT',
        'strict fleet drift crossed the exact convergence deadline',
        { disposition: failureDisposition(manifest) },
      );
    }
  } catch (cause) {
    if (cause instanceof ConvergenceError) throw cause;
    throw new ConvergenceError('STRICT_DRIFT_QUERY_FAILED', 'strict fleet drift could not be evaluated', { cause });
  }
  if (!strict || typeof strict !== 'object' || typeof strict.ok !== 'boolean') {
    throw new ConvergenceError('STRICT_DRIFT_INVALID', 'strict fleet drift returned an invalid result');
  }
  if (!strict.ok) {
    throw new ConvergenceError(
      'STRICT_DRIFT_FAILED',
      'strict exact-head fleet drift did not clear',
      { disposition: failureDisposition(manifest) },
    );
  }
  return {
    ok: true,
    attemptId: manifest.intent.attemptId,
    headSha: manifest.intent.headSha,
    intentDigest: manifest.intentDigest,
    resultDigest: manifest.resultDigest,
    acceptedDeploymentIds: [...accepted].sort(),
    strict,
  };
}

export function buildStrictDriftArgs(headSha, environment, expectedServices) {
  if (!Array.isArray(expectedServices) || expectedServices.length === 0
    || expectedServices.some((name) => typeof name !== 'string' || name.length === 0)
    || new Set(expectedServices).size !== expectedServices.length) {
    throw new TypeError('strict drift requires immutable unique expected service names');
  }
  return [
    fileURLToPath(new URL('./check-railway-deploy-drift.mjs', import.meta.url)),
    '--strict', '--json', '--head', headSha, '--environment', environment,
    ...expectedServices.flatMap((service) => ['--expected-service', service]),
  ];
}

export function createStrictDriftEnv(env = process.env) {
  return createRailwayCliEnv(env);
}

function runStrictDrift(headSha, environment, timeoutMs, expectedServices) {
  const result = spawnSync(process.execPath, buildStrictDriftArgs(
    headSha,
    environment,
    expectedServices,
  ), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.min(5 * 60 * 1_000, Math.max(1, timeoutMs)),
    env: createStrictDriftEnv(process.env),
  });
  if (result.signal || result.error) throw result.error ?? new Error('strict drift process timed out');
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error('strict drift returned malformed JSON', { cause });
  }
  if (!parsed?.summary || typeof parsed.summary.ok !== 'boolean') {
    throw new Error('strict drift response has no summary');
  }
  return parsed.summary;
}

export async function verifyRailwayManifest({
  manifest: uncheckedManifest,
  expectedHead,
  environment = 'production',
  deadlineMs = DEFAULT_CONVERGENCE_DEADLINE_MS,
}) {
  const manifest = validateResultManifest(uncheckedManifest);
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (projectId !== manifest.intent.projectId) {
    assertRailwayManifestContext(manifest, { projectId, environmentId: manifest.intent.environmentId });
  }
  const environmentId = resolveEnvironmentId(environment);
  assertRailwayManifestContext(manifest, { projectId, environmentId });
  const services = readRepositoryServices(environment);
  const byId = new Map(services.map((service) => [service.id, service]));
  return waitForRailwayDeployConvergence({
    manifest,
    expectedHead,
    deadlineMs,
    readDeployment: async (entry) => {
      const service = byId.get(entry.serviceId);
      if (!service || service.name !== entry.service) return null;
      const wanted = relevantDeploymentId(entry);
      const deployments = await readDeployments(service, environment, 100);
      return deployments.find((deployment) => deployment.id === wanted) ?? null;
    },
    verifyStrictDrift: async ({ headSha, remainingMs }) => (
      runStrictDrift(
        headSha,
        environment,
        remainingMs,
        manifest.intent.plannedServices.map(({ service }) => service),
      )
    ),
  });
}

async function main() {
  const manifestPath = readArgument(process.argv, '--manifest', null);
  const expectedHead = readArgument(process.argv, '--head', null);
  const environment = readArgument(process.argv, '--environment', 'production');
  if (!manifestPath || !expectedHead) throw new Error('--manifest and --head are required');
  const result = await verifyRailwayManifest({
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    expectedHead,
    environment,
  });
  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    if (error instanceof ConvergenceError) {
      console.error(JSON.stringify({ ok: false, code: error.code, disposition: error.disposition }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
}
