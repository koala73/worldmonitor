#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const aviationFiles = [
  resolve(apiDir, 'AviationService.openapi.json'),
  resolve(apiDir, 'AviationService.openapi.yaml'),
  resolve(apiDir, 'worldmonitor.openapi.yaml'),
];
const militaryFiles = [
  resolve(apiDir, 'MilitaryService.openapi.json'),
  resolve(apiDir, 'MilitaryService.openapi.yaml'),
  resolve(apiDir, 'worldmonitor.openapi.yaml'),
];

const touched = new Set();

for (const path of aviationFiles) {
  const original = readFileSync(path, 'utf8');
  const updated = original
    .replaceAll('"POSITION_SOURCE_OPENSKY",', '')
    .replace(/^[ \t]*- POSITION_SOURCE_OPENSKY\r?\n/gm, '');
  if (updated.includes('POSITION_SOURCE_OPENSKY')) {
    throw new Error(`openapi provider restriction failed for ${path}: OpenSky enum remains`);
  }
  if (updated !== original) {
    writeFileSync(path, updated);
    touched.add(path);
  }
}

for (const path of militaryFiles) {
  const original = readFileSync(path, 'utf8');
  const updated = original
    .replaceAll('or \\"opensky\\"', 'or \\"wingbits\\"')
    .replaceAll('or "opensky"', 'or "wingbits"');
  if (/Provider that supplied this observation[^\n]*opensky/i.test(updated)) {
    throw new Error(`openapi provider restriction failed for ${path}: OpenSky example remains`);
  }
  if (updated !== original) {
    writeFileSync(path, updated);
    touched.add(path);
  }
}

console.log(`openapi-restrict-provider-redistribution: updated ${touched.size} artifact(s)`);
