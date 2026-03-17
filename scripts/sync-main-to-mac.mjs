#!/usr/bin/env node
import { open, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { hashDirectory, verifyAppBundle } from './install-built-app.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_SYNC_ROOT = path.join(os.homedir(), '.worldmonitor-main-sync');
const DEFAULT_REMOTE_URL = 'https://github.com/bradleybond512/worldmonitor-macos.git';
const DEFAULT_REPO_SLUG = 'bradleybond512/worldmonitor-macos';
const DEFAULT_BRANCH = 'main';
const DEFAULT_INSTALL_PATH = path.join(os.homedir(), 'Applications', 'World Monitor.app');

export function buildSyncPaths(syncRoot = DEFAULT_SYNC_ROOT) {
  return {
    syncRoot,
    repoDir: path.join(syncRoot, 'repo'),
    stateFile: path.join(syncRoot, 'state.json'),
    statusFile: path.join(syncRoot, 'status.json'),
    lockFile: path.join(syncRoot, 'sync.lock'),
    logDir: path.join(syncRoot, 'logs'),
  };
}

function parseArgs(argv) {
  const paths = buildSyncPaths();
  const options = {
    syncRoot: paths.syncRoot,
    repoDir: paths.repoDir,
    stateFile: paths.stateFile,
    statusFile: paths.statusFile,
    lockFile: paths.lockFile,
    logDir: paths.logDir,
    repoSlug: DEFAULT_REPO_SLUG,
    remoteUrl: DEFAULT_REMOTE_URL,
    branch: DEFAULT_BRANCH,
    installPath: DEFAULT_INSTALL_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sync-root') {
      const nextRoot = argv[index + 1] ?? '';
      index += 1;
      Object.assign(options, buildSyncPaths(nextRoot));
      continue;
    }
    if (arg.startsWith('--sync-root=')) {
      Object.assign(options, buildSyncPaths(arg.slice('--sync-root='.length)));
      continue;
    }
    if (arg === '--repo') {
      options.repoSlug = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      options.repoSlug = arg.slice('--repo='.length);
      continue;
    }
    if (arg === '--remote-url') {
      options.remoteUrl = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--remote-url=')) {
      options.remoteUrl = arg.slice('--remote-url='.length);
      continue;
    }
    if (arg === '--branch') {
      options.branch = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--branch=')) {
      options.branch = arg.slice('--branch='.length);
      continue;
    }
    if (arg === '--install-path') {
      options.installPath = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--install-path=')) {
      options.installPath = arg.slice('--install-path='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function runLoggedCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 1}`);
  }
}

async function pathExists(filePath) {
  return stat(filePath).then(() => true).catch(() => false);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

class SyncBlockedError extends Error {}

async function acquireLock(lockFile) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  return open(lockFile, 'wx');
}

async function ensureClone(options) {
  await mkdir(path.dirname(options.repoDir), { recursive: true });

  if (!(await pathExists(path.join(options.repoDir, '.git')))) {
    await rm(options.repoDir, { recursive: true, force: true });
    runLoggedCommand('git', ['clone', '--branch', options.branch, '--single-branch', options.remoteUrl, options.repoDir]);
  } else {
    runCommand('git', ['remote', 'set-url', 'origin', options.remoteUrl], { cwd: options.repoDir });
  }

  runCommand('git', ['fetch', 'origin', options.branch, '--tags', '--prune'], { cwd: options.repoDir });
  const targetSha = runCommand('git', ['rev-parse', `origin/${options.branch}`], { cwd: options.repoDir });
  runLoggedCommand('git', ['checkout', '--force', '-B', options.branch, `origin/${options.branch}`], {
    cwd: options.repoDir,
  });
  runLoggedCommand('git', ['reset', '--hard', targetSha], { cwd: options.repoDir });
  runLoggedCommand('git', ['clean', '-fdx'], { cwd: options.repoDir });
  return targetSha;
}

function collectCheckStates(checkRunsPayload, statusPayload) {
  const states = new Map();
  for (const checkRun of checkRunsPayload?.check_runs ?? []) {
    if (checkRun?.name) {
      states.set(checkRun.name, checkRun.conclusion ?? checkRun.status ?? 'unknown');
    }
  }
  for (const status of statusPayload?.statuses ?? []) {
    if (status?.context) {
      states.set(status.context, status.state ?? 'unknown');
    }
  }
  return states;
}

function requireGreenChecks(requiredChecks, checkStates, sha) {
  const missing = [];
  const nonSuccess = [];

  for (const checkName of requiredChecks) {
    const state = checkStates.get(checkName);
    if (!state) {
      missing.push(checkName);
      continue;
    }
    if (state !== 'success') {
      nonSuccess.push(`${checkName}=${state}`);
    }
  }

  if (missing.length > 0 || nonSuccess.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing [${missing.join(', ')}]`);
    if (nonSuccess.length > 0) details.push(`non-success [${nonSuccess.join(', ')}]`);
    throw new SyncBlockedError(`Required GitHub checks are not green for ${sha}: ${details.join('; ')}`);
  }
}

