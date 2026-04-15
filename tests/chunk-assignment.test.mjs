import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');

/**
 * Extract all quoted string entries from a `new Set([...])` block.
 */
function extractSetEntries(varName) {
  const re = new RegExp(`const ${varName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`, 'm');
  const match = viteConfigSource.match(re);
  if (!match) return new Set();
  // Match only quoted strings — ignores comments and whitespace
  const entries = match[1].match(/'([^']+)'/g) || [];
  return new Set(entries.map(s => s.replace(/^'|'$/g, '')));
}

const CORE = extractSetEntries('CORE_PANEL_FILES');
const HAPPY = extractSetEntries('HAPPY_PANEL_FILES');
const FINANCE = extractSetEntries('FINANCE_PANEL_FILES');
const FULL = extractSetEntries('FULL_PANEL_FILES');
const TECH = extractSetEntries('TECH_PANEL_FILES');
const ALL_ASSIGNED = new Set([...CORE, ...HAPPY, ...FINANCE, ...FULL, ...TECH]);

const componentFiles = readdirSync(resolve(__dirname, '../src/components'))
  .filter(f => f.endsWith('.ts') && !f.includes('.test.'))
  .map(f => f.replace(/\.ts$/, ''));

const panelFiles = componentFiles.filter(f => f.endsWith('Panel') || f === 'Panel');

describe('chunk assignment sync enforcement', () => {
  it('every *Panel.ts component is assigned to exactly one chunk set', () => {
    const unassigned = panelFiles.filter(f => !ALL_ASSIGNED.has(f));
    assert.deepEqual(
      unassigned,
      [],
      `Unassigned panel files (add to a *_PANEL_FILES set in vite.config.ts): ${unassigned.join(', ')}`
    );
  });

  it('no panel appears in multiple chunk sets', () => {
    const sets = { CORE, HAPPY, FINANCE, FULL, TECH };
    const dupes = [];
    for (const file of ALL_ASSIGNED) {
      const inSets = Object.entries(sets)
        .filter(([, s]) => s.has(file))
        .map(([name]) => name);
      if (inSets.length > 1) {
        dupes.push(`${file} → ${inSets.join(', ')}`);
      }
    }
    assert.deepEqual(dupes, [], `Panels in multiple chunk sets:\n${dupes.join('\n')}`);
  });

  it('chunk sets do not reference non-existent component files', () => {
    const fileSet = new Set(componentFiles);
    const ghosts = [...ALL_ASSIGNED].filter(f => !fileSet.has(f));
    assert.deepEqual(
      ghosts,
      [],
      `Chunk sets reference files that don't exist in src/components/: ${ghosts.join(', ')}`
    );
  });

  it('vite.config.ts has no silent Panel catch-all fallback', () => {
    assert.doesNotMatch(
      viteConfigSource,
      /if\s*\(fileName\.endsWith\('Panel'\).*\)\s*return\s*'core-panels'/,
      'The silent catch-all that routes unassigned panels to core-panels must not exist. ' +
      'Use the throw-on-unassigned pattern instead.'
    );
  });
});
