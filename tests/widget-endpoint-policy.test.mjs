import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBootstrapRegistry } from '../shared/bootstrap-tier-keys.js';

const require = createRequire(import.meta.url);
const {
  WIDGET_DATA_CATALOG, buildWidgetDataUrl, BOOTSTRAP, RPCS, EXCLUDED_BOOTSTRAP_KEYS, EXCLUDED_RPC_ROUTES,
} = require('../scripts/_widget-data-policy.cjs');
const root = new URL('..', import.meta.url).pathname;
const read = path => readFileSync(join(root, path), 'utf8');

const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const generatedGetRoutes = walk(join(root, 'src/generated/server'))
  .flatMap(file => [...readFileSync(file, 'utf8').matchAll(/method: "GET",\s*path: "(\/api\/[^"]+)"/g)])
  .map(match => match[1]);
const premiumPaths = new Set([...read('src/shared/premium-paths.ts').matchAll(/'(\/api\/[^']+)'/g)].map(m => m[1]));

describe('widget data request boundary', () => {
  for (const [endpoint, params] of [
    ['/api/bootstrap?keys=marketQuotes,cryptoQuotes', undefined],
    ['/api/bootstrap', { keys: 'weatherAlerts' }],
    ['/api/economic/v1/get-fred-series?series_id=CPIAUCSL', { series_id: 'DGS10', note: 'A+B & café' }],
    ['/api/market/v1/get-country-stock-index', { country_code: 'JP' }],
  ]) it(`admits ${endpoint} ${JSON.stringify(params ?? {})}`, () => {
    const url = buildWidgetDataUrl(endpoint, params);
    assert.ok(url);
    assert.equal(url.origin, 'https://api.worldmonitor.app');
    for (const [key, value] of Object.entries(params || {})) assert.equal(url.searchParams.get(key), value);
  });

  it('sends numeric and boolean params as strings', () => {
    const url = buildWidgetDataUrl('/api/economic/v1/get-us-treasury-par-yield-curve', { history: true, limit: 5 });
    assert.equal(url.searchParams.get('history'), 'true');
    assert.equal(url.searchParams.get('limit'), '5');
  });

  for (const [endpoint, params] of [
    ['/api/not-in-catalog'], ['/api/bootstrap?keys=notAdvertised'],
    ['/api/../health'], ['/api/market/v1/analyze-stock'],
    ['/api/news/v1/summarize-article'], ['/api/intelligence/v1/deduct-situation'],
    ['/api/intelligence/v1/get-country-intel-brief'], ['/api/supply-chain/v1/get-bypass-options'],
    ['/api/bootstrap'], ['/api/bootstrap?keys='],
    ['/api/bootstrap?keys=marketQuotes,,cryptoQuotes'],
    ['/api/bootstrap?keys=marketQuotes&keys=notAdvertised'],
    ['/api/bootstrap?keys=marketQuotes', { keys: 'notAdvertised' }],
    ['/api/bootstrap?keys=notAdvertised', { keys: 'marketQuotes' }],
    ['/api/bootstrap?keys=marketQuotes', { tier: 'fast' }],
    ['/api/bootstrap?keys=marketQuotes&tier=fast'],
    ['/api/bootstrap?keys=marketQuotes%252cnotAdvertised'],
    ['/api/bootstrap?keys=chokepointTransits'], ['/api/bootstrap?keys=marketImplications'],
    ['/api/bootstrap?keys=iranEvents'], ['/api/bootstrap?keys=torontoRoads'],
    ['/api/x/../bootstrap?keys=marketQuotes'],
    ['/api/%2e%2e/health'], ['/api/%62ootstrap?keys=marketQuotes'],
    ['/api/bootstrap/?keys=marketQuotes'], ['/api/bootstrap#?keys=marketQuotes'],
    ['https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes'],
    ['//example.com/api/bootstrap?keys=marketQuotes'],
    ['/api/\\example.com/bootstrap?keys=marketQuotes'],
    ['/api/boot\nstrap?keys=marketQuotes'], ['/api/bootstrap?keys=marketQuotes%ZZ'],
    ['/api/bootstrap?keys=weatherAlerts&public=0'],
    ['/api/bootstrap?keys=weatherAlerts&public=1&public=1'],
    ['/api/bootstrap?keys=weatherAlerts,forecasts&public=1'],
    ['/api/bootstrap?keys=weatherAlerts', { public: '2' }],
    [null], [42], ['/api/bootstrap', null],
    ['/api/bootstrap', { keys: ['marketQuotes'] }],
    ['/api/market/v1/get-country-stock-index', { country_code: { toString: () => 'JP' } }],
  ]) it(`denies ${JSON.stringify(endpoint)} ${JSON.stringify(params ?? {})}`, () => {
    assert.equal(buildWidgetDataUrl(endpoint, params), null);
  });

  it('keeps the public bootstrap admission shape the API recognizes', async () => {
    const { classifyPublicBootstrapUrl } = await import('../api/_bootstrap-public-tier.js');
    for (const key of ['weatherAlerts', 'forecasts', 'cyberThreats', 'flightDelays', 'correlationCards']) {
      for (const [endpoint, params] of [
        [`/api/bootstrap?keys=${key}&public=1`],
        [`/api/bootstrap?keys=${key}`, { public: '1' }],
        ['/api/bootstrap?public=1', { keys: key }],
      ]) assert.ok(classifyPublicBootstrapUrl(buildWidgetDataUrl(endpoint, params)), key);
    }
  });
});

describe('widget data catalog', () => {
  const active = resolveBootstrapRegistry({ iranEventsEnabled: false }).cacheKeys;
  const all = resolveBootstrapRegistry({ iranEventsEnabled: true }).cacheKeys;

  it('lists or excludes every bootstrap registry key exactly once', () => {
    const listed = BOOTSTRAP.map(entry => entry.key);
    assert.equal(new Set(listed).size, listed.length, 'duplicate catalog key');
    for (const key of Object.keys(all)) {
      assert.ok(listed.includes(key) !== Object.hasOwn(EXCLUDED_BOOTSTRAP_KEYS, key), `${key} must be listed or excluded, not both`);
    }
    for (const key of [...listed, ...Object.keys(EXCLUDED_BOOTSTRAP_KEYS)]) assert.ok(Object.hasOwn(all, key), `unknown registry key: ${key}`);
    for (const key of listed) assert.ok(Object.hasOwn(active, key), `${key} is disabled in production`);
  });

  it('lists or excludes every generated GET route exactly once, and lists no Pro-only route', () => {
    const listed = RPCS.map(entry => entry.path);
    assert.equal(new Set(listed).size, listed.length, 'duplicate catalog route');
    for (const route of generatedGetRoutes) {
      assert.ok(listed.includes(route) !== Object.hasOwn(EXCLUDED_RPC_ROUTES, route), `${route} must be listed or excluded, not both`);
    }
    for (const route of [...listed, ...Object.keys(EXCLUDED_RPC_ROUTES)]) assert.ok(generatedGetRoutes.includes(route), `no generated GET route: ${route}`);
    for (const route of listed) assert.ok(!premiumPaths.has(route), `${route} is Pro-only; the widget session gets 401`);
  });

  it('describes every entry and admits every listed source', () => {
    for (const entry of [...BOOTSTRAP, ...RPCS]) {
      assert.ok(entry.holds && entry.holds.length <= 140, `${entry.key || entry.path} needs a one-line description`);
    }
    for (const { key, holds } of BOOTSTRAP) {
      assert.ok(WIDGET_DATA_CATALOG.includes(`- ${key}: ${holds}`), key);
      assert.ok(buildWidgetDataUrl('/api/bootstrap', { keys: key }), key);
    }
    for (const { path } of RPCS) {
      assert.ok(WIDGET_DATA_CATALOG.includes(`- ${path}`), path);
      assert.ok(buildWidgetDataUrl(path), path);
    }
  });

  it('gives excluded entries a reason and keeps them out of the prompt and the boundary', () => {
    for (const [key, reason] of Object.entries(EXCLUDED_BOOTSTRAP_KEYS)) {
      assert.ok(reason, key);
      assert.doesNotMatch(WIDGET_DATA_CATALOG, new RegExp(`^- ${key}:`, 'm'));
      assert.equal(buildWidgetDataUrl('/api/bootstrap', { keys: key }), null, key);
    }
    for (const [route, reason] of Object.entries(EXCLUDED_RPC_ROUTES)) {
      assert.ok(reason, route);
      assert.equal(buildWidgetDataUrl(route), null, route);
    }
  });

  it('is rendered into both tier prompts', () => {
    const source = read('scripts/ais-relay.cjs');
    for (const name of ['WIDGET_SYSTEM_PROMPT', 'WIDGET_PRO_SYSTEM_PROMPT']) {
      const template = source.split(`const ${name} = `)[1].split('`;')[0] + '`';
      const prompt = vm.runInNewContext(template, { WIDGET_DATA_CATALOG });
      assert.ok(prompt.includes(WIDGET_DATA_CATALOG), name);
    }
  });
});
