#!/usr/bin/env node

/**
 * Browser-bundle the API entrypoints that can actually ship in a commit.
 *
 * Git's tracked inventory is the deployment contract. Real Vercel functions
 * must be tracked to reach CI or production, while ignored desktop sidecar
 * bundles are local Node artifacts and must not be treated as edge functions.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { isMainModule } from './lib/main-module.mjs';

const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

/**
 * Exported so tests reuse this exact env rather than reimplementing it. A
 * second copy drifts: the first one already did, gaining GIT_CONFIG_GLOBAL /
 * GIT_CONFIG_SYSTEM nulling that the real gate never had.
 */
export function isolatedGitEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

function listTrackedApiFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'api'], {
    encoding: 'utf8',
    env: isolatedGitEnv(),
  })
    .split('\0')
    .filter(Boolean)
    .sort();
}

const LEGACY_CI_TOP_LEVEL_TS_ALLOWLIST = new Set(['api/mcp.ts']);

function normalizeCallerOptions({
  caller = 'default',
  skipMissingWorktreeEntries,
  topLevelTsAllowlist,
} = {}) {
  if (caller === 'prepush') {
    return {
      skipMissingWorktreeEntries: skipMissingWorktreeEntries ?? true,
      topLevelTsAllowlist: topLevelTsAllowlist ?? null,
    };
  }

  if (caller === 'ci') {
    return {
      skipMissingWorktreeEntries: skipMissingWorktreeEntries ?? false,
      topLevelTsAllowlist: topLevelTsAllowlist ?? LEGACY_CI_TOP_LEVEL_TS_ALLOWLIST,
    };
  }

  if (caller !== 'default') {
    throw new Error(`unknown edge bundle caller "${caller}"`);
  }

  return {
    skipMissingWorktreeEntries: skipMissingWorktreeEntries ?? false,
    topLevelTsAllowlist: topLevelTsAllowlist ?? null,
  };
}

/**
 * Underscore-prefixed paths are private helpers, never routed.
 *
 * The two selectors below apply this at DIFFERENT depths on purpose, because
 * each reproduces the surface it replaced: the hygiene suite walked the whole
 * tree and skipped `_`-prefixed directories outright (`recursive: true`), while
 * the pre-push/CI `find` predicates only ever matched `-not -name "_*"`, i.e.
 * the basename. Changing either silently changes what is checked, so the
 * asymmetry is encoded here once rather than duplicated at both call sites.
 */
function isPrivateApiPath(file, { recursive }) {
  const segments = recursive ? file.split('/').slice(1) : [path.posix.basename(file)];
  return segments.some((segment) => segment.startsWith('_'));
}

export function listTrackedApiSourceFiles(root = process.cwd()) {
  return listTrackedApiFiles(root).filter((file) => (
    !isPrivateApiPath(file, { recursive: true })
    && (file.endsWith('.js') || file.endsWith('.ts'))
  ));
}

function collectEdgeFunctionEntries(root, options = {}) {
  const { skipMissingWorktreeEntries, topLevelTsAllowlist } = normalizeCallerOptions(options);
  const trackedEntries = listTrackedApiFiles(root).filter((file) => {
    if (isPrivateApiPath(file, { recursive: false })) return false;
    if (path.posix.basename(file).includes('.test.')) return false;
    if (file.endsWith('.js')) return true;
    if (!file.endsWith('.ts') || path.posix.dirname(file) !== 'api') return false;
    // Nested TS gateways are checked through their importing top-level
    // entrypoints and API typecheck. CI keeps the legacy explicit allowlist,
    // while pre-push broadens to every tracked top-level TS entrypoint.
    return topLevelTsAllowlist === null || topLevelTsAllowlist.has(file);
  });

  if (!skipMissingWorktreeEntries) {
    return { trackedEntries, entries: trackedEntries, missingWorktreeEntries: [] };
  }

  const missingWorktreeEntries = trackedEntries.filter(
    (file) => !existsSync(path.join(root, file)),
  );
  const entries = trackedEntries.filter((file) => !missingWorktreeEntries.includes(file));
  return { trackedEntries, entries, missingWorktreeEntries };
}

export function listEdgeFunctionEntries(root = process.cwd(), options = {}) {
  return collectEdgeFunctionEntries(root, options).entries;
}

export async function checkEdgeFunctionBundles({ root = process.cwd(), ...options } = {}) {
  const { trackedEntries, entries, missingWorktreeEntries } = collectEdgeFunctionEntries(root, options);
  if (trackedEntries.length === 0) {
    throw new Error('edge function bundle check found zero tracked entrypoints');
  }
  if (entries.length === 0) {
    throw new Error(
      missingWorktreeEntries.length > 0
        ? 'edge function bundle check found no worktree-present tracked entrypoints'
        : 'edge function bundle check found zero bundleable entrypoints',
    );
  }

  const outdir = await mkdtemp(path.join(os.tmpdir(), 'worldmonitor-edge-bundles-'));
  try {
    await build({
      absWorkingDir: root,
      entryPoints: entries.map((file) => ({
        in: file,
        out: `${file.slice(0, -path.posix.extname(file).length)}-${path.posix.extname(file).slice(1)}`,
      })),
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      logLevel: 'error',
    });
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }

  return entries;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = { caller: 'default', list: false };

  for (const arg of argv) {
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg.startsWith('--caller=')) {
      options.caller = arg.slice('--caller='.length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const { caller, list } = parseCliArgs();
  const entries = list
    ? listEdgeFunctionEntries(process.cwd(), { caller })
    : await checkEdgeFunctionBundles({ root: process.cwd(), caller });

  if (list) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    console.log(`edge function bundles ok: ${entries.length} tracked entrypoints`);
  }
}

// Use the shared realpath-safe helper, NOT a local comparison. `path.resolve`
// does not resolve symlinks while Node sets import.meta.url to the realpath, so
// the naive form returns false for an absolute symlinked argv[1] — main() never
// runs and this merge-blocking gate exits 0 having checked nothing. That exact
// fail-open already shipped once here (#4246,
// .github/scripts/audit-production-dependencies.mjs).
if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`edge function bundle check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
