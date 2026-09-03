#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRailwayCliEnv } from './railway-cli.mjs';
import { CONFIGURATION_DRIFT_EXIT_CODE } from './audit-railway-watch-paths.mjs';

const AUDIT_PATH = fileURLToPath(new URL('./audit-railway-watch-paths.mjs', import.meta.url));
export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);
// One attempt of either mode is cut here so a hung Railway call cannot consume
// the whole job. Apply mode has no deadline of its own (the audit's 15-minute
// run budget covers the Viewer read only), so this bound times the attempts
// plus the retry delays is the apply step's worst case; the workflow's
// timeout-minutes must cover that, the Viewer budget, and setup, and the
// workflow test pins that arithmetic.
export const MODE_ATTEMPT_TIMEOUT_MS = Object.freeze({
  apply: 5 * 60_000,
  verify: 16 * 60_000,
});
const MODE_POLICY = Object.freeze({
  apply: Object.freeze({
    args: Object.freeze(['--apply', '--environment', 'production']),
    requiredCredential: 'RAILWAY_TOKEN',
    forbiddenCredential: 'RAILWAY_API_TOKEN',
  }),
  verify: Object.freeze({
    args: Object.freeze([
      '--deployment-only',
      '--environment',
      'production',
      '--concurrency',
      '2',
    ]),
    requiredCredential: 'RAILWAY_API_TOKEN',
    forbiddenCredential: 'RAILWAY_TOKEN',
  }),
});

function requireMode(value) {
  if (!Object.hasOwn(MODE_POLICY, value)) {
    throw new Error('--mode expected apply or verify');
  }
  return value;
}

export function parseRegistrySyncArgs(argv) {
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--mode') {
      if (mode !== null) throw new Error('--mode may be provided only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--mode requires a value');
      mode = requireMode(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--mode=')) {
      if (mode !== null) throw new Error('--mode may be provided only once');
      mode = requireMode(argument.slice('--mode='.length));
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  if (mode === null) throw new Error('--mode is required');
  return mode;
}

function hasValue(env, name) {
  return typeof env?.[name] === 'string' && env[name].trim().length > 0;
}

function validateCredentialBoundary(mode, env) {
  const policy = MODE_POLICY[requireMode(mode)];
  if (!hasValue(env, 'RAILWAY_PROJECT_ID')) {
    throw new Error(`${mode} mode requires RAILWAY_PROJECT_ID`);
  }
  if (!hasValue(env, policy.requiredCredential)) {
    throw new Error(`${mode} mode requires ${policy.requiredCredential}`);
  }
  if (hasValue(env, policy.forbiddenCredential)) {
    throw new Error(`${mode} mode forbids ${policy.forbiddenCredential}`);
  }
  return policy;
}

function registrySyncChildEnv(env) {
  const childEnv = createRailwayCliEnv(env);
  if (hasValue(env, 'RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS')) {
    childEnv.RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS = env.RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS;
  }
  return childEnv;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function describeChildFailure(result) {
  if (result?.error) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    return `spawn error: ${message}`;
  }
  if (result?.signal) return `signal ${result.signal}`;
  if (Number.isInteger(result?.status)) return `exit ${result.status}`;
  return 'unknown child-process result';
}

export async function runRailwayRegistrySync({
  mode,
  env = process.env,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  spawnImpl = spawnSync,
  sleepImpl = sleep,
}) {
  const policy = validateCredentialBoundary(mode, env);
  if (!Array.isArray(retryDelaysMs)
    || retryDelaysMs.some((delayMs) => !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new TypeError('retry delays must be non-negative finite numbers');
  }

  const attempts = retryDelaysMs.length + 1;
  let lastFailure = 'not started';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnImpl(process.execPath, [AUDIT_PATH, ...policy.args], {
      env: registrySyncChildEnv(env),
      stdio: 'inherit',
      timeout: MODE_ATTEMPT_TIMEOUT_MS[mode],
      killSignal: 'SIGTERM',
    });
    if (!result.error && !result.signal && result.status === 0) return;
    lastFailure = describeChildFailure(result);
    if (!result.error && !result.signal && result.status === CONFIGURATION_DRIFT_EXIT_CODE) {
      throw new Error(
        `Railway registry sync ${mode} reported configuration drift (${lastFailure}); verdicts are not retried`,
      );
    }
    if (attempt === attempts) break;
    const delayMs = retryDelaysMs[attempt - 1];
    console.error(
      `Railway registry sync ${mode} attempt ${attempt} failed (${lastFailure}); retrying in ${delayMs}ms.`,
    );
    await sleepImpl(delayMs);
  }
  throw new Error(
    `Railway registry sync ${mode} failed after ${attempts} attempts (last failure: ${lastFailure})`,
  );
}

if (import.meta.main) {
  try {
    const mode = parseRegistrySyncArgs(process.argv.slice(2));
    await runRailwayRegistrySync({ mode });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
