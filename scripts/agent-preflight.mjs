#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createPrSnapshot,
  parseGitHubRemote,
  resolveGhBinary,
} from './agent-pr-snapshot.mjs';

const SCHEMA = 'worldmonitor-agent-preflight/v1';
const DEFAULT_NPM_CACHE = '/tmp/worldmonitor-npm-cache';
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 180_000;
const DEFAULT_SNAPSHOT_CACHE = join(
  tmpdir(),
  `worldmonitor-agent-cache-${process.getuid?.() ?? 'user'}`,
);

export function parseArgs(argv = []) {
  const options = {
    allowDetached: false,
    allowDirty: false,
    allowStaleMain: false,
    bootstrapTimeoutMs: Number.parseInt(
      process.env.WM_AGENT_BOOTSTRAP_TIMEOUT_MS || `${DEFAULT_BOOTSTRAP_TIMEOUT_MS}`,
      10,
    ),
    cacheDir: process.env.WM_AGENT_CACHE_DIR || DEFAULT_SNAPSHOT_CACHE,
    help: false,
    issue: '',
    npmCacheDir: process.env.WM_AGENT_NPM_CACHE || DEFAULT_NPM_CACHE,
    pr: '',
    requireEnv: [],
    rootDir: process.cwd(),
    skipBootstrap: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--allow-detached') options.allowDetached = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--allow-stale-main') options.allowStaleMain = true;
    else if (arg === '--skip-bootstrap') options.skipBootstrap = true;
    else if (arg === '--bootstrap-timeout-ms') options.bootstrapTimeoutMs = Number.parseInt(next(), 10);
    else if (arg.startsWith('--bootstrap-timeout-ms=')) {
      options.bootstrapTimeoutMs = Number.parseInt(arg.slice('--bootstrap-timeout-ms='.length), 10);
    }
    else if (arg === '--issue') options.issue = next();
    else if (arg.startsWith('--issue=')) options.issue = arg.slice('--issue='.length);
    else if (arg === '--pr') options.pr = next();
    else if (arg.startsWith('--pr=')) options.pr = arg.slice('--pr='.length);
    else if (arg === '--require-env') options.requireEnv.push(next());
    else if (arg.startsWith('--require-env=')) options.requireEnv.push(arg.slice('--require-env='.length));
    else if (arg === '--cache') options.cacheDir = next();
    else if (arg.startsWith('--cache=')) options.cacheDir = arg.slice('--cache='.length);
    else if (arg === '--npm-cache') options.npmCacheDir = next();
    else if (arg.startsWith('--npm-cache=')) options.npmCacheDir = arg.slice('--npm-cache='.length);
    else if (arg === '--root') options.rootDir = next();
    else if (arg.startsWith('--root=')) options.rootDir = arg.slice('--root='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.issue && !/^\d+$/.test(options.issue)) {
    throw new Error('--issue must be a GitHub issue number');
  }
  if (!Number.isInteger(options.bootstrapTimeoutMs) || options.bootstrapTimeoutMs <= 0) {
    throw new Error('--bootstrap-timeout-ms must be a positive integer');
  }
  for (const key of options.requireEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }

  return options;
}

export function printHelp() {
  console.log(`Usage: npm run --silent agent:preflight -- [options]

Run fail-fast local and live checks before expensive verification.
The command emits one JSON document, bootstraps dependencies at most once,
and prepares ignored inventory facts in trusted worktrees.

Options:
  --issue <number>      Check open PRs and worktrees for duplicate issue work.
  --pr <number-or-url>  Check alignment with this pull request.
  --require-env <name>  Require an environment variable without printing its value.
                        Repeat for multiple variables.
  --allow-dirty         Mark the current dirty worktree as intentional.
  --allow-detached      Mark detached HEAD as intentional (for exact-head review).
  --allow-stale-main    Allow HEAD not to contain the current origin/main.
  --skip-bootstrap      Fail on incomplete dependencies and do not run target scripts.
  --bootstrap-timeout-ms <ms>
                        Stop a single bootstrap after this duration. Default: 600000.
  --cache <dir>         Override the PR snapshot cache directory.
  --npm-cache <dir>     Override the npm cache directory.
  --root <dir>          Repository worktree. Default: current directory.
  -h, --help            Show this help text.`);
}

function runCommand(runner, file, args, options = {}) {
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...options.env,
  };
  return runner(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
    ...options,
    env,
  });
}

