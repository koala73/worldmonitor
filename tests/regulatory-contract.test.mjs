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

  it('registers regulatoryActions in health standalone keys', () => {
    const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf8');
    assert.match(
      healthSrc,
      /regulatoryActions:\s+'regulatory:actions:v1'/
    );
  });

  it('registers regulatoryActions seed freshness metadata in health', () => {
    const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf8');
    assert.match(
      healthSrc,
      /regulatoryActions:\s+\{\s+key:\s+'seed-meta:regulatory:actions',\s+maxStaleMin:\s+240\s+\}/
    );
  });
});
