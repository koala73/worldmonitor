import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

describe('regulatory cache contracts', () => {
  it('exports REGULATORY_ACTIONS_KEY from cache-keys.ts', () => {
    const cacheKeysSrc = readFileSync(join(root, 'server', '_shared', 'cache-keys.ts'), 'utf8');
    assert.match(
      cacheKeysSrc,
      /export const REGULATORY_ACTIONS_KEY = 'regulatory:actions:v1';/
    );
  });
});
