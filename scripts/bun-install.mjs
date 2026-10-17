#!/usr/bin/env node
// Spike helper: `bun install`, then stamp the completed-install marker the
// pre-push gate and bootstrap-worktree.mjs both look for.
//
// Bun does not write a marker of its own (see writeBunInstallMarker), so this
// wrapper is what makes a bun-installed tree legible to the existing gates.
// Not wired into any npm lifecycle script — the spike is opt-in.
//
//   node scripts/bun-install.mjs [...bun install args]
import { spawnSync } from 'node:child_process';

import { writeBunInstallMarker } from './bootstrap-worktree.mjs';

const args = process.argv.slice(2);
const result = spawnSync('bun', ['install', ...args], { stdio: 'inherit' });

if (result.error) {
  console.error(`[bun-install] could not run bun: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (writeBunInstallMarker()) {
  console.log('[bun-install] stamped node_modules/.wm-bun-install');
} else {
  // No bun.lock means bun did not produce a lockfile to hash — the gate will
  // fall through to npm ci rather than trusting an unverifiable tree.
  console.warn('[bun-install] no bun.lock found; marker not written');
}