function output(result) {
  return String(result.stdout || '').trim();
}

function redactSecrets(value) {
  return value.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
}

function git(runner, rootDir, args, options = {}) {
  const result = runCommand(runner, 'git', args, { cwd: rootDir, ...options });
  const timeoutMs = options.timeout || COMMAND_TIMEOUT_MS;
  return {
    ok: result.status === 0,
    stderr: result.error?.code === 'ETIMEDOUT'
      ? `git ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs}ms`
      : redactSecrets(String(result.stderr || result.error?.code || '').trim()),
    value: output(result),
  };
}

export function supportedNode(rootDir = process.cwd(), version = process.versions.node) {
  const expectedRaw = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8').trim();
  const expectedMajor = Number.parseInt(expectedRaw.replace(/^v/, '').split('.')[0], 10);
  const actualMajor = Number.parseInt(version.split('.')[0], 10);
  return {
    actual: version,
    expected: expectedRaw,
    ok: Number.isInteger(expectedMajor) && actualMajor === expectedMajor,
  };
}

export function probeWritableDirectory(path) {
  const resolved = resolve(path);
  try {
    mkdirSync(resolved, { mode: 0o700, recursive: true });
    const probe = mkdtempSync(join(resolved, 'wm-agent-probe-'));
    const file = join(probe, 'write-test');
    writeFileSync(file, 'ok\n', { mode: 0o600 });
    accessSync(file, constants.R_OK | constants.W_OK);
    rmSync(probe, { force: true, recursive: true });
    return { ok: true, path: resolved };
  } catch (error) {
    return { error: error.code || error.message, ok: false, path: resolved };
  }
}

function binEntries(packageJson) {
  if (!packageJson.bin) return [];
  if (typeof packageJson.bin === 'string') {
    return [[basename(packageJson.name || ''), packageJson.bin]];
  }
  return Object.entries(packageJson.bin);
}

export function probeDependencies(rootDir = process.cwd(), runner = spawnSync) {
  const dependencyRoots = [
    { label: 'root', path: resolve(rootDir) },
    ...(existsSync(resolve(rootDir, 'blog-site', 'package.json'))
      ? [{ label: 'blog-site', path: resolve(rootDir, 'blog-site') }]
      : []),
  ];
  const missingPackages = [];
  const brokenExecutables = [];
  const trees = [];
  let directPackageCount = 0;

  for (const dependencyRoot of dependencyRoots) {
    const packageJson = JSON.parse(readFileSync(resolve(dependencyRoot.path, 'package.json'), 'utf8'));
    const direct = Object.keys({
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    }).sort();
    directPackageCount += direct.length;
    const prefix = dependencyRoot.label === 'root' ? '' : `${dependencyRoot.label}:`;
    const treeMissing = [];
    const treeBroken = [];

    for (const packageName of direct) {
      const installedManifest = resolve(
        dependencyRoot.path,
        'node_modules',
        packageName,
        'package.json',
      );
      if (!existsSync(installedManifest)) {
        treeMissing.push(`${prefix}${packageName}`);
        continue;
      }

      let installed;
      try {
        installed = JSON.parse(readFileSync(installedManifest, 'utf8'));
      } catch {
        treeMissing.push(`${prefix}${packageName}`);
        continue;
      }

      for (const [binName] of binEntries(installed)) {
        const link = resolve(dependencyRoot.path, 'node_modules', '.bin', binName);
        try {
          accessSync(link, constants.X_OK);
        } catch {
          treeBroken.push(`${prefix}${binName}`);
        }
      }
    }

    const installMarker = existsSync(
      resolve(dependencyRoot.path, 'node_modules', '.package-lock.json'),
    );
    const npmTreeOk = installMarker && treeMissing.length === 0 && treeBroken.length === 0
      ? runCommand(runner, 'npm', ['ls', '--depth=0', '--json'], {
          cwd: dependencyRoot.path,
        }).status === 0
      : false;
    missingPackages.push(...treeMissing);
    brokenExecutables.push(...treeBroken);
    trees.push({
      directPackageCount: direct.length,
      installMarker,
      label: dependencyRoot.label,
      npmTreeOk,
      ok: installMarker && treeMissing.length === 0 && treeBroken.length === 0 && npmTreeOk,
    });
  }

  return {
    brokenExecutables,
    directPackageCount,
    installMarker: trees.every(tree => tree.installMarker),
    missingPackages,
    npmTreeOk: trees.every(tree => tree.npmTreeOk),
    ok: trees.every(tree => tree.ok),
    trees,
  };
}

