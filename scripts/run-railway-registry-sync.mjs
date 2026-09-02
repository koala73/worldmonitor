#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRailwayCliEnv } from './railway-cli.mjs';

const AUDIT_PATH = fileURLToPath(new URL('./audit-railway-watch-paths.mjs', import.meta.url));
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);
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
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnImpl(process.execPath, [AUDIT_PATH, ...policy.args], {
      env: registrySyncChildEnv(env),
      stdio: 'inherit',
    });
    if (!result.error && !result.signal && result.status === 0) return;
    if (attempt === attempts) break;
    const delayMs = retryDelaysMs[attempt - 1];
    console.error(`Railway registry sync ${mode} attempt ${attempt} failed; retrying in ${delayMs}ms.`);
    await sleepImpl(delayMs);
  }
  throw new Error(`Railway registry sync ${mode} failed after ${attempts} attempts`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const mode = parseRegistrySyncArgs(process.argv.slice(2));
    await runRailwayRegistrySync({ mode });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
