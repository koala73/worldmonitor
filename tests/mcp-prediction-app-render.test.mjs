import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { PREDICTION_MARKETS_APP_HTML } from '../api/mcp/ui/prediction-markets-app.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { summarizeData } from '../api/mcp/filters.ts';
import { applyJmespath } from '../api/mcp/jmespath.ts';

const windows = [];
const market = { title: 'Controlled contract', source: 'polymarket', yesPrice: 62, volume: 1250000, url: 'https://polymarket.com/event/controlled', endDate: '2026-12-31T12:00:00Z' };
const payload = list => ({ cached_at: '2026-10-03T16:00:00Z', data: { 'markets-bootstrap': { geopolitical: list, tech: [], finance: [] } } });

async function mount(list) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(PREDICTION_MARKETS_APP_HTML);
  win.eval(win.document.querySelector('script').textContent);
  const sendResult = result => win.dispatchEvent(new win.MessageEvent('message', {
    source: win.eval('window.parent'),
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result } },
  }));
  const send = data => sendResult({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  send(payload(list));
  await win.happyDOM.waitUntilComplete();
  return { win, doc: win.document, send, sendResult };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });

describe('prediction MCP card parity with the website presentation', () => {
  it('renders the contract handoff, volume, closing date, conviction and complementary odds', async () => {
    const { doc } = await mount([market]);
    const link = doc.querySelector('.mkt-title');
    assert.equal(link.tagName, 'A');
    assert.equal(link.href, market.url);
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
    const text = doc.getElementById('groups').textContent;
    assert.match(text, /Yes 62%/);
    assert.match(text, /No 38%/);
    assert.match(text, /Vol: \$1\.3M/);
    const expectedDate = new Date(market.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    assert.ok(text.includes(`Closes: ${expectedDate}`));
    assert.match(text, /Lean Yes/);
    assert.match(text, /Polymarket/);
  });
  it('uses the website rounded-odds conviction boundaries', async () => {
    const { doc } = await mount([39.6, 50, 59.6].map(yesPrice => ({ ...market, yesPrice })));
    assert.deepEqual([...doc.querySelectorAll('.mkt-conviction')].map(node => node.textContent), ['Lean No', 'Toss-up', 'Lean Yes']);
    assert.deepEqual([...doc.querySelectorAll('.mkt-no')].map(node => node.textContent), ['No 60%', 'No 50%', 'No 40%']);
  });
  it('keeps missing odds unknown and omits invalid optional metadata', async () => {
    const { doc } = await mount([{ title: 'Unknown contract', yesPrice: null, volume: null, endDate: 'bad-date' }]);
    const text = doc.getElementById('groups').textContent;
    assert.doesNotMatch(text, /No 100%|Yes 0%|Lean No|Closes:|Vol:/);
    assert.match(text, /No —/);
    assert.equal(doc.querySelector('.pbar'), null);
  });
  it('treats unsafe contract URLs and hostile markup as text', async () => {
    const { doc } = await mount([{ ...market, url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>' }]);
    assert.equal(doc.querySelector('.mkt-title').tagName, 'SPAN');
    assert.equal(doc.querySelector('.mkt-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(doc.getElementById('groups').querySelector('img'), null);
  });
  it('shows the rest of the loaded category without another data read', async () => {
    const { win, doc } = await mount(Array.from({ length: 8 }, (_, i) => ({ ...market, title: `Contract ${i + 1}` })));
    let reads = 0;
    win.fetch = async () => { reads++; throw new Error('Unexpected data read'); };
    const messages = [];
    win.eval('window.parent').postMessage = message => messages.push(message);
    assert.equal(doc.querySelectorAll('.mkt').length, 6);
    const more = doc.querySelector('.mkt-more');
    assert.ok(more, 'loaded rows beyond six must remain reachable');
    more.click();
    assert.equal(doc.querySelectorAll('.mkt').length, 8);
    assert.match(doc.getElementById('groups').textContent, /Contract 8/);
    assert.equal(doc.querySelector('.mkt-more'), null);
    assert.equal(reads, 0);
    assert.ok(messages.length > 0, 'expansion reports its size to the host');
    assert.ok(messages.every(message => message.method === 'ui/notifications/size-changed'));
  });
  it('moves focus to the first new card even without a contract link', async () => {
    const { doc } = await mount(Array.from({ length: 8 }, (_, i) => ({ ...market, url: '', title: `Contract ${i + 1}` })));
    const more = doc.querySelector('.mkt-more');
    more.focus();
    assert.equal(doc.activeElement, more);
    more.click();
    assert.ok(doc.activeElement === doc.querySelectorAll('.mkt')[6], 'focus must move to the first new card');
    assert.equal(doc.activeElement.getAttribute('tabindex'), '-1');
  });
  it('clears expanded rows and links when a new tool result arrives', async () => {
    const { doc, send } = await mount(Array.from({ length: 8 }, () => market));
    doc.querySelector('.mkt-more')?.click();
    send(payload([{ title: 'Replacement contract', source: 'kalshi', yesPrice: 25 }]));
    assert.equal(doc.querySelectorAll('.mkt').length, 1);
    assert.equal(doc.querySelector('a'), null);
    assert.match(doc.getElementById('groups').textContent, /Kalshi/);
    assert.doesNotMatch(doc.getElementById('groups').textContent, /Controlled contract|\$1\.3M/);
  });
  it('expands each category independently', async () => {
    const { doc, send } = await mount([]);
    const contracts = category => Array.from({ length: 8 }, (_, i) => ({ ...market, title: `${category} ${i + 1}` }));
    send({ data: { 'markets-bootstrap': { geopolitical: contracts('Geo'), tech: contracts('Tech'), finance: [] } } });
    const [geo, tech] = doc.querySelectorAll('.mgroup');
    geo.querySelector('.mkt-more').click();
    assert.equal(geo.querySelectorAll('.mkt').length, 8);
    assert.equal(tech.querySelectorAll('.mkt').length, 6);
    assert.match(geo.querySelector('.mkt-count').textContent, /8 of 8/);
    tech.querySelector('.mkt-more').click();
    assert.equal(tech.querySelectorAll('.mkt').length, 8);
    assert.match(tech.textContent, /Tech 8/);
  });
  it('states when a summary sample contains fewer markets than the reported count', async () => {
    const { doc } = await mount({ count: 40, sample: [market] });
    assert.match(doc.querySelector('.mkt-count').textContent, /1 of 40/);
    assert.equal(doc.querySelector('.mkt-more'), null);
  });
  it('renders whole-envelope structured projections and expands every loaded category without reads', async () => {
    const { win, doc, sendResult } = await mount([]);
    const contracts = category => Array.from({ length: 8 }, (_, i) => ({ ...market, title: `${category} ${i + 1}`, yesPrice: i === 0 ? null : 62 }));
    const full = { ...payload([]), stale: true, data: { 'markets-bootstrap': { geopolitical: contracts('Geo'), tech: contracts('Tech'), finance: [] } } };
    const projected = applyJmespath(full, '@');
    let reads = 0;
    win.fetch = async () => { reads++; throw new Error('Unexpected data read'); };
    const messages = [];
    win.eval('window.parent').postMessage = message => messages.push(message);
    sendResult({ content: [{ type: 'text', text: projected.text }], structuredContent: buildStructuredContent(projected.value, { reshaped: true, rider: null }) });
    assert.equal(doc.querySelectorAll('.mkt').length, 12);
    assert.equal(doc.querySelector('.mkt-title').href, market.url);
    assert.match(doc.getElementById('groups').textContent, /Polymarket/);
    assert.match(doc.querySelector('.mkt').textContent, /Yes —No —/);
    assert.equal(doc.querySelector('.mkt').querySelector('.pbar'), null);
    assert.equal(doc.getElementById('foot').textContent, `Snapshot: ${full.cached_at} (stale)`);
    const [geo, tech] = doc.querySelectorAll('.mgroup');
    geo.querySelector('.mkt-more').click();
    assert.equal(geo.querySelectorAll('.mkt').length, 8);
    assert.equal(tech.querySelectorAll('.mkt').length, 6);
    assert.ok(doc.activeElement === geo.querySelectorAll('.mkt')[6], 'category expansion focuses its first new contract');
    tech.querySelector('.mkt-more').click();
    assert.equal(doc.querySelectorAll('.mkt').length, 16);
    assert.match(tech.textContent, /Tech 8/);
    assert.equal(reads, 0);
    assert.ok(messages.length > 0);
    assert.ok(messages.every(message => message.method === 'ui/notifications/size-changed'));
  });
  it('renders the actual structured summary envelope with source, unknown odds and reported count', async () => {
    const { doc, sendResult } = await mount([]);
    const full = { ...payload(Array.from({ length: 8 }, (_, i) => ({ ...market, title: `Sample ${i + 1}`, yesPrice: i === 0 ? null : 62 }))), stale: true };
    const summary = { ...full, data: summarizeData(full.data) };
    sendResult({ content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: buildStructuredContent(summary, { reshaped: true, rider: null }) });
    assert.equal(doc.querySelectorAll('.mkt').length, 3);
    assert.match(doc.querySelector('.mkt-count').textContent, /3 of 8 markets/);
    assert.equal(doc.querySelector('.mkt-more'), null);
    assert.equal(doc.querySelector('.mkt-title').href, market.url);
    assert.match(doc.querySelector('.mkt').textContent, /Polymarket.*Yes —No —/);
    assert.equal(doc.getElementById('foot').textContent, `Snapshot: ${full.cached_at} (stale)`);
  });
  it('clears earlier contracts and metadata for projections that omit the contract shape', async () => {
    const { doc, send, sendResult } = await mount([market]);
    for (const projection of [null, ['Only a title'], 62, { title: 'Only a title' }]) {
      send(payload([market]));
      assert.equal(doc.querySelectorAll('.mkt').length, 1);
      sendResult({ structuredContent: buildStructuredContent(projection, { reshaped: true, rider: null }) });
      assert.equal(doc.querySelectorAll('.mkt').length, 0);
      assert.match(doc.getElementById('groups').textContent, /Prediction data unavailable/);
      assert.match(doc.getElementById('foot').textContent, /Snapshot time unavailable/);
    }
  });
});


describe('prediction returned-category coverage and freshness', () => {
  const envelope = bootstrap => ({ cached_at: '2026-10-04T20:00:00Z', stale: false, data: { 'markets-bootstrap': bootstrap } });
  it('distinguishes returned empty arrays from omitted or malformed categories', async () => {
    const { doc, send } = await mount([]);
    send(envelope({ geopolitical: [], tech: [], finance: [] }));
    assert.match(doc.getElementById('groups').textContent, /No prediction contracts in this returned snapshot/);
    assert.equal(doc.querySelector('.mkt-coverage'), null);
    for (const bootstrap of [{ tech: [] }, { geopolitical: [], tech: [], finance: 'unreadable' }]) {
      send(envelope(bootstrap));
      assert.match(doc.querySelector('.mkt-coverage').textContent, /Unavailable or omitted categories: .*Finance/);
      assert.match(doc.getElementById('groups').textContent, /No contracts in the available returned categories/);
      assert.doesNotMatch(doc.getElementById('groups').textContent, /No prediction contracts in this returned snapshot/);
    }
    send(envelope({}));
    assert.match(doc.getElementById('groups').textContent, /Prediction data unavailable/);
  });
  it('keeps supplied contracts and names missing categories in full and summary projections', async () => {
    const { doc, sendResult } = await mount([]);
    for (const raw of [[market], { count: 14, sample: [market] }]) {
      sendResult({ structuredContent: { projection: envelope({ tech: raw }) } });
      assert.equal(doc.querySelectorAll('.mkt').length, 1);
      assert.equal(doc.querySelector('.mkt-title').href, market.url);
      assert.equal(doc.querySelector('.mkt-coverage').textContent, 'Unavailable or omitted categories: Geopolitical, Finance.');
    }
  });
  it('does not treat a positive summary count with no display sample as empty', async () => {
    const { doc, send } = await mount([]);
    send(envelope({ geopolitical: { count: 14, sample: [] }, tech: [], finance: [] }));
    assert.match(doc.getElementById('groups').textContent, /Geopolitical summary reports 14 contracts but supplied no display sample/);
    assert.doesNotMatch(doc.getElementById('groups').textContent, /No prediction contracts|No contracts in the available/);
    send(envelope({ tech: { count: 14 } }));
    assert.match(doc.getElementById('groups').textContent, /Tech summary reports 14 contracts but supplied no display sample/);
    assert.doesNotMatch(doc.getElementById('groups').textContent, /No prediction contracts/);
  });
  it('shows unknown freshness and source notices independently of snapshot presence', async () => {
    const { doc, send } = await mount([]);
    send({ ...envelope({ tech: [market] }), cached_at: null, stale: true, freshnessUnknown: true });
    assert.equal(doc.querySelectorAll('.mkt').length, 1);
    assert.match(doc.getElementById('foot').textContent, /Snapshot time unavailable.*stale.*Freshness could not be verified/);
    send({ ...envelope({ tech: [market], degraded: true, error: '<img onerror=alert(1)>' }), freshnessUnknown: true });
    assert.match(doc.getElementById('foot').textContent, /Snapshot: 2026-10-04T20:00:00Z.*Freshness could not be verified.*Source degraded.*<img/);
    assert.equal(doc.getElementById('foot').querySelector('img'), null);
  });
  it('replaces earlier coverage and unknown freshness after an authoritative returned recovery', async () => {
    const { doc, send } = await mount([]);
    send({ ...envelope({ tech: [market] }), cached_at: null, freshnessUnknown: true });
    assert.ok(doc.querySelector('.mkt-coverage'));
    send(envelope({ geopolitical: [], tech: [], finance: [] }));
    assert.equal(doc.querySelector('.mkt-coverage'), null);
    assert.match(doc.getElementById('groups').textContent, /No prediction contracts in this returned snapshot/);
    assert.equal(doc.getElementById('foot').textContent, 'Snapshot: 2026-10-04T20:00:00Z');
  });
});
