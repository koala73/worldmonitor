import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INVENTORY_CONTRACTS,
  auditInventoryCountContracts,
  validateInventoryContractRegistry,
} from '../scripts/check-inventory-count-contracts.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Independent Appendix A closure. Do not derive this from INVENTORY_CONTRACTS:
// removing one production surface must fail this test instead of shrinking both
// the audit loop and its expected scan count together.
const EXPECTED_INVENTORY_SURFACES = [
  ['source-attribution-totals', 'tests/source-attribution.test.mjs', ['stats.activeHosts', 'stats.providerCount', 'stats.observedHosts']],
  ['panel-discoverability', 'tests/panel-config-guardrails.test.mjs', ['allRegistryPanelIds', 'panelCommandKeywordCounts', 'categoryMappedPanelIds', 'scheduled', 'primed']],
  ['panel-discoverability', 'tests/news-panel-key-reachability.test.mts', ['feedCategories', 'catalogPanelKeys', 'registrations']],
  ['mcp-output-schema-tools', 'tests/mcp-output-schema-coverage.test.mjs', ['registry', 'tools']],
  ['mcp-tool-annotations', 'tests/mcp-tool-annotations.test.mjs', ['registry', 'tools']],
  ['mcp-protocol-tools', 'tests/mcp-protocol-conformance.test.mjs', ['step1bListBody.result.tools', 'step3Body.result.tools']],
  ['mcp-protocol-tools', 'tests/mcp.test.mjs', ['body.result.tools', 'TOOL_REGISTRY']],
  ['mcp-protocol-tools', 'tests/mcp-resources.test.mjs', ['uiUris', 'listedUiUris']],
  ['llms-mcp-tools', 'tests/llms-txt-mcp-tools.test.mjs', ['registry']],
  ['openapi-server-specs', 'tests/openapi-servers-contract.test.mjs', ['serviceJsonSpecs', 'serviceYamlSpecs']],
  ['openapi-security-specs', 'tests/openapi-security-contract.test.mjs', ['serviceSpecs']],
  ['openapi-jmespath-specs', 'tests/openapi-jmespath-contract.test.mjs', ['serviceJsonSpecs', 'serviceYamlSpecs', 'jsonServiceGetIds', 'yamlServiceGetIds', 'bundleGetIds']],
  ['openapi-rate-limit-operations', 'tests/openapi-rate-limit-errors-contract.test.mjs', ['serviceJson', 'serviceYaml', 'jsonServiceOperationIds', 'yamlServiceOperationIds', 'bundleOperationIds']],
  ['route-cache-tiers', 'tests/route-cache-tier.test.mjs', ['getRoutes', 'tierKeys']],
  ['feed-client-server-catalogs', 'tests/feeds-client-server-parity.test.mjs', ['client', 'server', 'clientNameCount', 'serverNameCount']],
  ['feed-client-server-catalogs', 'tests/completeness-measurement.test.mjs', ['extractServerFeeds']],
  ['feed-client-server-catalogs', 'tests/publisher-families.test.mjs', ['FEED_LABELS', 'withHosts']],
  ['regional-feed-promises', 'tests/feed-catalog-drift.test.mts', ['CANADA_CATALOG', 'nordicBeyondSweden']],
  ['feed-source-provenance', 'tests/source-provenance.test.mts', ['names', 'explicitUnknownDimensions']],
  ['locale-key-completeness', 'tests/locale-completeness.test.mjs', ['enKeys', 'localeKeys']],
  ['food-stocks-locales', 'tests/food-stocks-registration.test.mjs', ['locales']],
  ['market-tape-locales', 'tests/market-tape-claim.test.mts', ['localeFiles']],
  ['product-catalog-inventories', 'tests/product-catalog-freshness.test.mjs', ['generatedProductIds', 'tiersJson', 'bundleHighlights']],
  ['agent-skills-index', 'tests/agent-skills-index.test.mjs', ['index.skills']],
  ['mcp-presets', 'tests/mcp-presets.test.mjs', ['presets']],
  ['route-explorer-countries', 'tests/route-explorer-pickers.test.mts', ['getAllCountries']],
  ['notification-country-registry', 'tests/notification-relay-country-scope-5359.test.mjs', ['names']],
  ['iso2-country-registry', 'convex/__tests__/followed-countries-mutations.test.ts', ['_ISO2_REGISTRY_FOR_TESTS']],
  ['public-fixed-algorithm-claims', 'tests/cii-docs-drift.test.mts', ['llmsBrief', 'llmsFull', 'pressKit', 'communityGuide', 'publicHome', 'agentView.capabilities']],
];

