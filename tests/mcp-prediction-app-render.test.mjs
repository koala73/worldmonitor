import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { PREDICTION_MARKETS_APP_HTML } from '../api/mcp/ui/prediction-markets-app.ts';

const windows = [];
const market = { title: 'Controlled contract', source: 'polymarket', yesPrice: 62, volume: 1250000, url: 'https://polymarket.com/event/controlled', endDate: '2026-12-31T12:00:00Z' };
const payload = list => ({ cached_at: '2026-10-03T16:00:00Z', data: { 'markets-bootstrap': { geopolitical: list, tech: [], finance: [] } } });

async function mount(list) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(PREDICTION_MARKETS_APP_HTML);
  win.eval(win.document.querySelector('script').textContent);
  const send = data => win.dispatchEvent(new win.MessageEvent('message', {
    source: win.eval('window.parent'),
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: { content: [{ type: 'text', text: JSON.stringify(data) }] } } },
  }));
  send(payload(list));
  await win.happyDOM.waitUntilComplete();
  return { win, doc: win.document, send };
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
    assert.match(text, /Closes: Dec 31, 2026/);
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
    assert.equal(doc.querySelectorAll('.mkt').length, 6);
    const more = doc.querySelector('.mkt-more');
    assert.ok(more, 'loaded rows beyond six must remain reachable');
    more.click();
    assert.equal(doc.querySelectorAll('.mkt').length, 8);
    assert.match(doc.getElementById('groups').textContent, /Contract 8/);
    assert.equal(doc.querySelector('.mkt-more'), null);
    assert.equal(reads, 0);
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
});
