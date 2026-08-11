import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('blog build uses the Windows-safe, path-guarded copy script', () => {
  const packageJson = JSON.parse(read('package.json'));
  const script = read('scripts/copy-blog-dist.mjs');

  assert.equal(packageJson.scripts['build:blog'], 'npm run build --prefix blog-site && node scripts/copy-blog-dist.mjs');
  assert.doesNotMatch(packageJson.scripts['build:blog'], /rm -rf|mkdir -p|cp -r/);
  assert.match(script, /isWithin\(publicDir, outputDir\)/);
  assert.match(script, /await rm\(outputDir, \{ recursive: true, force: true \}\)/);
});