function dependencyReport(probe) {
  const limit = 20;
  return {
    ...probe,
    missingPackageCount: probe.missingPackages.length,
    missingPackages: probe.missingPackages.slice(0, limit),
    missingPackagesTruncated: probe.missingPackages.length > limit,
  };
}

function parseStatusPaths(raw) {
  if (!raw) return [];
  const fields = raw.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(status) && fields[index + 1]) {
      paths.push(fields[index + 1]);
      index += 1;
    }
  }
  return paths;
}

function worktreeState(rootDir, runner, options) {
  const statusResult = runCommand(
    runner,
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: rootDir },
  );
  if (statusResult.status !== 0) {
    return { error: String(statusResult.stderr || '').trim() || 'git status failed', ok: false };
  }
  const branch = git(runner, rootDir, ['branch', '--show-current']).value || null;
  const paths = parseStatusPaths(String(statusResult.stdout || ''));
  const dirty = paths.length > 0;
  const detached = branch === null;
  return {
    branch,
    detached,
    dirty,
    dirtyPathCount: paths.length,
    dirtyPaths: paths,
    intentionalDetached: detached && options.allowDetached,
    intentionalDirty: dirty && options.allowDirty,
    ok: (!dirty || options.allowDirty) && (!detached || options.allowDetached),
  };
}

export function currentOriginMain(rootDir, runner, allowStaleMain) {
  const fetch = git(
    runner,
    rootDir,
    ['fetch', '--no-tags', 'origin', 'main'],
    { timeout: FETCH_TIMEOUT_MS },
  );
  if (!fetch.ok) {
    return { error: fetch.stderr || 'git fetch origin main failed', fetched: false, ok: false };
  }
  const head = git(runner, rootDir, ['rev-parse', 'HEAD']);
  const originMain = git(runner, rootDir, ['rev-parse', 'origin/main']);
  const counts = git(runner, rootDir, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
  const [aheadRaw, behindRaw] = counts.value.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw, 10);
  const behind = Number.parseInt(behindRaw, 10);
  const resolved = head.ok
    && originMain.ok
    && counts.ok
    && /^[0-9a-f]{40}$/.test(head.value)
    && /^[0-9a-f]{40}$/.test(originMain.value)
    && Number.isInteger(ahead)
    && Number.isInteger(behind);
  if (!resolved) {
    return {
      error: head.stderr || originMain.stderr || counts.stderr || 'cannot resolve origin/main state',
      fetched: true,
      ok: false,
    };
  }
  const contains = runCommand(
    runner,
    'git',
    ['merge-base', '--is-ancestor', originMain.value, head.value],
    { cwd: rootDir },
  );
  if (contains.status !== 0 && contains.status !== 1) {
    return {
      error: String(contains.stderr || '').trim() || 'cannot compare HEAD with origin/main',
      fetched: true,
      ok: false,
    };
  }
  const headContainsOriginMain = contains.status === 0;
  return {
    ahead,
    behind,
    fetched: true,
    headContainsOriginMain,
    headOid: head.value,
    intentionalStaleMain: !headContainsOriginMain && allowStaleMain,
    oid: originMain.value,
    ok: headContainsOriginMain || allowStaleMain,
  };
}

function envKeysFromFile(path) {
  if (!existsSync(path)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (value && value !== "''" && value !== '""') keys.add(match[1]);
  }
  return keys;
}

function credentialState(rootDir, runner, requiredEnv) {
  const ghBin = resolveGhBinary();
  const authBin = process.env.WM_GH_AUTH_BIN || 'gh';
  const auth = runCommand(runner, authBin, ['auth', 'status', '--hostname', 'github.com'], {
    cwd: rootDir,
  });
  const commonDir = git(
    runner,
    rootDir,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  );
  const envSource = commonDir.ok && basename(commonDir.value) === '.git'
    ? dirname(commonDir.value)
    : '';
  const envFiles = ['.env.local', '.env'].map(name => ({
    availableFromTrustedSource: Boolean(envSource && existsSync(resolve(envSource, name))),
    name,
    presentInWorktree: existsSync(resolve(rootDir, name)),
  }));
  const availableKeys = new Set();
  for (const file of envFiles) {
    if (file.presentInWorktree) {
      for (const key of envKeysFromFile(resolve(rootDir, file.name))) availableKeys.add(key);
    }
    if (file.availableFromTrustedSource) {
      for (const key of envKeysFromFile(resolve(envSource, file.name))) availableKeys.add(key);
    }
  }
  const required = Object.fromEntries(requiredEnv.map(key => [
    key,
    Boolean(process.env[key]) || availableKeys.has(key),
  ]));
  return {
    envFiles,
    github: { authBinary: authBin, available: auth.status === 0, binary: ghBin },
    ok: auth.status === 0 && Object.values(required).every(Boolean),
    requiredEnv: required,
  };
}

