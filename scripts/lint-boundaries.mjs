#!/usr/bin/env node
/**
 * Architectural boundary lint.
 *
 * Enforces forward-only dependency direction:
 *   types → config → services → components → app → App.ts
 *
 * Violations are imports that go backwards in this chain.
 * Lines with "boundary-ignore" comments are excluded.
 *
 * Also checks:
 *   - api/ legacy .js: must not import from src/ or server/ (self-contained)
 *   - api/ RPC .ts: may import server/ and src/generated/, but not src/ app code
 *   - server/ must not import from src/components/ or src/app/
 *
 * Exit code 1 if violations found. Agent-readable output.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = 'src';
const ROOT = process.cwd();

// Layer order (lower index = lower layer, can only import from same or lower)
const LAYERS = ['types', 'config', 'services', 'components', 'app'];

function getLayer(filePath) {
  const rel = relative(join(ROOT, SRC), filePath);
  for (const layer of LAYERS) {
    if (rel.startsWith(layer + '/') || rel.startsWith(layer + '\\')) return layer;
  }
  return null;
}

function getLayerIndex(layer) {
  return LAYERS.indexOf(layer);
}

function walkDir(dir, ext = ['.ts', '.tsx', '.js', '.mjs']) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue;
      results.push(...walkDir(full, ext));
    } else if (ext.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

const violations = [];

// --- Check 1: src/ layer boundaries ---
const srcFiles = walkDir(join(ROOT, SRC));
for (const file of srcFiles) {
  const fileLayer = getLayer(file);
  if (!fileLayer) continue;
  const fileIdx = getLayerIndex(fileLayer);

  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('boundary-ignore')) continue;
    if (i > 0 && lines[i - 1].includes('boundary-ignore')) continue;

    // Check both `from '@/layer'` imports and `import('@/layer')` type expressions
    const patterns = [
      line.match(/from\s+['"]@\/(\w+)/),
      line.match(/import\(['"]@\/(\w+)/),
    ];

    for (const match of patterns) {
      if (!match) continue;
      const importLayer = match[1];
      const importIdx = getLayerIndex(importLayer);
      if (importIdx === -1) continue; // not a tracked layer

      if (importIdx > fileIdx) {
        const rel = relative(ROOT, file);
        violations.push({
          file: rel,
          line: i + 1,
          from: fileLayer,
          to: importLayer,
          text: line.trim(),
          remedy: `Move the imported type/function to a lower layer (${fileLayer} or below), or add a "boundary-ignore" comment if this is a pragmatic exception.`,
        });
        break; // one violation per line is enough
      }
    }
  }
}

// --- Check 2: server/ must not import from src/components/ or src/app/ ---
const serverFiles = walkDir(join(ROOT, 'server'));
for (const file of serverFiles) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('boundary-ignore')) continue;
    if (i > 0 && lines[i - 1].includes('boundary-ignore')) continue;

    if (line.match(/from\s+['"].*\/(components|app)\//)) {
      violations.push({
        file: relative(ROOT, file),
        line: i + 1,
        from: 'server',
        to: 'src/' + line.match(/(components|app)/)[1],
        text: line.trim(),
        remedy: 'Server code must not import browser UI code. Extract shared logic into server/_shared/ or src/types/.',
      });
    }
  }
}

// --- Check 3: api/ boundary rules ---
// Legacy api/*.js: fully self-contained (no ../server/ or ../src/ imports)
// Sebuf RPC api/**/*.ts: may import server/ and src/generated/ (bundled at deploy),
//   but must NOT import src/ non-generated paths (components, services, config, etc.)
const apiFiles = walkDir(join(ROOT, 'api'), ['.js', '.mjs', '.ts']);
for (const file of apiFiles) {
  const basename = file.split('/').pop();
  if (basename.startsWith('_') || basename.includes('.test.')) continue;

  const isTs = file.endsWith('.ts');
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('boundary-ignore')) continue;
    if (i > 0 && lines[i - 1].includes('boundary-ignore')) continue;

    if (isTs) {
      // RPC .ts files: allow server/ and src/generated/, block src/ non-generated
      if (line.match(/from\s+['"]\.\..*\/src\//) && !line.match(/\/src\/generated\//)) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          from: 'api (RPC)',
          to: 'src (non-generated)',
          text: line.trim(),
          remedy: 'RPC Edge Functions may import from server/ and src/generated/, but not from src/ application code (components, services, config).',
        });
      }
    } else {
      // Legacy .js files: fully self-contained
      if (line.match(/from\s+['"]\.\.\/(?:src|server)\//)) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          from: 'api (legacy)',
          to: line.match(/\.\.\/(\w+)/)[1],
          text: line.trim(),
          remedy: 'Legacy Edge Functions must be self-contained. Only same-directory _*.js helpers and npm packages are allowed.',
        });
      }
    }
  }
}

// --- Output ---
if (violations.length === 0) {
  console.log('✓ No architectural boundary violations found.');
  process.exit(0);
} else {
  console.error(`✖ Found ${violations.length} architectural boundary violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.from} → ${v.to} (backward import)`);
    console.error(`    ${v.text}`);
    console.error(`    Remedy: ${v.remedy}`);
    console.error('');
  }
  process.exit(1);
}
