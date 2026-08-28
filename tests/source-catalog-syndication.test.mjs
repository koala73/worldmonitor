import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  attachCoverageToCatalog,
  buildLogicalProviders,
  catalogProviderIdentities,
  classifyFeedDeclaration,
  isCatalogProviderEntry,
  isSyndicationTransportHost,
  loadSourceGeography,
  logicalPublisherName,
  scanNamedFeedDeclarations,
  validateFeedBurnerPublisherIdentity,
} from '../scripts/source-catalog-identity.mjs';
import {
  loadManifest,
  scanUpstreamHosts,
  sourceAttributionLedgerStats,
} from '../scripts/source-attribution.mjs';
import { buildSourceCatalog } from '../scripts/crawlable-sources-page.mjs';
import { rawCatalogProviderNames } from './helpers/raw-catalog-providers.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('FeedBurner and Google News are syndication transports, not publisher hosts', () => {
  assert.equal(isSyndicationTransportHost('feeds.feedburner.com'), true);
  assert.equal(isSyndicationTransportHost('news.google.com'), true);
  assert.equal(isSyndicationTransportHost('reuters.com'), false);
  assert.equal(isSyndicationTransportHost('feeds.bbci.co.uk'), false);
});

test('NDTV and NDTV India collapse to the NDTV publisher family', () => {
  assert.equal(logicalPublisherName('NDTV'), 'NDTV');
  assert.equal(logicalPublisherName('NDTV India'), 'NDTV');
  assert.equal(logicalPublisherName('BBC Hindi'), 'BBC');
  assert.equal(logicalPublisherName('Reuters India'), 'Reuters');
  assert.equal(logicalPublisherName('India News Network'), 'India News Network');
});

test('FeedBurner declarations require an explicit publisher identity', () => {
  const named = classifyFeedDeclaration(
    'NDTV',
    'https://feeds.feedburner.com/ndtvnews-top-stories',
  );
  assert.equal(named.publisher, 'NDTV');
  assert.deepEqual(named.transportHosts, ['feeds.feedburner.com']);
  assert.deepEqual(named.editorialHosts, []);
  assert.deepEqual(
    validateFeedBurnerPublisherIdentity([
      { ...named, name: '', publisher: '' },
    ]),
    ['FeedBurner URL https://feeds.feedburner.com/ndtvnews-top-stories requires an explicit publisher identity'],
  );
});

test('multiline feed declarations retain their publisher identity', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'source-catalog-identity-'));
  try {
    const configDir = join(fixtureRoot, 'src/config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'feeds.ts'), `
      const rss = (url: string) => url;
      // { name: 'Ignored', url: rss('https://feeds.feedburner.com/ignored') }
      export const feeds = [{
        name: 'Fast Company',
        url: rss(
          'https://feeds.feedburner.com/fastcompany/headlines',
        ),
      }];
    `);

    const declarations = scanNamedFeedDeclarations(fixtureRoot);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].name, 'Fast Company');
    assert.equal(declarations[0].publisher, 'Fast Company');
    assert.equal(declarations[0].url, 'https://feeds.feedburner.com/fastcompany/headlines');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('feed declaration parsing works in the dependency-free docs-stats checkout', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'source-catalog-bare-node-'));
  try {
    for (const relativePath of [
      'scripts/source-catalog-identity.mjs',
      'scripts/source-origin.mjs',
      'shared/publisher-families.js',
    ]) {
      const destination = join(fixtureRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(rootDir, relativePath), destination);
    }
    const configDir = join(fixtureRoot, 'src/config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(fixtureRoot, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(configDir, 'feeds.ts'), `
      export const feeds = [{
        name: 'Fast Company',
        url: rss('https://feeds.feedburner.com/fastcompany/headlines'),
      }];
    `);

    const moduleUrl = pathToFileURL(join(fixtureRoot, 'scripts/source-catalog-identity.mjs')).href;
    const probe = `
      import { scanNamedFeedDeclarations } from ${JSON.stringify(moduleUrl)};
      const declarations = scanNamedFeedDeclarations(${JSON.stringify(fixtureRoot)});
      console.log(JSON.stringify(declarations.map(({ name, url }) => ({ name, url }))));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{
      name: 'Fast Company',
      url: 'https://feeds.feedburner.com/fastcompany/headlines',
    }]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Google News site queries keep the publisher; aggregation invents none', () => {
  const reuters = classifyFeedDeclaration(
    'Reuters India',
    'https://news.google.com/rss/search?q=site:reuters.com+India&hl=en-US&gl=US&ceid=US:en',
  );
  assert.equal(reuters.publisher, 'Reuters');
  assert.deepEqual(reuters.editorialHosts, ['reuters.com']);
  assert.deepEqual(reuters.transportHosts, ['news.google.com']);

  const aggregation = classifyFeedDeclaration(
    'India News Network',
    'https://news.google.com/rss/search?q=India+diplomacy+foreign+policy+news&hl=en&gl=US&ceid=US:en',
  );
  assert.equal(aggregation.publisher, 'India News Network');
  assert.deepEqual(aggregation.editorialHosts, []);
  assert.deepEqual(aggregation.transportHosts, ['news.google.com']);
});

