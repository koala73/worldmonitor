#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'worldmonitor-agent-pr-snapshot/v1';
const REFRESH_PHASES = new Set(['task-start', 'pre-push', 'final']);
const COMMAND_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 180_000;
const STALE_LOCK_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_DIR = join(
  tmpdir(),
  `worldmonitor-agent-cache-${process.getuid?.() ?? 'user'}`,
);

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      state
      isDraft
      mergeable
      mergeStateStatus
      author { login }
      headRefName
      headRefOid
      baseRefName
      baseRefOid
      isCrossRepository
      headRepository { nameWithOwner url sshUrl owner { login } }
      baseRepository { nameWithOwner url sshUrl owner { login } }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl startedAt completedAt
                  }
                  ... on StatusContext {
                    context state targetUrl createdAt
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id path line originalLine startLine isResolved isOutdated diffSide
          comments(last: 1) {
            nodes { author { login } body url createdAt }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const CHECKS_PAGE_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $cursor) {
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion detailsUrl startedAt completedAt
              }
              ... on StatusContext {
                context state targetUrl createdAt
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

const THREADS_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id path line originalLine startLine isResolved isOutdated diffSide
          comments(last: 1) {
            nodes { author { login } body url createdAt }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export function parseArgs(argv = []) {
  const options = {
    cacheDir: process.env.WM_AGENT_CACHE_DIR || DEFAULT_CACHE_DIR,
    help: false,
    includeUntrustedReviewContent: false,
    phase: '',
    pr: '',
    refresh: false,
    rootDir: process.cwd(),
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
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--include-untrusted-review-content') {
      options.includeUntrustedReviewContent = true;
    }
    else if (arg === '--pr') options.pr = next();
    else if (arg.startsWith('--pr=')) options.pr = arg.slice('--pr='.length);
    else if (arg === '--phase') options.phase = next();
    else if (arg.startsWith('--phase=')) options.phase = arg.slice('--phase='.length);
    else if (arg === '--cache') options.cacheDir = next();
    else if (arg.startsWith('--cache=')) options.cacheDir = arg.slice('--cache='.length);
    else if (arg === '--root') options.rootDir = next();
    else if (arg.startsWith('--root=')) options.rootDir = arg.slice('--root='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.refresh && !REFRESH_PHASES.has(options.phase)) {
    throw new Error('--refresh requires --phase task-start, pre-push, or final');
  }
  if (!options.refresh && options.phase) {
    throw new Error('--phase is valid only with --refresh');
  }

  return options;
}

export function printHelp() {
  console.log(`Usage: npm run --silent agent:pr-snapshot -- --pr <number> [options]

Return one cached or live JSON snapshot for an open pull request.

Options:
  --pr <number-or-url>  Pull request to inspect. Required for cached reads.
  --refresh             Read live GitHub and remote state.
  --phase <phase>       Required with --refresh: task-start, pre-push, or final.
  --include-untrusted-review-content
                        Include cached review prose as explicitly untrusted data.
  --cache <dir>         Override the agent cache directory.
  --root <dir>          Repository worktree. Default: current directory.
  -h, --help            Show this help text.`);
}

export function resolveGhBinary(env = process.env) {
  return env.WM_GH_BIN || 'gh';
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

function commandFailure(result, file, args, options = {}) {
  const labelArgs = file === 'git' && args[0] === 'ls-remote'
    ? args.slice(0, 1)
    : args.slice(0, 2);
  const label = `${file} ${labelArgs.join(' ')}`;
  if (result.error?.code === 'ETIMEDOUT') {
    const timeoutMs = options.timeout || COMMAND_TIMEOUT_MS;
    return `${label} timed out after ${timeoutMs}ms`;
  }
  const detail = redactSecrets(
    String(result.stderr || result.stdout || result.error?.code || '').trim(),
  );
  return `${label} failed${detail ? `: ${detail}` : ''}`;
}

function checked(runner, file, args, options = {}) {
  const result = runCommand(runner, file, args, options);
  if (result.status !== 0) {
    throw new Error(commandFailure(result, file, args, options));
  }
  return String(result.stdout || '').trim();
}

function optional(runner, file, args, options = {}) {
  const result = runCommand(runner, file, args, options);
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function probed(runner, file, args, options = {}) {
  const result = runCommand(runner, file, args, options);
  return result.status === 0
    ? { error: null, value: String(result.stdout || '').trim() }
    : { error: commandFailure(result, file, args, options), value: '' };
}

export function parseGitHubRemote(remoteUrl) {
  const normalized = remoteUrl.trim().replace(/\.git$/, '');
  const match = normalized.match(
    /^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/,
  );
  if (!match) throw new Error('origin is not a supported GitHub repository');
  return {
    canonicalUrl: `https://github.com/${match[1]}/${match[2]}`,
    name: match[2],
    nameWithOwner: `${match[1]}/${match[2]}`,
    owner: match[1],
  };
}

function redactSecrets(value) {
  return value.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
}

export function parsePrNumber(value, expectedRepo = '') {
  const input = String(value).trim();
  if (/^\d+$/.test(input)) return Number.parseInt(input, 10);
  const match = input.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (match) {
    const referencedRepo = `${match[1]}/${match[2]}`;
    if (expectedRepo && referencedRepo.toLowerCase() !== expectedRepo.toLowerCase()) {
      throw new Error(`Pull request URL is for ${referencedRepo}, not ${expectedRepo}`);
    }
    return Number.parseInt(match[3], 10);
  }
  throw new Error(`Invalid pull request number or URL: ${value}`);
}

function repoIdentity(rootDir, runner) {
  const remoteUrl = checked(runner, 'git', ['remote', 'get-url', 'origin'], { cwd: rootDir });
  return parseGitHubRemote(remoteUrl);
}

function ghJson(runner, ghBin, args, options = {}) {
  const raw = checked(runner, ghBin, args, options);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${ghBin} returned invalid JSON`);
  }
}

function resolvePrFromHead({ ghBin, repo, rootDir, runner }) {
  const headOid = checked(runner, 'git', ['rev-parse', 'HEAD'], { cwd: rootDir });
  const result = runCommand(
    runner,
    ghBin,
    ['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo.nameWithOwner}/commits/${headOid}/pulls`],
    { cwd: rootDir },
  );
  if (result.status !== 0) {
    const detail = redactSecrets(String(result.stderr || result.stdout || '').trim());
    if (/No commit found for SHA|HTTP 422/i.test(detail)) return null;
    throw new Error(`${ghBin} commit PR lookup failed${detail ? `: ${detail}` : ''}`);
  }
  let pulls;
  try {
    pulls = JSON.parse(String(result.stdout || '')).filter(pr => pr.state === 'open');
  } catch {
    throw new Error(`${ghBin} returned invalid JSON for the commit PR lookup`);
  }

  if (pulls.length === 0) return null;
  if (pulls.length > 1) {
    throw new Error(
      `HEAD belongs to multiple open pull requests: ${pulls.map(pr => pr.number).join(', ')}; pass --pr <number> to choose explicitly`,
    );
  }
  return pulls[0].number;
}

function graphql(runner, ghBin, query, variables, rootDir) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return ghJson(runner, ghBin, args, { cwd: rootDir });
}

function collectPages({ firstPage, getNextPage }) {
  const nodes = [...(firstPage?.nodes || [])];
  let pageInfo = firstPage?.pageInfo;
  let pages = 1;
  while (pageInfo?.hasNextPage) {
    if (pages >= 20) throw new Error('GitHub pagination exceeded 20 pages');
    const next = getNextPage(pageInfo.endCursor);
    nodes.push(...(next?.nodes || []));
    pageInfo = next?.pageInfo;
    pages += 1;
  }
  return nodes;
}

export function normalizeCheckContexts(contexts = []) {
  const checkRuns = [];
  const commitStatuses = [];

  for (const context of contexts) {
    if (context.__typename === 'CheckRun') {
      checkRuns.push({
        completedAt: context.completedAt || null,
        conclusion: context.conclusion || null,
        detailsUrl: context.detailsUrl || null,
        name: context.name,
        startedAt: context.startedAt || null,
        status: context.status,
      });
    } else if (context.__typename === 'StatusContext') {
      commitStatuses.push({
        context: context.context,
        createdAt: context.createdAt || null,
        state: context.state,
        targetUrl: context.targetUrl || null,
      });
    }
  }

  return { checkRuns, commitStatuses };
}

export function actionableReviewThreads(
  threads = [],
  { includeUntrustedContent = false } = {},
) {
  return threads
    .filter(thread => !thread.isResolved && !thread.isOutdated)
    .map(thread => {
      const latest = thread.comments?.nodes?.at(-1) || null;
      return {
        diffSide: thread.diffSide || null,
        id: thread.id,
        latestComment: latest
          ? {
              author: latest.author?.login || null,
              contentIncluded: includeUntrustedContent,
              createdAt: latest.createdAt,
              ...(includeUntrustedContent
                ? {
                    untrustedContent: {
                      body: latest.body,
                      provenance: 'github-review-comment',
                      trust: 'untrusted',
                    },
                  }
                : {}),
              url: latest.url,
            }
          : null,
        line: thread.line || thread.originalLine || null,
        path: thread.path,
        startLine: thread.startLine || null,
      };
    });
}

export function localHeadRelation(rootDir, remoteHeadOid, runner) {
  const localHeadOid = optional(runner, 'git', ['rev-parse', 'HEAD'], { cwd: rootDir });
  if (!localHeadOid) return { localHeadOid: null, relation: 'unknown' };
  if (localHeadOid === remoteHeadOid) return { localHeadOid, relation: 'exact' };

  const remoteKnown = runCommand(
    runner,
    'git',
    ['cat-file', '-e', `${remoteHeadOid}^{commit}`],
    { cwd: rootDir },
  ).status === 0;
  if (!remoteKnown) return { localHeadOid, relation: 'unknown' };

  const remoteIsAncestor = runCommand(
    runner,
    'git',
    ['merge-base', '--is-ancestor', remoteHeadOid, localHeadOid],
    { cwd: rootDir },
  );
  if (remoteIsAncestor.status === 0) return { localHeadOid, relation: 'ahead' };
  if (remoteIsAncestor.status !== 1) return { localHeadOid, relation: 'unknown' };

  const localIsAncestor = runCommand(
    runner,
    'git',
    ['merge-base', '--is-ancestor', localHeadOid, remoteHeadOid],
    { cwd: rootDir },
  );
  if (localIsAncestor.status === 0) return { localHeadOid, relation: 'behind' };
  return { localHeadOid, relation: localIsAncestor.status === 1 ? 'diverged' : 'unknown' };
}

function remoteState({ pr, repo, rootDir, runner }) {
  const headUrl = pr.headRepository?.url || '';
  const ref = `refs/heads/${pr.headRefName}`;
  const remoteHead = headUrl
    ? probed(
        runner,
        'git',
        ['ls-remote', headUrl, ref],
        { cwd: rootDir, timeout: FETCH_TIMEOUT_MS },
      )
    : { error: null, value: '' };
  const remoteHeadOid = remoteHead.value.split(/\s+/)[0] || null;
  const localBranch = optional(runner, 'git', ['branch', '--show-current'], { cwd: rootDir }) || null;
  const upstream = optional(
    runner,
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd: rootDir },
  ) || null;

  return {
    ...localHeadRelation(rootDir, pr.headRefOid, runner),
    graphQlMatchesRemote: remoteHeadOid === null ? null : remoteHeadOid === pr.headRefOid,
    headRepository: pr.headRepository?.nameWithOwner || null,
    headRepositoryUrl: headUrl || null,
    localBranch,
    originUrl: repo.canonicalUrl,
    remoteHeadError: remoteHead.error,
    remoteHeadOid,
    upstream,
  };
}

function baseState({ pr, rootDir, runner }) {
  checked(
    runner,
    'git',
    ['fetch', '--no-tags', 'origin', pr.baseRefName],
    { cwd: rootDir, timeout: FETCH_TIMEOUT_MS },
  );
  const fetchedOid = checked(
    runner,
    'git',
    ['rev-parse', `origin/${pr.baseRefName}`],
    { cwd: rootDir },
  );
  const local = localHeadRelation(rootDir, fetchedOid, runner);
  const graphQlMatchesFetched = fetchedOid === pr.baseRefOid;
  return {
    fetchedOid,
    graphQlMatchesFetched,
    localContainsBase: local.relation === 'exact' || local.relation === 'ahead',
    localHeadOid: local.localHeadOid,
    localRelation: local.relation,
    ok: local.relation === 'exact' || local.relation === 'ahead',
    pullRequestOid: pr.baseRefOid,
  };
}

function snapshotPaths(cacheDir, repoName, prNumber, headOid = '') {
  const repoKey = repoName.replace(/[^A-Za-z0-9_.-]/g, '_');
  const prDir = resolve(cacheDir, repoKey, `pr-${prNumber}`);
  return {
    headPath: headOid ? join(prDir, 'heads', `${headOid}.json`) : '',
    latestPath: join(prDir, 'latest.json'),
    prDir,
  };
}

function assertPrivateDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe PR snapshot cache directory: ${path}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`PR snapshot cache directory is not owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`PR snapshot cache directory permissions are too broad: ${path}`);
  }
}

function ensurePrivateDirectory(path, cacheDir) {
  const root = resolve(cacheDir);
  mkdirSync(root, { mode: 0o700, recursive: true });
  assertPrivateDirectory(root);
  const suffix = relative(root, resolve(path));
  if (suffix.startsWith('..') || resolve(root, suffix) !== resolve(path)) {
    throw new Error('PR snapshot cache path escapes its root');
  }
  let current = root;
  for (const segment of suffix.split('/').filter(Boolean)) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    assertPrivateDirectory(current);
  }
}

function assertPrivateFile(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Unsafe PR snapshot cache file: ${path}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`PR snapshot cache file is not owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`PR snapshot cache file permissions are too broad: ${path}`);
  }
}

