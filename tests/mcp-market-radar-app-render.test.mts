import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { Window } from 'happy-dom';
import { toSeedEtfFlow } from '../scripts/shared/etf-flow-provider.mjs';
import { buildProducerBackedMarketFixture } from './helpers/mcp-producer-fixtures.mjs';
import { buildUiResourceRead, MARKET_RADAR_UI_URI } from '../api/mcp/ui/registry';
import { presentDefaultMarketData } from '../api/mcp/registry/cache-tools';

const bundle = buildSync({
  entryPoints: ['src/plugin-market-main.ts'], bundle: true, write: false, format: 'iife', platform: 'browser',
  alias: { '@': './src' }, loader: { '.css': 'empty' },
  define: { 'import.meta.url': JSON.stringify('https://www.worldmonitor.app/plugin/assets/market-test.js') },
}).outputFiles[0]!.text;
const template = new Window();
template.document.write(readFileSync('market.html', 'utf8'));
for (const script of template.document.querySelectorAll('script')) script.remove();
const body = template.document.documentElement.outerHTML;
await template.happyDOM.close();
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
  const fetchReads: unknown[] = [];
  window.fetch = input => { fetchReads.push(input); throw new Error('Market UI must not fetch data'); };
  if (managed) window.document.documentElement.dataset.wmPluginManagedBoot = 'true';
  window.eval(bundle);
  const send = (result: unknown, source = parent) => window.dispatchEvent(new window.MessageEvent('message', {
    source, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result } },
  }));
  send({ content: [{ type: 'text', text: JSON.stringify(payload) }], _meta: {
    'worldmonitor/usage': { unit: 'requests', remaining: 47, resetsAt: '2026-10-04T00:00:00Z' },
  } });
  await window.happyDOM.waitUntilComplete();
  return { window, document: window.document, send, messages, fetchReads };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(window => window.happyDOM.close())); });

const etfSource = {
  timestamp: '2026-10-03T17:00:00Z',
  etfs: [
    toSeedEtfFlow({ ticker: 'IN', issuer: 'Inflow issuer', price: 100, priceChange: 1, volume: 10 }),
    toSeedEtfFlow({ ticker: 'FLAT', issuer: 'Neutral issuer', price: 100, priceChange: 0, volume: 10 }),
    toSeedEtfFlow({ ticker: 'ZERO', issuer: 'Zero issuer', price: 100, priceChange: -1, volume: 0 }),
  ],
  summary: { netDirection: 'NEUTRAL', totalEstFlow: 0, totalVolume: 20, etfCount: 3, inflowCount: 1, outflowCount: 1 },
};