function inventorySurfaceRows(contracts) {
  return contracts.flatMap((entry) => entry.surfaces.map((entrySurface) => [
    entry.id,
    entrySurface.path,
    [...entrySurface.selectors],
  ]));
}

function assertInventorySurfaceClosure(contracts) {
  assert.deepEqual(inventorySurfaceRows(contracts), EXPECTED_INVENTORY_SURFACES);
}

function fixtureContract({ action = 'replace', classifications = ['parity'] } = {}) {
  return [{
    id: 'fixture-providers',
    authoritativeUniverse: 'fixture provider registry',
    classifications,
    migrationAction: action,
    reason: 'fixture reason',
    surfaces: [{ path: 'fixture.test.mjs', selectors: ['stats.providerCount'] }],
  }];
}

function auditFixture(source, contractOptions) {
  const rootDir = mkdtempSync(join(tmpdir(), 'wm-inventory-count-contract-'));
  writeFileSync(join(rootDir, 'fixture.test.mjs'), source);
  return auditInventoryCountContracts({ rootDir, contracts: fixtureContract(contractOptions) });
}

function codes(result) {
  return result.violations.map((violation) => violation.code);
}

describe('extensible inventory count contract audit', () => {
  it('ships a valid closed-world registry for every Appendix A test surface', () => {
    assert.deepEqual(validateInventoryContractRegistry(INVENTORY_CONTRACTS), []);
    assert.equal(new Set(INVENTORY_CONTRACTS.map((entry) => entry.id)).size, INVENTORY_CONTRACTS.length);
    assertInventorySurfaceClosure(INVENTORY_CONTRACTS);
  });

  it('rejects deleting one existing Appendix A surface from the registry', () => {
    const mutant = INVENTORY_CONTRACTS.map((entry) => entry.id === 'mcp-protocol-tools'
      ? { ...entry, surfaces: entry.surfaces.filter((entrySurface) => entrySurface.path !== 'tests/mcp.test.mjs') }
      : entry);
    assert.throws(
      () => assertInventorySurfaceClosure(mutant),
      /Expected values to be strictly deep-equal/,
    );
  });

  it('keeps every registered repository surface free of unclassified inventory literals', () => {
    const result = auditInventoryCountContracts({ rootDir: repoRoot });
    assert.deepEqual(result.violations, []);
    assert.equal(
      result.scannedSurfaces.length,
      INVENTORY_CONTRACTS.flatMap((entry) => entry.surfaces).length,
      'the audit must scan every closed-world surface',
    );
  });

  it('accepts derived exact set parity without a hardcoded total', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const stats = { providerCount: providers.size };
      assert.deepEqual([...providers].sort(), [...manifestProviders].sort());
      assert.equal(stats.providerCount, manifestProviders.size);
    `);
    assert.deepEqual(result.violations, []);
    assert.ok(result.scannedSurfaces[0].references > 0);
  });

  it('rejects an unmarked hardcoded inventory total', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      assert.equal(stats.providerCount, 552);
    `);
    assert.ok(codes(result).includes('unclassified-literal'));
  });

  it('follows aliases and helper parameters and evaluates computed literals', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const count = stats.providerCount;
      const expected = 500 + 52;
      function checkProviderCount(actual) {
        assert.equal(actual, expected);
      }
      checkProviderCount(count);
    `);
    assert.ok(codes(result).includes('unclassified-literal'));
  });

  it('follows object destructuring and string element access', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const { providerCount: count } = stats;
      const alsoCount = stats['providerCount'];
      assert.equal(count, 552);
      assert.equal(alsoCount, 552);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 2);
  });

  it('follows enclosing aliases, function returns, arrow helpers, and numeric wrappers', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const outer = stats.providerCount;
      const arrow = () => stats.providerCount;
      function helper() { return stats.providerCount; }
      function run() {
        assert.equal(outer, 552);
        assert.equal(arrow(), 552);
        assert.equal(helper(), 552);
        assert.equal(Number(outer), 552);
      }
      run();
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 4);
  });

  it('follows inventory and numeric arguments through parameterized helpers', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const arrowCheck = (actual) => assert.equal(actual, 552);
      function namedCheck(actual, expected) {
        assert.equal(actual, expected);
      }
      arrowCheck(stats.providerCount);
      namedCheck(stats.providerCount, 500 + 52);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 2);
  });

  it('follows array destructuring and generic identity wrappers', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const [arrayCount] = [stats.providerCount];
      const identity = (value) => value;
      const wrappedCount = identity(stats.providerCount);
      assert.equal(arrayCount, 552);
      assert.equal(wrappedCount, 552);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 2);
  });

  it('follows object and static generic identity wrappers', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const helpers = { identity(value) { return value; } };
      class Helpers { static identity(value) { return value; } }
      const objectWrapped = helpers.identity(stats.providerCount);
      const staticWrapped = Helpers.identity(stats.providerCount);
      assert.equal(objectWrapped, 552);
      assert.equal(staticWrapped, 552);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 2);
  });

  it('follows integer-preserving Math wrappers', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const truncated = Math.trunc(stats.providerCount);
      const floored = Math.floor(stats.providerCount);
      const ceiled = Math.ceil(stats.providerCount);
      const rounded = Math.round(stats.providerCount);
      const bounded = Math.max(stats.providerCount, 0);
      assert.equal(truncated, 552);
      assert.equal(floored, 552);
      assert.equal(ceiled, 552);
      assert.equal(rounded, 552);
      assert.equal(bounded, 552);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 5);
  });

  it('follows numeric constants through object properties and array elements', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const expected = { providers: 500 + 52 };
      const snapshots = [552];
      assert.ok(stats.providerCount > 0);
      assert.equal(stats.providerCount, expected.providers);
      assert.equal(stats.providerCount, snapshots[0]);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 2);
  });

  it('resolves forward numeric references and numeric destructuring', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const expected = { providers: TOTAL };
      const TOTAL = 500 + 52;
      const { providers: objectCount } = { providers: 552 };
      const [arrayCount] = [552];
      const numericObject = { providers: 552 };
      const { providers: referencedObjectCount } = numericObject;
      const numericArray = [552];
      const [referencedArrayCount] = numericArray;
      assert.equal(stats.providerCount, expected.providers);
      assert.equal(stats.providerCount, objectCount);
      assert.equal(stats.providerCount, arrayCount);
      assert.equal(stats.providerCount, referencedObjectCount);
      assert.equal(stats.providerCount, referencedArrayCount);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 5);
  });

  it('follows inventory aliases through object spreads', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      assert.ok(stats.providerCount > 0);
      const snapshot = { ...stats };
      assert.equal(snapshot.providerCount, 552);
    `);
    assert.ok(codes(result).includes('unclassified-literal'));
  });

  it('does not exempt an exact inventory of one', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      assert.equal(stats.providerCount, 1);
    `);
    assert.ok(codes(result).includes('unclassified-literal'));
  });

  it('does not exempt exact zero or a vacuous greater-than-or-equal zero floor', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      assert.equal(stats.providerCount, 0);
      assert.ok(stats.providerCount >= 0);
    `);
    assert.equal(codes(result).filter((code) => code === 'unclassified-literal').length, 2);
  });

  it('accepts a semantic non-empty assertion against zero', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      assert.ok(stats.providerCount > 0);
    `);
    assert.deepEqual(result.violations, []);
  });

  it('rejects an exact inventory total embedded in a positive prose regex', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const stats = { providerCount: '552 providers' };
      assert.match(stats.providerCount, /552 providers/);
    `);
    assert.ok(codes(result).includes('unclassified-literal'));
  });

  it('does not treat a rejected stale prose total as a positive count contract', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      const stats = { providerCount: 'registry-derived providers' };
      assert.doesNotMatch(stats.providerCount, /552 providers/);
    `);
    assert.deepEqual(result.violations, []);
  });

  it('fails closed on a parse error', () => {
    const result = auditFixture(`
      const value = stats.providerCount;
      assert.equal(value, 552;
    `);
    assert.ok(codes(result).includes('parse-error'));
  });

  it('fails closed when selector extraction is empty', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      assert.equal(unrelatedValue, derivedValue);
    `);
    assert.ok(codes(result).includes('empty-extraction'));
  });

  it('fails closed when a registered surface is missing', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'wm-inventory-count-contract-missing-'));
    const result = auditInventoryCountContracts({ rootDir, contracts: fixtureContract() });
    assert.ok(codes(result).includes('missing-surface'));
  });

  it('rejects a retained floor without a named product promise', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      // inventory-contract: fixture-providers; classification: floor; reason: catalog should be useful
      assert.ok(stats.providerCount >= 2);
    `, { action: 'keep', classifications: ['floor', 'named-member'] });
    assert.ok(codes(result).includes('unsupported-floor'));
  });

  it('accepts a retained floor only with its classification, promise, and reason', () => {
    const result = auditFixture(`
      import assert from 'node:assert/strict';
      // inventory-contract: fixture-providers; classification: floor; promise: two independent official providers; reason: one source cannot provide redundancy
      assert.ok(stats.providerCount >= 2);
    `, { action: 'keep', classifications: ['floor', 'named-member'] });
    assert.deepEqual(result.violations, []);
  });
});
