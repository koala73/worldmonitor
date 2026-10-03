import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { FORECASTS_APP_HTML } from '../api/mcp/ui/forecasts-app.ts';

const windows = [];
const forecast = {
  title: 'Controlled supply forecast', domain: 'energy', region: 'Europe', probability: 0.65,
  trend: 'rising', timeHorizon: '7 days', scenario: 'Executive scenario', priorProbability: 0.6,
  calibration: { marketTitle: 'Controlled market', marketPrice: 0.55 }, cascades: [{ effect: 'Trade pressure' }],
  perspectives: { strategic: 'Strategic view', regional: 'Regional view', contrarian: 'Contrarian view' },
  caseFile: {
    baseCase: 'Baseline outcome', changeSummary: 'Updated assessment', changeItems: ['New observation'],
    worldState: { summary: 'Current world state', activePressures: ['Active pressure'], stabilizers: ['Stabilizer'], keyUnknowns: ['Unresolved question'] },
    escalatoryCase: 'Escalatory path', contrarianCase: 'Alternative outcome',
    supportingEvidence: [{ summary: 'Supporting observation', weight: 0.8 }],
    counterEvidence: [{ summary: 'Counter observation', weight: 0.3 }], triggers: ['Watch signal'],
    actors: [{ name: 'Controlled actor', category: 'state', influenceScore: 0.7, role: 'Actor role', objectives: ['Actor objective'], constraints: ['Actor constraint'], likelyActions: ['Actor action'] }],
    branches: [{ title: 'Controlled branch', projectedProbability: 0.4, summary: 'Branch summary', outcome: 'Branch outcome', rounds: [{ round: 1, focus: 'Round focus', developments: ['Round development'], actorMoves: ['Round action'] }] }],
  },
};
const payload = (predictions, fields = {}) => ({ cached_at: '2026-10-03T17:00:00Z', data: { predictions: { predictions, generatedAt: '2026-10-03T16:55:00Z', ...fields } } });
async function mount(data = payload([forecast])) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(FORECASTS_APP_HTML);
  win.eval(win.document.querySelector('script').textContent);
  const send = value => win.dispatchEvent(new win.MessageEvent('message', {
    source: win.eval('window.parent'),
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } },
  }));
  send(data);
  await win.happyDOM.waitUntilComplete();
  return { win, doc: win.document, send };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });

describe('forecast MCP analysis parity', () => {
  it('exposes loaded website case sections and forecast context', async () => {
    const { doc } = await mount();
    const details = doc.querySelector('details');
    assert.ok(details, 'loaded analysis must be expandable');
    assert.equal(details.querySelector('summary').textContent, 'Analysis');
    const text = details.textContent;
    for (const phrase of ['Executive scenario', 'Baseline outcome', 'Updated assessment', 'New observation', 'Current world state', 'Active pressure', 'Stabilizer', 'Unresolved question', 'Escalatory path', 'Alternative outcome', 'Supporting observation (80%)', 'Counter observation (30%)', 'Watch signal', 'Controlled actor', 'Actor role', 'Actor objective', 'Actor constraint', 'Actor action', 'Controlled branch', '40%', 'Branch summary', 'Branch outcome', 'Round development', 'Round action', 'Strategic view', 'Regional view', 'Contrarian view', 'Controlled market', '55%', 'Prior: 60%', 'Cascades: 1']) {
      assert.ok(text.includes(phrase), `missing website analysis field: ${phrase}`);
    }
    assert.match(doc.getElementById('list').textContent, /rising.*7 days/);
  });
  it('filters every loaded forecast locally without host tool calls or fetches', async () => {
    const { win, doc } = await mount(payload(Array.from({ length: 15 }, (_, i) => ({ ...forecast, title: `Forecast ${i + 1}`, domain: i === 14 ? 'conflict' : 'energy', region: i === 14 ? 'Asia' : 'Europe' }))));
    assert.equal(doc.querySelectorAll('.fc').length, 15, 'loaded rows after twelve must remain reachable');
    let reads = 0;
    win.fetch = async () => { reads++; throw new Error('Unexpected data read'); };
    const messages = [];
    win.eval('window.parent').postMessage = message => messages.push(message);
    const domain = doc.getElementById('domain');
    domain.value = 'conflict';
    domain.dispatchEvent(new win.Event('change'));
    assert.equal(doc.querySelectorAll('.fc').length, 1);
    assert.match(doc.getElementById('list').textContent, /Forecast 15/);
    const region = doc.getElementById('region');
    region.value = 'Europe';
    region.dispatchEvent(new win.Event('change'));
    assert.match(doc.getElementById('list').textContent, /No forecasts match/);
    region.value = 'Asia';
    region.dispatchEvent(new win.Event('change'));
    const details = doc.querySelector('details');
    details.open = true;
    details.dispatchEvent(new win.Event('toggle'));
    assert.equal(reads, 0);
    assert.ok(messages.length > 0);
    assert.ok(messages.every(message => message.method === 'ui/notifications/size-changed'));
  });
  it('distinguishes unavailable, empty and sampled results and missing analysis', async () => {
    const { doc, send } = await mount({ data: { predictions: null } });
    assert.match(doc.getElementById('list').textContent, /Forecast data unavailable/);
    send(payload([]));
    assert.match(doc.getElementById('list').textContent, /No forecasts available/);
    send(payload({ count: 30, sample: [{ title: 'Sample forecast', probability: null, hasCaseFile: true }] }));
    assert.match(doc.getElementById('count').textContent, /1 of 30/);
    assert.match(doc.querySelector('details').textContent, /Case evidence is not included in this result/);
    assert.equal(doc.querySelector('.pbar'), null);
    assert.match(doc.querySelector('.fc-prob').textContent, /—/);
  });
  it('shows degraded and stale source state without calling it fresh', async () => {
    const { doc } = await mount({ ...payload([forecast], { degraded: true, stale: true, error: 'upstream_unavailable' }), stale: true });
    assert.match(doc.getElementById('foot').textContent, /source degraded/);
    assert.match(doc.getElementById('foot').textContent, /stale/);
    assert.match(doc.getElementById('foot').textContent, /2026-10-03T16:55:00Z/);
  });
  it('keeps hostile fields as text and ignores non-text optional fields', async () => {
    const { doc } = await mount(payload([{ ...forecast, title: '<img src=x onerror=alert(1)>', scenario: '<script>alert(1)</script>', caseFile: { ...forecast.caseFile, triggers: [{ bad: 'object' }, '<img src=x>'], baseCase: { bad: 'object' } } }]));
    assert.equal(doc.getElementById('list').querySelector('img,script'), null);
    assert.match(doc.getElementById('list').textContent, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(doc.getElementById('list').textContent, /\[object Object\]/);
  });
  it('replaces prior analysis and resets a filter absent from the new result', async () => {
    const { win, doc, send } = await mount();
    const domain = doc.getElementById('domain');
    domain.value = 'energy';
    domain.dispatchEvent(new win.Event('change'));
    doc.querySelector('details').open = true;
    send(payload([{ title: 'Replacement forecast', domain: 'conflict', region: 'Asia', probability: 0.2, caseFile: { actorLenses: ['Regional actor lens'] } }]));
    assert.equal(domain.value, '');
    assert.equal(doc.querySelectorAll('.fc').length, 1);
    assert.match(doc.getElementById('list').textContent, /Regional actor lens/);
    assert.doesNotMatch(doc.getElementById('list').textContent, /Baseline outcome|Controlled actor/);
    assert.equal(doc.querySelector('details').open, false);
  });
});
