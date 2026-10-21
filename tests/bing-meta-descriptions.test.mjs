import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { GLOSSARY_TERMS } from '../blog-site/src/data/glossary.ts';
import { COMPARISON_PAGES } from '../scripts/build-comparison-pages.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const urls = JSON.parse(read('tests/fixtures/seo/bing-short-descriptions-2026-09-12.json'));
const specs = readdirSync(new URL('../docs/api/', import.meta.url))
  .filter((name) => name.endsWith('.openapi.json'));

function descriptionFor(url) {
  const { pathname } = new URL(url);
  if (pathname.startsWith('/docs/api-reference/')) {
    const [service, operationId] = pathname.slice('/docs/api-reference/'.length).split('/');
    const file = specs.find((name) => name.toLowerCase() === `${service}.openapi.json`);
    assert.ok(file, `Missing service for ${url}`);
    const spec = JSON.parse(read(`docs/api/${file}`));
    const operation = Object.values(spec.paths).flatMap(Object.values)
      .find((value) => value.operationId?.toLowerCase() === operationId);
    assert.ok(operation, `Missing operation for ${url}`);
    return operation.description;
  }
  if (pathname.startsWith('/docs/')) {
    const frontmatter = read(`${pathname.slice(1)}.mdx`).split('---')[1];
    return parse(frontmatter).description;
  }
  if (pathname === '/pro') return JSON.parse(read('pro-test/src/locales/zh.json')).meta.description;
  if (pathname === '/dashboard') return JSON.parse(read('src/locales/zh.json')).shell.metaDescription;
  if (pathname.startsWith('/blog/glossary/')) {
    return GLOSSARY_TERMS.find((term) => pathname === `/blog/glossary/${term.slug}/`)?.metaDescription;
  }
  return COMPARISON_PAGES.find((page) => page.path === pathname)?.metaDescription;
}

test('all 50 supplied Bing URLs have unique, complete 150–160 character descriptions', () => {
  assert.equal(urls.length, 50, 'The supplied export contains 50 URLs, not the reported 132');
  assert.equal(new Set(urls).size, urls.length);
  const descriptions = new Set();
  for (const url of urls) {
    const description = descriptionFor(url);
    assert.equal(typeof description, 'string', `Missing description: ${url}`);
    const length = [...description].length;
    assert.ok(length >= 150 && length <= 160, `${url}: ${length} characters`);
    assert.match(description, /[.。]$/, `Incomplete sentence: ${url}`);
    assert.ok(!descriptions.has(description), `Duplicate description: ${url}`);
    descriptions.add(description);
  }
});
