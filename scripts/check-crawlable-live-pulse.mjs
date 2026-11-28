import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIVE_PULSE_SNAPSHOT_DIR = 'docs/snapshots';
export const LIVE_PULSE_SNAPSHOT_RE = /^crawlable-live-pulse-(\d{4}-\d{2}-\d{2})\.json$/;

// Allow the weekly refresh three days to land before official publishing stops.
export const MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS = 10;

export function livePulseSnapshotAgeDays(capturedAt, now = Date.now()) {
  const capturedAtMs = Date.parse(`${String(capturedAt || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(capturedAtMs)
    ? (now - capturedAtMs) / 86_400_000
    : Number.POSITIVE_INFINITY;
}

export function resolveLatestLivePulseSnapshotPath(rootDir = DEFAULT_ROOT) {
  const snapshotDir = join(rootDir, LIVE_PULSE_SNAPSHOT_DIR);
  const candidates = readdirSync(snapshotDir)
    .map((filename) => ({ filename, match: filename.match(LIVE_PULSE_SNAPSHOT_RE) }))
    .filter(({ match }) => match)
    .sort((a, b) => b.match[1].localeCompare(a.match[1], 'en-US'));
  if (candidates.length === 0) {
    throw new Error(`No crawlable live-pulse snapshot found in ${LIVE_PULSE_SNAPSHOT_DIR}`);
  }

  const [{ filename, match }] = candidates;
  const relativePath = join(LIVE_PULSE_SNAPSHOT_DIR, filename);
  const snapshot = JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'));
  if (snapshot.capturedAt !== match[1]) {
    throw new Error(
      `${relativePath} filename date ${match[1]} does not match capturedAt ${snapshot.capturedAt}`,
    );
  }
  if (!snapshot.countries || !snapshot.chokepoints || !snapshot.crises || !snapshot.signalConvergence) {
    throw new Error(`${relativePath} is missing required live-pulse sections`);
  }
  return relativePath;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const relativePath = resolveLatestLivePulseSnapshotPath(process.cwd());
  // The resolver checked that the filename agrees with the capture date.
  const [, capturedAt] = basename(relativePath).match(LIVE_PULSE_SNAPSHOT_RE);
  const ageDays = livePulseSnapshotAgeDays(capturedAt);
  if (ageDays > MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS) {
    throw new Error(
      `${relativePath} is ${Math.round(ageDays)} days old (max ${MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS}); `
      + 'run `npm run freeze:crawlable-live-pulse` to republish current values',
    );
  }
  console.log(`Live-pulse snapshot is fresh: ${relativePath}`);
}