describe('ETF flow observations in the compiled Market Radar', () => {
  it('shows canonical signed flow fields without changing quote rows, charts or host reads', async () => {
    const { document, messages, fetchReads } = await open({ ...fixture, data: { ...fixture.data, 'etf-flows': etfSource } });
    const rows = [...document.querySelectorAll('.etf-flow-row')];
    assert.equal(rows.length, 3);
    assert.deepEqual(fetchReads, []);
    assert.deepEqual(rows.map(row => row.querySelector('.etf-ticker')!.textContent), ['IN', 'FLAT', 'ZERO']);
    assert.deepEqual(rows.map(row => row.querySelector('.qname')!.textContent), ['Inflow issuer', 'Neutral issuer', 'Zero issuer']);
    assert.deepEqual(rows.map(row => row.querySelector('.etf-amount')!.textContent), ['+$100.00', '-$100.00', '$0.00']);
    assert.deepEqual(rows.map(row => row.querySelector('.etf-direction')!.textContent), ['inflow', 'neutral', 'outflow']);
    assert.deepEqual(rows.map(row => row.querySelector('.etf-volume')!.textContent), ['10', '10', '0']);
    assert.deepEqual(rows.map(row => row.querySelector('.etf-price-change')!.textContent), ['+1.00%', '0.00%', '-1.00%']);
    assert.match(document.querySelector('.etf-fetch-time')!.textContent, /2026-10-03T17:00:00Z/);
    assert.match(document.querySelector('#marketSnapshot')!.textContent, /2026-10-03T18:25:00Z.*stale/);
    assert.match(document.querySelector('.market-etf-flows')!.textContent, /heuristic, not verified net subscriptions/);
    assert.match(document.querySelector('#marketStatus')!.textContent, /12 loaded quotes.*3 loaded ETF flow rows/);
    assert.equal(document.querySelectorAll('.quote').length, 12);
    for (const details of document.querySelectorAll('details')) {
      details.open = true;
      details.dispatchEvent(new document.defaultView!.Event('toggle'));
    }
    assert.equal(document.querySelectorAll('.terminal-chart').length, 11);
    assert.equal(document.querySelector('.etf-flow-row details'), null);
    assert.equal(messages.filter((message: any) => message.method === 'tools/call').length, 0);
  });
  it('keeps source summary independent of the displayed subset and supports named projection wrappers', async () => {
    const { document, send } = await open();
    send({ structuredContent: { projection: { cached_at: fixture.cached_at, data: { 'etf-flows': {
      ...etfSource, etfs: { count: 3, sample: [etfSource.etfs[0]] },
    } } } } });
    assert.equal(document.querySelectorAll('.etf-flow-row').length, 1);
    assert.match(document.querySelector('.etf-row-coverage')!.textContent, /Showing 1 of 3 ETF flow rows/);
    assert.match(document.querySelector('.etf-source-summary')!.textContent, /before filtering, list caps and response-budget omissions.*NEUTRAL.*\$0.00.*volume: 20.*ETFs: 3.*inflows: 1.*outflows: 1/);
    assert.match(document.querySelector('#marketStatus')!.textContent, /^1 loaded ETF flow rows/);
    assert.doesNotMatch(document.querySelector('#marketStatus')!.textContent, /quotes|chart|no market/i);
    send({ structuredContent: { projection: [etfSource.etfs[0]] } });
    assert.equal(document.querySelector('.market-etf-flows'), null, 'arbitrary projected arrays are not inferred to be ETF flows');
  });
  it('preserves unknown numbers, directions, summary counts and timestamps rather than manufacturing zero', async () => {
    const { document, send } = await open();
    for (const bad of [undefined, null, Infinity, NaN, '0']) {
      send({ structuredContent: { cached_at: fixture.cached_at, data: { 'etf-flows': {
        timestamp: 1234567890, etfs: [{ ticker: 'UNKNOWN', estFlow: bad, volume: bad, priceChange: bad, direction: 'other', change: 99 }],
        summary: { netDirection: 'other', totalEstFlow: bad, totalVolume: bad, etfCount: -1, inflowCount: 1.5, outflowCount: '0' },
      } } } });
      for (const selector of ['.etf-amount', '.etf-volume', '.etf-price-change']) assert.equal(document.querySelector(selector)!.textContent, '—');
      assert.equal(document.querySelector('.etf-direction')!.textContent, 'unknown');
      assert.match(document.querySelector('.etf-source-summary')!.textContent, /Unknown.*flow \(USD\): —.*volume: —.*ETFs: —.*inflows: —.*outflows: —/);
      assert.equal(document.querySelector('.etf-fetch-time')!.textContent, 'ETF data fetched: unavailable');
      assert.match(document.querySelector('#marketSnapshot')!.textContent, /2026-10-03T18:25/);
    }
    for (const timestamp of [undefined, '', 'invalid', '1234567890']) {
      send({ structuredContent: { data: { 'etf-flows': { ...etfSource, timestamp } } } });
      assert.equal(document.querySelector('.etf-fetch-time')!.textContent, 'ETF data fetched: unavailable');
    }
    send({ structuredContent: { data: { 'etf-flows': { ...etfSource, timestamp: '2026-10-03T21:00:00+04:00' } } } });
    assert.match(document.querySelector('.etf-fetch-time')!.textContent, /21:00:00\+04:00/);
  });
  it('distinguishes source absence, unreadable, empty, sampled, rate-limited and budget-omitted states', async () => {
    const { document, send } = await open();
    assert.equal(document.querySelector('.market-etf-flows'), null);
    for (const source of [null, 'unreadable', {}, { etfs: null }]) {
      send({ structuredContent: { data: { 'etf-flows': source } } });
      assert.match(document.querySelector('.etf-row-coverage')!.textContent, /data unavailable/);
      assert.equal(document.querySelectorAll('.etf-flow-row').length, 0);
      assert.doesNotMatch(document.querySelector('#marketStatus')!.textContent, /quotes|chart/);
    }
    send({ structuredContent: { data: { 'etf-flows': { etfs: [], rateLimited: true } } } });
    assert.match(document.querySelector('.market-etf-flows')!.textContent, /Provider rate limit.*No ETF flow rows/s);
    assert.doesNotMatch(document.querySelector('.etf-source-summary')!.textContent, /\$0|NEUTRAL/);
    const budgeted = presentDefaultMarketData({ data: { 'etf-flows': { etfs: [{ ticker: 'HUGE', issuer: 'x'.repeat(131072) }] } } }, 131072);
    send({ structuredContent: budgeted });
    assert.match(document.querySelector('.etf-row-coverage')!.textContent, /rows omitted to fit the response budget/);
    assert.doesNotMatch(document.querySelector('.etf-row-coverage')!.textContent, /No ETF flow rows/);
    send({ structuredContent: { data: { 'etf-flows': { etfs: { count: -2, sample: [etfSource.etfs[0]] } } } } });
    assert.equal(document.querySelector('.etf-row-coverage')!.textContent, '1 loaded ETF flow rows.');
  });
  it('distinguishes an empty response sample from a known empty ETF snapshot', async () => {
    const { document, send } = await open();
    for (const etfs of [{ count: 3, sample: [] }, { total: 3, sample: [] }]) {
      send({ structuredContent: { data: { 'etf-flows': { etfs } } } });
      assert.equal(document.querySelector('#marketStatus')!.textContent, 'No ETF flow rows in this response sample.');
      assert.match(document.querySelector('.etf-row-coverage')!.textContent, /Showing 0 of 3/);
    }
    for (const etfs of [{ sample: [] }, { count: -1, sample: [] }, { count: '0', sample: [] }]) {
      send({ structuredContent: { data: { 'etf-flows': { etfs } } } });
      assert.equal(document.querySelector('#marketStatus')!.textContent, 'No ETF flow rows in this response sample.');
      assert.equal(document.querySelector('.etf-row-coverage')!.textContent, 'No ETF flow rows in this response sample.');
    }
    send({ structuredContent: { data: { 'etf-flows': { etfs: { count: 0, sample: [] } } } } });
    assert.equal(document.querySelector('#marketStatus')!.textContent, 'No ETF flow rows in this snapshot.');
  });
  it('distinguishes filtered non-empty ETF collections from empty snapshots', async () => {
    const { document, send } = await open();
    const invalidRows = [null, {}, 12, 'invalid'];
    for (const etfs of [invalidRows, { count: 4, sample: invalidRows }, { sample: invalidRows }]) {
      send({ structuredContent: { data: { 'etf-flows': { etfs } } } });
      assert.equal(document.querySelector('#marketStatus')!.textContent, 'No usable ETF flow rows in this response.');
      assert.equal(document.querySelectorAll('.etf-flow-row').length, 0);
      assert.doesNotMatch(document.querySelector('.market-etf-flows')!.textContent, /No ETF flow rows in this snapshot/);
    }
  });
  it('renders untrusted labels inertly and clears all flow content on replacement', async () => {
    const { document, window, send } = await open({ data: { 'etf-flows': { ...etfSource, etfs: [{
      ...etfSource.etfs[0], ticker: '<img src=x onerror="window.pwned=true">', issuer: '<script>bad</script>',
    }] } } });
    assert.match(document.querySelector('.etf-ticker')!.textContent, /<img src=x/);
    assert.equal(document.querySelector('.etf-flow-row .qname')!.textContent, '<script>bad</script>');
    assert.equal(document.querySelector('img,script'), null);
    assert.equal(window.eval('window.pwned'), undefined);
    send({ structuredContent: fixture });
    assert.equal(document.querySelector('.market-etf-flows'), null);
    assert.equal(document.querySelectorAll('.quote').length, 12);
    assert.doesNotMatch(document.querySelector('#marketStatus')!.textContent, /ETF/);
  });
  it('renders flow-only data after one managed mount without a tool call', async () => {
    const payload = { data: { 'etf-flows': etfSource } };
    const { document, window, send, messages, fetchReads } = await open(payload, true);
    assert.deepEqual(messages, []);
    assert.equal(document.querySelector('.market-etf-flows'), null);
    document.dispatchEvent(new window.Event('wm-plugin-mount'));
    document.dispatchEvent(new window.Event('wm-plugin-mount'));
    send({ structuredContent: payload });
    assert.equal(document.querySelectorAll('.etf-flow-row').length, 3);
    assert.equal(document.querySelectorAll('.quote, details').length, 0);
    assert.deepEqual(fetchReads, []);
    assert.deepEqual(messages.filter((message: any) => !['ui/initialize', 'ui/notifications/size-changed'].includes(message.method)), []);
  });
});

