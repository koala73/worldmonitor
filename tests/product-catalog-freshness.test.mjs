/**
 * Product catalog freshness tests.
 *
 * Verifies that generated files (products.generated.ts, tiers.json)
 * match the canonical catalog in convex/config/productCatalog.ts.
 * Bidirectional: checks generated→catalog AND catalog→generated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PRODUCT_ID_ALLOWED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];
const PRODUCT_ID_EXCLUDE_PATTERNS = [
  'node_modules',
  'dist/',
  '.git',
  '.claude/worktrees/',
  'convex/_generated/',
  'convex/config/productCatalog',
  'api/product-catalog',
  'api/_product-fallback-prices',
  'src/config/products.generated',
  'pro-test/src/generated/',
  'public/pro/',
  'tests/',
  'convex/__tests__/',
  'scripts/generate-product-config',
];

function isMissingPathError(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function collectRawProductIds(root, filesystem = {}) {
  const {
    readdir = readdirSync,
    stat = statSync,
    readFile = readFileSync,
  } = filesystem;
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = readdir(currentDir);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      let fileStat;
      try {
        fileStat = stat(fullPath);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      const checkPath = fileStat.isDirectory() ? `${relPath}/` : relPath;

      if (PRODUCT_ID_EXCLUDE_PATTERNS.some((pattern) => checkPath.includes(pattern))) {
        continue;
      }

      if (fileStat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const extIdx = entry.lastIndexOf('.');
      const ext = extIdx !== -1 ? entry.substring(extIdx) : '';
      if (!PRODUCT_ID_ALLOWED_EXTENSIONS.includes(ext) || entry.includes('.test.')) continue;

      let content;
      try {
        content = readFile(fullPath, 'utf8');
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      if (!content.includes('pdt_')) continue;

      content.split(/\r?\n/).forEach((line, index) => {
        if (line.includes('pdt_')) {
          results.push(`${relPath}:${index + 1}:${line}`);
        }
      });
    }
  }

  walk(root);
  return results;
}

describe('Product catalog freshness', () => {
  // Read generated files
  const generatedProductsSrc = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
  const tiersJson = JSON.parse(readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8'));
  const proLocalesDir = join(ROOT, 'pro-test/src/locales');
  const readProLocaleFiles = () => Object.fromEntries(
    readdirSync(proLocalesDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => [file, readFileSync(join(proLocalesDir, file), 'utf8')]),
  );

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

  it('generated products.ts includes typed plan limits', () => {
    assert.match(generatedProductsSrc, /export const PLAN_LIMITS = \{/, 'Missing PLAN_LIMITS export');
    assert.match(generatedProductsSrc, /"api_starter": \{"apiRequestsPerDay":1000,/, 'API Starter daily limit missing');
    assert.match(generatedProductsSrc, /"api_business": \{"apiRequestsPerDay":10000,/, 'API Business daily limit missing');
    assert.match(generatedProductsSrc, /"enterprise": \{"apiRequestsPerDay":null,/, 'Enterprise unlimited daily limit missing');
  });

  it('generated tiers expose plan limits for public plans', () => {
    const pro = tiersJson.find(t => t.name === 'Pro');
    const api = tiersJson.find(t => t.name === 'API');
    const ent = tiersJson.find(t => t.name === 'Enterprise');

    assert.equal(pro?.planLimits?.mcpCallsPerDay, 50, 'Pro MCP daily limit should be visible');
    assert.equal(api?.planLimits?.apiRequestsPerDay, 1000, 'API Starter daily limit should be visible');
    assert.equal(ent?.planLimits?.apiRequestsPerDay, null, 'Enterprise daily limit should be unlimited');
  });

  it('Enterprise tier is custom with contact CTA', () => {
    const ent = tiersJson.find(t => t.name === 'Enterprise');
    assert.ok(ent, 'Enterprise tier not found');
    assert.equal(ent.price, null, 'Enterprise price should be null');
    assert.equal(ent.cta, 'Contact Sales');
  });

  it('English pro locale pricing feature placeholders cover every publicVisible tier group', () => {
    const enLocale = JSON.parse(readFileSync(join(proLocalesDir, 'en.json'), 'utf8'));
    const pricingTiers = enLocale?.pricing?.tiers;
    assert.ok(
      pricingTiers && typeof pricingTiers === 'object' && !Array.isArray(pricingTiers),
      'en.json missing pricing.tiers',
    );

    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const blocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    const visibleGroups = new Set();
    for (const block of blocks) {
      if (block.includes('publicVisible: true')) {
        const groupMatch = block.match(/tierGroup:\s*['"]([^'"]+)['"]/);
        if (groupMatch) visibleGroups.add(groupMatch[1]);
      }
    }

    const groupToName = { free: 'Free', pro: 'Pro', api_starter: 'API', api_business: 'API Business', enterprise: 'Enterprise' };
    const groupToLocaleKey = { free: 'free', pro: 'pro', api_starter: 'api', api_business: 'apiBusiness', enterprise: 'enterprise' };
    const tiersByLocaleKey = new Map(tiersJson.map((tier) => [tier.localeKey, tier]));

    for (const group of visibleGroups) {
      const expectedName = groupToName[group];
      assert.ok(
        expectedName,
        'Catalog tier group ' + group + ' is publicVisible but has no expected generated tier name mapping in this test',
      );

      const localeKey = groupToLocaleKey[group];
      assert.ok(
        localeKey,
        'Catalog tier group ' + group + ' is publicVisible but has no expected pro locale key mapping in this test',
      );

      const generatedTier = tiersByLocaleKey.get(localeKey);
      assert.ok(
        generatedTier,
        'Missing generated tier for publicVisible catalog group ' + group + ' (expected localeKey ' + localeKey + ')',
      );
      assert.equal(
        generatedTier.name,
        expectedName,
        'Generated tier name mismatch for publicVisible catalog group ' + group,
      );

      const localeTier = pricingTiers[localeKey];
      assert.ok(
        localeTier && typeof localeTier === 'object' && !Array.isArray(localeTier),
        'en.json missing pricing.tiers.' + localeKey + ' for publicVisible catalog group ' + group,
      );
      assert.ok(
        Array.isArray(localeTier.features),
        'en.json pricing.tiers.' + localeKey + '.features must be an array',
      );
      assert.deepEqual(
        localeTier.features,
        generatedTier.features,
        'en.json pricing.tiers.' + localeKey + '.features is not synced to generated tier features for ' + group,
      );
    }
  });

  it('Pro locale MCP pricing feature mentions Claude Desktop and the call allowance', () => {
    for (const [file, src] of Object.entries(readProLocaleFiles())) {
      const locale = JSON.parse(src);
      const features = locale?.pricing?.tiers?.pro?.features;
      assert.ok(Array.isArray(features), `${file} missing pricing.tiers.pro.features`);
      const feature = features.find((value) => /\bMCP\b/.test(value));
      assert.equal(typeof feature, 'string', `${file} missing a Pro pricing feature mentioning MCP`);
      assert.match(feature, /\bMCP\b/, `${file} Pro MCP feature should mention MCP`);
      assert.match(feature, /Claude Desktop/, `${file} Pro MCP feature should mention Claude Desktop`);
      assert.match(feature, /\b50\b/, `${file} Pro MCP feature should mention the 50 calls/day allowance`);
    }
  });

  it('product catalog fallbacks advertise the canonical Pro MCP feature', () => {
    const expectedFeature = tiersJson.find((tier) => tier.localeKey === 'pro')?.features?.find((f) => /\bMCP\b/.test(f));
    assert.equal(
      expectedFeature,
      'MCP + SDK access for Claude Desktop & other AI clients (50 calls/day)',
      'generated Pro MCP feature changed; update fallback catalog copy and this assertion together',
    );

    for (const relPath of ['api/product-catalog.js', 'scripts/ais-relay.cjs']) {
      const src = readFileSync(join(ROOT, relPath), 'utf8');
      assert.ok(src.includes(expectedFeature), `${relPath} is missing the canonical Pro MCP feature`);
      assert.ok(!src.includes('MCP data connectors'), `${relPath} still contains stale Pro MCP feature copy`);
    }
  });

  // PR #4946 P0 regression guard: the Railway seeder (scripts/ais-relay.cjs
  // "DodoPrices" loop) writes the Redis payload that /api/product-catalog
  // serves on every cache HIT — in steady state it WINS over the edge
  // fallback. When #4945 published api_business, the seeder's hardcoded
  // 4-tier mirror silently reverted the live /pro page to 4 cards the
  // moment the fetch resolved. These parity checks make every priced,
  // publicVisible catalog entry provably present in the seeder mirror.
  it('ais-relay Dodo seeder mirrors every priced publicVisible catalog entry', () => {
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const relaySrc = readFileSync(join(ROOT, 'scripts/ais-relay.cjs'), 'utf8');

    // Catalog truth: publicVisible entries with a Dodo product + real price.
    const entries = [];
    for (const block of catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1)) {
      if (!block.includes('publicVisible: true')) continue;
      const id = block.match(/dodoProductId:\s*["']([^"']+)["']/)?.[1];
      const group = block.match(/tierGroup:\s*["']([^"']+)["']/)?.[1];
      const cents = block.match(/priceCents:\s*(\d+)/)?.[1];
      if (id && group && cents && Number(cents) > 0) {
        entries.push({ id, group, cents: Number(cents) });
      }
    }
    assert.ok(entries.length >= 5, 'expected at least 5 priced publicVisible catalog entries');

    const relayIds = [...relaySrc.matchAll(/'(pdt_[A-Za-z0-9]+)'/g)].map((m) => m[1]);
    const publicGroupsMatch = relaySrc.match(/const publicGroups = \[([^\]]+)\]/);
    assert.ok(publicGroupsMatch, 'ais-relay.cjs must declare publicGroups');
    const relayGroups = [...publicGroupsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    for (const { id, group, cents } of entries) {
      assert.ok(relayIds.includes(id),
        `ais-relay.cjs DODO_PRODUCT_IDS is missing ${id} (${group}) — the Redis-seeded catalog will drop this tier from the live /pro page`);
      assert.ok(new RegExp(`'${id}':\\s*\\{\\s*tierGroup:\\s*'${group}'`).test(relaySrc),
        `ais-relay.cjs DODO_PRODUCT_META is missing/mismatched for ${id} (${group})`);
      assert.ok(new RegExp(`'${id}':\\s*${cents}\\b`).test(relaySrc),
        `ais-relay.cjs DODO_FALLBACK_PRICES for ${id} must be ${cents} to match productCatalog.ts`);
      assert.ok(relayGroups.includes(group),
        `ais-relay.cjs publicGroups is missing '${group}' — tier will never render from the seeded payload`);
    }

    // Mirror↔mirror: the seeder and the edge fallback must agree on the
    // public tier list (order included — it is the /pro card order).
    const edgeSrc = readFileSync(join(ROOT, 'api/product-catalog.js'), 'utf8');
    const edgeGroupsMatch = edgeSrc.match(/const PUBLIC_TIER_GROUPS = \[([^\]]+)\]/);
    assert.ok(edgeGroupsMatch, 'api/product-catalog.js must declare PUBLIC_TIER_GROUPS');
    const edgeGroups = [...edgeGroupsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(relayGroups, edgeGroups,
      'ais-relay publicGroups and api/product-catalog PUBLIC_TIER_GROUPS have drifted apart');

    // Feature-array parity (#4974): the XLSX phantom survived in copy
    // because nothing compared the mirrors' features lists. Every tier's
    // features must be IDENTICAL between the seeder and the edge fallback,
    // and must match the generated tiers.json (catalog marketingFeatures)
    // for the tiers it carries.
    const extractFeatures = (src, label) => {
      const map = {};
      for (const m of src.matchAll(/(\w+):\s*\{[^{}]*?features:\s*\[([^\]]*)\]/g)) {
        map[m[1]] = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((f) => f[1]);
      }
      assert.ok(Object.keys(map).length >= 5, label + ': expected ≥5 tier feature lists');
      return map;
    };
    const relayFeatures = extractFeatures(relaySrc, 'ais-relay.cjs');
    const edgeFeatures = extractFeatures(edgeSrc, 'api/product-catalog.js');
    assert.deepEqual(relayFeatures, edgeFeatures,
      'tier features have drifted between ais-relay.cjs and api/product-catalog.js');
    const tiersByName = new Map(tiersJson.map((tier) => [tier.name, tier]));
    for (const [group, features] of Object.entries(edgeFeatures)) {
      const name = { free: 'Free', pro: 'Pro', api_starter: 'API', api_business: 'API Business', enterprise: 'Enterprise' }[group];
      const generated = tiersByName.get(name);
      if (!generated) continue;
      assert.deepEqual(features, generated.features,
        'features for ' + group + ' drifted between the mirrors and generated tiers.json (catalog marketingFeatures)');
    }

    // Both mirrors must carry the generated localeKey for every public tier
    // so translations survive the live payload replacing static tiers.json
    // (PricingSection falls back to name.toLowerCase(), which breaks for
    // multi-word names like 'API Business').
    for (const localeKey of ['free', 'pro', 'api', 'apiBusiness', 'enterprise']) {
      for (const [label, src] of [['ais-relay.cjs', relaySrc], ['api/product-catalog.js', edgeSrc]]) {
        assert.ok(src.includes(`localeKey: '${localeKey}'`),
          `${label} TIER_CONFIG is missing localeKey '${localeKey}'`);
      }
    }
  });

  it('generated files and pro locale placeholders are fresh (re-running generator produces same output)', () => {
    // Capture current generated content
    const currentProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const currentTiers = readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8');
    const currentFallback = readFileSync(join(ROOT, 'api/_product-fallback-prices.js'), 'utf8');
    const currentLocales = readProLocaleFiles();

    // Re-run generator
    execSync('npx tsx scripts/generate-product-config.mjs', { cwd: ROOT, stdio: 'pipe' });

    // Compare
    const freshProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const freshTiers = readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8');
    const freshFallback = readFileSync(join(ROOT, 'api/_product-fallback-prices.js'), 'utf8');
    const freshLocales = readProLocaleFiles();

    assert.equal(currentProducts, freshProducts, 'products.generated.ts is stale — run: npx tsx scripts/generate-product-config.mjs');
    assert.equal(currentTiers, freshTiers, 'tiers.json is stale — run: npx tsx scripts/generate-product-config.mjs');

    assert.equal(currentFallback, freshFallback, '_product-fallback-prices.js is stale — run: npx tsx scripts/generate-product-config.mjs');
    assert.deepEqual(currentLocales, freshLocales, 'pro locale pricing feature placeholders are stale — run: npx tsx scripts/generate-product-config.mjs');
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
    const groupToName = { free: 'Free', pro: 'Pro', api_starter: 'API', api_business: 'API Business', enterprise: 'Enterprise' };
    for (const group of visibleGroups) {
      const expectedName = groupToName[group] || group;
      assert.ok(
        tierNames.includes(expectedName),
        `Catalog tier group "${group}" is publicVisible but missing from tiers.json (expected name: "${expectedName}")`,
      );
    }
  });

  it('fallback prices file has entries for all self-serve products', () => {
    const fallbackSrc = readFileSync(join(ROOT, 'api/_product-fallback-prices.js'), 'utf8');
    const fallbackIds = [...fallbackSrc.matchAll(/'(pdt_[^']+)'/g)].map(m => m[1]);

    // Every self-serve product with a price should have a fallback
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const blocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    for (const block of blocks) {
      const isSelfServe = block.includes('selfServe: true');
      const idMatch = block.match(/dodoProductId:\s*["']([^"']+)["']/);
      const priceMatch = block.match(/priceCents:\s*(\d+)/);
      if (isSelfServe && idMatch && priceMatch && Number(priceMatch[1]) > 0) {
        assert.ok(
          fallbackIds.includes(idMatch[1]),
          `Self-serve product ${idMatch[1]} missing from _product-fallback-prices.js`,
        );
      }
    }
  });
});

describe('Product ID guard', () => {
  it('ignores a file deleted after directory enumeration', () => {
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const results = collectRawProductIds(ROOT, {
      readdir: () => ['gone.mjs'],
      stat: () => { throw missing; },
    });

    assert.deepEqual(results, []);
  });

  it('does not suppress stable-source read errors', () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    assert.throws(
      () => collectRawProductIds(ROOT, {
        readdir: () => ['unreadable.mjs'],
        stat: () => ({ isDirectory: () => false }),
        readFile: () => { throw denied; },
      }),
      /permission denied/,
    );
  });

  it('ignores generated build artifacts', () => {
    const distDir = join(ROOT, 'dist');
    const builtAsset = join(distDir, 'panel.js');
    const results = collectRawProductIds(ROOT, {
      readdir: (path) => path === ROOT ? ['dist'] : ['panel.js'],
      stat: (path) => ({ isDirectory: () => path === distDir }),
      readFile: (path) => {
        assert.equal(path, builtAsset);
        return "const productId = 'pdt_built_artifact';";
      },
    });

    assert.deepEqual(results, []);
  });

  it('no raw pdt_ strings outside allowed paths', () => {
    const results = collectRawProductIds(ROOT);

    if (results.length > 0) {
      assert.fail(
        `Found pdt_ strings outside allowed paths. These should import from the catalog:\n${results.join('\n')}`,
      );
    }
  });
});
