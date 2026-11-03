#!/usr/bin/env node
// Writes scripts/shared/live-video-refresh-channels.generated.json: every YouTube channel a live video catalog slot
// lists (canaries excluded), for the seed-live-video-resolved Railway cron. That service is packaged from scripts/
// alone and runs plain Node, so it cannot read src/config/live-video-sources.ts; this file is its copy of the list.
// Run with: npm run sync:live-video-channels (writes) or npm run sync:live-video-channels:check (CI gate).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CATALOG } from './check-live-video-sources.mjs';
import { refreshChannels } from './lib/live-video-refresh.mjs';
import { isMainModule } from './lib/main-module.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REFRESH_CHANNELS_FILE = resolve(root, 'scripts/shared/live-video-refresh-channels.generated.json');
const GENERATED_FROM = 'src/config/live-video-sources.ts';

/** The generated file's exact text for `catalog`. */
export function renderRefreshChannels(catalog = DEFAULT_CATALOG) {
  return `${JSON.stringify({ generatedFrom: GENERATED_FROM, channels: refreshChannels(catalog) }, null, 2)}\n`;
}

function channelsIn(text) {
  try {
    const channels = JSON.parse(text)?.channels;
    return Array.isArray(channels) ? channels : [];
  } catch {
    return [];
  }
}

/**
 * Compares the committed file with the catalog. `ok` is true only for an exact match; otherwise `problems` names every
 * channel added, removed or whose slots changed, so the CI log says what to regenerate for.
 */
export function checkRefreshChannels(actualText, catalog = DEFAULT_CATALOG) {
  const expectedText = renderRefreshChannels(catalog);
  if (actualText === expectedText) return { ok: true, problems: [] };
  const expected = new Map(channelsIn(expectedText).map((entry) => [entry.channelId, JSON.stringify(entry.slots)]));
  const actual = new Map(channelsIn(actualText).map((entry) => [entry?.channelId, JSON.stringify(entry?.slots)]));
  const problems = [];
  for (const [id, slots] of expected) {
    if (!actual.has(id)) problems.push(`missing ${id} (${slots})`);
    else if (actual.get(id) !== slots) problems.push(`slots changed for ${id}: ${actual.get(id)} -> ${slots}`);
  }
  for (const id of actual.keys()) if (!expected.has(id)) problems.push(`not in the catalog: ${id}`);
  if (problems.length === 0) problems.push('order or formatting differs');
  return { ok: false, problems };
}

export function runSync({ check = false, file = REFRESH_CHANNELS_FILE, catalog = DEFAULT_CATALOG, log = console.log, error = console.error } = {}) {
  if (!check) {
    writeFileSync(file, renderRefreshChannels(catalog));
    log(`Updated ${relative(root, file)} (${refreshChannels(catalog).length} channels)`);
    return 0;
  }
  let actualText = '';
  try {
    actualText = readFileSync(file, 'utf8');
  } catch {
    // A missing file reads as empty and fails below.
  }
  const { ok, problems } = checkRefreshChannels(actualText, catalog);
  if (ok) return 0;
  error(`${relative(root, file)} is stale. Run npm run sync:live-video-channels.`);
  for (const problem of problems) error(`  ${problem}`);
  return 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = runSync({ check: process.argv.includes('--check') });
}
