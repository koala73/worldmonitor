import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  PROVIDER_IDENTITY_GROUPS,
  PROVIDER_IDENTITY_REVIEW,
  buildManifest,
  buildSourceAttributionStats,
  checkSourceAttribution,
  loadManifest,
  matchGeneratedAttributionSection,
  renderAttributionSection,
  runSourceAttribution,
  scanUpstreamHosts,
  sourceAttributionLedgerStats,
  sourceAttributionStats,
  validateSourceAttributionLedger,
  validateManifest,
  validateProviderIdentityGroups,
  providerIdentityDigest,
} from '../scripts/source-attribution.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// Deliberately independent of the production active-entry predicate. Keep this
// oracle expressed only in raw manifest fields so a predicate mutation cannot
// change both the implementation and the expected membership.
function rawManifestActiveEntries(manifest) {
  assert.ok(Array.isArray(manifest?.entries), 'the attribution manifest must contain an entries array');
  return manifest.entries.filter(
    (entry) => entry?.observed === true && (entry.status === 'reviewed' || entry.status === 'terms-review'),
  );
}

/**
 * Build a throwaway checkout whose committed artifacts the generator itself
 * produced, so every `--check` failure below is caused by the one mutation the
 * test makes and not by fixture drift.
 */
function makeFixtureCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'source-attribution-'));
  for (const root of ['scripts', 'server', 'api', 'src', 'shared', 'docs']) {
    mkdirSync(join(dir, root), { recursive: true });
  }
  writeFileSync(
    join(dir, 'scripts/seed-fixture.mjs'),
    "const FIXTURE_URL = 'https://fixture.example/v1/data';\nexport const url = FIXTURE_URL;\n",
  );
  const inventory = scanUpstreamHosts(dir);
  const manifest = buildManifest(inventory, { entries: [], logicalEntries: [] });
  const manifestPath = join(dir, 'shared/source-attribution-manifest.json');
  const docsPath = join(dir, 'docs/source-attribution.mdx');
  const writeManifest = (value) => {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(manifestPath, serialized);
  };
  const writeDocs = (value) => writeFileSync(
    docsPath,
    `---\ntitle: "Source Attribution"\n---\n\n${renderAttributionSection(inventory, value)}\n`,
  );
  writeManifest(manifest);
  writeDocs(manifest);
  return {
    dir,
    manifest,
    manifestPath,
    docsPath,
    writeManifest,
    writeDocs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function readFixtureArtifacts(fixture) {
  return {
    manifest: readFileSync(fixture.manifestPath, 'utf8'),
    docs: readFileSync(fixture.docsPath, 'utf8'),
  };
}

test('source inventory has complete metadata and matches the generated catalog', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  assert.deepEqual(validateManifest(inventory, manifest), []);

  const docs = readFileSync(join(rootDir, 'docs/source-attribution.mdx'), 'utf8');
  const generated = renderAttributionSection(inventory, manifest);
  const actual = matchGeneratedAttributionSection(docs);
  assert.equal(actual, generated, 'docs/source-attribution.mdx must contain exactly the generated attribution section');
  assert.match(generated, /\| Provider \| Observed surface \|/);
  for (const forbidden of [
    /\blicen[cs]\w*/i,
    /\bterms-review\b/i,
    /\bredistribut\w*/i,
    /\bcommercial(?:-|\s+)use\b/i,
  ]) {
    assert.doesNotMatch(docs, forbidden, `public source attribution docs must omit ${forbidden}`);
  }

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
  const activeEntries = rawManifestActiveEntries(manifest);
  const inventoryHosts = new Set(inventory.map((entry) => entry.host));
  const observedManifestHosts = new Set(
    manifest.entries.filter((entry) => entry.observed === true).map((entry) => entry.host),
  );
  assert.ok(activeEntries.length > 0, 'the active source oracle must not be empty');
  assert.deepEqual(observedManifestHosts, inventoryHosts, 'raw manifest membership must match the source scan exactly');
  assert.equal(stats.activeHosts, activeEntries.length, 'production stats must match the independent active-host oracle');
  assert.equal(
    stats.providerCount,
    new Set(activeEntries.map((entry) => entry.provider)).size,
    'production stats must match the independent provider oracle',
  );
  assert.equal(stats.observedHosts, inventory.length, 'observed stats must derive from the source scan');
  assert.ok(stats.reviewNeeded > 0, 'the internal source-policy review backlog must remain tracked');

  const byHost = new Map(manifest.entries.map((entry) => [entry.host, entry]));
  assert.equal(byHost.get('auth.opensky-network.org')?.provider, 'opensky-network.org');
  assert.equal(byHost.get('opensky-network.org')?.provider, 'opensky-network.org');
  assert.equal(byHost.get('customer-api.wingbits.com')?.provider, 'wingbits.com');
  assert.equal(byHost.get('ecs-api.wingbits.com')?.provider, 'wingbits.com');
});

