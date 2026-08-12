import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildManifest,
  loadManifest,
  matchGeneratedAttributionSection,
  renderAttributionSection,
  scanUpstreamHosts,
  sourceAttributionStats,
  validateManifest,
} from '../scripts/source-attribution.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('source inventory has complete metadata and matches the generated catalog', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  assert.deepEqual(validateManifest(inventory, manifest), []);

  const docs = readFileSync(join(rootDir, 'docs/source-attribution.mdx'), 'utf8');
  const generated = renderAttributionSection(inventory, manifest);
  const actual = matchGeneratedAttributionSection(docs);
  assert.equal(actual, generated, 'docs/source-attribution.mdx must contain exactly the generated attribution section');

  // Mintlify parses these pages as MDX v3, which rejects `<!--` with
  // "Unexpected character `!` (U+0021) before name" and fails the whole
  // deployment. Nothing repo-side catches that, so pin it here.
  const dataSourcesDocs = readFileSync(join(rootDir, 'docs/data-sources.mdx'), 'utf8');
  for (const [path, text] of [
    ['docs/source-attribution.mdx', docs],
    ['docs/data-sources.mdx', dataSourcesDocs],
  ]) {
    assert.equal(
      text.includes('<!--'),
      false,
      `${path} must not contain HTML comments — MDX v3 rejects them; use {/* ... */}`,
    );
  }

  const stats = sourceAttributionStats(inventory, manifest);
  assert.equal(stats.activeHosts, 531);
  assert.equal(stats.providerCount, 529);
  assert.equal(stats.observedHosts, 650);
  assert.ok(stats.reviewNeeded > 0, 'terms-review rows must remain visible until a license audit is complete');
});

test('the issue audit providers are represented by named attribution rows', () => {
  const manifest = loadManifest(rootDir);
  const names = new Set([...manifest.entries, ...manifest.logicalEntries].map((entry) => entry.provider));
  for (const provider of [
    'Kalshi',
    'Hyperliquid',
    'CFTC Commitments of Traders',
    'FINRA',
    'SEC EDGAR',
    'USPTO Open Data Portal',
    'OpenAQ',
    'World Air Quality Index (WAQI)',
    'Safecast',
    'EPA RadNet',
    'ENTSO-E Transparency Platform',
    'Ember electricity data',
    'Our World in Data',
    'Global Energy Monitor',
    'SWF Institute',
    'International Forum of Sovereign Wealth Funds',
    'AusTender',
    'UNDP Human Development Report',
    'Reporters Without Borders (RSF)',
    'Vision of Humanity / Global Peace Index',
    'Financial Action Task Force (FATF)',
    'OpenSanctions',
    'Element84 Earth Search STAC',
    'TeleGeography Submarine Cable Map',
    'Firecrawl',
    'Brave Search API',
    'SerpAPI',
    'CoinPaprika',
    'Barchart',
    'ReliefWeb (UN OCHA)',
    'NSIDC',
    'Fintraffic Digitraffic',
  ]) {
    assert.ok(names.has(provider), `missing named provider row: ${provider}`);
  }
});

test('uppercase URL constants are included in the upstream inventory', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const travelpayouts = inventory.find((entry) => entry.host === 'api.travelpayouts.com');
  assert.ok(travelpayouts, 'BASE_V2/BASE_V3 URL constants must be attributed');
  assert.ok(travelpayouts.references.some((reference) => reference.path.endsWith('travelpayouts_data.ts')));
});

test('live HLS playback origins are observed with an explicit presentation exclusion', () => {
  const inventory = scanUpstreamHosts(rootDir);
  assert.ok(inventory.some((entry) => entry.host === 'pe-fa-lp02a.9c9media.com'));
  const manifest = loadManifest(rootDir);
  const entry = manifest.entries.find((candidate) => candidate.host === 'pe-fa-lp02a.9c9media.com');
  assert.equal(entry?.status, 'excluded');
  assert.match(entry?.attribution ?? '', /presentation-only HLS stream/);
});

test('new observed hosts fail closed until they have attribution metadata', () => {
  const errors = validateManifest(
    [{ host: 'new-provider.example', kinds: ['structured'], references: [{ path: 'server/new-provider.ts', line: 1 }] }],
    { entries: [], logicalEntries: [] },
  );
  assert.ok(errors.some((error) => error.includes('missing manifest entry for new-provider.example')));
});

test('current observed hosts cannot be hidden behind an excluded manifest row', () => {
  const errors = validateManifest(
    [{ host: 'current-provider.example', kinds: ['structured'], references: [{ path: 'server/current-provider.ts', line: 1 }] }],
    {
      entries: [{
        host: 'current-provider.example',
        provider: 'Current Provider',
        license: 'Terms review',
        attribution: 'Credit Current Provider.',
        observed: false,
        status: 'excluded',
      }],
      logicalEntries: [],
    },
  );
  assert.ok(errors.some((error) => error.includes('must mark current host current-provider.example observed')));
});

