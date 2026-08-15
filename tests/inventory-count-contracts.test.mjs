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
    const registeredIds = new Set(INVENTORY_CONTRACTS.map((entry) => entry.id));
    for (const requiredId of [
      'source-attribution-totals',
      'panel-discoverability',
      'mcp-output-schema-tools',
      'mcp-tool-annotations',
      'mcp-protocol-tools',
      'llms-mcp-tools',
      'openapi-server-specs',
      'openapi-security-specs',
      'openapi-jmespath-specs',
      'openapi-rate-limit-operations',
      'route-cache-tiers',
      'feed-client-server-catalogs',
      'regional-feed-promises',
      'feed-source-provenance',
      'locale-key-completeness',
      'food-stocks-locales',
      'market-tape-locales',
      'product-catalog-inventories',
      'agent-skills-index',
      'mcp-presets',
      'route-explorer-countries',
      'notification-country-registry',
      'consumer-price-health-markets',
      'iso2-country-registry',
      'public-fixed-algorithm-claims',
    ]) {
      assert.ok(registeredIds.has(requiredId), `missing required cross-domain contract ${requiredId}`);
    }
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