test('Google News site feeds account for both the editorial host and Google News', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const byHost = new Map(inventory.map((entry) => [entry.host, entry]));

  const googleNews = byHost.get('news.google.com');
  assert.ok(googleNews, 'Google News must remain an accounted transport host');

  const lorientToday = byHost.get('lorientlejour.com');
  assert.ok(lorientToday, "L'Orient Today must be accounted under lorientlejour.com");
  assert.ok(
    lorientToday.references.some((reference) => reference.path === 'src/config/feeds.ts'),
    "L'Orient Today must retain its client feed reference",
  );
  assert.ok(
    lorientToday.references.some((reference) => reference.path === 'server/worldmonitor/news/v1/_feeds.ts'),
    "L'Orient Today must retain its server feed reference",
  );

  const annahar = byHost.get('annahar.com');
  assert.ok(annahar, 'Annahar must be accounted under annahar.com');
  assert.ok(
    annahar.references.some((reference) => reference.path === 'src/config/feeds.ts'),
    'Annahar must retain its client feed reference',
  );
  assert.ok(
    annahar.references.some((reference) => reference.path === 'server/worldmonitor/news/v1/_feeds.ts'),
    'Annahar must retain its server feed reference',
  );

  for (const [host, provider] of [
    ['pap.pl', 'PAP'],
    ['wyborcza.pl', 'Gazeta Wyborcza'],
    ['polityka.pl', 'Polityka'],
    ['wiadomosci.onet.pl', 'Onet'],
    ['oko.press', 'OKO.press'],
    ['tvp.info', 'TVP Info'],
  ]) {
    const entry = byHost.get(host);
    assert.ok(entry, `${provider} must be accounted under ${host}`);
    assert.ok(
      entry.references.some((reference) => reference.path === 'src/config/feeds.ts'),
      `${provider} must retain its client feed reference`,
    );
    assert.ok(
      entry.references.some((reference) => reference.path === 'server/worldmonitor/news/v1/_feeds.ts'),
      `${provider} must retain its server feed reference`,
    );
  }

  const serverFeeds = readFileSync(
    join(rootDir, 'server/worldmonitor/news/v1/_feeds.ts'),
    'utf8',
  );
  const configuredPublisherHosts = new Set();
  for (const rawLine of serverFeeds.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || !line.includes('site:')) continue;
    for (const match of line.matchAll(/\bsite:([a-z0-9.-]+)/gi)) {
      configuredPublisherHosts.add(match[1].toLowerCase());
    }
  }
  const missingHosts = [...configuredPublisherHosts]
    .filter((host) => !byHost.has(host))
    .sort();
  assert.deepEqual(
    missingHosts,
    [],
    'every site-scoped publisher must be accounted under its own configured host',
  );
});

