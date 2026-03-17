import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const viteConfig = readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');
const unifiedSettings = readFileSync(path.join(repoRoot, 'src', 'components', 'UnifiedSettings.ts'), 'utf8');

test('desktop builds embed and display build identity metadata', () => {
  assert.match(
    viteConfig,
    /__BUILD_VARIANT__[\s\S]*__BUILD_TAG__[\s\S]*__BUILD_COMMIT_SHA__[\s\S]*__BUILD_TIMESTAMP__/,
    'vite should inject build identity constants at build time',
  );
  assert.match(
    unifiedSettings,
    /Build Identity[\s\S]*__BUILD_TAG__[\s\S]*__BUILD_COMMIT_SHA__/,
    'the settings UI should surface build identity values to operators',
  );
});
