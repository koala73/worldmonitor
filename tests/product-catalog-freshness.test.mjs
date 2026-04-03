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