test('provider identity groups declare complete reviewed multi-host membership', () => {
  const manifest = loadManifest(rootDir);
  assert.deepEqual(validateProviderIdentityGroups(manifest), []);
  for (const [groupId, group] of Object.entries(PROVIDER_IDENTITY_GROUPS)) {
    assert.ok(group.reason.trim(), `${groupId} must explain why its hosts are one provider`);
    assert.match(group.reviewReference, /(?:PR|issue|review)\s+#?\d+/i, `${groupId} needs a review reference`);
    const manifestHosts = manifest.entries
      .filter((entry) => entry.provider === group.provider)
      .map((entry) => entry.host)
      .sort();
    assert.deepEqual(manifestHosts, [...group.memberHosts].sort(), `${groupId} must declare every ledger host`);
  }
});

test('provider collisions and incomplete identity groups fail closed', () => {
  const collision = {
    entries: ['a.example', 'b.example'].map((host) => ({
      host,
      provider: 'Accidentally Shared',
      observed: true,
      status: 'terms-review',
    })),
  };
  assert.ok(
    validateProviderIdentityGroups(collision).some((error) => error.includes('undeclared identity collision')),
    'a shared provider label must not silently collapse two hosts',
  );

  const groups = {
    shared: {
      provider: 'Declared Shared',
      memberHosts: ['a.example', 'b.example'],
      reason: 'Reviewed shared service identity.',
      reviewReference: 'PR #1',
    },
  };
  const overrides = {
    'a.example': { provider: 'Declared Shared', identityGroup: 'shared' },
    'b.example': { provider: 'Declared Shared', identityGroup: 'shared' },
  };
  const incomplete = {
    entries: [{ host: 'a.example', provider: 'Declared Shared', observed: true, status: 'reviewed' }],
  };
  assert.ok(
    validateProviderIdentityGroups(incomplete, groups, overrides)
      .some((error) => error.includes('manifest membership') && error.includes('b.example')),
    'a declared group must preserve its complete host set',
  );

  assert.ok(
    validateProviderIdentityGroups({ entries: [] }, groups, overrides)
      .some((error) => error.includes('manifest membership') && error.includes('(empty)')),
    'deleting an entire declared group must require an explicit group retirement review',
  );
});

test('single-host provider identity changes require a reviewed lifecycle epoch', () => {
  const overrides = {
    'single.example': { provider: 'Original Provider' },
  };
  const review = {
    sha256: providerIdentityDigest(overrides),
    reason: 'Fixture baseline.',
    reviewReference: 'PR #1',
  };
  assert.deepEqual(validateProviderIdentityGroups({ entries: [] }, {}, overrides, review), []);
  overrides['single.example'].provider = 'Renamed Provider';
  assert.ok(
    validateProviderIdentityGroups({ entries: [] }, {}, overrides, review)
      .some((error) => error.includes('without a reviewed lifecycle epoch')),
    'a single-host provider rename must update the explicit identity review epoch',
  );

  const manifest = loadManifest(rootDir);
  const directRename = structuredClone(manifest);
  const defaultNamedEntry = directRename.entries.find(
    (entry) => entry.observed && entry.status !== 'excluded' && entry.provider === entry.host,
  );
  assert.ok(defaultNamedEntry, 'the direct-rename mutation needs a default-named provider');
  defaultNamedEntry.provider = 'Silently Renamed Provider';
  assert.ok(
    validateManifest(scanUpstreamHosts(rootDir), directRename)
      .some((error) => error.includes('must be declared in PROVIDER_OVERRIDES')),
    'a direct single-host manifest rename must declare an explicit reviewed identity override',
  );
  assert.match(PROVIDER_IDENTITY_REVIEW.reviewReference, /(?:PR|issue|review)\s+#?\d+/i);
});

test('the independent raw-manifest oracle catches an active-predicate mutation', async () => {
  const sourcePath = join(rootDir, 'scripts/source-attribution.mjs');
  const source = readFileSync(sourcePath, 'utf8');
  const originalPredicate = "return entry?.observed === true && CREDIT_BEARING_STATUSES.has(entry.status);";
  assert.equal(source.split(originalPredicate).length - 1, 1, 'mutation target must identify the canonical predicate once');
  const mutantDir = mkdtempSync(join(tmpdir(), 'source-attribution-mutant-'));
  const mutantPath = join(mutantDir, 'source-attribution-mutant.mjs');
  try {
    writeFileSync(
      mutantPath,
      source.replace(originalPredicate, "return entry?.observed === true && entry.status === 'excluded';"),
    );
    const mutant = await import(`${pathToFileURL(mutantPath).href}?test=${Date.now()}`);
    const manifest = loadManifest(rootDir);
    const expectedHosts = rawManifestActiveEntries(manifest).map((entry) => entry.host).sort();
    const mutantHosts = mutant.activeSourceAttributionEntries(manifest).map((entry) => entry.host).sort();
    assert.notDeepEqual(mutantHosts, expectedHosts, 'the independent oracle must reject a mutated active predicate');
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
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

test('City of Toronto CART host stays terms-review while CKAN licence_id is notspecified', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  const observed = inventory.find((entry) => entry.host === 'secure.toronto.ca');
  assert.ok(observed, 'secure.toronto.ca must be observed from the Toronto seeder/adapter');
  const entry = [...manifest.entries, ...manifest.logicalEntries].find((row) => row.host === 'secure.toronto.ca');
  assert.ok(entry, 'secure.toronto.ca must have a generated attribution row');
  assert.equal(entry.status, 'terms-review');
  assert.equal(entry.provider, 'City of Toronto Open Data');
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

test('scanUpstreamHosts does not crash on empty leftover api/[domain]/v1 trees', () => {
  const fixture = makeFixtureCheckout();
  try {
    mkdirSync(join(fixture.dir, 'api', '[__docs_stats_probe__]', 'v1'), { recursive: true });
    assert.doesNotThrow(() => scanUpstreamHosts(fixture.dir));
  } finally {
    fixture.cleanup();
  }
});

test('ledger stats match validated stats when the committed manifest is current', () => {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  const validated = sourceAttributionStats(inventory, manifest);
  const ledger = sourceAttributionLedgerStats(manifest, { observedHosts: inventory.length });
  assert.deepEqual(ledger, validated);
  assert.deepEqual(buildSourceAttributionStats({ rootDir, validate: false }), sourceAttributionLedgerStats(manifest));
});

test('ledger stats remain countable when scan-parity validation would fail', () => {
  const stale = {
    entries: [{
      host: 'stale.example',
      provider: 'stale.example',
      license: 'Provider terms',
      attribution: 'Credit stale.example.',
      observed: true,
      kind: 'structured',
      status: 'terms-review',
      references: [{ path: 'scripts/removed-seed.mjs' }],
    }],
    logicalEntries: [],
  };
  assert.throws(
    () => sourceAttributionStats([], stale),
    /invalid manifest/,
  );
  const ledger = sourceAttributionLedgerStats(stale);
  assert.equal(ledger.activeHosts, 1);
  assert.equal(ledger.providerCount, 1);
  assert.equal(ledger.structuredHosts, 1);
  assert.equal(ledger.observedHosts, 1);
});

test('ledger stats reject intrinsic manifest failures before counting', () => {
  const malformed = {
    entries: [
      {
        host: 'invalid.example',
        provider: '',
        license: '',
        attribution: '',
        observed: true,
        kind: 'not-a-source-kind',
        status: 'reviewed',
        references: [{ path: 'scripts/invalid.mjs' }],
      },
      {
        host: 'invalid.example',
        provider: 'invalid.example',
        license: 'Provider terms',
        attribution: 'Credit invalid.example.',
        observed: true,
        kind: 'structured',
        status: 'reviewed',
        references: [{ path: 'scripts/duplicate.mjs' }],
      },
    ],
    logicalEntries: [{
      host: 'candidate.example',
      provider: 'Candidate',
      license: '',
      attribution: '',
      observed: false,
      kind: 'candidate',
      status: 'excluded',
    }],
  };
  const errors = validateSourceAttributionLedger(malformed);
  assert.ok(errors.some((error) => error.includes('invalid manifest kind')));
  assert.ok(errors.some((error) => error.includes('incomplete attribution metadata')));
  assert.ok(errors.some((error) => error.includes('duplicate manifest entry')));
  assert.ok(errors.some((error) => error.includes('incomplete logical attribution metadata')));
  assert.throws(() => sourceAttributionLedgerStats(malformed), /invalid manifest/);
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
  };
  const rebuilt = buildManifest([], { entries: [retired], logicalEntries: [] });
  assert.deepEqual(
    rebuilt.entries.find((entry) => entry.host === 'gone.example'),
    retired,
    'a row retired by an earlier regeneration must be retained, not silently deleted',
  );
  // Retention only makes --write a fixpoint if it is stable across runs.
  assert.deepEqual(buildManifest([], rebuilt), rebuilt);
  assert.throws(
    () => buildManifest([], rebuilt, { retireHosts: ['gone.example'] }),
    /cannot retire gone\.example because it is already retired/,
  );
});

test('credit-bearing hosts cannot leave the inventory without explicit retirement', () => {
  for (const status of ['terms-review', 'reviewed']) {
    const previous = {
      entries: [{
        host: `${status}.example`,
        provider: status,
        license: 'Provider terms',
        attribution: `Credit ${status}.`,
        observed: true,
        kind: 'structured',
        status,
        references: [{ path: 'scripts/seed-provider.mjs' }],
      }],
      logicalEntries: [],
    };

    assert.throws(
      () => buildManifest([], previous),
      new RegExp(`${status}\\.example left the scan; confirm removal with --retire ${status}\\.example`),
    );
    assert.equal(previous.entries[0].observed, true, 'a refused retirement must not mutate the previous manifest');
  }
});

test('an explicit retirement drops a credit-bearing host from the active inventory', () => {
  const previous = {
    entries: [{
      host: 'gone.example',
      provider: 'Gone',
      license: 'Provider terms',
      attribution: 'Credit Gone.',
      observed: true,
      kind: 'feed',
      status: 'terms-review',
      references: [{ path: 'src/config/feeds.ts' }],
    }],
    logicalEntries: [],
  };

  const rebuilt = buildManifest([], previous, { retireHosts: ['gone.example'] });
  const retired = rebuilt.entries.find((entry) => entry.host === 'gone.example');
  assert.equal(retired.observed, false);
  assert.equal(retired.status, 'excluded');
  assert.equal(retired.references, undefined);
  assert.equal(retired.attribution, 'Credit Gone.', 'explicit retirement must preserve required credit');
});

test('an invalid manifest status cannot be laundered into retirement', () => {
  const previous = {
    entries: [{
      host: 'invalid-status.example',
      provider: 'Invalid Status',
      license: 'Provider terms',
      attribution: 'Credit Invalid Status.',
      observed: true,
      kind: 'structured',
      status: 'review',
      references: [{ path: 'scripts/seed-provider.mjs' }],
    }],
    logicalEntries: [],
  };

  assert.throws(
    () => buildManifest([], previous),
    /cannot retire invalid-status\.example because its manifest status is invalid/,
  );
  assert.throws(
    () => buildManifest([], previous, { retireHosts: ['invalid-status.example'] }),
    /cannot retire invalid-status\.example because its manifest status is invalid/,
    'explicit retirement must not normalize malformed compliance state',
  );
  assert.equal(previous.entries[0].observed, true);
  assert.equal(previous.entries[0].status, 'review');
});

test('an explicit retirement host must name a current manifest row that left the scan', () => {
  const previous = {
    entries: [{
      host: 'current.example',
      provider: 'Current',
      license: 'Provider terms',
      attribution: 'Credit Current.',
      observed: true,
      kind: 'structured',
      status: 'terms-review',
      references: [{ path: 'server/current.ts' }],
    }],
    logicalEntries: [],
  };
  const inventory = [{
    host: 'current.example',
    kinds: ['structured'],
    references: [{ path: 'server/current.ts' }],
  }];

  assert.throws(
    () => buildManifest(inventory, previous, { retireHosts: ['current.example'] }),
    /cannot retire current\.example because the scanner still finds it/,
  );
  assert.throws(
    () => buildManifest([], previous, { retireHosts: ['typo.example'] }),
    /cannot retire unknown host typo\.example/,
  );
});

test('the CLI refuses malformed, unpaired, or still-observed retirement requests without writing', () => {
  const fixture = makeFixtureCheckout();
  try {
    const before = readFixtureArtifacts(fixture);
    for (const [label, args, expected] of [
      ['missing value at end', ['--write', '--retire'], /--retire requires a host/],
      ['another flag used as the value', ['--retire', '--write'], /--retire requires a host/],
      ['missing --write', ['--retire', 'fixture.example'], /--retire requires --write/],
      ['still observed', ['--write', '--retire', 'fixture.example'], /cannot retire fixture\.example because the scanner still finds it/],
    ]) {
      const errors = [];
      const exitCode = runSourceAttribution({
        rootDir: fixture.dir,
        args,
        log: () => {},
        warn: () => {},
        reportError: (message) => errors.push(message),
      });
      assert.equal(exitCode, 1, `${label} must fail`);
      assert.ok(errors.some((error) => expected.test(error)), `${label} reported ${JSON.stringify(errors)}`);
      assert.deepEqual(readFixtureArtifacts(fixture), before, `${label} must not rewrite attribution artifacts`);
    }
  } finally {
    fixture.cleanup();
  }
});

test('the CLI explicitly retires a missing fixture host and updates canonical artifacts', () => {
  const fixture = makeFixtureCheckout();
  try {
    writeFileSync(join(fixture.dir, 'scripts/seed-fixture.mjs'), 'export const removed = true;\n');
    const before = readFixtureArtifacts(fixture);
    const errors = [];
    const warnings = [];
    const exitCode = runSourceAttribution({
      rootDir: fixture.dir,
      args: ['--write', '--retire', 'fixture.example'],
      log: () => {},
      warn: (message) => warnings.push(message),
      reportError: (message) => errors.push(message),
    });

    assert.equal(exitCode, 0, JSON.stringify(errors));
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((warning) => /retired 1 host\(s\): fixture\.example/.test(warning)));

    const after = readFixtureArtifacts(fixture);
    assert.notEqual(after.manifest, before.manifest);
    assert.notEqual(after.docs, before.docs);
    const retired = JSON.parse(after.manifest).entries.find((entry) => entry.host === 'fixture.example');
    assert.equal(retired.observed, false);
    assert.equal(retired.status, 'excluded');
    assert.equal(retired.references, undefined);
    assert.match(retired.attribution, /Credit fixture\.example/);
    assert.match(after.docs, /fixture\.example\) \| Excluded \/ candidate — No current fetch observed/);
    assert.deepEqual(checkSourceAttribution(fixture.dir).errors, [], 'the explicit retirement must leave a clean fixpoint');
  } finally {
    fixture.cleanup();
  }
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

test('a playback-only host that gains a real fetch stops being excluded', () => {
  const playbackOnly = {
    host: 'stream.example',
    provider: 'stream.example',
    license: 'Excluded: live-video playback transport; channel/provider terms apply separately',
    attribution: 'Excluded from the external-provider count: presentation-only HLS stream, not an ingested dataset.',
    observed: true,
    kind: 'feed',
    status: 'excluded',
    references: [{ path: 'src/components/LiveNewsPanel.ts' }],
  };
  const rebuilt = buildManifest(
    [{
      host: 'stream.example',
      kinds: ['structured'],
      references: [{ path: 'scripts/seed-example.mjs' }, { path: 'src/components/LiveNewsPanel.ts' }],
    }],
    { entries: [playbackOnly], logicalEntries: [] },
  );
  const promoted = rebuilt.entries.find((entry) => entry.host === 'stream.example');
  assert.equal(promoted.status, 'terms-review', 'an ingested host must not keep a playback-only exclusion');
  assert.doesNotMatch(promoted.license, /Excluded:/, 'the exclusion license must not outlive the exclusion');
  assert.doesNotMatch(promoted.attribution, /Excluded from/);

  // The same host while still playback-only stays excluded — otherwise the
  // assertions above would pass against a rule that never fires.
  const unchanged = buildManifest(
    [{ host: 'stream.example', kinds: ['feed'], references: [{ path: 'src/components/LiveNewsPanel.ts' }] }],
    { entries: [playbackOnly], logicalEntries: [] },
  );
  assert.equal(unchanged.entries.find((entry) => entry.host === 'stream.example').status, 'excluded');
});

test('a host dropped from EXCLUDED_HOSTS stops being excluded', () => {
  // The sibling of the playback-only case: the other rule that mints an
  // exclusion. Both branches must withdraw, not just the one.
  const firstParty = {
    host: 'not-excluded-any-more.example',
    provider: 'not-excluded-any-more.example',
    license: 'Excluded: first-party, control-plane, UI, or rendering transport',
    attribution: 'Excluded from the external-provider count: not an ingested upstream dataset.',
    observed: true,
    kind: 'structured',
    status: 'excluded',
    references: [{ path: 'scripts/seed-example.mjs' }],
  };
  const rebuilt = buildManifest(
    [{ host: 'not-excluded-any-more.example', kinds: ['structured'], references: [{ path: 'scripts/seed-example.mjs' }] }],
    { entries: [firstParty], logicalEntries: [] },
  );
  const entry = rebuilt.entries.find((candidate) => candidate.host === 'not-excluded-any-more.example');
  assert.equal(entry.status, 'terms-review');
  assert.doesNotMatch(entry.license, /Excluded:/);
});

test('a retired row stops claiming a source path it is no longer found in', () => {
  const rebuilt = buildManifest([], {
    entries: [{
      host: 'gone.example',
      provider: 'gone.example',
      license: 'Terms review',
      attribution: 'Credit Gone.',
      observed: true,
      kind: 'feed',
      status: 'terms-review',
      references: [{ path: 'src/config/feeds.ts' }],
    }],
    logicalEntries: [],
  }, { retireHosts: ['gone.example'] });
  const retired = rebuilt.entries.find((entry) => entry.host === 'gone.example');
  assert.equal(retired.observed, false);
  assert.equal(retired.references, undefined, 'a host the scanner cannot find must not publish a source path');
  assert.match(
    renderAttributionSection([], rebuilt),
    /gone\.example\) \| Excluded \/ candidate — No current fetch observed/,
  );
});

test('a reference carrying anything beyond a path fails the manifest gate', () => {
  const errors = validateManifest([], {
    entries: [{
      host: 'legacy.example',
      provider: 'Legacy',
      license: 'Terms review',
      attribution: 'Credit Legacy.',
      observed: false,
      kind: 'feed',
      status: 'excluded',
      references: [{ path: 'src/config/feeds.ts', line: 175 }],
    }],
    logicalEntries: [],
  });
  assert.ok(
    errors.some((error) => error.includes('carries fields beyond path')),
    `a re-introduced line number must be rejected, got: ${JSON.stringify(errors)}`,
  );
});

test('a field this script owns sends the reviewer to the script, not to --write', () => {
  // api.openaq.org is in PROVIDER_OVERRIDES, so --write reasserts its license.
  // Telling a reviewer to regenerate would destroy the edit they just made.
  const errors = validateManifest(
    [{ host: 'api.openaq.org', kinds: ['structured'], references: [{ path: 'scripts/seed-air-quality.mjs' }] }],
    {
      entries: [{
        host: 'api.openaq.org',
        provider: 'OpenAQ',
        license: 'CC BY 4.0 — reviewed by counsel',
        attribution: 'OpenAQ, https://openaq.org/.',
        observed: true,
        kind: 'structured',
        status: 'reviewed',
        references: [{ path: 'scripts/seed-air-quality.mjs' }],
      }],
      logicalEntries: [],
    },
  );
  assert.ok(errors.some((error) => error.includes('edit the script instead')), JSON.stringify(errors));
  assert.ok(!errors.some((error) => /license.*run node scripts/.test(error)), 'must not prescribe --write for an owned field');
});

test('a malformed inventory row is reported, not thrown', () => {
  assert.doesNotThrow(() => validateManifest([{ host: 'broken.example' }], { entries: [], logicalEntries: [] }));
  const errors = validateManifest([{ host: 'broken.example' }], { entries: [], logicalEntries: [] });
  assert.ok(errors.some((error) => error.includes('broken.example') && error.includes('kinds and references')));
});

test('a reviewed host loses its verdict across a retire and revive round trip', () => {
  // Pinning a deliberate loss, not endorsing it: retirement overwrites status,
  // so the completed audit is already gone by the time the host returns. The
  // direction is fail-safe — it re-opens review rather than claiming one that
  // no longer describes the provider's current terms.
  const reviewed = {
    host: 'roundtrip.example',
    provider: 'Roundtrip',
    license: 'CC BY 4.0',
    attribution: 'Credit Roundtrip.',
    observed: true,
    kind: 'structured',
    status: 'reviewed',
    references: [{ path: 'scripts/seed-roundtrip.mjs' }],
  };
  const retired = buildManifest(
    [],
    { entries: [reviewed], logicalEntries: [] },
    { retireHosts: ['roundtrip.example'] },
  );
  const revived = buildManifest(
    [{ host: 'roundtrip.example', kinds: ['structured'], references: [{ path: 'scripts/seed-roundtrip.mjs' }] }],
    retired,
  );
  assert.equal(revived.entries.find((entry) => entry.host === 'roundtrip.example').status, 'terms-review');
});

test('a truncated reference list says how much it is hiding', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ path: `scripts/seed-${name}.mjs` }));
  const section = renderAttributionSection(
    [{ host: 'many.example', kinds: ['structured'], references: many }],
    {
      entries: [{
        host: 'many.example',
        provider: 'many.example',
        license: 'Terms review',
        attribution: 'Credit Many.',
        observed: true,
        kind: 'structured',
        status: 'terms-review',
        references: many,
      }],
      logicalEntries: [],
    },
  );
  assert.match(section, /scripts\/seed-d\.mjs, \+2 more/);
});

