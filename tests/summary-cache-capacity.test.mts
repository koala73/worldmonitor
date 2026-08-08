import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'src', 'services', 'summarization.ts'), 'utf-8');

describe('summary circuit breaker configuration', () => {
  it('maxCacheEntries is at least 128', () => {
    const m = src.match(/maxCacheEntries:\s*(\d+)/);
    assert.ok(m, 'maxCacheEntries not found in summarization.ts');
    assert.ok(Number(m![1]) >= 128, `maxCacheEntries is ${m![1]}, expected >= 128`);
  });

  it('persistCache is enabled on summaryResultBreaker', () => {
    assert.match(src, /summaryResultBreaker[\s\S]*?persistCache:\s*true/, 'persistCache should be true on summaryResultBreaker');
  });

  it('cacheTtlMs is 2 hours on summaryResultBreaker', () => {
    const block = src.match(/summaryResultBreaker[\s\S]*?cacheTtlMs:\s*([\d\s*]+)/);
    assert.ok(block, 'cacheTtlMs not found in summaryResultBreaker block');
    assert.match(block![1].trim(), /^2\s*\*\s*60\s*\*\s*60\s*\*\s*1000$/, `cacheTtlMs should be 2 * 60 * 60 * 1000, got "${block![1].trim()}"`);
  });
});
