import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tauriMainSrc = readFileSync(
  path.join(repoRoot, 'src-tauri/src/main.rs'),
  'utf8',
);

it('uses the getrandom 0.4 fill API for desktop local token generation', () => {
  assert.match(
    tauriMainSrc,
    /getrandom::fill\(&mut buf\)/,
    'desktop token generation should use getrandom::fill with the current crate API',
  );
  assert.doesNotMatch(
    tauriMainSrc,
    /getrandom::getrandom\(&mut buf\)/,
    'desktop token generation should not call the removed getrandom::getrandom API',
  );
});