test('logical FeedBurner publishers are counted once and carry India coverage for NDTV', () => {
  const geography = new Map([
    ['NDTV', ['IN']],
    ['NDTV India', ['IN']],
    ['Fast Company', []],
  ]);
  const providers = buildLogicalProviders([
    classifyFeedDeclaration('NDTV', 'https://feeds.feedburner.com/ndtvnews-top-stories'),
    classifyFeedDeclaration('NDTV India', 'https://feeds.feedburner.com/ndtvkhabar-latest'),
    classifyFeedDeclaration('Fast Company', 'https://feeds.feedburner.com/fastcompany/headlines'),
    classifyFeedDeclaration(
      'India News Network',
      'https://news.google.com/rss/search?q=India+diplomacy&hl=en&gl=US&ceid=US:en',
    ),
  ], geography);
  const ndtv = providers.find((entry) => entry.provider === 'NDTV');
  assert.ok(ndtv, 'NDTV must become a logical provider');
  assert.deepEqual(ndtv.feedLabels, ['NDTV', 'NDTV India']);
  assert.equal(ndtv.originCountry, 'IN');
  assert.deepEqual(ndtv.coveredCountries, ['IN']);
  const fastCompany = providers.find((entry) => entry.provider === 'Fast Company');
  assert.ok(fastCompany, 'Fast Company must become a logical provider');
  assert.deepEqual(fastCompany.transportHosts, ['feeds.feedburner.com']);
  assert.deepEqual(fastCompany.coveredCountries, []);
  assert.ok(!providers.some((entry) => entry.provider === 'India News Network'));
  assert.ok(!providers.some((entry) => /feedburner/i.test(entry.provider)));
});

test('the committed inventory keeps transport hosts in the ledger but not the provider count', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  const byHost = new Map(inventory.map((entry) => [entry.host, entry]));
  assert.ok(byHost.get('feeds.feedburner.com'), 'FeedBurner remains an observed transport host');
  assert.ok(byHost.get('news.google.com'), 'Google News remains an observed transport host');

  const feedburner = manifest.entries.find((entry) => entry.host === 'feeds.feedburner.com');
  const googleNews = manifest.entries.find((entry) => entry.host === 'news.google.com');
  assert.equal(feedburner?.role, 'transport');
  assert.equal(googleNews?.role, 'transport');
  assert.equal(isCatalogProviderEntry(feedburner), false);
  assert.equal(isCatalogProviderEntry(googleNews), false);

  const stats = sourceAttributionLedgerStats(manifest, { observedHosts: inventory.length });
  const identities = catalogProviderIdentities(manifest);
  const oracle = rawCatalogProviderNames(manifest);
  assert.deepEqual([...identities].sort(), [...oracle].sort());
  assert.equal(stats.providerCount, identities.size);
  assert.ok(!identities.has('feeds.feedburner.com'));
  assert.ok(!identities.has('news.google.com'));
  assert.ok(identities.has('NDTV'));
  assert.ok(identities.has('reuters.com') || identities.has('Reuters'));
});

test('catalog cards distinguish origin from coverage for BBC, NDTV, and Reuters', () => {
  const manifest = loadManifest(rootDir);
  const declarations = scanNamedFeedDeclarations(rootDir);
  const geography = loadSourceGeography(rootDir);
  const catalog = attachCoverageToCatalog(
    buildSourceCatalog(
      manifest.entries.filter(isCatalogProviderEntry),
      { logicalProviders: manifest.logicalProviders || [] },
    ),
    declarations,
    geography,
  );
  const byName = new Map(catalog.map((row) => [row.displayName, row]));

  assert.ok(!catalog.some((row) => row.displayName === 'Google News'));
  assert.ok(!catalog.some((row) => /FeedBurner/i.test(row.displayName)));

  const ndtv = byName.get('NDTV');
  assert.ok(ndtv, 'NDTV must appear as its own catalog provider');
  assert.equal(ndtv.originCountry, 'IN');
  assert.ok(ndtv.coveredCountries.includes('IN'));
  assert.ok(ndtv.hosts.includes('feeds.feedburner.com'));
  assert.deepEqual(ndtv.transportHosts, ['feeds.feedburner.com']);

  const bbcRows = catalog.filter((row) => row.provider === 'BBC');
  assert.equal(bbcRows.length, 1, 'BBC must render exactly one logical publisher card');
  const [bbc] = bbcRows;
  assert.ok(bbc, 'BBC Hindi must remain under BBC');
  assert.equal(bbc.originCountry, 'GB');
  assert.ok(bbc.coveredCountries.includes('IN'), 'BBC Hindi must declare India coverage');
  assert.deepEqual(
    bbc.hosts,
    ['feeds.bbci.co.uk', 'www.bbc.com'],
    'BBC feed and language-edition hosts must collapse into one publisher card',
  );

  const reuters = byName.get('Reuters');
  assert.ok(reuters, 'site-scoped Reuters queries must keep the Reuters identity');
  assert.equal(reuters.originCountry, 'GB');
  assert.ok(reuters.coveredCountries.includes('IN'), 'India-focused Reuters routes must declare India coverage');
  assert.ok(reuters.hosts.includes('reuters.com'));
});

test('www catalog hosts inherit geography from stripped editorial hosts', () => {
  const catalog = attachCoverageToCatalog(
    [{
      provider: 'www.thehindu.com',
      displayName: 'Unrelated Display Name',
      hosts: ['www.thehindu.com'],
      coveredCountries: [],
      transportHosts: [],
    }],
    [classifyFeedDeclaration('The Hindu', 'https://www.thehindu.com/news/national/feeder/default.rss')],
    new Map([['The Hindu', ['IN']]]),
  );
  assert.deepEqual(catalog[0].coveredCountries, ['IN']);
});
