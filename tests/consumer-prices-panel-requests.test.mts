import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function harness() {
  const result = await build({
    entryPoints: ['src/components/ConsumerPricesPanel.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node',
    plugins: [{ name: 'request-boundaries', setup(api) {
      api.onResolve({ filter: /^(\.\/Panel|@\/)/ }, ({ path }) => ({ path, namespace: 'stub' }));
      api.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents:
        path === './Panel' ? 'export class Panel {}' :
        path.endsWith('consumer-prices') ? `
          export const MARKETS = [], SINGLE_MARKETS = [], DEFAULT_MARKET = 'all', DEFAULT_BASKET = 'essentials-ae';
          ${['fetchConsumerPriceOverview', 'fetchConsumerPriceCategories', 'fetchConsumerPriceMovers', 'fetchRetailerPriceSpreads', 'fetchConsumerPriceFreshness', 'fetchAllMarketsOverview'].map(name => `export const ${name} = (...args) => globalThis.__priceRequests('${name}', args);`).join('\n')}
        ` : path.endsWith('i18n') ? 'export const t = k => k;' :
        path.endsWith('sanitize') ? 'export const escapeHtml = x => x, unsafeRawHtml = x => x;' :
        path.endsWith('dom-utils') ? 'export const setTrustedHtml = () => {}, trustedHtml = x => x;' :
        path.endsWith('sparkline') ? 'export const sparkline = () => "";' :
        'export const getAllCountriesInflation = async () => [];', loader: 'js' }));
    } }],
  });
  const { ConsumerPricesPanel } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const requests: Array<{ name: string; args: string[]; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  (globalThis as any).__priceRequests = (name: string, args: string[]) => new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }));
  const panel = Object.assign(Object.create(ConsumerPricesPanel.prototype), {
    element: { isConnected: true }, settings: { market: 'ae', basket: 'essentials-ae', range: '30d' },
    loading: false, requestGeneration: 0, activeRequestKey: null,
    showLoading() {}, render() { this.renders = (this.renders ?? 0) + 1; },
    showError(_message: string, retry: () => void) { this.retry = retry; },
  });
  return { panel, requests };
}

test('new market supersedes pending market and duplicate requests stay coalesced', async () => {
  const { panel, requests } = await harness();
  const old = panel.fetchData();
  await panel.fetchData();
  assert.equal(requests.length, 5);
  panel.settings = { market: 'us', basket: 'essentials-us', range: '7d' };
  const latest = panel.fetchData();
  assert.equal(requests.length, 10);
  requests.slice(5).forEach(r => r.resolve({ marketCode: 'us' }));
  await latest;
  requests.slice(0, 5).forEach(r => r.resolve({ marketCode: 'ae' }));
  await old;
  assert.equal(panel.overview.marketCode, 'us');
  assert.equal(panel.categories.marketCode, 'us');
  assert.equal(panel.renders, 1);
});

test('obsolete all-market response cannot overwrite newer single-market request', async () => {
  const { panel, requests } = await harness();
  panel.settings.market = 'all';
  const old = panel.fetchData();
  panel.settings.market = 'us';
  const latest = panel.fetchData();
  assert.equal(requests.length, 6);
  requests[0].resolve([{ marketCode: 'ae' }]);
  await old;
  assert.equal(panel.renders, undefined);
  requests.slice(1).forEach(r => r.resolve({ marketCode: 'us' }));
  await latest;
  assert.equal(panel.overview.marketCode, 'us');
});

test('failed fetch releases ownership and exposes a working retry', async () => {
  const { panel, requests } = await harness();
  panel.settings.market = 'all';
  const failed = panel.fetchData();
  requests[0].reject(new Error('offline'));
  await failed;
  assert.equal(typeof panel.retry, 'function');
  panel.retry();
  assert.equal(requests.length, 2);
  requests[1].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.renders, 1);
});

test('unavailable single-market fallback exposes a retry', async () => {
  const { panel, requests } = await harness();
  const pending = panel.fetchData();
  requests.forEach(r => r.resolve({ upstreamUnavailable: true }));
  await pending;
  assert.equal(panel.renders, undefined);
  assert.equal(typeof panel.retry, 'function');
});

test('obsolete failure cannot clear newer request ownership or show an error', async () => {
  const { panel, requests } = await harness();
  panel.settings.market = 'all';
  const old = panel.fetchData();
  panel.settings.market = 'us';
  const latest = panel.fetchData();
  requests[0].reject(new Error('obsolete failure'));
  await old;
  assert.equal(panel.retry, undefined);
  await panel.fetchData();
  assert.equal(requests.length, 6);
  requests.slice(1).forEach(r => r.resolve({ marketCode: 'us' }));
  await latest;
  assert.equal(panel.overview.marketCode, 'us');
});

test('detached panel ignores a completed request', async () => {
  const { panel, requests } = await harness();
  const pending = panel.fetchData();
  panel.element.isConnected = false;
  requests.forEach(r => r.resolve({ marketCode: 'ae' }));
  await pending;
  assert.equal(panel.renders, undefined);
  assert.equal(panel.activeRequestKey, null);
});
