import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerIdentityDigest, PROVIDER_IDENTITY_REVIEW } from '../../scripts/source-attribution.mjs';
import { buildCentroids } from '../../scripts/build-country-centroids.mjs';
import { buildToolEntries } from '../../scripts/build-coverage-catalog.mjs';
import { buildJudgedSubjectTerms } from '../../scripts/build-judged-subject-terms.mjs';
import { dedupeSharedSchemaSubtrees } from '../../scripts/openapi-dedup-schemas.mjs';
import { loadCountryCorpusIdentities } from '../../scripts/build-crawlable-corpus.mjs';
import { MIN_CORPUS_COUNTRIES, renderCountryCorpusModule } from '../../scripts/generate-country-corpus-slugs.mjs';
import { portableLocale } from './generator-locale-env.mjs';

const directory = process.argv[2];
const run = (script, args = []) => execFileSync(process.execPath, [...process.execArgv, join(directory, 'scripts', script), ...args], {
  cwd: directory,
  stdio: 'pipe',
  timeout: 15_000,
});
run('generate-country-bboxes.cjs');
run('generate-iso3-maps.cjs');
run('build-country-names.cjs');
cpSync(new URL('../../scripts/data/outbreak-places.json', import.meta.url), join(directory, 'scripts/data/outbreak-places.json'));
run('build-news-places.mjs', [join(directory, 'words'), join(directory, 'propernames')]);
run('build-outbreak-places.mjs', [join(directory, 'cities'), join(directory, 'admin1')]);

const artifacts = {};
for (const path of [
  'shared/country-bboxes.json', 'scripts/shared/country-bboxes.json',
  'shared/country-bboxes.js', 'shared/country-bboxes.d.ts',
  'shared/iso3-to-iso2.json', 'shared/iso2-to-iso3.json',
  'shared/iso2-to-iso3.js', 'shared/iso2-to-iso3.d.ts',
  'shared/country-names.json', 'scripts/shared/news-places.json',
  'scripts/data/outbreak-places.json',
]) artifacts[path] = readFileSync(join(directory, path), 'utf8');

const codes = ['CH', 'CI', 'HU', 'GG', 'GH', 'GY', 'AZ', 'LT', 'LV', 'EE'];
const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
artifacts.centroids = JSON.stringify(buildCentroids({
  features: codes.map(code => ({ properties: { 'ISO3166-1-Alpha-2': code }, geometry })),
}, { features: [] }));
const names = ['Chainwire', 'Haiti', 'Aarhus', 'Aachen', 'Ängelholm', 'Zürich', 'New Zealand', 'Newark', 'Istanbul', 'İzmir'];
artifacts.coverage = JSON.stringify(buildToolEntries({
  tools: names.map(title => ({ name: title, title, description: 'A generated tool description.' })),
  toolAccess: () => 'public',
}));
artifacts.subjectTerms = JSON.stringify(buildJudgedSubjectTerms());
const schema = { type: 'string', description: 'A sufficiently long repeated schema whose reference target must not depend on the host locale. '.repeat(3) };
const spec = { components: { schemas: { Chain: structuredClone(schema), Haiti: structuredClone(schema) } } };
assert.ok(dedupeSharedSchemaSubtrees(spec).replacedRefs > 0);
artifacts.openapi = JSON.stringify(spec);

// The same comparison `generate-country-corpus-slugs.mjs --check` makes, run in
// this process (already under the requested locale) instead of a child that
// reloads the whole crawlable-corpus module graph for every locale.
const root = new URL('../../', import.meta.url);
const countries = loadCountryCorpusIdentities(fileURLToPath(root));
assert.ok(countries.length >= MIN_CORPUS_COUNTRIES, `corpus country universe collapsed to ${countries.length}`);
assert.equal(
  renderCountryCorpusModule(countries),
  readFileSync(new URL('api/_country-corpus-slugs.generated.js', root), 'utf8'),
  'api/_country-corpus-slugs.generated.js is stale under this locale',
);
console.log(JSON.stringify({
  hostLocale: new Intl.Collator().resolvedOptions().locale,
  portableLocale,
  samples: names,
  defaultOrder: [...names].sort((a, b) => a.localeCompare(b)),
  digest: providerIdentityDigest(),
  reviewedDigest: PROVIDER_IDENTITY_REVIEW.sha256,
  corpusCurrent: true,
  artifacts,
}));
