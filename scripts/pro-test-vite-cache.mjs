import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENV_CACHE_DIR = 'WM_PRO_TEST_VITE_CACHE';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PRO_TEST_ROOT = resolve(REPO_ROOT, 'pro-test');

export function hashLockfile(contents) {
  return createHash('sha256').update(contents).digest('hex').slice(0, 12);
}

export function readGitCommonDir(cwd, runGit = spawnSync) {
  const result = runGit(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.status !== 0) return '';
  return (result.stdout || '').trim();
}

export function resolveProTestViteCacheDir({
  env = process.env,
  proTestRoot = DEFAULT_PRO_TEST_ROOT,
  gitCommonDir,
  lockfileContents,
  runGit = spawnSync,
} = {}) {
  const override = env[ENV_CACHE_DIR];
  if (typeof override === 'string' && override.trim()) {
    return resolve(override.trim());
  }

  const lockPath = resolve(proTestRoot, 'package-lock.json');
  let contents = lockfileContents;
  if (contents == null) {
    try {
      contents = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      contents = '';
    }
  }
  const shard = contents ? hashLockfile(contents) : 'nolock';

  const common = gitCommonDir !== undefined ? gitCommonDir : readGitCommonDir(proTestRoot, runGit);
  if (common) {
    return resolve(common, 'wm-vite-cache', `pro-test-${shard}`);
  }

  return resolve(proTestRoot, 'node_modules', '.vite');
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  process.stdout.write(`${resolveProTestViteCacheDir()}\n`);
}
