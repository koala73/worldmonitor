import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');

// ─── Edge endpoint ──────────────────────────────────────────────────────────

describe('Country products endpoint (api/supply-chain/v1/country-products.ts)', () => {
  const filePath = join(root, 'api', 'supply-chain', 'v1', 'country-products.ts');
  const src = readFileSync(filePath, 'utf-8');

  it('exports edge config with runtime: edge', () => {
    assert.ok(
      src.includes("runtime: 'edge'"),
      'country-products.ts: must export edge config with runtime: "edge"',
    );
  });

  it('has a default export handler function', () => {
    assert.ok(
      /export\s+default\s+async\s+function\s+handler/.test(src),
      'country-products.ts: must have a default async function handler export',
    );
  });

  it('returns 405 for non-GET requests', () => {
    assert.ok(
      src.includes("req.method !== 'GET'") || src.includes('req.method !== "GET"'),
      'country-products.ts: must check for GET method and return 405 for other methods',
    );
    assert.ok(
      src.includes('status: 405'),
      'country-products.ts: must return 405 status for non-GET',
    );
  });

  it('validates iso2 parameter with /^[A-Z]{2}$/ pattern', () => {
    assert.ok(
      src.includes('[A-Z]{2}'),
      'country-products.ts: must validate iso2 with a two-uppercase-letter regex',
    );
  });

  it('returns 400 for invalid iso2', () => {
    assert.ok(
      src.includes('status: 400'),
      'country-products.ts: must return 400 for invalid or missing iso2',
    );
  });

  it('uses isCallerPremium for PRO gating', () => {
    assert.ok(
      src.includes('isCallerPremium'),
      'country-products.ts: must use isCallerPremium for PRO-gating',
    );
    const importIdx = src.indexOf('isCallerPremium');
    const callIdx = src.indexOf('isCallerPremium(req)');
    assert.ok(
      importIdx !== -1 && callIdx !== -1,
      'country-products.ts: must import and invoke isCallerPremium(req)',
    );
  });

  it('returns 403 for non-PRO users', () => {
    assert.ok(
      src.includes('status: 403'),
      'country-products.ts: must return 403 for non-PRO callers',
    );
    assert.ok(
      src.includes('PRO subscription required'),
      'country-products.ts: 403 response must include descriptive error message',
    );
  });

  it('uses private Cache-Control (not public) for successful responses', () => {
    assert.ok(
      src.includes("'Cache-Control': 'private"),
      'country-products.ts: Cache-Control for PRO data must be private, not public',
    );
    assert.ok(
      !src.includes("'Cache-Control': 'public"),
      'country-products.ts: must not use public Cache-Control for PRO-gated data',
    );
  });

  it('Vary header includes Authorization', () => {
    assert.ok(
      src.includes("'Vary'") || src.includes('"Vary"'),
      'country-products.ts: must include Vary header',
    );
    assert.ok(
      src.includes('Authorization'),
      'country-products.ts: Vary header must include Authorization for PRO-gated responses',
    );
  });

  it('non-PRO/empty-data path uses no-store cache control', () => {
    assert.ok(
      src.includes('no-store'),
      'country-products.ts: empty data / fallback path must use no-store cache control',
    );
  });

  it('reads from Upstash Redis via readJsonFromUpstash', () => {
    assert.ok(
      src.includes('readJsonFromUpstash'),
      'country-products.ts: must read cached data from Upstash Redis',
    );
  });

  it('passes a timeout to readJsonFromUpstash', () => {
    const match = src.match(/readJsonFromUpstash\(\s*key\s*,\s*(\d[\d_]*)\s*\)/);
    assert.ok(
      match,
      'country-products.ts: must pass a timeout parameter to readJsonFromUpstash to bound Redis reads',
    );
    const timeout = Number(match[1].replace(/_/g, ''));
    assert.ok(
      timeout > 0 && timeout <= 10_000,
      `country-products.ts: readJsonFromUpstash timeout should be reasonable (got ${timeout}ms)`,
    );
  });

  it('iso2 validation happens after PRO gate (prevents free users probing keys)', () => {
    const proIdx = src.indexOf('isCallerPremium');
    const isoIdx = src.indexOf('[A-Z]{2}');
    assert.ok(
      proIdx < isoIdx,
      'country-products.ts: PRO gate must come before iso2 validation to prevent free users probing parameter patterns',
    );
  });
});

// ─── Seeder structure ────────────────────────────────────────────────────────

