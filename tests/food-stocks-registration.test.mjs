import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { PSD_COMMODITIES, normalizePsdCountryCode } from '../scripts/_food-stocks-helpers.mjs';
import { normalizeFoodStocksCountry } from '../server/worldmonitor/resilience/v1/_food-stocks-query.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function supportedLocaleFiles() {
  const source = read('src/services/i18n.ts');
  const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
  assert.ok(declaration, 'SUPPORTED_LANGUAGES declaration must be extractable');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => `${match[1]}.json`).sort();
}

describe('food stocks production registration (#6440)', () => {
  it('pairs the Redis data key with seed-meta and a 60-day fetch window', () => {
    assert.equal(__testing__.STANDALONE_KEYS.foodStocks, 'resilience:food-stocks:v1');
    assert.equal(__testing__.SEED_META.foodStocks.key, 'seed-meta:resilience:food-stocks');
    assert.equal(__testing__.SEED_META.foodStocks.maxStaleMin, 86400);
    assert.equal(__testing__.SEED_META.foodStocks.cutover?.mode, 'expiring-ack');
    assert.equal(__testing__.SEED_META.foodStocks.cutover?.issue, 6440);
    assert.match(read('api/seed-health.js'), /'resilience:food-stocks':\s*\{ key: 'seed-meta:resilience:food-stocks',\s*intervalMin: 43200/);
  });

  it('schedules the seeder in the resilience bundle and watches its files', () => {
    assert.match(
      read('scripts/seed-bundle-resilience.mjs'),
      /label: 'Food-Stocks'[\s\S]*script: 'seed-food-stocks\.mjs'[\s\S]*seedMetaKey: 'resilience:food-stocks'[\s\S]*intervalMs: 30 \* DAY/,
    );
    const railway = JSON.parse(read('scripts/railway-services.json'));
    const bundle = railway.find((entry) => entry.service === 'seed-bundle-resilience');
    assert.ok(bundle?.watchPatterns.includes('scripts/seed-food-stocks.mjs'));
    assert.ok(bundle?.watchPatterns.includes('scripts/_food-stocks-helpers.mjs'));
    assert.match(read('scripts/seed-food-stocks.mjs'), /lockTtlMs:\s*540_000/);
    // fetchPhaseTimeoutMs must stay STRICTLY below lockTtlMs so the lock still
    // covers the publish phase after a full-budget fetch.
    assert.match(read('scripts/seed-food-stocks.mjs'), /fetchPhaseTimeoutMs:\s*420_000/);
    // A rejected snapshot must be a hard failure, not a quiet period: the
    // validate-skip path otherwise stamps fresh seed-meta and the bundle runner
    // skips this section for intervalMs*0.8 (24 days) after one transient outage.
    assert.match(read('scripts/seed-food-stocks.mjs'), /emptyDataIsFailure:\s*true/);
    assert.match(read('scripts/seed-food-stocks.mjs'), /USDA_FAS_PSD_API_KEY/);
    assert.match(read('scripts/seed-food-stocks.mjs'), /https:\/\/api\.fas\.usda\.gov\/api\/psd/);
    assert.match(read('scripts/seed-food-stocks.mjs'), /'X-Api-Key': apiKey/);
  });

  it('gates the RPC as premium + entitlement before generate', () => {
    assert.ok(PREMIUM_RPC_PATHS.has('/api/resilience/v1/get-food-stocks'));
    assert.match(read('server/_shared/entitlement-check.ts'), /'\/api\/resilience\/v1\/get-food-stocks': 1/);
    assert.match(read('server/gateway.ts'), /'\/api\/resilience\/v1\/get-food-stocks': 'slow'/);
  });
});

describe('food stocks i18n + normalizer parity', () => {
  const en = JSON.parse(read('src/locales/en.json'));

  it('every PSD commodity slug has a matching countryBrief.commodities key', () => {
    // The label lookup is a TEMPLATE literal
    // (`countryBrief.commodities.${slug}`), so the repo's literal-only i18n key
    // scan cannot see it. Adding a seventh commodity without a locale key would
    // silently degrade the card to the raw slug.
    const slugs = Object.keys(PSD_COMMODITIES);
    assert.ok(slugs.includes('wheat'), 'the critical wheat commodity must remain registered');
    for (const slug of slugs) {
      assert.equal(
        typeof en.countryBrief?.commodities?.[slug],
        'string',
        `missing countryBrief.commodities.${slug} in en.json`,
      );
    }
  });

  it('every locale carries the food-stocks UI keys', () => {
    const required = [
      'foodStocks', 'foodStocksHelp', 'loadingFoodStocks', 'foodStocksUnavailable',
      'foodStocksProLocked', 'foodStocksCommodity', 'foodStocksMarketingYear',
      'foodStocksRatio', 'foodStocksWorld',
    ];
    const locales = readdirSync(new URL('../src/locales/', import.meta.url))
      .filter((f) => f.endsWith('.json') && !f.endsWith('.shell.json'));
    assert.deepEqual(locales.sort(), supportedLocaleFiles(), 'food-stocks locale sweep must match SUPPORTED_LANGUAGES exactly');
    for (const file of locales) {
      const cb = JSON.parse(read(`src/locales/${file}`)).countryBrief;
      for (const key of required) {
        assert.equal(typeof cb?.[key], 'string', `${file} is missing countryBrief.${key}`);
      }
      for (const slug of Object.keys(PSD_COMMODITIES)) {
        assert.equal(typeof cb?.commodities?.[slug], 'string', `${file} is missing commodities.${slug}`);
      }
    }
  });

  it('the two country-code normalizers agree on the shapes they share', () => {
    // They are deliberately different at the edges (the seeder accepts PSD's
    // numeric "00" world code; the RPC treats empty as unfiltered), but the
    // SHARED contract must not drift - a new WORLD alias or an ISO-2 rule change
    // has to land in both.
    for (const input of ['BR', 'br', 'eg', 'WORLD', 'WLD', 'USA', '12', 'Egypt', 'ZZ']) {
      assert.equal(
        normalizeFoodStocksCountry(input),
        normalizePsdCountryCode(input),
        `normalizers disagree on ${JSON.stringify(input)}`,
      );
    }
    // Documented, intentional divergences - pinned so a change is deliberate.
    assert.equal(normalizeFoodStocksCountry(''), '', 'RPC: empty means unfiltered');
    assert.equal(normalizePsdCountryCode(''), null, 'seeder: empty is not a country');
    assert.equal(normalizePsdCountryCode('00'), '_world', 'seeder accepts PSD numeric world rows');
    assert.equal(normalizeFoodStocksCountry('00'), null, 'RPC does not accept PSD-internal codes');
  });
});
