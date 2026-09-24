import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COUNTRY_CORPUS_NAMES, COUNTRY_CORPUS_SLUGS } from '../api/_country-corpus-slugs.generated.js';
import { loadCountryCorpusIdentities } from '../scripts/build-crawlable-corpus.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// api/story.js canonicalises share stubs onto /countries/<slug>/ from this
// committed map (#8604). A corpus rename that skipped the generator would send
// every share of that country to a 404, so pin the map to the corpus universe.
const corpusCountries = loadCountryCorpusIdentities(ROOT);

test('the generated map has one entry per corpus country page', () => {
  assert.ok(corpusCountries.length >= 150, `corpus publishes only ${corpusCountries.length} country pages`);
  assert.deepEqual(
    Object.keys(COUNTRY_CORPUS_SLUGS).sort(),
    corpusCountries.map((country) => country.code).sort(),
    'api/_country-corpus-slugs.generated.js is stale — run: npm run corpus:country-slugs',
  );
  assert.deepEqual(Object.keys(COUNTRY_CORPUS_NAMES), Object.keys(COUNTRY_CORPUS_SLUGS));
});

test('every generated slug and name matches the corpus page it points at', () => {
  for (const { code, name, slug } of corpusCountries) {
    assert.equal(
      COUNTRY_CORPUS_SLUGS[code],
      slug,
      `${code} canonicalises to /countries/${COUNTRY_CORPUS_SLUGS[code]}/ but the corpus publishes /countries/${slug}/`
        + ' — run: npm run corpus:country-slugs',
    );
    assert.equal(COUNTRY_CORPUS_NAMES[code], name, `${code} display name is stale — run: npm run corpus:country-slugs`);
  }
});

test('the generator reports the committed map as fresh', () => {
  // Proves the map is regenerable, not just internally consistent: --check
  // exits non-zero (and throws here) whenever the committed bytes differ.
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/generate-country-corpus-slugs.mjs', '--check'],
    { cwd: ROOT, stdio: 'pipe' },
  );
});

test('the map keeps the hand-written country names it replaced', () => {
  // The 20 codes api/story.js carried inline before #8604. A snapshot that
  // dropped one of these would silently retitle its stub with a raw ISO2.
  const legacyNames = {
    UA: 'Ukraine', RU: 'Russia', CN: 'China', US: 'United States',
    IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
    SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
    FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
    SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
  };
  for (const [code, name] of Object.entries(legacyNames)) {
    assert.equal(COUNTRY_CORPUS_NAMES[code], name, `${code} lost its display name`);
    assert.ok(COUNTRY_CORPUS_SLUGS[code], `${code} lost its corpus page`);
  }
});

test('the map is frozen and URL-safe', () => {
  assert.ok(Object.isFrozen(COUNTRY_CORPUS_SLUGS));
  assert.ok(Object.isFrozen(COUNTRY_CORPUS_NAMES));
  const slugs = Object.values(COUNTRY_CORPUS_SLUGS);
  assert.equal(new Set(slugs).size, slugs.length, 'two countries claim the same corpus slug');
  for (const [code, slug] of Object.entries(COUNTRY_CORPUS_SLUGS)) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.match(slug, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, `${code}: ${slug} is not a safe path segment`);
    assert.equal(encodeURIComponent(slug), slug);
  }
});
