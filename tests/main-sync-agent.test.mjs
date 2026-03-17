import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildLaunchAgentPlist } from '../scripts/setup-main-sync-agent.mjs';
import { buildSyncPaths } from '../scripts/sync-main-to-mac.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const syncScriptPath = path.join(repoRoot, 'scripts', 'sync-main-to-mac.mjs');
const setupScriptPath = path.join(repoRoot, 'scripts', 'setup-main-sync-agent.mjs');
const packageJsonPath = path.join(repoRoot, 'package.json');

function readIfExists(filePath) {
  if (!existsSync(filePath)) {
    return '';
  }
  return readFileSync(filePath, 'utf8');
}

test('main sync helper paths stay inside the dedicated sync root', () => {
  assert.deepEqual(buildSyncPaths('/Users/bradleybond/.worldmonitor-main-sync'), {
    syncRoot: '/Users/bradleybond/.worldmonitor-main-sync',
    repoDir: '/Users/bradleybond/.worldmonitor-main-sync/repo',
    stateFile: '/Users/bradleybond/.worldmonitor-main-sync/state.json',
    statusFile: '/Users/bradleybond/.worldmonitor-main-sync/status.json',
    lockFile: '/Users/bradleybond/.worldmonitor-main-sync/sync.lock',
    logDir: '/Users/bradleybond/.worldmonitor-main-sync/logs',
  });
});

test('main sync launch agent plist runs Node on a fixed interval', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.bradleybond.worldmonitor.main-sync',
    nodePath: '/opt/homebrew/bin/node',
    syncScriptPath: '/Users/bradleybond/developer/worldmonitor/scripts/sync-main-to-mac.mjs',
    syncRoot: '/Users/bradleybond/.worldmonitor-main-sync',
    logDir: '/Users/bradleybond/.worldmonitor-main-sync/logs',
    intervalSeconds: 60,
  });

  assert.match(plist, /<string>com\.bradleybond\.worldmonitor\.main-sync<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /sync-main-to-mac\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
});

test('main-to-mac sync uses a local clean clone instead of a GitHub self-hosted runner workflow', () => {
  const syncScript = readIfExists(syncScriptPath);

  assert.equal(
    existsSync(syncScriptPath),
    true,
    'sync-main-to-mac.mjs should exist as the local main-to-Mac delivery entrypoint',
  );
  assert.match(
    syncScript,
    /\.worldmonitor-main-sync/,
    'sync-main-to-mac should use a dedicated sync root outside the working tree',
  );
  assert.match(
    syncScript,
    /repo['"`]/,
    'sync-main-to-mac should keep a dedicated clean clone directory',
  );
  assert.match(
    syncScript,
    /\['npm', \['run', 'lockfile:check'\]\][\s\S]*\['npm', \['ci'\]\][\s\S]*\['npm', \['run', 'version:check'\]\][\s\S]*\['npm', \['run', 'typecheck:all'\]\][\s\S]*\['npm', \['run', 'build'\]\][\s\S]*\['npm', \['run', 'desktop:build:app:full'\]\]/,
    'sync-main-to-mac should rerun the hard verification stack and build a local app bundle before install',
  );
  assert.match(
    syncScript,
    /install-built-app\.mjs/,
    'sync-main-to-mac should install via the verified app installer script',
  );
  assert.doesNotMatch(
    syncScript,
    /self-hosted/,
    'sync-main-to-mac should no longer rely on a GitHub self-hosted runner',
  );
});

test('main sync setup installs a launch agent that runs the sync script directly', () => {
  const setupScript = readIfExists(setupScriptPath);

  assert.equal(
    existsSync(setupScriptPath),
    true,
    'setup-main-sync-agent.mjs should exist to install the local launch agent',
  );
  assert.match(
    setupScript,
    /LaunchAgents/,
    'setup-main-sync-agent should write a macOS LaunchAgent plist',
  );
  assert.match(
    setupScript,
    /StartInterval/,
    'setup-main-sync-agent should configure periodic sync execution',
  );
  assert.match(
    setupScript,
    /sync-main-to-mac\.mjs/,
    'setup-main-sync-agent should launch the sync script directly',
  );
});

test('package scripts expose the supported main sync commands', () => {
  const packageJson = readFileSync(packageJsonPath, 'utf8');

  assert.match(
    packageJson,
    /"main-sync:run": "node scripts\/sync-main-to-mac\.mjs"/,
    'package.json should expose the main sync runner',
  );
  assert.match(
    packageJson,
    /"main-sync:setup": "node scripts\/setup-main-sync-agent\.mjs"/,
    'package.json should expose the launch agent bootstrap command',
  );
  assert.doesNotMatch(
    packageJson,
    /"runner:setup": "node scripts\/setup-self-hosted-runner\.mjs"/,
    'package.json should not keep the abandoned self-hosted runner setup command',
  );
});