function acquireRefreshLock(cacheDir, repoName, prNumber) {
  const { prDir } = snapshotPaths(cacheDir, repoName, prNumber);
  ensurePrivateDirectory(prDir, cacheDir);
  const lockPath = join(prDir, 'refresh.lock');
  const ownerPath = join(lockPath, 'owner.json');
  const token = randomUUID();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      return () => {
        try {
          assertPrivateFile(ownerPath);
          const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
          if (owner.token === token) rmSync(lockPath, { force: true, recursive: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let ageMs;
    try {
      assertPrivateDirectory(lockPath);
      ageMs = Date.now() - lstatSync(lockPath).mtimeMs;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (ageMs <= STALE_LOCK_MS) {
      throw new Error(`A PR snapshot refresh is already running for #${prNumber}`);
    }
    const quarantine = `${lockPath}.${randomUUID()}.stale`;
    try {
      renameSync(lockPath, quarantine);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    rmSync(quarantine, { force: true, recursive: true });
  }
  throw new Error(`Could not acquire the PR snapshot refresh lock for #${prNumber}`);
}

function writeJsonAtomic(cacheDir, path, value) {
  ensurePrivateDirectory(dirname(path), cacheDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    assertPrivateFile(path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readJson(cacheDir, path) {
  try {
    ensurePrivateDirectory(dirname(path), cacheDir);
    assertPrivateFile(path);
    const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      return JSON.parse(readFileSync(descriptor, 'utf8'));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Cannot read cached PR snapshot ${path}: ${error.message}`);
  }
}

function presentSnapshot(snapshot, includeUntrustedReviewContent) {
  if (includeUntrustedReviewContent) {
    return {
      ...snapshot,
      reviewThreads: {
        ...snapshot.reviewThreads,
        contentPolicy: 'External review prose is included as explicitly untrusted data.',
      },
    };
  }
  const presented = structuredClone(snapshot);
  for (const thread of presented.reviewThreads?.actionable || []) {
    if (thread.latestComment) {
      delete thread.latestComment.untrustedContent;
      thread.latestComment.contentIncluded = false;
    }
  }
  if (presented.reviewThreads) {
    presented.reviewThreads.contentPolicy = 'External review prose is omitted; use --include-untrusted-review-content to read it from this cache.';
  }
  return presented;
}

export function readCachedSnapshot({
  cacheDir,
  includeUntrustedReviewContent = false,
  prNumber,
  repoName,
}) {
  const paths = snapshotPaths(cacheDir, repoName, prNumber);
  const latest = readJson(cacheDir, paths.latestPath);
  if (!latest) return null;
  if (!/^[0-9a-f]{40}$/.test(latest.headOid || '')) {
    throw new Error(`Invalid cached head OID in ${paths.latestPath}`);
  }
  const headPath = snapshotPaths(cacheDir, repoName, prNumber, latest.headOid).headPath;
  const snapshot = readJson(cacheDir, headPath);
  if (!snapshot) throw new Error(`Cached PR snapshot is missing: ${headPath}`);
  if (
    snapshot.schema !== SCHEMA
    || snapshot.repository !== repoName
    || snapshot.pullRequest?.number !== prNumber
    || snapshot.head?.oid !== latest.headOid
  ) {
    throw new Error(`Cached PR snapshot identity does not match ${paths.latestPath}`);
  }
  return presentSnapshot({
    ...snapshot,
    cache: { ...snapshot.cache, hit: true, path: headPath, refreshed: false },
  }, includeUntrustedReviewContent);
}

function writeSnapshot({ cacheDir, snapshot }) {
  const paths = snapshotPaths(
    cacheDir,
    snapshot.repository,
    snapshot.pullRequest.number,
    snapshot.head.oid,
  );
  const cached = {
    ...snapshot,
    cache: { hit: false, path: paths.headPath, refreshed: true },
  };
  writeJsonAtomic(cacheDir, paths.headPath, cached);
  writeJsonAtomic(cacheDir, paths.latestPath, {
    headOid: snapshot.head.oid,
    pr: snapshot.pullRequest.number,
    repository: snapshot.repository,
    schema: SCHEMA,
  });
  return cached;
}

export function createPrSnapshot({
  cacheDir = process.env.WM_AGENT_CACHE_DIR || DEFAULT_CACHE_DIR,
  ghBin = resolveGhBinary(),
  includeUntrustedReviewContent = false,
  phase,
  pr: requestedPr,
  rootDir = process.cwd(),
  runner = spawnSync,
} = {}) {
  const resolvedRoot = resolve(rootDir);
  const repo = repoIdentity(resolvedRoot, runner);
  const prNumber = requestedPr
    ? parsePrNumber(requestedPr, repo.nameWithOwner)
    : resolvePrFromHead({ ghBin, repo, rootDir: resolvedRoot, runner });
  if (!prNumber) return null;
  const releaseRefreshLock = acquireRefreshLock(cacheDir, repo.nameWithOwner, prNumber);

  try {
    const response = graphql(
      runner,
      ghBin,
      PR_QUERY,
      { name: repo.name, number: prNumber, owner: repo.owner },
      resolvedRoot,
    );
    const pr = response.data?.repository?.pullRequest;
    if (!pr) throw new Error(`Pull request #${prNumber} was not found in ${repo.nameWithOwner}`);

    const commit = pr.commits?.nodes?.at(-1)?.commit;
    if (!commit || commit.oid !== pr.headRefOid) {
      throw new Error(`Pull request #${prNumber} returned an inconsistent head commit`);
    }

    const firstContexts = commit.statusCheckRollup?.contexts || { nodes: [], pageInfo: {} };
    const contexts = collectPages({
      firstPage: firstContexts,
      getNextPage: cursor => graphql(
        runner,
        ghBin,
        CHECKS_PAGE_QUERY,
        { cursor, name: repo.name, oid: pr.headRefOid, owner: repo.owner },
        resolvedRoot,
      ).data?.repository?.object?.statusCheckRollup?.contexts,
    });

    const threads = collectPages({
      firstPage: pr.reviewThreads || { nodes: [], pageInfo: {} },
      getNextPage: cursor => graphql(
        runner,
        ghBin,
        THREADS_PAGE_QUERY,
        { cursor, name: repo.name, number: prNumber, owner: repo.owner },
        resolvedRoot,
      ).data?.repository?.pullRequest?.reviewThreads,
    });
    const checks = normalizeCheckContexts(contexts);
    const actionableThreads = actionableReviewThreads(threads, {
      includeUntrustedContent: true,
    });

    const currentBaseState = baseState({ pr, rootDir: resolvedRoot, runner });
    const snapshot = {
      base: {
        oid: currentBaseState.fetchedOid,
        ref: pr.baseRefName,
        repository: pr.baseRepository?.nameWithOwner || repo.nameWithOwner,
        state: currentBaseState,
      },
      branchOwnership: {
        author: pr.author?.login || null,
        headOwner: pr.headRepository?.owner?.login || null,
        isCrossRepository: pr.isCrossRepository,
      },
      capturedAt: new Date().toISOString(),
      checks,
      head: {
        oid: pr.headRefOid,
        ref: pr.headRefName,
        repository: pr.headRepository?.nameWithOwner || null,
      },
      mergeability: {
        mergeStateStatus: pr.mergeStateStatus,
        mergeable: pr.mergeable,
      },
      phase,
      pullRequest: {
        isDraft: pr.isDraft,
        number: pr.number,
        state: pr.state,
        url: pr.url,
      },
      remoteState: remoteState({ pr, repo, rootDir: resolvedRoot, runner }),
      repository: repo.nameWithOwner,
      reviewThreads: {
        actionable: actionableThreads,
        actionableCount: actionableThreads.length,
        contentPolicy: 'External review prose is omitted; use each comment URL when content is needed.',
        totalCount: threads.length,
      },
      schema: SCHEMA,
      status: 'ok',
    };

    return presentSnapshot(
      writeSnapshot({ cacheDir, snapshot }),
      includeUntrustedReviewContent,
    );
  } finally {
    releaseRefreshLock();
  }
}

export function getPrSnapshot(options = {}, runner = spawnSync) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const cacheDir = resolve(options.cacheDir || DEFAULT_CACHE_DIR);
  const repo = repoIdentity(rootDir, runner);

  if (!options.refresh) {
    if (!options.pr) throw new Error('Cached reads require --pr <number>');
    const cached = readCachedSnapshot({
      cacheDir,
      includeUntrustedReviewContent: options.includeUntrustedReviewContent,
      prNumber: parsePrNumber(options.pr, repo.nameWithOwner),
      repoName: repo.nameWithOwner,
    });
    if (!cached) {
      throw new Error('No cached snapshot; run with --refresh --phase task-start');
    }
    return cached;
  }

  return createPrSnapshot({
    cacheDir,
    includeUntrustedReviewContent: options.includeUntrustedReviewContent,
    phase: options.phase,
    pr: options.pr,
    rootDir,
    runner,
  });
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else {
      const snapshot = getPrSnapshot(options);
      console.log(JSON.stringify(snapshot || {
        schema: SCHEMA,
        status: 'not-applicable',
        reason: 'HEAD is not associated with an open pull request',
      }, null, 2));
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, schema: SCHEMA, status: 'error' }, null, 2));
    process.exitCode = 1;
  }
}
