import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Anchor } from './anchor.mjs';
import { WorldMonitorMcp } from './mcp-client.mjs';
import { ArchiveSource, CombinedSource, LiveSource } from './sources.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
// Committed, dated snapshots of real WorldMonitor data (see snapshots/README.md).
export const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');

/**
 * Precedence, highest first: the shell, demos/verification-desk/.env, then
 * the repository's own .env.local and .env two levels up. A variable that is
 * already set, or set to an empty value, is never overwritten, and an empty
 * assignment (every line of .env.example) never blocks a later file. The
 * presenter's keys (WorldMonitor, Anthropic, LiveAvatar) already live in the
 * repo's .env.local; they need not be copied here.
 */
export function loadEnv(files = envFiles()) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (value !== '' && !process.env[key]) process.env[key] = value;
    }
  }
}

export function envFiles() {
  const repoRoot = path.resolve(ROOT, '..', '..');
  return [path.join(ROOT, '.env'), path.join(repoRoot, '.env.local'), path.join(repoRoot, '.env')];
}

/**
 * Live WorldMonitor MCP when a key is set, with the archived and committed
 * snapshots behind it. DESK_OFFLINE=1 (npm run offline) reads the snapshots
 * only: real WorldMonitor data, no network, no keys: no Claude, no article
 * fetches, no live backdrop.
 */
export function buildDesk({ offline = process.env.DESK_OFFLINE === '1' } = {}) {
  const anchor = offline ? new Anchor({ apiKey: null }) : new Anchor();
  const apiKey = process.env.WORLDMONITOR_API_KEY;
  const bearerToken = process.env.WORLDMONITOR_MCP_TOKEN;
  const live = !offline && (apiKey || bearerToken)
    ? new LiveSource(new WorldMonitorMcp({ url: process.env.WORLDMONITOR_MCP_URL || 'https://worldmonitor.app/mcp', apiKey, bearerToken }))
    : null;
  // Rolling snapshots age out; the committed ones are the offline fallback and never do.
  const archiveDirs = [{ dir: ARCHIVE_DIR }, { dir: SNAPSHOT_DIR, days: Infinity }].filter((d) => existsSync(d.dir));
  const archive = archiveDirs.length ? new ArchiveSource(archiveDirs, { days: Number(process.env.DESK_ARCHIVE_DAYS || 7) }) : null;
  if (!live && !archive) {
    throw new Error('No data source: set WORLDMONITOR_API_KEY in demos/verification-desk/.env, or keep the committed snapshots/.');
  }
  return { source: new CombinedSource(live, archive, { noNetwork: offline }), anchor, offline: !live, noNetwork: offline };
}
