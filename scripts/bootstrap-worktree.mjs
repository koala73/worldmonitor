#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  findLocalSecretDumps,
  formatLocalSecretDumpError,
} from './check-local-secret-dumps.mjs';

const LOCAL_ENV_FILES = ['.env.local', '.env'];
const DEFAULT_NPM_CACHE = '/tmp/worldmonitor-npm-cache';

export function parseArgs(argv = []) {
  const options = {
    cacheDir: process.env.npm_config_cache || DEFAULT_NPM_CACHE,
    dryRun: false,
    envSource: process.env.WM_ENV_SOURCE || '',
    forceInstall: false,
    help: false,
    ignoreScripts: false,
    rootDir: process.cwd(),
    skipEnv: false,
    skipInstall: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--skip-env') {
      options.skipEnv = true;
    } else if (arg === '--skip-install') {
      options.skipInstall = true;
    } else if (arg === '--force-install') {
      options.forceInstall = true;
    } else if (arg === '--ignore-scripts') {
      options.ignoreScripts = true;
    } else if (arg === '--env-source') {
      options.envSource = nextValue();
    } else if (arg?.startsWith('--env-source=')) {
      options.envSource = arg.slice('--env-source='.length);
    } else if (arg === '--cache') {
      options.cacheDir = nextValue();
    } else if (arg?.startsWith('--cache=')) {
      options.cacheDir = arg.slice('--cache='.length);
    } else if (arg === '--root') {
      options.rootDir = nextValue();
    } else if (arg?.startsWith('--root=')) {
      options.rootDir = arg.slice('--root='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function printHelp() {
  console.log(`Usage: node scripts/bootstrap-worktree.mjs [options]

Bootstrap ignored local state for a fresh WorldMonitor worktree.

Options:
  --env-source <dir>  Source repo root for .env.local/.env links.
                      Defaults to WM_ENV_SOURCE or the main worktree inferred
                      from git's common .git directory.
  --cache <dir>       npm cache directory. Default: ${DEFAULT_NPM_CACHE}
  --skip-env          Do not create env symlinks.
  --skip-install      Do not run npm ci when node_modules is missing.
  --force-install     Run npm ci even when node_modules already exists.
  --ignore-scripts    Pass --ignore-scripts to npm ci for docs/test-only work.
  --dry-run           Print what would happen without changing files.
  -h, --help          Show this help text.`);
}

export function inferEnvSource(rootDir = process.cwd()) {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );

  if (result.status !== 0) return '';

  const gitCommonDir = result.stdout.trim();
  if (!gitCommonDir || basename(gitCommonDir) !== '.git') return '';

  const source = dirname(gitCommonDir);
  return source === resolve(rootDir) ? '' : source;
}

export function assertProjectRoot(rootDir = process.cwd()) {
  const packagePath = resolve(rootDir, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`package.json not found at ${packagePath}`);
  }
}

export function assertNoForbiddenEnvDumps(rootDir = process.cwd()) {
  const found = findLocalSecretDumps(rootDir);
  if (found.length > 0) {
    throw new Error(formatLocalSecretDumpError(found));
  }
  return found;
}

function targetAlreadyExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function describeExistingEnvTarget(targetPath, sourcePath) {
  const stat = targetAlreadyExists(targetPath);
  if (!stat) return '';

  if (!stat.isSymbolicLink()) {
    return 'already exists; leaving untouched';
  }

  const currentTarget = readlinkSync(targetPath);
  const resolvedCurrentTarget = resolve(dirname(targetPath), currentTarget);
  if (resolvedCurrentTarget === sourcePath) {
    return 'already linked';
  }

  return `already links to ${currentTarget}; leaving untouched`;
}

export function linkEnvFiles({
  dryRun = false,
  log = console.log,
  rootDir = process.cwd(),
  sourceDir = '',
} = {}) {
  if (!sourceDir) {
    log('[worktree] no env source found; set WM_ENV_SOURCE or pass --env-source to link local env files');
    return { linked: [], missing: LOCAL_ENV_FILES, skipped: [], wouldLink: [] };
  }

  const resolvedRoot = resolve(rootDir);
  const resolvedSource = resolve(sourceDir);
  const result = { linked: [], missing: [], skipped: [], wouldLink: [] };

  for (const fileName of LOCAL_ENV_FILES) {
    const sourcePath = resolve(resolvedSource, fileName);
    const targetPath = resolve(resolvedRoot, fileName);

    if (!existsSync(sourcePath)) {
      log(`[worktree] ${fileName} source missing at ${sourcePath}; skipping`);
      result.missing.push(fileName);
      continue;
    }

    const existing = describeExistingEnvTarget(targetPath, sourcePath);
    if (existing) {
      log(`[worktree] ${fileName} ${existing}`);
      result.skipped.push(fileName);
      continue;
    }

    if (dryRun) {
      log(`[worktree] would link ${fileName} -> ${sourcePath}`);
      result.wouldLink.push(fileName);
    } else {
      symlinkSync(sourcePath, targetPath);
      log(`[worktree] linked ${fileName} -> ${sourcePath}`);
      result.linked.push(fileName);
    }
  }

  return result;
}

export function shouldInstallDependencies({
  forceInstall = false,
  rootDir = process.cwd(),
} = {}) {
  return forceInstall || !existsSync(resolve(rootDir, 'node_modules'));
}

export function installDependencies({
  cacheDir = DEFAULT_NPM_CACHE,
  dryRun = false,
  ignoreScripts = false,
  log = console.log,
  rootDir = process.cwd(),
} = {}) {
  const args = ['ci', '--cache', cacheDir];
  if (ignoreScripts) args.push('--ignore-scripts');

  if (dryRun) {
    log(`[worktree] would run: npm ${args.join(' ')}`);
    return { status: 0 };
  }

  mkdirSync(cacheDir, { recursive: true });
  log(`[worktree] running: npm ${args.join(' ')}`);

  const result = spawnSync('npm', args, {
    cwd: rootDir,
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return result;
}

// A stale absolute core.hooksPath makes every push from this worktree run
// ANOTHER checkout's (possibly ancient) pre-push hook — the 2026-07-24
// "pushes take minutes and time out" incident: the main checkout was parked
// 800+ commits behind and its unconditional pre-#4800 gate ran on every
// worktree push. Worktree-creation tooling copies the shared value into
// .git/worktrees/<name>/config.worktree at creation time, so a one-time
// absolute value keeps resurfacing in new worktrees. Policy: a per-worktree
// override pointing outside this worktree is unset (worktree-local, safe);
// a foreign absolute value in the SHARED config is warned about but never
// mutated from a bootstrap script.
export function decideHooksPathAction({ rootDir, hooksPathValue, originFile }) {
  if (!hooksPathValue) return { action: 'none', reason: 'core.hooksPath not set' };
  if (!hooksPathValue.startsWith('/')) {
    return { action: 'none', reason: `relative hooksPath (${hooksPathValue}) resolves per-worktree` };
  }
  if (hooksPathValue === resolve(rootDir, '.husky')) {
    return { action: 'none', reason: 'absolute hooksPath already points into this worktree' };
  }
  if (originFile.includes('/config.worktree')) {
    return {
      action: 'unset-worktree',
      reason: `per-worktree override points outside this worktree (${hooksPathValue})`,
    };
  }
  return {
    action: 'warn-shared',
    reason: `shared config sets absolute hooksPath outside this worktree (${hooksPathValue})`,
  };
}

export function normalizeWorktreeHooksPath({ dryRun = false, log = console.log, rootDir = process.cwd() } = {}) {
  const probe = spawnSync(
    'git',
    ['config', '--show-origin', '--get', 'core.hooksPath'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  // Exit 1 = unset; other failures (not a repo, no git) are not bootstrap's problem.
  if (probe.status !== 0) return { action: 'none', reason: 'core.hooksPath not set' };

  const [origin = '', ...valueParts] = probe.stdout.trim().split('\t');
  const decision = decideHooksPathAction({
    rootDir,
    hooksPathValue: valueParts.join('\t'),
    originFile: origin.replace(/^file:/, ''),
  });

  if (decision.action === 'unset-worktree') {
    log(`[worktree] removing stale hooksPath override: ${decision.reason}`);
    if (!dryRun) {
      spawnSync('git', ['config', '--worktree', '--unset', 'core.hooksPath'], {
        cwd: rootDir,
        stdio: 'inherit',
      });
    }
  } else if (decision.action === 'warn-shared') {
    log(`[worktree] WARNING: ${decision.reason}`);
    log('[worktree]   pushes here will run that checkout\'s hook copy, which may be stale.');
    log('[worktree]   Fix once for all worktrees: git config core.hooksPath .husky');
  }
  return decision;
}

export function bootstrapWorktree(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const log = options.log || console.log;
  const envSource = options.envSource
    ? resolve(options.envSource)
    : inferEnvSource(rootDir);

  assertProjectRoot(rootDir);

  normalizeWorktreeHooksPath({ dryRun: options.dryRun, log, rootDir });

  if (!options.skipEnv) {
    linkEnvFiles({
      dryRun: options.dryRun,
      log,
      rootDir,
      sourceDir: envSource,
    });
  }

  assertNoForbiddenEnvDumps(rootDir);

  if (!options.skipInstall) {
    if (shouldInstallDependencies({ forceInstall: options.forceInstall, rootDir })) {
      installDependencies({
        cacheDir: options.cacheDir || DEFAULT_NPM_CACHE,
        dryRun: options.dryRun,
        ignoreScripts: options.ignoreScripts,
        log,
        rootDir,
      });
    } else {
      log('[worktree] node_modules present; skipping npm ci');
    }
  }

  log('[worktree] bootstrap complete');
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      bootstrapWorktree(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
