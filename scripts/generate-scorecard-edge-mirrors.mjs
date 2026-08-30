#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = resolve(ROOT, 'scripts/scorecard/v1');
const EDGE_DIR = resolve(ROOT, 'server/worldmonitor/scorecard/v1');
export const SCORECARD_EDGE_MIRRORS = [
  '_input-registry',
  '_methodology',
  '_score-country',
  '_snapshot',
  '_source-adapters',
  '_source-registry',
  '_types',
];

export function renderScorecardEdgeMirror(name, source) {
  const generatedFrom = relative(ROOT, resolve(SOURCE_DIR, `${name}.mts`));
  return [
    `// Generated from ${generatedFrom} by scripts/generate-scorecard-edge-mirrors.mjs. Do not edit.`,
    source.replace(/(['"]\.\/[^'"]+)\.mts(['"])/g, '$1$2'),
  ].join('\n');
}

export function generateScorecardEdgeMirrors({ check = false } = {}) {
  const stale = [];
  for (const name of SCORECARD_EDGE_MIRRORS) {
    const source = readFileSync(resolve(SOURCE_DIR, `${name}.mts`), 'utf8');
    const outputPath = resolve(EDGE_DIR, `${name}.ts`);
    const expected = renderScorecardEdgeMirror(name, source);
    let actual = null;
    try {
      actual = readFileSync(outputPath, 'utf8');
    } catch { /* missing output is stale */ }
    if (actual === expected) continue;
    stale.push(relative(ROOT, outputPath));
    if (!check) writeFileSync(outputPath, expected);
  }
  return stale;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const check = process.argv.includes('--check');
  const stale = generateScorecardEdgeMirrors({ check });
  if (check && stale.length > 0) {
    console.error(`Stale scorecard Edge mirrors:\n${stale.map((file) => `  ${file}`).join('\n')}`);
    process.exit(1);
  }
  console.log(check
    ? `scorecard Edge mirrors current (${SCORECARD_EDGE_MIRRORS.length})`
    : `generated ${SCORECARD_EDGE_MIRRORS.length} scorecard Edge mirrors`);
}