test('a curated exclusion keeps its reviewer-written credit', () => {
  const curated = {
    host: 'api.axiom.co',
    provider: 'Axiom',
    license: 'Excluded: World Monitor operational telemetry, not an external data provider',
    attribution: 'Not an upstream dataset.',
    observed: true,
    kind: 'structured',
    status: 'excluded',
    references: [{ path: 'api/_usage-telemetry.js' }],
  };
  const rebuilt = buildManifest(
    [{ host: 'api.axiom.co', kinds: ['structured'], references: [{ path: 'api/_usage-telemetry.js' }] }],
    { entries: [curated], logicalEntries: [] },
  );
  const entry = rebuilt.entries.find((candidate) => candidate.host === 'api.axiom.co');
  assert.equal(entry.status, 'excluded', 'PROVIDER_OVERRIDES still asserts this exclusion');
  assert.match(entry.license, /operational telemetry/);
});

// The CI gate is `node scripts/source-attribution.mjs --check`. The unit tests
// above exercise its pieces; these drive the whole verdict against a throwaway
// checkout, so each way it must go red is proven rather than assumed. Without
// them, deleting the manifest comparison from the gate leaves every test green.
test('the check gate passes on a checkout the generator just wrote', () => {
  const fixture = makeFixtureCheckout();
  try {
    const { errors, stats } = checkSourceAttribution(fixture.dir);
    assert.deepEqual(errors, []);
    assert.ok(stats.activeHosts > 0, 'the fixture must contain a host, or every red case below is vacuous');
  } finally {
    fixture.cleanup();
  }
});

