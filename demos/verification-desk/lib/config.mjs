import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Anchor } from './anchor.mjs';
import { SourceBook } from './quality.mjs';
import { WorldMonitorMcp } from './mcp-client.mjs';
import { ArchiveSource, CombinedSource, FixtureSource, LiveSource } from './sources.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
// Committed, dated snapshots of real WorldMonitor data (see snapshots/README.md).
export const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');

export function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/** WorldMonitor's outlet ratings (get_sources), as committed in snapshots/sources.json. */
export function loadSourceBook() {
  try {
    return new SourceBook(JSON.parse(readFileSync(path.join(SNAPSHOT_DIR, 'sources.json'), 'utf8')).outlets);
  } catch {
    return new SourceBook([]);
  }
}

export function buildDesk({ rehearsal = process.env.DESK_REHEARSAL === '1' } = {}) {
  const anchor = new Anchor();
  const book = loadSourceBook();
  if (rehearsal) {
    const fixture = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'rehearsal.json'), 'utf8'));
    return { source: new FixtureSource(fixture), anchor, book: new SourceBook(fixture.sources ?? []), rehearsal: true };
  }
  const apiKey = process.env.WORLDMONITOR_API_KEY;
  const bearerToken = process.env.WORLDMONITOR_MCP_TOKEN;
  const live = apiKey || bearerToken
    ? new LiveSource(new WorldMonitorMcp({ url: process.env.WORLDMONITOR_MCP_URL || 'https://worldmonitor.app/mcp', apiKey, bearerToken }))
    : null;
  const archiveDirs = [ARCHIVE_DIR, SNAPSHOT_DIR].filter((d) => existsSync(d));
  const archive = archiveDirs.length ? new ArchiveSource(archiveDirs, { days: Number(process.env.DESK_ARCHIVE_DAYS || 7) }) : null;
  if (!live && !archive) {
    throw new Error('No data source: set WORLDMONITOR_API_KEY in demos/verification-desk/.env, or run with DESK_REHEARSAL=1.');
  }
  return { source: new CombinedSource(live, archive), anchor, book, rehearsal: false };
}
