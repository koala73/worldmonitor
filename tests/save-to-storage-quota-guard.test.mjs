import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');

function readSrc(path) {
  return readFileSync(resolve(root, path), 'utf-8');
}

describe('saveToStorage quota handling', () => {
  it('continues attempting preference writes after cache storage quota is marked exceeded', () => {
    const src = readSrc('src/utils/index.ts');
    const start = src.indexOf('export function saveToStorage');
    assert.notEqual(start, -1, 'saveToStorage helper must exist');

    const nextExport = src.indexOf('\nexport function ', start + 1);
    const body = src.slice(start, nextExport === -1 ? undefined : nextExport);

    assert.ok(
      body.includes('localStorage.setItem(key, JSON.stringify(value))'),
      'saveToStorage must still attempt the localStorage write',
    );
    assert.equal(
      /if\s*\(\s*isStorageQuotaExceeded\(\)\s*\)\s*return;?/.test(body),
      false,
      'cache quota backoff must not silently disable user preference writes such as worldmonitor-panels',
    );
  });

  it('keeps persistent cache writes behind the quota backoff', () => {
    const src = readSrc('src/services/persistent-cache.ts');

    assert.match(
      src,
      /if\s*\(\s*isIndexedDbAvailable\(\)\s*&&\s*!isStorageQuotaExceeded\(\)\s*\)/,
      'IndexedDB cache writes should still stop after quota exhaustion',
    );
    assert.match(
      src,
      /if\s*\(\s*isStorageQuotaExceeded\(\)\s*\)\s*return;/,
      'localStorage cache fallback writes should still stop after quota exhaustion',
    );
  });
});