test('the check gate goes red on manifest, docs, and logical-entry drift', () => {
  for (const [label, mutate, expected] of [
    ['a stale reference path', (f) => {
      const drifted = structuredClone(f.manifest);
      drifted.entries[0].references = [{ path: 'scripts/moved-away.mjs' }];
      f.writeManifest(drifted);
    }, /stale manifest entry for fixture\.example/],
    ['a deleted logical attribution row', (f) => {
      const drifted = structuredClone(f.manifest);
      drifted.logicalEntries = [];
      f.writeManifest(drifted);
    }, /source-attribution-manifest\.json is out of date/],
    ['a reformatted manifest', (f) => {
      writeFileSync(
        join(f.dir, 'shared/source-attribution-manifest.json'),
        `${JSON.stringify(f.manifest)}\n`,
      );
    }, /source-attribution-manifest\.json is out of date/],
    ['an edited docs table', (f) => {
      const docsPath = join(f.dir, 'docs/source-attribution.mdx');
      writeFileSync(docsPath, readFileSync(docsPath, 'utf8').replace('fixture.example', 'fixture.tampered'));
    }, /source-attribution\.mdx is out of date/],
    ['a missing manifest', (f) => rmSync(f.manifestPath), /source-attribution-manifest\.json is missing/],
  ]) {
    const fixture = makeFixtureCheckout();
    try {
      mutate(fixture);
      const { errors } = checkSourceAttribution(fixture.dir);
      assert.ok(errors.length > 0, `${label} must fail the gate`);
      assert.ok(
        errors.some((error) => expected.test(error)),
        `${label} reported the wrong error: ${JSON.stringify(errors)}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
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
