import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(repoRoot, 'src', 'app', 'vault-intro.ts'), 'utf8');

test('vault intro scanner does not stack hover listeners across retries', () => {
  assert.match(
    src,
    /scannerBtn\.onmouseenter\s*=/,
    'scanner hover behavior should be assigned through a single replaceable handler',
  );
  assert.match(
    src,
    /scannerBtn\.onmouseleave\s*=/,
    'scanner hover leave behavior should be assigned through a single replaceable handler',
  );
  assert.doesNotMatch(
    src,
    /scannerBtn\.addEventListener\('mouseenter'/,
    'scanner hover should not add a new mouseenter listener every time idle state is re-entered',
  );
  assert.doesNotMatch(
    src,
    /scannerBtn\.addEventListener\('mouseleave'/,
    'scanner hover should not add a new mouseleave listener every time idle state is re-entered',
  );
});