function parseWorktrees(raw) {
  const records = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      records.push(current);
    } else if (!current || !line) continue;
    else if (line.startsWith('HEAD ')) current.headOid = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'detached') current.detached = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  return records;
}

export function findWorktreeCollisions(worktrees, {
  currentRoot,
  issue = '',
  watchedBranches = [],
} = {}) {
  const issuePattern = issue ? new RegExp(`(?:^|[^0-9])${issue}(?:[^0-9]|$)`) : null;
  const watched = new Set(watchedBranches.filter(Boolean));
  return worktrees.filter(worktree => {
    if (resolve(worktree.path) === resolve(currentRoot) || worktree.prunable) return false;
    return watched.has(worktree.branch)
      || Boolean(issuePattern?.test(worktree.branch || ''))
      || Boolean(issuePattern?.test(worktree.path));
  });
}

function duplicatePrState({ currentPr, ghBin, issue, repo, rootDir, runner }) {
  if (!issue) return { checked: false, duplicates: [], ok: true, reason: 'no issue number supplied' };
  const result = runCommand(
    runner,
    ghBin,
    [
      'pr', 'list', '--repo', repo.nameWithOwner, '--state', 'open', '--limit', '1000',
      '--json', 'number,title,body,url,headRefName,headRefOid,author',
    ],
    { cwd: rootDir },
  );
  if (result.status !== 0) {
    return { checked: true, duplicates: [], error: 'open PR query failed', ok: false };
  }
  let prs;
  try {
    prs = JSON.parse(output(result));
  } catch {
    return { checked: true, duplicates: [], error: 'open PR query returned invalid JSON', ok: false };
  }
  if (prs.length >= 1000) {
    return {
      checked: true,
      duplicates: [],
      error: 'open PR query reached its 1000-result safety limit',
      ok: false,
    };
  }
  const issuePattern = new RegExp(`(?:#|issues/|issue[-_/ ]?)${issue}(?:[^0-9]|$)`, 'i');
  const branchPattern = new RegExp(`(?:^|[-_/])${issue}(?:[-_/]|$)`);
  const matches = prs.filter(pr => (
    issuePattern.test(`${pr.title || ''}\n${pr.body || ''}`)
    || branchPattern.test(pr.headRefName || '')
  ));
  const summarize = pr => ({
    author: pr.author?.login || null,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    number: pr.number,
    url: pr.url,
  });
  const duplicates = matches.filter(pr => pr.number !== currentPr).map(summarize);
  return { checked: true, duplicates, matchCount: matches.length, ok: duplicates.length === 0 };
}

export function prAlignment(snapshot, rootDir, runner, { allowDetached = false } = {}) {
  if (!snapshot) return { applicable: false, ok: true };
  void rootDir;
  void runner;
  const localBaseOid = snapshot.base.state?.fetchedOid || null;
  const headRelation = snapshot.remoteState.relation;
  const headAligned = headRelation === 'exact' || headRelation === 'ahead';
  const localBranch = snapshot.remoteState.localBranch;
  const branchAligned = localBranch === snapshot.head.ref
    || (localBranch === null && allowDetached && headRelation === 'exact');
  const baseAligned = snapshot.base.oid === localBaseOid
    && snapshot.base.state?.localContainsBase === true;
  const remoteAligned = snapshot.remoteState.graphQlMatchesRemote === true;
  const stateOpen = snapshot.pullRequest.state === 'OPEN';
  return {
    applicable: true,
    baseAligned,
    branchAligned,
    headAligned,
    headRelation,
    localBaseOid,
    localBranch,
    ok: baseAligned && branchAligned && headAligned && remoteAligned && stateOpen,
    remoteAligned,
    stateOpen,
  };
}

