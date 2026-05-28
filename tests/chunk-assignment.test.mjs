import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');
const manualChunksMatch = viteConfigSource.match(
  /manualChunks\(id\)\s*\{([\s\S]*?)\n\s*\/\/ Give lazy-loaded locale chunks/,
);
assert.ok(
  manualChunksMatch,
  'Could not locate the manualChunks body in vite.config.ts; chunk guardrails would otherwise be vacuous.',
);
const manualChunksSource = manualChunksMatch[1];

describe('panel chunk assignment guardrails', () => {
  it('keeps panel component modules in one chunk until TDZ-prone singletons are removed', () => {
    assert.match(
      manualChunksSource,
      /id\.includes\('\/src\/components\/'\)\s*&&\s*id\.endsWith\('Panel\.ts'\)[\s\S]*?return\s+'panels'/,
      'Panel component modules must stay in the single panels chunk until top-level service clients are lazy-initialized.',
    );
  });

  it('does not re-enable variant panel chunks that create circular ESM evaluation', () => {
    assert.doesNotMatch(
      manualChunksSource,
      /return\s+'(?:core|full|finance|happy|tech)-panels'/,
      'Variant panel chunks can reintroduce core-panels -> full-panels -> core-panels cycles and startup TDZ crashes.',
    );
  });

  it('does not retain unused staged panel-cluster config', () => {
    assert.doesNotMatch(
      viteConfigSource,
      /\bPANEL_CLUSTER\b/,
      'Unused staged panel-cluster maps add maintenance surface and can be mistaken for active build routing.',
    );
  });

  it('does not wire domain panel chunks into manualChunks', () => {
    assert.doesNotMatch(
      manualChunksSource,
      /return\s+['"`]panels-[a-z-]+['"`]/,
      'Domain panel chunks can reintroduce startup TDZ crashes while panel modules still have top-level service clients.',
    );
  });
});
