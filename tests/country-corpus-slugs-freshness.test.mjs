import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COUNTRY_CORPUS_NAMES, COUNTRY_CORPUS_SLUGS } from '../api/_country-corpus-slugs.generated.js';
import { loadCountryCorpusIdentities } from '../scripts/build-crawlable-corpus.mjs';
import { MIN_CORPUS_COUNTRIES } from '../scripts/generate-country-corpus-slugs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// api/story.js canonicalises share stubs onto /countries/<slug>/ from this
// committed map (#8604). A corpus rename that skipped the generator would send
// every share of that country to a 404, so pin the map to the corpus universe.
const corpusCountries = loadCountryCorpusIdentities(ROOT);

// Both assertions above rest on loadCountryCorpusIdentities() agreeing with what
// buildCorpus writes. This pins the map to a published artifact instead, so a
// later publish filter inside loadCorpusData cannot keep the gate green while
// the map still names pages nobody serves.
function sitemapCountrySlugs() {
  const sitemap = readFileSync(join(ROOT, 'public/sitemap-main.xml'), 'utf8');
  return [...sitemap.matchAll(/<loc>https:\/\/www\.worldmonitor\.app\/countries\/([^<]*)<\/loc>/g)]
    .map((match) => match[1].replace(/\/$/, ''))
    // The /countries/ hub is an index, not a country page.
    .filter(Boolean);
}

test('the generated map has one entry per corpus country page', () => {
  assert.ok(
    corpusCountries.length >= MIN_CORPUS_COUNTRIES,
    `corpus publishes only ${corpusCountries.length} country pages (floor ${MIN_CORPUS_COUNTRIES})`,
  );
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

test('every mapped slug is a country page the published sitemap lists', () => {
  const published = sitemapCountrySlugs();

  assert.ok(published.length >= 190, `sitemap-main.xml lists only ${published.length} country pages`);
  assert.deepEqual(
    [...published].sort(),
    Object.values(COUNTRY_CORPUS_SLUGS).sort(),
    'api/_country-corpus-slugs.generated.js and public/sitemap-main.xml disagree on the country page set'
      + ' — a canonical here would 404. Run: npm run build:crawlable-corpus && npm run build:sitemap',
  );
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

test('every workflow that rebuilds the corpus stages and verifies the map', () => {
  // build:crawlable-corpus regenerates the map, and both refresh crons stage an
  // explicit file list with no `git commit -a`. Omitting the map there publishes
  // a renamed country's page while api/story.js keeps canonicalising the old
  // slug — a hard 404, worse than the /dashboard canonical it replaced (#8604).
  for (const name of ['resilience-snapshot-refresh.yml', 'crawlable-pulse-refresh.yml']) {
    const workflow = readFileSync(join(ROOT, '.github/workflows', name), 'utf8');

    assert.match(workflow, /npm run build:crawlable-corpus/, `${name} no longer rebuilds the corpus`);
    assert.match(
      workflow,
      /git add [^\n]*\bapi\/_country-corpus-slugs\.generated\.js\b/,
      `${name} rebuilds the slug map and then discards it`,
    );
    assert.match(
      workflow,
      /tests\/country-corpus-slugs-freshness\.test\.mjs/,
      `${name} stages the slug map without running the gate that proves it fresh`,
    );
  }
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
