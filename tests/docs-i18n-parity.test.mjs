/**
 * Docs i18n parity: ensures every nav-included English MDX page has a
 * non-empty zh/ counterpart. Fails when English adds a page without a
 * zh translation — forces translators to notice drift.
 *
 * Reads docs.json navigation.languages, extracts the en page paths,
 * and asserts each has a corresponding zh/<path>.mdx that is non-empty
 * and contains Chinese characters (proving it was translated, not just
 * copied as a stub).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).pathname;
const DOCS_JSON = join(ROOT, 'docs', 'docs.json');
const DOCS_DIR = join(ROOT, 'docs');

function collectPagePaths(node, pages = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectPagePaths(item, pages);
    return pages;
  }
  if (node && typeof node === 'object') {
    if (typeof node.pages === 'string') pages.push(node.pages);
    if (Array.isArray(node.pages)) {
      for (const p of node.pages) {
        if (typeof p === 'string') pages.push(p);
        else if (p && typeof p === 'object') collectPagePaths(p, pages);
      }
    }
    for (const [key, v] of Object.entries(node)) {
      if (key === 'pages') continue; // already traversed above
      if (v && typeof v === 'object') collectPagePaths(v, pages);
    }
  }
  return pages;
}

const docs = JSON.parse(readFileSync(DOCS_JSON, 'utf8'));
const languages = docs.navigation?.languages ?? [];

const enLang = languages.find(l => l.language === 'en');
const zhLang = languages.find(l => l.language === 'zh-Hans');

if (!enLang) throw new Error('No "en" language in docs.json navigation.languages');
if (!zhLang) throw new Error('No "zh-Hans" language in docs.json navigation.languages');

// Collect English page paths (root-level, no prefix)
const enPagesRaw = collectPagePaths(enLang);
// Filter out OpenAPI spec references and external URLs
const enPages = [...new Set(enPagesRaw)].filter(p =>
  typeof p === 'string' &&
  !p.startsWith('http') &&
  !p.startsWith('api/') &&
  !p.endsWith('.yaml') &&
  !p.endsWith('.json')
);

describe('docs i18n parity', () => {
  it('zh-Hans language is registered in navigation.languages', () => {
    assert.ok(zhLang, 'zh-Hans must be registered in navigation.languages');
  });

  it('en is the default (first) language', () => {
    assert.equal(languages[0].language, 'en', 'en must be first language (default)');
  });

  for (const page of enPages) {
    it(`zh/ counterpart exists for ${page}`, () => {
      const zhPath = join(DOCS_DIR, 'zh', page + '.mdx');
      assert.ok(existsSync(zhPath), `Missing zh/${page}.mdx`);
      const stat = statSync(zhPath);
      assert.ok(stat.size > 100, `zh/${page}.mdx is suspiciously small (${stat.size} bytes)`);
    });

    it(`zh/ counterpart is translated (has Chinese) for ${page}`, () => {
      const zhPath = join(DOCS_DIR, 'zh', page + '.mdx');
      if (!existsSync(zhPath)) return; // covered by existence test above
      const content = readFileSync(zhPath, 'utf8');
      const hasCJK = /[\u4e00-\u9fff]/.test(content);
      assert.ok(hasCJK, `zh/${page}.mdx has no Chinese characters — not translated`);
    });
  }

  it('every zh-Hans nav page path starts with zh/', () => {
    const zhPages = collectPagePaths(zhLang);
    const leaks = zhPages.filter(p =>
      typeof p === 'string' &&
      !p.startsWith('zh/') &&
      !p.startsWith('http') &&
      !p.startsWith('api/') &&
      !p.endsWith('.yaml') &&
      !p.endsWith('.json')
    );
    assert.equal(leaks.length, 0, `zh-Hans nav has non-zh/-prefixed page paths: ${leaks.join(', ')}`);
  });
});