async function verifyRemoteChecks(options, sha) {
  const requiredPayload = JSON.parse(
    runCommand('gh', ['api', `repos/${options.repoSlug}/branches/${options.branch}/protection/required_status_checks`]),
  );
  const requiredChecks = (requiredPayload.checks ?? []).map((entry) => entry.context).filter(Boolean);
  const checkRunsPayload = JSON.parse(
    runCommand('gh', ['api', `repos/${options.repoSlug}/commits/${sha}/check-runs`]),
  );
  const statusPayload = JSON.parse(
    runCommand('gh', ['api', `repos/${options.repoSlug}/commits/${sha}/status`]),
  );
  requireGreenChecks(requiredChecks, collectCheckStates(checkRunsPayload, statusPayload), sha);
  return requiredChecks;
}

async function isInstalledCommitHealthy(state, installPath) {
  if (!state?.installedSha) {
    return false;
  }
  try {
    await verifyAppBundle(installPath);
    return true;
  } catch {
    return false;
  }
}

async function runVerificationAndBuild(repoDir) {
  const commands = [
    ['npm', ['run', 'lockfile:check']],
    ['npm', ['ci']],
    ['npm', ['run', 'version:check']],
    ['npm', ['run', 'typecheck:all']],
    ['npm', ['run', 'build']],
    ['npm', ['run', 'desktop:build:app:full']],
  ];

  for (const [command, args] of commands) {
    runLoggedCommand(command, args, { cwd: repoDir, env: process.env });
  }
}

async function installBuiltApp(repoDir, installPath) {
  const appPath = path.join(repoDir, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'World Monitor.app');
  await verifyAppBundle(appPath);
  const appSha = await hashDirectory(appPath);
  runLoggedCommand(process.execPath, [
    path.join(repoDir, 'scripts', 'install-built-app.mjs'),
    '--app',
    appPath,
    '--install-path',
    installPath,
    '--sha256',
    appSha,
    '--relaunch',
  ]);
  return { appPath, appSha };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const lockHandle = await acquireLock(options.lockFile).catch((error) => {
    if (error?.code === 'EEXIST') {
      throw new SyncBlockedError('A main sync run is already in progress');
    }
    throw error;
  });

  try {
    await mkdir(options.logDir, { recursive: true });
    const state = await readJson(options.stateFile);
    const targetSha = await ensureClone(options);

    await writeJson(options.statusFile, {
      phase: 'checking',
      startedAt,
      targetSha,
      installPath: options.installPath,
      repoDir: options.repoDir,
    });

    const requiredChecks = await verifyRemoteChecks(options, targetSha);

    if (state?.installedSha === targetSha && (await isInstalledCommitHealthy(state, options.installPath))) {
      await writeJson(options.statusFile, {
        phase: 'idle',
        checkedAt: new Date().toISOString(),
        targetSha,
        installedSha: state.installedSha,
        requiredChecks,
      });
      console.log(`[sync-main-to-mac] ${targetSha} already installed and healthy`);
      return;
    }

    await writeJson(options.statusFile, {
      phase: 'building',
      startedAt,
      targetSha,
      requiredChecks,
    });

    await runVerificationAndBuild(options.repoDir);
    const installResult = await installBuiltApp(options.repoDir, options.installPath);
    const finishedAt = new Date().toISOString();

    await writeJson(options.stateFile, {
      installedAt: finishedAt,
      installedSha: targetSha,
      installPath: options.installPath,
      appPath: installResult.appPath,
      appSha256: installResult.appSha,
      repoSlug: options.repoSlug,
      branch: options.branch,
      requiredChecks,
    });
    await writeJson(options.statusFile, {
      phase: 'installed',
      installedAt: finishedAt,
      targetSha,
      installPath: options.installPath,
      appSha256: installResult.appSha,
    });
    console.log(`[sync-main-to-mac] Installed ${targetSha} to ${options.installPath}`);
  } catch (error) {
    const status = error instanceof SyncBlockedError ? 'blocked' : 'failed';
    await writeJson(options.statusFile, {
      phase: status,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    if (error instanceof SyncBlockedError) {
      console.log(`[sync-main-to-mac] ${error.message}`);
      return;
    }
    throw error;
  } finally {
    await lockHandle?.close().catch(() => {});
    await rm(options.lockFile, { force: true }).catch(() => {});
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(`[sync-main-to-mac] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
