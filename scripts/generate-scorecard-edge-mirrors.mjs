#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIRRORS = [
  ['_input-registry', 'scripts/scorecard/v1/_input-registry.mts', 'server/worldmonitor/scorecard/v1/_input-registry.ts'],
  ['_methodology', 'scripts/scorecard/v1/_methodology.mts', 'server/worldmonitor/scorecard/v1/_methodology.ts'],
  ['_score-country', 'scripts/scorecard/v1/_score-country.mts', 'server/worldmonitor/scorecard/v1/_score-country.ts'],
  ['_snapshot', 'scripts/scorecard/v1/_snapshot.mts', 'server/worldmonitor/scorecard/v1/_snapshot.ts'],
  ['_source-adapters', 'scripts/scorecard/v1/_source-adapters.mts', 'server/worldmonitor/scorecard/v1/_source-adapters.ts'],
  ['_source-registry', 'scripts/scorecard/v1/_source-registry.mts', 'server/worldmonitor/scorecard/v1/_source-registry.ts'],
  ['_types', 'scripts/scorecard/v1/_types.mts', 'server/worldmonitor/scorecard/v1/_types.ts'],
];
export const SCORECARD_EDGE_MIRRORS = MIRRORS.map(([name]) => name);

export function renderScorecardEdgeMirror(name, source) {
  const mirror = MIRRORS.find(([candidate]) => candidate === name);
  if (!mirror) throw new Error(`Unknown scorecard Edge mirror: ${name}`);
  const generatedFrom = mirror[1];
  return [
    `// Generated from ${generatedFrom} by scripts/generate-scorecard-edge-mirrors.mjs. Do not edit.`,
    source.replace(/(['"]\.\/[^'"]+)\.mts(['"])/g, '$1$2'),
  ].join('\n');
}

export function generateScorecardEdgeMirrors({ check = false } = {}) {
  const stale = [];
  for (const [name, sourcePath, edgePath] of MIRRORS) {
    const source = readFileSync(resolve(ROOT, sourcePath), 'utf8');
    const outputPath = resolve(ROOT, edgePath);
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
