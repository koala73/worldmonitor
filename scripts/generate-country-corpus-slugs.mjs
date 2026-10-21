#!/usr/bin/env node
/**
 * Generate the ISO2 → crawlable-corpus country page map for legacy `api/*.js`.
 *
 * Source chain (the newest snapshot wins, same as the corpus build):
 *   docs/snapshots/resilience-ranking-*.json (the corpus country universe)
 *   shared/country-names.json                (display-name fallbacks)
 *   scripts/build-crawlable-corpus.mjs       (slugify/uniqueSlug, shared)
 *
 * The snapshot is refreshed monthly by
 * .github/workflows/resilience-snapshot-refresh.yml, which stages this script's
 * output alongside it. A rename there moves the published page, so an unstaged
 * map would leave api/story.js canonicalising at a slug that 404s.
 *
 * `api/*.js` entries are self-contained JavaScript and may import only
 * same-directory `_*.js` helpers, never `scripts/` or `src/` (AGENTS.md
 * "Critical boundaries"). Committing the map is what lets api/story.js
 * canonicalise a share stub onto `/countries/<slug>/` without that import.
 *
 * Usage:
 *   npm run corpus:country-slugs
 *   npm run corpus:country-slugs:check
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCountryCorpusIdentities } from './build-crawlable-corpus.mjs';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = 'api/_country-corpus-slugs.generated.js';
const CHECK = process.argv.includes('--check');

export function renderCountryCorpusModule(countries) {
  const sorted = [...countries].sort((a, b) => a.code.localeCompare(b.code));
  const seenSlugs = new Set();
  for (const { code, name, slug } of sorted) {
    if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Corpus country code ${code} is not ISO 3166-1 alpha-2`);
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`${code}: corpus slug ${JSON.stringify(slug)} is not URL-safe`);
    if (seenSlugs.has(slug)) throw new Error(`${code}: corpus slug ${slug} is not unique`);
    if (!name) throw new Error(`${code}: corpus country has no display name`);
    seenSlugs.add(slug);
  }
  const entries = (pick) => sorted
    .map(({ code, ...rest }) => `  ${code}: ${JSON.stringify(pick(rest))},`)
    .join('\n');

  return `// AUTO-GENERATED from the crawlable corpus country universe.
// Do not edit manually. Run: npm run corpus:country-slugs
// @ts-check

/**
 * ISO 3166-1 alpha-2 → the country's crawlable corpus page slug. Every entry
 * has a published page at https://www.worldmonitor.app/countries/<slug>/.
 *
 * Null-prototype: the lookup key is caller-supplied (\`?c=\` on a public share
 * URL), so an inherited \`constructor\`/\`toString\` hit would build a canonical
 * out of a function body. Object.freeze alone does not sever the prototype.
 */
export const COUNTRY_CORPUS_SLUGS = Object.freeze({
  __proto__: null,
${entries(({ slug }) => slug)}
});

/** ISO 3166-1 alpha-2 → the display name that corpus page is titled with. */
export const COUNTRY_CORPUS_NAMES = Object.freeze({
  __proto__: null,
${entries(({ name }) => name)}
});
`;
}

function emit(path, content) {
  const absolute = join(ROOT, path);
  const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  if (current === content) {
    console.log(`  = ${path} is fresh`);
    return true;
  }
  if (CHECK) {
    console.error(`  ✗ ${path} is stale — run: npm run corpus:country-slugs`);
    return false;
  }
  writeFileSync(absolute, content);
  console.log(`  ✓ ${absolute}`);
  return true;
}

// The corpus publishes 196 country pages. A floor far below that would let a
// truncated snapshot regenerate clean and silently revert the missing countries'
// canonicals to /dashboard, which is the exact regression #8604 fixes.
export const MIN_CORPUS_COUNTRIES = 190;

export function generateCountryCorpusSlugs() {
  const countries = loadCountryCorpusIdentities(ROOT);
  if (countries.length < MIN_CORPUS_COUNTRIES) {
    throw new Error(
      `Corpus country universe collapsed to ${countries.length} entries `
      + `(floor ${MIN_CORPUS_COUNTRIES}); refusing to publish the map`,
    );
  }
  return emit(OUTPUT_PATH, renderCountryCorpusModule(countries));
}

if (isMainModule(import.meta.url, process.argv[1]) && !generateCountryCorpusSlugs()) process.exit(1);