describe('Comtrade bilateral HS4 seeder (scripts/seed-comtrade-bilateral-hs4.mjs)', () => {
  const filePath = join(root, 'scripts', 'seed-comtrade-bilateral-hs4.mjs');
  const src = readFileSync(filePath, 'utf-8');

  it('uses acquireLockSafely for distributed locking', () => {
    assert.ok(
      src.includes('acquireLockSafely'),
      'seeder: must use acquireLockSafely to prevent concurrent runs',
    );
  });

  it('calls releaseLock in a finally block', () => {
    const finallyIdx = src.lastIndexOf('finally');
    const releaseIdx = src.indexOf('releaseLock', finallyIdx);
    assert.ok(
      finallyIdx !== -1 && releaseIdx !== -1 && releaseIdx > finallyIdx,
      'seeder: must call releaseLock in a finally block to guarantee lock cleanup',
    );
  });

  it('has isMain guard at the bottom (prevents automatic execution on import)', () => {
    assert.ok(
      src.includes("process.argv[1]?.endsWith('seed-comtrade-bilateral-hs4.mjs')"),
      'seeder: must have isMain guard checking process.argv[1]',
    );
    const isMainIdx = src.indexOf('isMain');
    const mainCallIdx = src.indexOf('main()', isMainIdx);
    assert.ok(
      isMainIdx !== -1 && mainCallIdx !== -1,
      'seeder: isMain guard must gate the main() call',
    );
  });

  it('reads COMTRADE_API_KEYS from environment', () => {
    assert.ok(
      src.includes('process.env.COMTRADE_API_KEYS'),
      'seeder: must read COMTRADE_API_KEYS from environment for API authentication',
    );
  });

  it('implements key rotation via getNextKey pattern', () => {
    assert.ok(
      src.includes('getNextKey'),
      'seeder: must implement getNextKey for API key rotation across requests',
    );
    assert.ok(
      src.includes('keyIndex'),
      'seeder: key rotation must track index via keyIndex',
    );
    assert.ok(
      src.includes('COMTRADE_KEYS.length'),
      'seeder: key rotation must cycle through all available keys',
    );
  });

  it('TTL_SECONDS is 259200 (72 hours)', () => {
    assert.ok(
      src.includes('TTL_SECONDS = 259200'),
      'seeder: TTL_SECONDS must be 259200 (72h) to match the cache interval',
    );
  });

  it('META_KEY follows seed-meta: convention', () => {
    const match = src.match(/META_KEY\s*=\s*'(seed-meta:[^']+)'/);
    assert.ok(
      match,
      'seeder: META_KEY must follow the seed-meta: prefix convention',
    );
    assert.strictEqual(
      match[1],
      'seed-meta:comtrade:bilateral-hs4',
      'seeder: META_KEY must be seed-meta:comtrade:bilateral-hs4',
    );
  });

  it('KEY_PREFIX follows expected pattern', () => {
    const match = src.match(/KEY_PREFIX\s*=\s*'([^']+)'/);
    assert.ok(
      match,
      'seeder: KEY_PREFIX must be defined',
    );
    assert.strictEqual(
      match[1],
      'comtrade:bilateral-hs4:',
      'seeder: KEY_PREFIX must be comtrade:bilateral-hs4:',
    );
  });

  it('defines exactly 20 HS4 codes', () => {
    const match = src.match(/HS4_CODES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(match, 'seeder: HS4_CODES array must be defined');
    const codes = match[1].match(/'(\d{4})'/g);
    assert.ok(codes, 'seeder: HS4_CODES must contain quoted 4-digit codes');
    assert.strictEqual(
      codes.length,
      20,
      `seeder: HS4_CODES must have exactly 20 codes, got ${codes.length}`,
    );
  });

  it('does NOT write empty data to Redis on fetch failure (preserves existing data)', () => {
    assert.ok(
      src.includes('preserving existing data'),
      'seeder: catch block must log that existing data is preserved on failure',
    );
    const catchBlock = src.slice(
      src.indexOf("fetch failed, preserving existing data"),
    );
    assert.ok(
      catchBlock.includes('failedCount++'),
      'seeder: failed fetches must increment failedCount without writing empty data to Redis',
    );
    assert.ok(
      !catchBlock.startsWith('commands.push'),
      'seeder: catch block must NOT push SET commands for failed countries',
    );
  });

  it('handles 429 rate limiting with sleep and retry', () => {
    assert.ok(
      src.includes('429'),
      'seeder: must detect HTTP 429 rate limit responses',
    );
    assert.ok(
      src.includes('rate-limited'),
      'seeder: must log rate limit events',
    );
    // Matches bare `sleep(60_000)` or indirected `_retrySleep(60_000)` — the
    // latter is the test-injectable form used so retry unit tests don't
    // actually sleep 60s. Either form preserves the 60s production cadence.
    assert.ok(
      /\b(?:_retrySleep|sleep)\(60[_]?000\)/.test(src),
      'seeder: must wait 60 seconds on 429 before retrying',
    );
  });

  it('exports main() function for external invocation', () => {
    assert.ok(
      /export\s+async\s+function\s+main/.test(src),
      'seeder: must export main() for use by orchestration scripts',
    );
  });

  it('writes seed-meta with fetchedAt and recordCount fields', () => {
    assert.ok(
      src.includes('fetchedAt'),
      'seeder: seed-meta must include fetchedAt timestamp',
    );
    assert.ok(
      src.includes('recordCount'),
      'seeder: seed-meta must include recordCount',
    );
  });

  it('extends TTL on lock-skipped path (prevents stale data when another instance runs)', () => {
    const skippedIdx = src.indexOf('lock.skipped');
    assert.ok(skippedIdx !== -1, 'seeder: must check lock.skipped');
    const extendIdx = src.indexOf('extendExistingTtl', skippedIdx);
    assert.ok(
      extendIdx !== -1 && extendIdx - skippedIdx < 300,
      'seeder: must call extendExistingTtl when lock is skipped',
    );
  });

  it('defines COMTRADE_REPORTER_OVERRIDES for all countries with non-standard Comtrade codes', () => {
    assert.ok(
      src.includes('COMTRADE_REPORTER_OVERRIDES'),
      'seeder: must define COMTRADE_REPORTER_OVERRIDES to handle non-standard Comtrade reporter codes',
    );
    assert.ok(
      src.includes("FR: '251'"),
      "seeder: COMTRADE_REPORTER_OVERRIDES must map FR to '251' (Comtrade reporter code, not UN M49 250)",
    );
    assert.ok(
      src.includes("IT: '381'"),
      "seeder: COMTRADE_REPORTER_OVERRIDES must map IT to '381' (Comtrade reporter code, not UN M49 380)",
    );
    assert.ok(
      src.includes("US: '842'"),
      "seeder: COMTRADE_REPORTER_OVERRIDES must map US to '842' (Comtrade reporter code, not UN M49 840)",
    );
  });

  it('applies COMTRADE_REPORTER_OVERRIDES before falling back to ISO2_TO_UN for reporter code lookup', () => {
    const overrideIdx = src.indexOf('COMTRADE_REPORTER_OVERRIDES[iso2]');
    const iso2ToUnIdx = src.indexOf('ISO2_TO_UN[iso2]', overrideIdx);
    assert.ok(
      overrideIdx !== -1,
      'seeder: must use COMTRADE_REPORTER_OVERRIDES when resolving the Comtrade reporter code',
    );
    assert.ok(
      iso2ToUnIdx !== -1 && iso2ToUnIdx > overrideIdx,
      'seeder: COMTRADE_REPORTER_OVERRIDES must be checked before ISO2_TO_UN (override takes precedence)',
    );
  });
});

