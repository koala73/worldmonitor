/**
 * Regression test: loadNews must not block news rendering on digest fetch.
 *
 * The bug: loadNews() awaited digestPromise BEFORE starting the category loop.
 * If digest was slow (8s timeout), ALL news panels stayed blank for up to 8s —
 * even though most categories don't depend on digest data.
 *
 * Fix: start categories and digest in parallel; apply digest to already-rendered
 * categories when it arrives.
 *
 * Run: node --test tests/loadnews-digest-parallel.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve to worldmonitor/src/app/data-loader.ts (one level up from tests/)
const srcPath = resolve(__dirname, '..', 'src', 'app', 'data-loader.ts');
const src = readFileSync(srcPath, 'utf-8');

describe('loadNews digest-parallel fix', () => {
  /**
   * Extract the loadNews method body from data-loader.ts.
   * We look for the function signature and grab everything up to the closing brace
   * at the same indentation level.
   */
  const loadNewsStart = src.indexOf('async loadNews(): Promise<void> {');
  const afterSignature = src.slice(loadNewsStart + 'async loadNews(): Promise<void> {'.length);

  // Track nesting to find the matching closing brace
  let braceCount = 1;
  let endPos = 0;
  for (let i = 0; i < afterSignature.length; i++) {
    if (afterSignature[i] === '{') braceCount++;
    else if (afterSignature[i] === '}') {
      braceCount--;
      if (braceCount === 0) { endPos = i; break; }
    }
  }
  const loadNewsBody = afterSignature.slice(0, endPos);

  it('loadNews does not await digestPromise before the category loop', () => {
    const awaitDigestPos = loadNewsBody.indexOf('await digestPromise');
    const loadNewsCategoryPattern = /loadNewsCategory/;
    const loadNewsCategoryPos = loadNewsCategoryPattern.test(loadNewsBody)
      ? loadNewsBody.search(loadNewsCategoryPattern)
      : -1;

    if (awaitDigestPos === -1) {
      assert.ok(
        loadNewsCategoryPos !== -1,
        'loadNewsCategory calls must exist',
      );
      return;
    }

    // BUG DETECTION: "await digestPromise" appears BEFORE loadNewsCategory starts
    assert.ok(
      loadNewsCategoryPos !== -1 && awaitDigestPos > loadNewsCategoryPos,
      '"await digestPromise" must NOT appear before the category loop starts. ' +
        'Bug: digest was awaited before categories, blocking news render for up to 8s.',
    );
  });

  it('categories are loaded via Promise.allSettled (parallel, not sequential await)', () => {
    const hasPromiseAllSettled = /Promise\.allSettled/.test(loadNewsBody);
    assert.ok(hasPromiseAllSettled, 'Category results must be collected via Promise.allSettled');
  });

  it('digest application is deferred — happens after categories are already running', () => {
    const categoriesStart = loadNewsBody.indexOf('categories');
    const awaitDigest = loadNewsBody.indexOf('await digestPromise');

    assert.ok(
      categoriesStart !== -1 && (awaitDigest === -1 || categoriesStart < awaitDigest),
      'Categories definition must appear before or without "await digestPromise"',
    );
  });
});