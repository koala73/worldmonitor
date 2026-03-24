#!/usr/bin/env node
// Runs after desktop:build:full (via postdesktop:build:full npm hook).
// Skipped in CI. Installs the freshly built app to ~/Applications and
// records the local git SHA so the main-sync agent won't overwrite it.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.env.CI) {
  console.log('[local-install] CI detected — skipping local install');
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? 1}`);
  }
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.stdout?.trim() ?? '';
}

const localSha = capture('git', ['rev-parse', 'HEAD']);

run(process.execPath, [
  path.join(scriptDir, 'install-built-app.mjs'),
  '--relaunch',
  '--local-sha', localSha,
]);