// ─── Service function ────────────────────────────────────────────────────────

describe('fetchCountryProducts service (src/services/supply-chain/index.ts)', () => {
  const filePath = join(root, 'src', 'services', 'supply-chain', 'index.ts');
  const src = readFileSync(filePath, 'utf-8');

  it('fetchCountryProducts function exists', () => {
    assert.ok(
      /export\s+async\s+function\s+fetchCountryProducts/.test(src),
      'supply-chain/index.ts: must export fetchCountryProducts function',
    );
  });

  it('CountryProductsResponse type is exported', () => {
    assert.ok(
      src.includes('export interface CountryProductsResponse'),
      'supply-chain/index.ts: must export CountryProductsResponse interface',
    );
  });

  it('CountryProduct type is exported', () => {
    assert.ok(
      src.includes('export interface CountryProduct'),
      'supply-chain/index.ts: must export CountryProduct interface',
    );
  });

  it('ProductExporter type is exported', () => {
    assert.ok(
      src.includes('export interface ProductExporter'),
      'supply-chain/index.ts: must export ProductExporter interface',
    );
  });

  it('uses premiumFetch (not plain fetch) for PRO-gated data', () => {
    const fnStart = src.indexOf('async function fetchCountryProducts');
    const fnBody = src.slice(fnStart, src.indexOf('\n}\n', fnStart) + 3);
    assert.ok(
      fnBody.includes('premiumFetch'),
      'fetchCountryProducts: must use premiumFetch to attach auth credentials',
    );
    assert.ok(
      !fnBody.includes('globalThis.fetch('),
      'fetchCountryProducts: must not use globalThis.fetch directly for PRO endpoints',
    );
  });

  it('returns empty products array on error (graceful fallback)', () => {
    assert.ok(
      src.includes("products: [], fetchedAt: ''"),
      'fetchCountryProducts: emptyProducts fallback must have empty products array and empty fetchedAt',
    );
    const fnStart = src.indexOf('async function fetchCountryProducts');
    const fnBody = src.slice(fnStart, src.indexOf('\n}\n', fnStart) + 3);
    assert.ok(
      fnBody.includes('catch'),
      'fetchCountryProducts: must have catch block for graceful fallback',
    );
    assert.ok(
      fnBody.includes('emptyProducts'),
      'fetchCountryProducts: catch block must return emptyProducts',
    );
  });

  it('CountryProduct interface has expected fields', () => {
    const ifaceStart = src.indexOf('export interface CountryProduct');
    const ifaceEnd = src.indexOf('}', ifaceStart);
    const iface = src.slice(ifaceStart, ifaceEnd + 1);
    assert.ok(iface.includes('hs4: string'), 'CountryProduct must have hs4: string');
    assert.ok(iface.includes('description: string'), 'CountryProduct must have description: string');
    assert.ok(iface.includes('totalValue: number'), 'CountryProduct must have totalValue: number');
    assert.ok(iface.includes('topExporters: ProductExporter[]'), 'CountryProduct must have topExporters: ProductExporter[]');
    assert.ok(iface.includes('year: number'), 'CountryProduct must have year: number');
  });
});

