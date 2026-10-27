#!/usr/bin/env node
// Writes the browser's slice of shared/news-catalog.json to
// src/config/news-catalog.browser.generated.json. The browser bundle imports
// the slice so it ships only what the browser serves (no server-only fields,
// notes or server placements). Run under tsx: `node --import tsx <this>`.
// --check exits 1 when the committed slice is stale.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectBrowserCatalog } from '../shared/news-catalog.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSER_CATALOG_PATH = 'src/config/news-catalog.browser.generated.json';

export function renderBrowserCatalog() {
  return `${JSON.stringify(projectBrowserCatalog(), null, 2)}\n`;
}

function main() {
  const target = resolve(ROOT, BROWSER_CATALOG_PATH);
  const next = renderBrowserCatalog();
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error(`${BROWSER_CATALOG_PATH} is stale; run \`npm run generate\`.`);
      process.exit(1);
    }
    return;
  }
  if (current !== next) writeFileSync(target, next);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
