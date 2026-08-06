import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
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

  const docs = readFileSync(join(rootDir, 'docs/data-sources.mdx'), 'utf8');
  const generated = renderAttributionSection(inventory, manifest);
  const actual = matchGeneratedAttributionSection(docs);
  assert.equal(actual, generated, 'docs/data-sources.mdx must contain exactly the generated attribution section');

  // Mintlify parses this page as MDX v3, which rejects `<!--` with
  // "Unexpected character `!` (U+0021) before name" and fails the whole
  // deployment. Nothing repo-side catches that, so pin it here.
  assert.equal(
    docs.includes('<!--'),
    false,
    'docs/data-sources.mdx must not contain HTML comments — MDX v3 rejects them; use {/* ... */}',
  );

  const stats = sourceAttributionStats(inventory, manifest);
  assert.equal(stats.activeHosts, 530);
  assert.equal(stats.providerCount, 528);
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
