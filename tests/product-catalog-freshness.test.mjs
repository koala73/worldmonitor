/**
 * Product catalog freshness tests.
 *
 * Verifies that generated files (products.generated.ts, tiers.json)
 * match the canonical catalog in convex/config/productCatalog.ts.
 * Bidirectional: checks generated→catalog AND catalog→generated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

describe('Product catalog freshness', () => {
  // Read generated files
  const generatedProductsSrc = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
  const tiersJson = JSON.parse(readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8'));

  // Extract product IDs from generated TS (regex since we can't import TS in node:test)
  const generatedProductIds = [...generatedProductsSrc.matchAll(/'(pdt_[^']+)'/g)].map(m => m[1]);

  it('generated products.ts contains valid product IDs', () => {
    assert.ok(generatedProductIds.length >= 4, `Expected at least 4 product IDs, got ${generatedProductIds.length}`);
    for (const id of generatedProductIds) {
      assert.match(id, /^pdt_/, `Product ID should start with pdt_: ${id}`);
    }
  });

  it('generated tiers.json has expected tier structure', () => {
    assert.ok(Array.isArray(tiersJson), 'tiers.json should be an array');
    assert.ok(tiersJson.length >= 3, `Expected at least 3 tiers, got ${tiersJson.length}`);

    const names = tiersJson.map(t => t.name);
    assert.ok(names.includes('Free'), 'Missing Free tier');
    assert.ok(names.includes('Pro'), 'Missing Pro tier');
    assert.ok(names.includes('API'), 'Missing API tier');
  });

  it('Pro tier has monthly and annual prices', () => {
    const pro = tiersJson.find(t => t.name === 'Pro');
    assert.ok(pro, 'Pro tier not found');
    assert.ok(typeof pro.monthlyPrice === 'number', 'Pro should have monthlyPrice');
    assert.ok(typeof pro.annualPrice === 'number', 'Pro should have annualPrice');
    assert.ok(pro.monthlyProductId, 'Pro should have monthlyProductId');
    assert.ok(pro.annualProductId, 'Pro should have annualProductId');
  });

  it('API tier has monthly and annual prices', () => {
    const api = tiersJson.find(t => t.name === 'API');
    assert.ok(api, 'API tier not found');
    assert.ok(typeof api.monthlyPrice === 'number', 'API should have monthlyPrice');
    assert.ok(typeof api.annualPrice === 'number', 'API should have annualPrice');
  });

  it('Enterprise tier is custom with contact CTA', () => {
    const ent = tiersJson.find(t => t.name === 'Enterprise');
    assert.ok(ent, 'Enterprise tier not found');
    assert.equal(ent.price, null, 'Enterprise price should be null');
    assert.equal(ent.cta, 'Contact Sales');
  });

  it('every currentForCheckout catalog entry appears in generated products', () => {
    // Reverse check: catalog → generated. Catches generator silently dropping entries.
    // Import catalog via the generator's own output (re-run to get fresh data)
    execSync('npx tsx scripts/generate-product-config.mjs', { cwd: ROOT, stdio: 'pipe' });
    const freshProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const allGeneratedIds = [...freshProducts.matchAll(/'(pdt_[^']+)'/g)].map(m => m[1]);

    // Read catalog entries that should be in generated (currentForCheckout with a dodoProductId)
    // Parse from the catalog source file since we can't import TS
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const checkoutBlocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    for (const block of checkoutBlocks) {
      const hasCheckout = block.includes('currentForCheckout: true');
      const idMatch = block.match(/dodoProductId:\s*["']([^"']+)["']/);
      if (hasCheckout && idMatch) {
        assert.ok(
          allGeneratedIds.includes(idMatch[1]),
          `Catalog entry with dodoProductId ${idMatch[1]} has currentForCheckout=true but is missing from products.generated.ts`,
        );
      }
    }
  });

  it('every publicVisible tier group appears in generated tiers.json', () => {
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const tierNames = tiersJson.map(t => t.name);

    // Extract publicVisible tier groups from catalog
    const blocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    const visibleGroups = new Set();
    for (const block of blocks) {
      if (block.includes('publicVisible: true')) {
        const groupMatch = block.match(/tierGroup:\s*["']([^"']+)["']/);
        if (groupMatch) visibleGroups.add(groupMatch[1]);
      }
    }

    // Each visible group should have a corresponding tier in the JSON
    // Map group names to expected display names
    const groupToName = { free: 'Free', pro: 'Pro', api_starter: 'API', enterprise: 'Enterprise' };
    for (const group of visibleGroups) {
      const expectedName = groupToName[group] || group;
      assert.ok(
        tierNames.includes(expectedName),
        `Catalog tier group "${group}" is publicVisible but missing from tiers.json (expected name: "${expectedName}")`,
      );
    }
  });

  it('generated files are fresh (re-running generator produces same output)', () => {
    // Capture current generated content
    const currentProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const currentTiers = readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8');

    // Re-run generator
    execSync('npx tsx scripts/generate-product-config.mjs', { cwd: ROOT, stdio: 'pipe' });

    // Compare
    const freshProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const freshTiers = readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8');

    assert.equal(currentProducts, freshProducts, 'products.generated.ts is stale — run: npx tsx scripts/generate-product-config.mjs');
    assert.equal(currentTiers, freshTiers, 'tiers.json is stale — run: npx tsx scripts/generate-product-config.mjs');
  });
});

describe('Product ID guard', () => {
  it('no raw pdt_ strings outside allowed paths', () => {
    // Allowed paths: catalog, generated files, tests, built assets
    const result = execSync(
      `grep -rn 'pdt_' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' . ` +
      `| grep -v node_modules ` +
      `| grep -v 'convex/config/productCatalog' ` +
      `| grep -v 'src/config/products.generated' ` +
      `| grep -v 'pro-test/src/generated/' ` +
      `| grep -v 'public/pro/' ` +
      `| grep -v 'tests/' ` +
      `| grep -v 'convex/__tests__/' ` +
      `| grep -v 'scripts/generate-product-config' ` +
      `| grep -v '.test.' ` +
      `|| true`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();

    if (result) {
      assert.fail(
        `Found pdt_ strings outside allowed paths. These should import from the catalog:\n${result}`,
      );
    }
  });
});
