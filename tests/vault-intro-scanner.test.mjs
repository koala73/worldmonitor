import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(repoRoot, 'src', 'app', 'vault-intro.ts'), 'utf8');

test('vault intro scanner wiring is single-registration and retry-safe', () => {
  const clickListenerMatches = src.match(/scanBtn\.addEventListener\('click'/g) ?? [];
  assert.equal(
    clickListenerMatches.length,
    1,
    'scanner should register one click listener when the flow starts',
  );
  assert.match(
    src,
    /setTimeout\(\(\) => void tryAuth\(false\), 900\);/,
    'scanner should attempt one automatic authentication pass without rebinding listeners',
  );
  assert.match(
    src,
    /setTimeout\(\(\) => \{ if \(!settled\) setIdle\(refs\.state\); \}, 1500\);/,
    'retry path should reset scanner state without registering new DOM handlers',
  );
});
