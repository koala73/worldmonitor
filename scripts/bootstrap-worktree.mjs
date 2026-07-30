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

// Relative, so git resolves it against whichever worktree the hook runs from.
const RELATIVE_HOOKS_PATH = '.husky';

// A stale absolute core.hooksPath makes every push from this worktree run
// ANOTHER checkout's (possibly ancient) pre-push hook — the 2026-07-24
// "pushes take minutes and time out" incident: the main checkout was parked
// 800+ commits behind and its unconditional pre-#4800 gate ran on every
// worktree push. Worktree-creation tooling copies the shared value into
// .git/worktrees/<name>/config.worktree at creation time, so a one-time
// absolute value keeps resurfacing in new worktrees.
//
// Policy (#5810): repair, do not merely report. Warning was tried and the
// value came back three times — a log line at worktree-creation time is not a
// gate, and the hook's own self-identity tripwire cannot help here because a
// hook copy stale enough to be the problem predates the tripwire. Both layers
// are therefore healed: a per-worktree override pointing outside this worktree
// is unset, and an absolute SHARED value is rewritten to the relative form.
// The two carve-outs keep the repair from clobbering a deliberate setup: a
// hooks dir that is not a `.husky` (so, not this repo's shape) is left alone,
// as is any value when WM_ALLOW_FOREIGN_HOOKS is set — the same escape hatch
// .husky/pre-push honours.
export function decideHooksPathAction({
  allowForeignHooks = false,
  hooksPathValue,
  hooksPathOwnedByRepository = false,
  originFile,
  rootDir,
}) {
  if (!hooksPathValue) return { action: 'none', reason: 'core.hooksPath not set' };
  if (!hooksPathValue.startsWith('/')) {
    return { action: 'none', reason: `relative hooksPath (${hooksPathValue}) resolves per-worktree` };
  }

  // A worktree-local override only governs this worktree, so pointing at this
  // worktree's own hooks is harmless. The same value in the SHARED config
  // welds every OTHER worktree to this checkout's hook file, which is the bug.
  if (originFile.includes('/config.worktree')) {
    if (hooksPathValue === resolve(rootDir, RELATIVE_HOOKS_PATH)) {
      return { action: 'none', reason: 'absolute hooksPath already points into this worktree' };
    }
    return {
      action: 'unset-worktree',
      reason: `per-worktree override points outside this worktree (${hooksPathValue})`,
    };
  }

  if (basename(hooksPathValue) !== RELATIVE_HOOKS_PATH) {
    return {
      action: 'warn-shared',
      reason: `shared config points at a non-husky hooks dir (${hooksPathValue}); leaving it alone`,
    };
  }
  if (allowForeignHooks) {
    return {
      action: 'warn-shared',
      reason: `shared config sets absolute hooksPath (${hooksPathValue}); WM_ALLOW_FOREIGN_HOOKS is set, leaving it alone`,
    };
  }
  if (!hooksPathOwnedByRepository) {
    return {
      action: 'warn-shared',
      reason: `shared config points at an unverified .husky dir (${hooksPathValue}); leaving it alone`,
    };
  }
  return {
    action: 'repair-shared',
    reason: `shared config pins every worktree's hooks to one checkout (${hooksPathValue})`,
  };
}

function probeHooksPath(rootDir, runGit) {
  const probe = runGit(
    'git',
    ['config', '--show-origin', '--get', 'core.hooksPath'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  // Exit 1 = unset; other failures (not a repo, no git) are not bootstrap's problem.
  if (probe.status !== 0) return null;

  const [origin = '', ...valueParts] = probe.stdout.trim().split('\t');
  return {
    hooksPathValue: valueParts.join('\t'),
    originFile: origin.replace(/^file:/, ''),
  };
}

function getGitCommonDir(rootDir, runGit) {
  const result = runGit(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  return result.status === 0 ? resolve(result.stdout.trim()) : null;
}

function hooksPathBelongsToRepository({ hooksPathValue, rootDir, runGit }) {
  const currentCommonDir = getGitCommonDir(rootDir, runGit);
  const hooksCheckoutCommonDir = getGitCommonDir(dirname(hooksPathValue), runGit);
  return currentCommonDir !== null && currentCommonDir === hooksCheckoutCommonDir;
}

export function normalizeWorktreeHooksPath({
  allowForeignHooks = Boolean(process.env.WM_ALLOW_FOREIGN_HOOKS),
  dryRun = false,
  log = console.log,
  rootDir = process.cwd(),
  runGit = spawnSync,
} = {}) {
  const decisions = [];

  // Two passes, because `--show-origin` reports only the winning layer: a
  // per-worktree override hides whatever the shared config says, so unsetting
  // it can expose a second, broken value underneath. Fixing one layer and
  // calling it done is exactly how the 2026-07-24 incident survived its first
  // fix.
  for (let pass = 0; pass < 2; pass += 1) {
    const probed = probeHooksPath(rootDir, runGit);
    if (!probed) {
      decisions.push({ action: 'none', reason: 'core.hooksPath not set' });
      break;
    }

    const decision = decideHooksPathAction({
      allowForeignHooks,
      hooksPathOwnedByRepository:
        probed.hooksPathValue.startsWith('/')
        && hooksPathBelongsToRepository({
          hooksPathValue: probed.hooksPathValue,
          rootDir,
          runGit,
        }),
      rootDir,
      ...probed,
    });
    decisions.push(decision);

    if (decision.action === 'unset-worktree') {
      log(`[worktree] removing stale hooksPath override: ${decision.reason}`);
      if (dryRun) {
        log('[worktree]   the shared value it masks cannot be read until the override is gone');
        break;
      }
      const unset = runGit('git', ['config', '--worktree', '--unset', 'core.hooksPath'], {
        cwd: rootDir,
        stdio: 'inherit',
      });
      if (unset.status !== 0) {
        throw new Error(
          'failed to remove stale worktree hooksPath override; '
          + 'run: git config --worktree --unset core.hooksPath',
        );
      }
      continue;
    }

    if (decision.action === 'repair-shared') {
      log(`[worktree] repairing shared hooksPath: ${decision.reason}`);
      log(`[worktree]   setting core.hooksPath=${RELATIVE_HOOKS_PATH} so each worktree runs its own hook`);
      if (!dryRun) {
        const repair = runGit('git', ['config', 'core.hooksPath', RELATIVE_HOOKS_PATH], {
          cwd: rootDir,
          stdio: 'inherit',
        });
        if (repair.status !== 0) {
          throw new Error(
            'failed to repair shared hooksPath; run: git config core.hooksPath .husky',
          );
        }
      }
    } else if (decision.action === 'warn-shared') {
      log(`[worktree] WARNING: ${decision.reason}`);
      log('[worktree]   pushes here run that hooks dir, not this worktree\'s .husky/pre-push.');
      log('[worktree]   To switch to per-worktree hooks: git config core.hooksPath .husky');
    }
    break;
  }

  // The top-level action is the FINAL state; `decisions` is the audit trail,
  // which is the only place a two-layer repair is visible.
  const last = decisions[decisions.length - 1];
  return { ...last, decisions };
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
