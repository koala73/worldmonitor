#!/usr/bin/env node
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildSyncPaths } from './sync-main-to-mac.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_LABEL = 'com.bradleybond.worldmonitor.main-sync';
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_LEGACY_LABEL = 'com.bradleybond.worldmonitor.runner';
const DEFAULT_LEGACY_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DEFAULT_LEGACY_LABEL}.plist`);

export function buildLaunchAgentPlist({ label, nodePath, syncScriptPath, syncRoot, logDir, intervalSeconds, envPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${syncScriptPath}</string>
    <string>--sync-root</string>
    <string>${syncRoot}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'main-sync.stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'main-sync.stderr.log')}</string>
</dict>
</plist>
`;
}

function parseArgs(argv) {
  const syncPaths = buildSyncPaths();
  const options = {
    syncRoot: syncPaths.syncRoot,
    logDir: syncPaths.logDir,
    launchAgentPath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${DEFAULT_LABEL}.plist`),
    label: DEFAULT_LABEL,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    start: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sync-root') {
      const nextRoot = argv[index + 1] ?? '';
      index += 1;
      const nextPaths = buildSyncPaths(nextRoot);
      options.syncRoot = nextPaths.syncRoot;
      options.logDir = nextPaths.logDir;
      continue;
    }
    if (arg.startsWith('--sync-root=')) {
      const nextPaths = buildSyncPaths(arg.slice('--sync-root='.length));
      options.syncRoot = nextPaths.syncRoot;
      options.logDir = nextPaths.logDir;
      continue;
    }
    if (arg === '--launch-agent-path') {
      options.launchAgentPath = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--launch-agent-path=')) {
      options.launchAgentPath = arg.slice('--launch-agent-path='.length);
      continue;
    }
    if (arg === '--interval-seconds') {
      options.intervalSeconds = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--interval-seconds=')) {
      options.intervalSeconds = Number.parseInt(arg.slice('--interval-seconds='.length), 10);
      continue;
    }
    if (arg === '--no-start') {
      options.start = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 30) {
    throw new Error('intervalSeconds must be an integer >= 30');
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
}

async function installLaunchAgent(options) {
  await mkdir(path.dirname(options.launchAgentPath), { recursive: true });
  await mkdir(options.logDir, { recursive: true });
  const plist = buildLaunchAgentPlist({
    label: options.label,
    nodePath: process.execPath,
    syncScriptPath: path.join(repoRoot, 'scripts', 'sync-main-to-mac.mjs'),
    syncRoot: options.syncRoot,
    logDir: options.logDir,
    intervalSeconds: options.intervalSeconds,
    envPath: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  });
  await writeFile(options.launchAgentPath, plist);
  await chmod(options.launchAgentPath, 0o644);
}

async function removeLegacyRunner() {
  const uid = process.getuid?.();
  if (uid) {
    spawnSync('launchctl', ['bootout', `gui/${uid}`, DEFAULT_LEGACY_PLIST], { stdio: 'ignore' });
  }
  await rm(DEFAULT_LEGACY_PLIST, { force: true }).catch(() => {});
}

function reloadLaunchAgent(launchAgentPath, label) {
  const uid = process.getuid?.();
  if (!uid) {
    throw new Error('Could not determine user id for launchctl bootstrap');
  }
  spawnSync('launchctl', ['bootout', `gui/${uid}`, launchAgentPath], { stdio: 'ignore' });
  runCommand('launchctl', ['bootstrap', `gui/${uid}`, launchAgentPath]);
  runCommand('launchctl', ['enable', `gui/${uid}/${label}`]);
  runCommand('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await removeLegacyRunner();
  await installLaunchAgent(options);
  if (options.start) {
    reloadLaunchAgent(options.launchAgentPath, options.label);
  }
  console.log(JSON.stringify({
    label: options.label,
    launchAgentPath: options.launchAgentPath,
    syncRoot: options.syncRoot,
    intervalSeconds: options.intervalSeconds,
    started: options.start,
  }, null, 2));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(`[setup-main-sync-agent] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
