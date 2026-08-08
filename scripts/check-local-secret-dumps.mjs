#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_LOCAL_ENV_DUMPS = [
  '.env.vercel-backup',
  '.env.vercel-export',
];

export const FORBIDDEN_LOCAL_ENV_DUMP_PATTERN =
  /^\.env(?:[.-].*)?[.-](?:bak|backup|export)[^/]*$/i;

const ZERO_SHA = /^0+$/;
const GIT_COMMIT_BATCH_SIZE = 256;
const CLEAN_GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function isForbiddenLocalEnvDump(fileName) {
  return FORBIDDEN_LOCAL_ENV_DUMPS.includes(fileName)
    || FORBIDDEN_LOCAL_ENV_DUMP_PATTERN.test(fileName);
}

export function findLocalSecretDumps(rootDir = process.cwd()) {
  let fileNames;
  try {
    fileNames = readdirSync(rootDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return fileNames
    .filter(isForbiddenLocalEnvDump)
    .sort();
}

function runGit(rootDir, args, input) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: CLEAN_GIT_ENV,
    input,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parsePrePushUpdates(input) {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha, ...extra] = line.trim().split(/\s+/);
      if (!localRef || !localSha || !remoteRef || !remoteSha || extra.length > 0) {
        throw new Error(`Invalid pre-push update line: ${line}`);
      }
      return { localSha, remoteSha };
    });
}

function listPushedCommits(rootDir, update, remoteName) {
  if (ZERO_SHA.test(update.localSha)) {
    return [];
  }

  if (!ZERO_SHA.test(update.remoteSha)) {
    try {
      return runGit(rootDir, ['rev-list', update.localSha, `^${update.remoteSha}`])
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      // The remote tip is not always available in a shallow or stale clone.
      // Fall back to commits that are not reachable from another ref on the
      // destination remote rather than silently skipping the history check.
    }
  }

  const remoteRefs = remoteName ? `--remotes=${remoteName}` : '--remotes';
  return runGit(rootDir, ['rev-list', update.localSha, '--not', remoteRefs])
    .split(/\r?\n/)
    .filter(Boolean);
}

export function findPushedSecretDumps(
  rootDir = process.cwd(),
  prePushInput = '',
  remoteName = '',
) {
  const commits = new Set();
  for (const update of parsePrePushUpdates(prePushInput)) {
    for (const commit of listPushedCommits(rootDir, update, remoteName)) {
      commits.add(commit);
    }
  }

  const findings = new Map();
  const commitList = [...commits];
  for (let start = 0; start < commitList.length; start += GIT_COMMIT_BATCH_SIZE) {
    const batch = commitList.slice(start, start + GIT_COMMIT_BATCH_SIZE);
    const batchCommits = new Set(batch);
    const entries = runGit(rootDir, [
      'diff-tree',
      '--stdin',
      '--root',
      '-r',
      '-m',
      '--name-only',
      '--diff-filter=AMCR',
      '-z',
      '--',
      '.env*',
    ], `${batch.join('\n')}\n`).split('\0').filter(Boolean);

    let currentCommit = '';
    for (const entry of entries) {
      if (batchCommits.has(entry)) {
        currentCommit = entry;
        continue;
      }
      const filePath = entry;
      if (!filePath.includes('/') && isForbiddenLocalEnvDump(filePath)) {
        findings.set(filePath, findings.get(filePath) ?? currentCommit);
      }
    }
  }

  return [...findings]
    .map(([filePath, commit]) => ({ filePath, commit }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function formatLocalSecretDumpError(found, { includesPushedCommits = false } = {}) {
  const location = includesPushedCommits
    ? 'the working tree or commits being pushed'
    : 'the repository root';
  const remediation = includesPushedCommits
    ? [
        'Remove these plaintext dumps from every commit being pushed; deleting a file',
        'only in a later commit does not remove the secret from Git history.',
      ]
    : ['Delete these plaintext dumps before continuing.'];

  return [
    `ERROR: local environment dump files are present in ${location}.`,
    '',
    ...found.map((fileName) => `  - ${fileName}`),
    '',
    ...remediation,
    'Rotate exposed production secrets through the owning vendor dashboards.',
  ].join('\n');
}

export function runLocalSecretDumpCheck(
  rootDir = process.cwd(),
  { prePushInput = '', remoteName = '' } = {},
) {
  const pushed = prePushInput
    ? findPushedSecretDumps(rootDir, prePushInput, remoteName)
    : [];
  const pushedPaths = new Set(pushed.map(({ filePath }) => filePath));
  const found = [
    ...findLocalSecretDumps(rootDir).filter((fileName) => !pushedPaths.has(fileName)),
    ...pushed.map(
      ({ filePath, commit }) => `${filePath} (commit ${commit.slice(0, 12)})`,
    ),
  ];

  if (found.length > 0) {
    throw new Error(formatLocalSecretDumpError(found, {
      includesPushedCommits: pushed.length > 0,
    }));
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  try {
    const prePushFlagIndex = process.argv.indexOf('--pre-push');
    const prePushInput = prePushFlagIndex >= 0 ? readFileSync(0, 'utf8') : '';
    const remoteName = prePushFlagIndex >= 0
      ? process.argv[prePushFlagIndex + 1] ?? ''
      : '';
    runLocalSecretDumpCheck(process.cwd(), { prePushInput, remoteName });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
