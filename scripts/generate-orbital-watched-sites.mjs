#!/usr/bin/env node
// Writes the composed watched-site registry (shared/watched-sites.ts) to
// scripts/shared/, where the Railway site seeder can import it without the TypeScript
// sources. Run through `npm run generate`; `--check` fails when the committed copy is stale.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeWatchedSites } from '../shared/watched-sites.ts';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WATCHED_SITES_OUTPUT = 'scripts/shared/orbital-watched-sites.generated.mjs';

export function renderWatchedSitesModule(sites) {
  const lines = sites.map((site) => `  ${JSON.stringify(site)},`);
  const version = createHash('sha256').update(JSON.stringify(sites)).digest('hex').slice(0, 16);
  return `// AUTO-GENERATED from shared/watched-sites.ts. Do not edit manually.
// Run: npm run generate
// @ts-check

export const WATCHED_SITES_VERSION = ${JSON.stringify(version)};

/** @type {ReadonlyArray<import('../../shared/watched-sites.ts').WatchedSite>} */
export const WATCHED_SITES = Object.freeze([
${lines.join('\n')}
]);
`;
}

export const isWatchedSitesModuleCurrent = (committed, sites = composeWatchedSites()) => committed === renderWatchedSitesModule(sites);

function main() {
  const rendered = renderWatchedSitesModule(composeWatchedSites());
  const path = join(ROOT, WATCHED_SITES_OUTPUT);
  let committed = '';
  try { committed = readFileSync(path, 'utf8'); } catch { /* first run */ }
  if (process.argv.includes('--check')) {
    if (!isWatchedSitesModuleCurrent(committed)) {
      console.error(`${WATCHED_SITES_OUTPUT} is stale. Run: npm run generate`);
      process.exit(1);
    }
    console.log(`${WATCHED_SITES_OUTPUT} is current`);
    return;
  }
  if (committed === rendered) return console.log(`${WATCHED_SITES_OUTPUT} unchanged`);
  writeFileSync(path, rendered);
  console.log(`wrote ${WATCHED_SITES_OUTPUT}`);
}

if (isMainModule(import.meta.url, process.argv[1])) main();