describe('compiled Market Radar actual entry and host result', () => {
  it('shows transport omissions separately from source absence and clears coverage on replacement', async () => {
    const input = { data: { 'stocks-bootstrap': { quotes: [{ symbol: 'GIANT', name: 'x'.repeat(131072) }] }, crypto: { quotes: [] }, sectors: null } };
    const fitted = presentDefaultMarketData(input, 131072);
    const { document, send, messages } = await open(fitted);
    assert.match(document.querySelector('.market-transport-coverage')!.textContent, /Equities: 0 of 1 rows returned; 1 omitted to fit the response budget/);
    assert.match(document.querySelector('.market-transport-coverage')!.textContent, /Crypto: 0 of 0 rows returned/);
    assert.match(document.querySelector('.market-transport-coverage')!.textContent, /Sectors: count unavailable/);
    assert.match(document.querySelector('.market-transport-coverage')!.textContent, /ETF/);
    assert.match(document.querySelector('#marketContent')!.textContent, /Quotes omitted to fit the response budget/);
    send({ structuredContent: { projection: [fixture.data['stocks-bootstrap'].quotes[0]], transportCoverage: fitted.transportCoverage } });
    assert.equal(document.querySelector('.market-transport-coverage'), null);
    send({ structuredContent: fixture });
    assert.equal(document.querySelector('.market-transport-coverage'), null);
    assert.equal(document.querySelectorAll('.qsym').length, 12);
    assert.equal(messages.filter((message: any) => message.method === 'tools/call').length, 0);
  });
  it('renders fitted structured data with complete retained chart series and no extra host read', async () => {
    const fitted = presentDefaultMarketData({ ...fixture, data: { ...fixture.data, 'etf-flows': { timestamp: '2026-10-03T17:00:00Z', etfs: [toSeedEtfFlow({ ticker: 'ETF_TEST', issuer: 'Fixture issuer', price: 100, priceChange: 0, volume: 10 })] } } }, 131072);
    const { document, send, messages } = await open();
    send({ structuredContent: fitted });
    assert.equal(document.querySelectorAll('.qsym').length, 12);
    const details = document.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new document.defaultView!.Event('toggle'));
    assert.match(details.textContent, /HI 110.*LAST 100.*LO 90/);
    assert.match(document.querySelector('.market-transport-coverage')!.textContent, /Equities: 12 of 12 rows returned/);
    assert.match(document.querySelector('.market-transport-coverage')!.textContent, /ETF flows: 1 of 1 rows returned/);
    assert.equal(document.querySelector('.market-etf-flows h2')?.textContent, 'ETF flows');
    assert.equal(document.querySelectorAll('.qsym').length, 12, 'returned ETF flow rows do not claim an added chart group');
    assert.equal(messages.filter((message: any) => message.method === 'tools/call').length, 0);
  });
  it('renders every loaded row and original chart/name instead of dropping rows after eight', async () => {
    const { document } = await open();
    assert.equal(document.querySelectorAll('.qsym').length, 12);
    assert.equal(document.querySelectorAll('.terminal-chart').length, 0);
    for (const details of document.querySelectorAll('details')) {
      details.open = true;
      details.dispatchEvent(new document.defaultView!.Event('toggle'));
    }
    assert.equal(document.querySelectorAll('.terminal-chart').length, 11);
    assert.equal(document.querySelectorAll('details').length, 11);
    assert.match(document.querySelector('#marketContent')!.textContent, /Controlled asset 11/);
    assert.match(document.querySelector('.terminal-chart')!.textContent, /HI 110.*LAST 100.*LO 90/);
  });
  it('retains the name-only sector identity supported by the former renderer', async () => {
    const { document } = await open({ data: { sectors: { sectors: [{ name: 'Technology', change: 1.5 }] } } });
    assert.equal(document.querySelector('.qsym')!.textContent, 'Technology');
  });
  it('preserves flat charts and unknown prices, changes and missing chart coverage', async () => {
    const { document } = await open();
    const rows = document.querySelectorAll('.quote');
    const flat = rows[9] as HTMLDetailsElement;
    flat.open = true;
    flat.dispatchEvent(new document.defaultView!.Event('toggle'));
    assert.match(flat.textContent, /HI\/LO\/LAST 7/);
    assert.equal(rows[10]!.querySelector('.qprice')!.textContent, '—');
    assert.equal(rows[10]!.querySelector('.qchg')!.textContent, '—');
    assert.match(rows[11]!.textContent, /chart unavailable/);
    assert.equal(rows[11]!.querySelector('details'), null);
  });
  it('renders the dispatcher projection wrapper used for summary and JMESPath', async () => {
    const { document, send } = await open();
    const projection = { data: { 'stocks-bootstrap': { quotes: { count: 30, sample: [fixture.data['stocks-bootstrap'].quotes[0]] } } } };
    send({ structuredContent: { projection } });
    assert.equal(document.querySelectorAll('.quote').length, 1);
    assert.match(document.body.textContent, /Showing 1 of 30/);
    send({ structuredContent: { projection: [fixture.data['stocks-bootstrap'].quotes[1]] } });
    assert.equal(document.querySelector('.qsym')!.textContent, 'TEST1');
    assert.match(document.body.textContent, /Projected quotes/);
  });
  it('renders direct projected quote collections and preserves their snapshot and sample coverage', async () => {
    const { document, send } = await open();
    send({ structuredContent: { projection: {
      cached_at: fixture.cached_at, quotes: [fixture.data['stocks-bootstrap'].quotes[0]],
    } } });
    assert.equal(document.querySelectorAll('.quote').length, 1);
    assert.equal(document.querySelector('.qsym')!.textContent, 'TEST0');
    assert.match(document.querySelector('#marketSnapshot')!.textContent, /2026-10-03T18:25/);
    send({ structuredContent: { projection: {
      quotes: { count: 30, sample: [fixture.data['stocks-bootstrap'].quotes[1]] },
    } } });
    assert.equal(document.querySelector('.qsym')!.textContent, 'TEST1');
    assert.match(document.body.textContent, /Showing 1 of 30/);
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
    const chartRow = document.querySelector('details')!;
    chartRow.open = true;
    chartRow.dispatchEvent(new document.defaultView!.Event('toggle'));
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
    const chart = details.querySelector('.terminal-chart');
    details.open = false;
    details.dispatchEvent(new document.defaultView!.Event('toggle'));
    details.open = true;
    details.dispatchEvent(new document.defaultView!.Event('toggle'));
    assert.equal(details.querySelector('.terminal-chart'), chart);
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