test('malformed manifest rows fail closed before public counts are derived', () => {
  const manifest = {
    entries: [{
      host: 'ghost.example',
      provider: 'Ghost',
      license: 'L',
      attribution: 'A',
      observed: 0,
      kind: 'garbage',
      status: 'bogus',
    }],
    logicalEntries: [],
  };
  const errors = validateManifest([], manifest);
  assert.ok(errors.some((error) => error.includes('observed must be boolean')));
  assert.ok(errors.some((error) => error.includes('invalid manifest kind')));
  assert.ok(errors.some((error) => error.includes('invalid manifest status')));
  assert.throws(() => sourceAttributionStats([], manifest), /invalid manifest/);
});

// The gate this file guards used to compare the committed docs against a render
// of the committed manifest, so it agreed with itself while the manifest itself
// drifted away from the source tree. These four tests pin the properties that
// make --check honest: no drift-prone line numbers, a manifest that is a
// fixpoint of its own generator, and a validator that can see reference and
// kind drift on a row it already knows about.
test('manifest and scanner references record a path only', () => {
  const manifest = loadManifest(rootDir);
  for (const entry of manifest.entries) {
    for (const reference of entry.references || []) {
      assert.deepEqual(
        Object.keys(reference),
        ['path'],
        `${entry.host} carries a drift-prone reference field: ${JSON.stringify(reference)}`,
      );
    }
    const paths = (entry.references || []).map((reference) => reference.path);
    assert.deepEqual([...new Set(paths)], paths, `${entry.host} repeats a reference path`);
  }
  for (const observed of scanUpstreamHosts(rootDir)) {
    for (const reference of observed.references) {
      assert.deepEqual(Object.keys(reference), ['path'], `scanner emitted ${JSON.stringify(reference)}`);
    }
  }
});

test('the committed manifest is a fixpoint of its own generator', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  const rebuilt = buildManifest(inventory, manifest);
  const committedByHost = new Map(manifest.entries.map((entry) => [entry.host, entry]));
  const drifted = rebuilt.entries
    .filter((entry) => JSON.stringify(entry) !== JSON.stringify(committedByHost.get(entry.host)))
    .map((entry) => entry.host);
  const dropped = manifest.entries
    .filter((entry) => !rebuilt.entries.some((candidate) => candidate.host === entry.host))
    .map((entry) => entry.host);
  assert.deepEqual(drifted, [], 'committed rows differ from a rebuild; run node scripts/source-attribution.mjs --write');
  assert.deepEqual(dropped, [], 'a rebuild would delete these committed rows instead of retiring them in place');
});

test('reference and kind drift on an observed row fails the manifest gate', () => {
  const errors = validateManifest(
    [{ host: 'provider.example', kinds: ['feed', 'structured'], references: [{ path: 'server/a.ts' }, { path: 'server/b.ts' }] }],
    {
      entries: [{
        host: 'provider.example',
        provider: 'Provider',
        license: 'Terms review',
        attribution: 'Credit Provider.',
        observed: true,
        kind: 'structured',
        status: 'terms-review',
        references: [{ path: 'server/a.ts' }],
      }],
      logicalEntries: [],
    },
  );
  assert.ok(
    errors.some((error) => error.includes('provider.example') && error.includes('references')),
    `stale references must be reported, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some((error) => error.includes('provider.example') && error.includes('kind')),
    `stale kind must be reported, got: ${JSON.stringify(errors)}`,
  );
});

test('a retired row survives regeneration instead of being deleted', () => {
  const retired = {
    host: 'gone.example',
    provider: 'Gone',
    license: 'Terms review',
    attribution: 'Excluded: gone.example is no longer observed in the source tree.',
    observed: false,
    kind: 'feed',
    status: 'excluded',
    references: [{ path: 'src/config/feeds.ts' }],
  };
  const rebuilt = buildManifest([], { entries: [retired], logicalEntries: [] });
  assert.deepEqual(
    rebuilt.entries.find((entry) => entry.host === 'gone.example'),
    retired,
    'a row retired by an earlier regeneration must be retained verbatim, not silently deleted',
  );
});

test('a retired host that comes back is counted again instead of staying excluded', () => {
  const retired = {
    host: 'back.example',
    provider: 'Back',
    license: 'Terms review',
    attribution: 'Credit Back.',
    observed: false,
    kind: 'feed',
    status: 'excluded',
    references: [{ path: 'src/config/feeds.ts' }],
  };
  const rebuilt = buildManifest(
    [{ host: 'back.example', kinds: ['feed'], references: [{ path: 'src/config/feeds.ts' }] }],
    { entries: [retired], logicalEntries: [] },
  );
  const revived = rebuilt.entries.find((entry) => entry.host === 'back.example');
  assert.equal(revived.observed, true);
  assert.equal(revived.status, 'terms-review', 'retirement must not keep a re-observed host out of the active count');
  assert.equal(revived.attribution, 'Credit Back.', 'the curated credit survives the round trip');
});

test('observed manifest rows cannot erase their source references', () => {
  const errors = validateManifest(
    [{ host: 'provider.example', kinds: ['structured'], references: [{ path: 'server/provider.ts', line: 1 }] }],
    {
      entries: [{
        host: 'provider.example',
        provider: 'Provider',
        license: 'Terms review',
        attribution: 'Credit Provider.',
        observed: true,
        kind: 'structured',
        status: 'terms-review',
        references: [],
      }],
      logicalEntries: [],
    },
  );
  assert.ok(errors.some((error) => error.includes('at least one reference')));
});