function repoIdentity(rootDir, runner) {
  const remote = git(runner, rootDir, ['remote', 'get-url', 'origin']);
  if (!remote.ok) throw new Error(remote.stderr || 'origin remote is unavailable');
  return parseGitHubRemote(remote.value);
}

export function bootstrapOnce(rootDir, npmCacheDir, runner, timeoutMs) {
  const startedAt = Date.now();
  const targets = [
    { label: 'root', path: rootDir },
    ...(existsSync(resolve(rootDir, 'blog-site', 'package.json'))
      ? [{ label: 'blog-site', path: resolve(rootDir, 'blog-site') }]
      : []),
  ];
  const completedTargets = [];
  for (const target of targets) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return {
        attempted: true,
        completedTargets,
        error: `worktree bootstrap timed out after ${timeoutMs}ms`,
        lifecycleScripts: false,
        ok: false,
        timeoutMs,
      };
    }
    const result = runner('npm', ['ci', '--cache', npmCacheDir, '--ignore-scripts'], {
      cwd: target.path,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        npm_config_cache: npmCacheDir,
        npm_config_ignore_scripts: 'true',
      },
      // Preserve stdout for the preflight's single JSON result while showing
      // bootstrap progress and avoiding a large captured-output buffer.
      stdio: ['ignore', 2, 2],
      timeout: remainingMs,
    });
    if (result.status !== 0) {
      return {
        attempted: true,
        completedTargets,
        error: result.error?.code === 'ETIMEDOUT'
          ? `worktree bootstrap timed out after ${timeoutMs}ms`
          : `${target.label} dependency bootstrap failed`,
        lifecycleScripts: false,
        ok: false,
        timeoutMs,
      };
    }
    completedTargets.push(target.label);
  }
  return {
    attempted: true,
    completedTargets,
    lifecycleScripts: false,
    error: null,
    ok: true,
    timeoutMs,
  };
}

export function inventoryGenerationSkipReason(rootDir, {
  currentDir = process.cwd(),
  skipBootstrap = false,
} = {}) {
  if (skipBootstrap) return 'inventory generation disabled by --skip-bootstrap';
  if (!existsSync(resolve(rootDir, 'scripts', 'generate-inventory-facts.mjs'))) {
    return 'generator not present in this checkout';
  }
  if (resolve(rootDir) !== resolve(currentDir)) {
    return 'inventory generation disabled for an alternate --root target';
  }
  return null;
}

export function prepareInventoryFacts(
  rootDir,
  runner = spawnSync,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const result = runner(process.execPath, ['scripts/generate-inventory-facts.mjs'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    },
    // Keep stdout available for the preflight's single JSON document while
    // still showing generation progress to the operator.
    stdio: ['ignore', 2, 2],
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    return {
      attempted: true,
      error: result.error?.code === 'ETIMEDOUT'
        ? `inventory fact generation timed out after ${timeoutMs}ms`
        : 'inventory fact generation failed',
      ok: false,
      timeoutMs,
    };
  }
  return { attempted: true, error: null, ok: true, timeoutMs };
}

