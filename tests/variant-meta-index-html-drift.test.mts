// Drift guard for #5005: htmlVariantPlugin (vite.config.ts) unconditionally
// replaces index.html's meta tags with VARIANT_META.full at build time, so any
// hand-tuned copy in index.html that isn't mirrored in variant-meta.ts silently
// never ships (the WIRED/2M+ description drifted this way for months).
// This test extracts each replaced tag from index.html using the same anchors
// the plugin uses and asserts it equals VARIANT_META.full — the full-variant
// build must be a no-op. Editing either side alone fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VARIANT_META } from '../src/config/variant-meta';

const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const full = VARIANT_META.full;

function extract(label: string, pattern: RegExp): string {
  const m = indexHtml.match(pattern);
  assert.ok(m, `index.html anchor not found for ${label} (pattern: ${pattern}) — if the markup changed, htmlVariantPlugin's matching replace in vite.config.ts is now dead too`);
  return m[1];
}

// Each case mirrors one .replace() in htmlVariantPlugin (vite.config.ts ~211-225).
const cases: Array<{ label: string; pattern: RegExp; expected: string }> = [
  { label: '<title>', pattern: /<title>(.*?)<\/title>/, expected: full.title },
  { label: 'meta name="title"', pattern: /<meta name="title" content="(.*?)" \/>/, expected: full.title },
  { label: 'meta name="description"', pattern: /<meta name="description" content="(.*?)" \/>/, expected: full.description },
  { label: 'meta name="keywords"', pattern: /<meta name="keywords" content="(.*?)" \/>/, expected: full.keywords },
  { label: 'link rel="canonical"', pattern: /<link rel="canonical" href="(.*?)" \/>/, expected: full.url },
  { label: 'meta name="application-name"', pattern: /<meta name="application-name" content="(.*?)" \/>/, expected: full.siteName },
  { label: 'og:url', pattern: /<meta property="og:url" content="(.*?)" \/>/, expected: full.url },
  { label: 'og:title', pattern: /<meta property="og:title" content="(.*?)" \/>/, expected: full.title },
  { label: 'og:description', pattern: /<meta property="og:description" content="(.*?)" \/>/, expected: full.description },
  { label: 'og:site_name', pattern: /<meta property="og:site_name" content="(.*?)" \/>/, expected: full.siteName },
  { label: 'meta name="subject"', pattern: /<meta name="subject" content="(.*?)" \/>/, expected: full.subject },
  { label: 'meta name="classification"', pattern: /<meta name="classification" content="(.*?)" \/>/, expected: full.classification },
  { label: 'twitter:url', pattern: /<meta name="twitter:url" content="(.*?)" \/>/, expected: full.url },
  { label: 'twitter:title', pattern: /<meta name="twitter:title" content="(.*?)" \/>/, expected: full.title },
  { label: 'twitter:description', pattern: /<meta name="twitter:description" content="(.*?)" \/>/, expected: full.description },
];

for (const { label, pattern, expected } of cases) {
  test(`index.html ${label} matches VARIANT_META.full (build replacement is a no-op)`, () => {
    assert.equal(extract(label, pattern), expected);
  });
}
