import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('vite optimizeDeps prebundles lz-string when discovery is disabled', () => {
  const viteConfig = readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');

  assert.match(viteConfig, /noDiscovery:\s*true/);
  assert.match(viteConfig, /include:\s*\[[\s\S]*'lz-string'/);
});