export function runAgentPreflight(options = {}, runner = spawnSync) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const skipBootstrap = Boolean(options.skipBootstrap);
  const node = supportedNode(rootDir);
  const temp = probeWritableDirectory(tmpdir());
  const npmCache = probeWritableDirectory(options.npmCacheDir || DEFAULT_NPM_CACHE);
  const snapshotCache = probeWritableDirectory(
    options.cacheDir || DEFAULT_SNAPSHOT_CACHE,
  );
  let worktree = worktreeState(rootDir, runner, options);
  const credentials = credentialState(rootDir, runner, options.requireEnv || []);
  const repo = repoIdentity(rootDir, runner);
  let dependencies = probeDependencies(rootDir, runner);
  const localGatesOk = [
    node.ok,
    temp.ok,
    npmCache.ok,
    snapshotCache.ok,
    worktree.ok,
    credentials.ok,
  ].every(Boolean);
  let bootstrap = {
    attempted: false,
    ok: dependencies.ok,
    reason: dependencies.ok ? 'dependencies already complete' : 'blocked before bootstrap',
  };

  if (!dependencies.ok && localGatesOk && !skipBootstrap) {
    bootstrap = bootstrapOnce(
      rootDir,
      options.npmCacheDir || DEFAULT_NPM_CACHE,
      runner,
      options.bootstrapTimeoutMs || DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    );
    if (bootstrap.ok) {
      dependencies = probeDependencies(rootDir, runner);
      worktree = worktreeState(rootDir, runner, options);
    }
  } else if (!dependencies.ok && skipBootstrap) {
    bootstrap.reason = 'bootstrap disabled by --skip-bootstrap';
  }

  const inventorySkipReason = inventoryGenerationSkipReason(rootDir, { skipBootstrap });
  let inventoryFacts = inventorySkipReason
    ? { attempted: false, ok: true, reason: inventorySkipReason }
    : { attempted: false, ok: false, reason: 'blocked before inventory generation' };
  const inventoryPrerequisitesOk = [
    node.ok,
    temp.ok,
    npmCache.ok,
    snapshotCache.ok,
    worktree.ok,
    credentials.ok,
    dependencies.ok,
    bootstrap.ok,
  ].every(Boolean);
  if (!inventorySkipReason && inventoryPrerequisitesOk) {
    inventoryFacts = prepareInventoryFacts(rootDir, runner);
    if (inventoryFacts.ok) worktree = worktreeState(rootDir, runner, options);
  }

  // Capture mutable Git and GitHub state only after a possible bootstrap. A
  // long install must not make the task-start snapshot stale before we use it.
  const originMain = currentOriginMain(rootDir, runner, options.allowStaleMain);

  let prSnapshot = null;
  let prSnapshotError = null;
  if (credentials.github.available) {
    try {
      prSnapshot = createPrSnapshot({
        cacheDir: options.cacheDir,
        ghBin: credentials.github.binary,
        phase: 'task-start',
        pr: options.pr,
        rootDir,
        runner,
      });
    } catch (error) {
      prSnapshotError = error.message;
    }
  }

  const alignment = prSnapshotError
    ? { applicable: Boolean(options.pr), error: prSnapshotError, ok: false }
    : prAlignment(prSnapshot, rootDir, runner, { allowDetached: options.allowDetached });
  const duplicates = duplicatePrState({
    currentPr: prSnapshot?.pullRequest.number || null,
    ghBin: credentials.github.binary,
    issue: options.issue,
    repo,
    rootDir,
    runner,
  });
  const listedWorktrees = git(runner, rootDir, ['worktree', 'list', '--porcelain']);
  const worktrees = listedWorktrees.ok ? parseWorktrees(listedWorktrees.value) : [];
  const watchedBranches = [
    prSnapshot?.head.ref,
    ...duplicates.duplicates.map(pr => pr.headRefName),
  ];
  const collisions = findWorktreeCollisions(worktrees, {
    currentRoot: rootDir,
    issue: options.issue,
    watchedBranches,
  });
  const worktreeInventory = {
    activeCount: worktrees.filter(item => !item.prunable).length,
    collisions,
    ok: listedWorktrees.ok && collisions.length === 0,
  };

  const allGatesOk = [
    node.ok,
    temp.ok,
    npmCache.ok,
    snapshotCache.ok,
    worktree.ok,
    originMain.ok,
    credentials.ok,
    alignment.ok,
    duplicates.ok,
    worktreeInventory.ok,
  ].every(Boolean);

  const checks = {
    bootstrap,
    credentials,
    dependencies: dependencyReport(dependencies),
    duplicatePullRequests: duplicates,
    inventoryFacts,
    node,
    originMain,
    prAlignment: alignment,
    prSnapshot: prSnapshot
      ? {
          baseOid: prSnapshot.base.oid,
          cachePath: prSnapshot.cache.path,
          capturedAt: prSnapshot.capturedAt,
          headOid: prSnapshot.head.oid,
          number: prSnapshot.pullRequest.number,
        }
      : null,
    storage: { npmCache, snapshotCache, temp },
    worktree,
    worktrees: worktreeInventory,
  };
  const ok = allGatesOk && dependencies.ok && bootstrap.ok && inventoryFacts.ok;
  return {
    checks,
    completedAt: new Date().toISOString(),
    expensiveTestsAllowed: ok,
    ok,
    repository: repo.nameWithOwner,
    schema: SCHEMA,
    status: ok ? 'ready' : 'blocked',
  };
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else {
      const result = runAgentPreflight(options);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, schema: SCHEMA, status: 'error' }, null, 2));
    process.exitCode = 1;
  }
}
