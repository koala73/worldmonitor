import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { Window } from 'happy-dom';
import { buildProducerBackedMarketFixture } from './helpers/mcp-producer-fixtures.mjs';
import { buildUiResourceRead, MARKET_RADAR_UI_URI } from '../api/mcp/ui/registry';

const bundle = buildSync({
  entryPoints: ['src/plugin-market-main.ts'], bundle: true, write: false, format: 'iife', platform: 'browser',
  alias: { '@': './src' }, loader: { '.css': 'empty' },
}).outputFiles[0]!.text;
const body = readFileSync('market.html', 'utf8').replace(/<script[\s\S]*?<\/script>/, '');
const windows: Window[] = [];
const fixture = { cached_at: '2026-10-03T18:25:00Z', stale: true, data: {
  'stocks-bootstrap': { asOf: '2026-10-03T18:20:00Z', quotes: Array.from({ length: 12 }, (_, i) => ({
    symbol: 'TEST' + i, name: 'Controlled asset ' + i, price: i === 10 ? null : 100 + i,
    change: i === 10 ? null : 1.25, sparkline: i === 11 ? [] : i === 9 ? [7, 7, 7] : [90, 110, 100],
  })) },
} };
async function open(payload: unknown = fixture, managed = false) {
  const window = new Window({ url: 'https://www.worldmonitor.app/' });
  windows.push(window);
  window.document.write(body);
  const messages: unknown[] = [];
  const parent = window.eval('window.parent');
  parent.postMessage = (message: unknown) => messages.push(message);
  window.fetch = () => { throw new Error('Market UI must not fetch data'); };
  if (managed) window.document.documentElement.dataset.wmPluginManagedBoot = 'true';
  window.eval(bundle);
  const send = (result: unknown, source = parent) => window.dispatchEvent(new window.MessageEvent('message', {
    source, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result } },
  }));
  send({ content: [{ type: 'text', text: JSON.stringify(payload) }], _meta: {
    'worldmonitor/usage': { unit: 'requests', remaining: 47, resetsAt: '2026-10-04T00:00:00Z' },
  } });
  await window.happyDOM.waitUntilComplete();
  return { window, document: window.document, send, messages };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(window => window.happyDOM.close())); });