// ─── CountryDeepDivePanel product imports ────────────────────────────────────

describe('CountryDeepDivePanel product imports section', () => {
  const filePath = join(root, 'src', 'components', 'CountryDeepDivePanel.ts');
  const src = readFileSync(filePath, 'utf-8');

  it('updateProductImports method exists as public', () => {
    assert.ok(
      src.includes('public updateProductImports'),
      'CountryDeepDivePanel: must have a public updateProductImports method',
    );
  });

  it('has product search/filter input', () => {
    assert.ok(
      src.includes("'cdp-product-search'") || src.includes('"cdp-product-search"'),
      'CountryDeepDivePanel: must create a search input element for product filtering',
    );
    assert.ok(
      src.includes("placeholder = 'Search products") || src.includes('placeholder = "Search products'),
      'CountryDeepDivePanel: product search input must have a search placeholder',
    );
  });

  it('implements filter logic on product list', () => {
    assert.ok(
      src.includes('.filter(p =>') || src.includes('.filter((p)'),
      'CountryDeepDivePanel: must filter products by search term',
    );
    assert.ok(
      src.includes('toLowerCase'),
      'CountryDeepDivePanel: filter must be case-insensitive via toLowerCase',
    );
  });

  it('PRO gate check (hasPremiumAccess) guards product imports card', () => {
    assert.ok(
      src.includes("import { hasPremiumAccess }"),
      'CountryDeepDivePanel: must import hasPremiumAccess for PRO gating',
    );
    const productImportsIdx = src.indexOf('productImportsCardBody');
    assert.ok(
      productImportsIdx !== -1,
      'CountryDeepDivePanel: must have productImportsCardBody',
    );
    const nearbyIsPro = src.slice(Math.max(0, productImportsIdx - 200), productImportsIdx + 300);
    assert.ok(
      nearbyIsPro.includes('isPro'),
      'CountryDeepDivePanel: productImportsCardBody must be gated by isPro check',
    );
  });

  it('uses textContent for product rendering (XSS-safe, no innerHTML)', () => {
    const renderStart = src.indexOf('private renderProductDetail');
    assert.ok(renderStart !== -1, 'CountryDeepDivePanel: must have private renderProductDetail method');
    const renderBody = src.slice(renderStart, src.indexOf('\n  }\n', renderStart + 100) + 5);
    assert.ok(
      renderBody.includes('.textContent'),
      'renderProductDetail: must use textContent for safe text rendering',
    );
    assert.ok(
      !renderBody.includes('.innerHTML'),
      'renderProductDetail: must not use innerHTML (XSS risk with user-influenced product data)',
    );
  });

  it('resetPanelContent clears productImportsBody', () => {
    const resetIdx = src.indexOf('private resetPanelContent');
    assert.ok(resetIdx !== -1, 'CountryDeepDivePanel: must have private resetPanelContent method');
    const resetBody = src.slice(resetIdx, src.indexOf('\n  }\n', resetIdx + 50) + 5);
    assert.ok(
      resetBody.includes('this.productImportsBody = null'),
      'resetPanelContent: must set productImportsBody to null',
    );
  });

  it('sectionCard is used for the product imports card', () => {
    assert.ok(
      src.includes("this.sectionCard('Product Imports'"),
      'CountryDeepDivePanel: product imports must use sectionCard for consistent card structure',
    );
  });

  it('product imports card is appended to the body grid', () => {
    assert.ok(
      src.includes('productImportsCard'),
      'CountryDeepDivePanel: productImportsCard must be appended to bodyGrid',
    );
  });
});
