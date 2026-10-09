import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Anchor } from './anchor.mjs';
import { WorldMonitorMcp } from './mcp-client.mjs';
import { ArchiveSource, CombinedSource, LiveSource } from './sources.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
// Committed, dated snapshots of real WorldMonitor data (see snapshots/README.md).
export const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');

export function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/**
 * Live WorldMonitor MCP when a key is set, with the archived and committed
 * snapshots behind it. DESK_OFFLINE=1 (npm run offline) reads the snapshots
 * only: real WorldMonitor data, no network, no keys.
 */
export function buildDesk({ offline = process.env.DESK_OFFLINE === '1' } = {}) {
  const anchor = new Anchor();
  const apiKey = process.env.WORLDMONITOR_API_KEY;
  const bearerToken = process.env.WORLDMONITOR_MCP_TOKEN;
  const live = !offline && (apiKey || bearerToken)
    ? new LiveSource(new WorldMonitorMcp({ url: process.env.WORLDMONITOR_MCP_URL || 'https://worldmonitor.app/mcp', apiKey, bearerToken }))
    : null;
  const archiveDirs = [ARCHIVE_DIR, SNAPSHOT_DIR].filter((d) => existsSync(d));
  const archive = archiveDirs.length ? new ArchiveSource(archiveDirs, { days: Number(process.env.DESK_ARCHIVE_DAYS || 7) }) : null;
  if (!live && !archive) {
    throw new Error('No data source: set WORLDMONITOR_API_KEY in demos/verification-desk/.env, or keep the committed snapshots/.');
  }
  return { source: new CombinedSource(live, archive), anchor, offline: !live };
}