describe('compiled Market Radar actual entry and host result', () => {
  it('renders every loaded row and original chart/name instead of dropping rows after eight', async () => {
    const { document } = await open();
    assert.equal(document.querySelectorAll('.qsym').length, 12);
    assert.equal(document.querySelectorAll('.terminal-chart').length, 11);
    assert.equal(document.querySelectorAll('details').length, 11);
    assert.match(document.querySelector('#marketContent')!.textContent, /Controlled asset 11/);
    assert.match(document.querySelector('.terminal-chart')!.textContent, /HI 110.*LAST 100.*LO 90/);
  });
  it('preserves flat charts and unknown prices, changes and missing chart coverage', async () => {
    const { document } = await open();
    const rows = document.querySelectorAll('.quote');
    assert.match(rows[9]!.textContent, /HI\/LO\/LAST 7/);
    assert.equal(rows[10]!.querySelector('.qprice')!.textContent, '—');
    assert.equal(rows[10]!.querySelector('.qchg')!.textContent, '—');
    assert.match(rows[11]!.textContent, /chart unavailable/);
    assert.equal(rows[11]!.querySelector('details'), null);
  });
  it('keeps sampled coverage, observed provider limits and source dates explicit', async () => {
    const { document } = await open({ data: { 'stocks-bootstrap': {
      quotes: { count: 30, sample: [fixture.data['stocks-bootstrap'].quotes[0]] },
      rateLimited: true, skipReason: 'upstream-unavailable', asOf: '2026-10-03T18:20:00Z',
    } } });
    assert.equal(document.querySelectorAll('.quote').length, 1);
    assert.match(document.body.textContent, /Showing 1 of 30 quotes.*Provider|Provider rate limit/);
    assert.match(document.body.textContent, /upstream-unavailable/);
    assert.match(document.body.textContent, /Observed 2026-10-03/);
  });
  it('distinguishes missing source, empty curated result and absent unrequested classes', async () => {
    const { document } = await open({ data: { 'stocks-bootstrap': null, crypto: { quotes: [] } } });
    assert.equal(document.querySelectorAll('.mgroup').length, 2);
    assert.match(document.body.textContent, /Source data unavailable/);
    assert.match(document.body.textContent, /does not establish why a requested symbol is absent/);
    assert.doesNotMatch(document.body.textContent, /Commodities|Provider rate limit/);
  });
  it('filters invalid series points and leaves untrusted quote labels inert', async () => {
    const { document, window } = await open({ data: { 'stocks-bootstrap': { quotes: [{
      symbol: '<img src=x onerror="window.pwned=true">', name: '<script>bad</script>',
      price: 'oops', change: null, sparkline: [null, '2', 5, 7],
    }] } } });
    assert.match(document.body.textContent, /<img src=x/);
    assert.equal(document.querySelector('img,script'), null);
    assert.equal(document.querySelectorAll('.terminal-chart').length, 1);
    assert.doesNotMatch(document.querySelector('.terminal-chart')!.outerHTML, /NaN|undefined/);
    assert.equal(document.querySelector('.terminal-chart img'), null);
    assert.equal(window.eval('window.pwned'), undefined);
  });
  it('replaces rows on a new result and rejects messages from another window', async () => {
    const { document, send, window } = await open();
    const replacement = { structuredContent: { data: { crypto: { quotes: [{ symbol: 'BTC', price: 40000, change: -1 }] } } } };
    const stranger = new Window();
    windows.push(stranger);
    send(replacement, stranger);
    assert.equal(document.querySelectorAll('.qsym').length, 12);
    send(replacement);
    assert.equal(document.querySelectorAll('.qsym').length, 1);
    assert.equal(document.querySelector('.qsym')!.textContent, 'BTC');
    assert.equal(document.querySelectorAll('.terminal-chart').length, 0);
    assert.equal(window.document.querySelector('#marketUsage')!.hidden, true);
  });
  for (const error of [{ error: 'Source unavailable' }, { _budget_exceeded: true }, { _jmespath_error: true }]) {
    it('shows a useful error instead of empty success for ' + Object.keys(error)[0], async () => {
      const { document } = await open(error);
      assert.equal(document.querySelectorAll('.quote').length, 0);
      assert.match(document.querySelector('#marketStatus')!.textContent, /unavailable|too large|Projection/);
    });
  }
  it('managed boot makes no host calls until its one-shot mount event', async () => {
    const { window, document, messages, send } = await open(fixture, true);
    assert.deepEqual(messages, []);
    assert.equal(document.querySelectorAll('.quote').length, 0);
    document.dispatchEvent(new window.Event('wm-plugin-mount'));
    document.dispatchEvent(new window.Event('wm-plugin-mount'));
    assert.equal(messages.filter(message => (message as { method: string }).method === 'ui/initialize').length, 1);
    send({ structuredContent: fixture });
    assert.equal(document.querySelectorAll('.quote').length, 12);
  });
  it('local chart expansion retains usage and sends no tool call', async () => {
    const { document, messages } = await open();
    const details = document.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new document.defaultView!.Event('toggle'));
    assert.match(document.querySelector('#marketUsage')!.textContent, /47 panel requests remaining/);
    assert.ok(messages.length > 0);
    assert.deepEqual(messages.filter(message => !['ui/initialize', 'ui/notifications/size-changed'].includes((message as { method: string }).method)), []);
  });
  it('retains signed producer fields across every captured quote group', async () => {
    const payload = buildProducerBackedMarketFixture(JSON.parse(readFileSync('tests/fixtures/jmespath-samples/fat-get-market-data.response.json', 'utf8')));
    const { document } = await open(payload);
    assert.equal(document.querySelectorAll('.mgroup').length, 5);
    for (const change of document.querySelectorAll('.qchg')) assert.match(change.textContent, /^[+-]?\d+\.\d{2}%$/);
    assert.equal(document.querySelector('.qsym')!.textContent, 'AAPL');
    assert.match(document.body.textContent, /Fear & Greed/);
  });
});

describe('market resource current-document delivery', () => {
  it('both the new URI and legacy read alias use the data-free bounded loader and asset policy', async () => {
    const previous = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(body.replace('</body>', '<script type="module" src="/plugin/assets/market-test.js"></script></body>'), { headers: { 'Content-Type': 'text/html' } });
    };
    try {
      for (const uri of [MARKET_RADAR_UI_URI, 'ui://worldmonitor/market-radar.html']) {
        const response = await buildUiResourceRead(1, uri, {});
        const resource = (await response.json()).result.contents[0];
        assert.equal(resource.uri, uri);
        assert.match(resource.text, /market.html/);
        assert.match(resource.text, /marketRoot/);
        assert.match(resource.text, /cache: 'no-store'/);
        assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
        assert.deepEqual(resource._meta.ui.csp.resourceDomains, ['https://www.worldmonitor.app']);
        assert.deepEqual(resource._meta.ui.csp.frameDomains, []);
      }
      assert.deepEqual(requested, ['https://www.worldmonitor.app/plugin/market.html', 'https://www.worldmonitor.app/plugin/market.html']);
    } finally { globalThis.fetch = previous; }
  });
});
