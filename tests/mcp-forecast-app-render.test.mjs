import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { FORECASTS_APP_HTML } from '../api/mcp/ui/forecasts-app.ts';

const windows = [];
const forecast = {
  id: 'controlled-case', title: 'Controlled supply forecast', domain: 'energy', region: 'Europe', probability: 0.65,
  trend: 'rising', timeHorizon: '7 days', scenario: 'Executive scenario', priorProbability: 0.6,
  signals: [{ value: 'Observed forecast signal' }], simulationAdjustment: 0.1, simPathConfidence: 0.6,
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
const payload = (predictions, fields = {}) => ({ cached_at: '2026-10-03T17:00:00Z', data: { predictions: { predictions, generatedAt: Date.parse('2026-10-03T16:55:00Z'), ...fields } } });
async function mount(data = payload([forecast])) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(FORECASTS_APP_HTML);
  const messages = [];
  win.eval('window.parent').postMessage = message => messages.push(message);
  win.eval(win.document.querySelector('script').textContent);
  const sendResult = result => win.dispatchEvent(new win.MessageEvent('message', {
    source: win.eval('window.parent'),
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result } },
  }));
  const send = value => sendResult({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  send(data);
  await win.happyDOM.waitUntilComplete();
  return { win, doc: win.document, send, sendResult, messages };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });

const originalTheater = { theaterId: 'T1', theaterLabel: 'Controlled original theater', stateKind: 'pressure', topPaths: [
  { pathId: 'P1', label: 'Original path', summary: 'Original theater assessment', confidence: null, keyActors: ['Original actor'], keyActorRoles: ['Original mediator'] },
  { pathId: 'P2', label: 'Alternate path', summary: 'Alternative assessment', confidence: 0.6, keyActors: ['Alternate actor'] },
], dominantReactions: ['Original reaction'], stabilizers: ['Original stabilizer'], invalidators: ['Original invalidator'] };
const theaterResponse = { status: 'ready', found: true, runId: '1791113000000-controlled', schemaVersion: 'v1', theaterCount: 1,
  generatedAt: 1791113000000, note: '', error: '', theaterSummariesJson: JSON.stringify([originalTheater]), processing: false,
  eligibleTheaterCount: 1, failedTheaterCount: 0, allTheatersFailed: false, completionStatus: 'completed' };
const signedForecasts = () => ({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: false }]), panelRequest: { panel: 'forecasts', token: 'controlled-forecast-receipt' } });
function hostReply(win, id, result, source = win.eval('window.parent')) {
  win.dispatchEvent(new win.MessageEvent('message', { source, data: { jsonrpc: '2.0', id, result } }));
}
function enableTools(win) { hostReply(win, 1, { hostCapabilities: { serverTools: {} } }); }
function theaterReply(win, request, source = theaterResponse) { hostReply(win, request.id, { structuredContent: { data: { forecastTheaters: source } } }); }

describe('original forecast theater UI', () => {
  it('loads one closed signed request on demand and expands every original evidence field locally', async () => {
    const { doc, win, messages } = await mount(signedForecasts());
    enableTools(win);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 0);
    const load = doc.getElementById('load-theaters');
    assert.ok(load);
    load.click(); load.click();
    const requests = messages.filter(m => m.method === 'tools/call');
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].params)), { name: 'get_forecast_theaters', arguments: { panel_request: 'controlled-forecast-receipt' } });
    theaterReply(win, requests[0]);
    const text = doc.getElementById('theaters').textContent;
    for (const phrase of ['Controlled original theater', 'Original path', 'Original theater assessment', 'Original actor', 'Original mediator', 'Original reaction', 'Original stabilizer', 'Original invalidator', 'Alternate path', 'Alternative assessment', '60%', 'Confidence unknown', theaterResponse.runId, 'completed', '1 of 1', '2026-10-04T11:23:20.000Z']) assert.ok(text.includes(phrase), phrase);
    assert.ok(!text.includes('Confidence: 0%'), 'unknown confidence must not become zero');
    for (const details of doc.getElementById('theaters').querySelectorAll('details')) { details.open = true; details.dispatchEvent(new win.Event('toggle')); }
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
  });
  it('keeps partial evidence while exposing a manual retry and rejects stale replies after replacement', async () => {
    const { doc, win, messages, send } = await mount(signedForecasts());
    enableTools(win);
    doc.getElementById('load-theaters').click();
    const first = messages.find(m => m.method === 'tools/call');
    theaterReply(win, first, { ...theaterResponse, status: 'partial', completionStatus: 'partial', eligibleTheaterCount: 2, failedTheaterCount: 1 });
    assert.match(doc.getElementById('theaters').textContent, /1 of 2.*1 failed/);
    assert.match(doc.getElementById('theaters').textContent, /Original theater assessment/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
    doc.getElementById('load-theaters').click();
    const retry = messages.filter(m => m.method === 'tools/call')[1];
    send({ ...signedForecasts(), panelRequest: { panel: 'forecasts', token: 'replacement-receipt' } });
    theaterReply(win, retry);
    assert.ok(!doc.getElementById('theaters').textContent.includes('Original theater assessment'));
    assert.match(doc.getElementById('theaters').textContent, /Load active theaters/);
  });
  it('shows missing capabilities, unavailable data and unknown completion without automatic retries', async () => {
    const { doc, win, messages } = await mount(signedForecasts());
    doc.getElementById('load-theaters').click();
    assert.match(doc.getElementById('theaters').textContent, /host does not support/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 0);
    enableTools(win);
    doc.getElementById('load-theaters').click();
    const first = messages.find(m => m.method === 'tools/call');
    theaterReply(win, first, { ...theaterResponse, status: 'unknown', completionStatus: '' });
    assert.match(doc.getElementById('theaters').textContent, /Completion unknown/);
    assert.match(doc.getElementById('theaters').textContent, /Original theater assessment/);
    doc.getElementById('load-theaters').click();
    const second = messages.filter(m => m.method === 'tools/call')[1];
    theaterReply(win, second, { ...theaterResponse, theaterSummariesJson: '[{"topPaths":null}]' });
    assert.match(doc.getElementById('theaters').textContent, /invalid/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 2);
  });
  it('bounds a stalled theater read and ignores a response from outside the host', async () => {
    const { doc, win, messages } = await mount(signedForecasts());
    enableTools(win);
    let expire;
    const nativeTimeout = win.setTimeout.bind(win);
    win.setTimeout = (callback, delay, ...args) => { if (delay === 15000) expire = callback; return nativeTimeout(callback, delay, ...args); };
    doc.getElementById('load-theaters').click();
    const request = messages.find(m => m.method === 'tools/call');
    hostReply(win, request.id, { structuredContent: { data: { forecastTheaters: theaterResponse } } }, null);
    assert.match(doc.getElementById('theaters').textContent, /Loading/);
    assert.equal(typeof expire, 'function');
    expire();
    assert.match(doc.getElementById('theaters').textContent, /timed out/);
    theaterReply(win, request);
    assert.ok(!doc.getElementById('theaters').textContent.includes('Original theater assessment'));
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
  });
});

describe('forecast MCP analysis parity', () => {
  it('exposes loaded website case sections and forecast context', async () => {
    const { doc } = await mount();
    const details = doc.querySelector('details');
    assert.ok(details, 'loaded analysis must be expandable');
    assert.equal(details.querySelector('summary').textContent, 'Analysis');
    const text = details.textContent;
    for (const phrase of ['Executive scenario', 'Baseline outcome', 'Updated assessment', 'New observation', 'Current world state', 'Active pressure', 'Stabilizer', 'Unresolved question', 'Escalatory path', 'Alternative outcome', 'Supporting observation (80%)', 'Counter observation (30%)', 'Watch signal', 'Observed forecast signal', 'Controlled actor', 'Actor role', 'Actor objective', 'Actor constraint', 'Actor action', 'Controlled branch', '40%', 'Branch summary', 'Branch outcome', 'Round development', 'Round action', 'Strategic view', 'Regional view', 'Contrarian view', 'Controlled market', '55%', 'Prior: 60%', 'Cascades: 1']) {
      assert.ok(text.includes(phrase), `missing website analysis field: ${phrase}`);
    }
    assert.match(doc.getElementById('list').textContent, /rising.*7 days/);
    assert.match(doc.querySelector('.fc-meta').textContent, /AI backed.*AI signal \(moderate\).*\+10%/);
  });
  it('renders full and sampled forecasts from the dispatcher projection envelope', async () => {
    const { doc, sendResult } = await mount({ data: { predictions: null } });
    sendResult({ structuredContent: { projection: payload([forecast]) }, content: [{ type: 'text', text: JSON.stringify({ data: { predictions: null } }) }] });
    assert.equal(doc.querySelectorAll('.fc').length, 1, 'structured projected forecasts must override the fallback text');
    assert.match(doc.querySelector('details').textContent, /Supporting observation \(80%\).*Controlled actor/);
    assert.match(doc.getElementById('foot').textContent, /Snapshot: 2026-10-03T17:00:00Z/);
    sendResult({ structuredContent: { projection: { ...payload({ count: 14, sample: [{ ...forecast, probability: null }] }, { degraded: true, stale: true }), stale: true } } });
    assert.equal(doc.querySelectorAll('.fc').length, 1);
    assert.match(doc.getElementById('count').textContent, /1 of 14 loaded/);
    assert.equal(doc.querySelector('.fc-prob').textContent, '—');
    assert.equal(doc.querySelector('.pbar'), null);
    assert.match(doc.getElementById('foot').textContent, /Generated: 2026-10-03T16:55:00\.000Z.*Snapshot: 2026-10-03T17:00:00Z.*source degraded.*stale cache/);
  });
  it('keeps projected unknown, empty and malformed coverage distinct and replaces prior forecasts', async () => {
    const { doc, sendResult } = await mount();
    sendResult({ structuredContent: { projection: payload([]) } });
    assert.equal(doc.querySelectorAll('.fc').length, 0);
    assert.match(doc.getElementById('list').textContent, /No forecasts available/);
    for (const projection of [null, [], { data: { predictions: null } }]) {
      sendResult({ structuredContent: { projection }, content: [{ type: 'text', text: JSON.stringify(payload([forecast])) }] });
      assert.equal(doc.querySelectorAll('.fc').length, 0, 'an unknown projection must not fall back to unrelated prior/text forecasts');
      assert.match(doc.getElementById('list').textContent, /Forecast data unavailable/);
      assert.doesNotMatch(doc.getElementById('count').textContent, /0 of 0/);
    }
  });
  it('loads original case details through one correlated signed host call and reuses them locally', async () => {
    const compact = { ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'signed-panel' } };
    const { win, doc, messages, send } = await mount(compact);
    const reply = (id, result, source = win.eval('window.parent')) => win.dispatchEvent(new win.MessageEvent('message', { source, data: { jsonrpc: '2.0', id, result } }));
    reply(1, { hostCapabilities: { serverTools: {} } });
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 0);
    const details = doc.querySelector('details');
    details.open = true;
    details.dispatchEvent(new win.Event('toggle'));
    const calls = messages.filter(m => m.method === 'tools/call');
    assert.equal(calls.length, 1, 'first user expansion must request the original dossier once');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].params)), { name: 'get_forecast_case', arguments: { forecast_id: forecast.id, generated_at: String(Date.parse('2026-10-03T16:55:00Z')), panel_request: 'signed-panel' } });
    const result = { structuredContent: { cached_at: '2026-10-03T17:05:00Z', stale: true, freshnessUnknown: true, unreadable: ['predictions'], data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast } } } };
    reply(calls[0].id, result, win);
    reply('wrong-request', result);
    assert.doesNotMatch(details.textContent, /Supporting observation/);
    reply(calls[0].id, result);
    assert.match(details.textContent, /Supporting observation \(80%\).*Controlled actor/);
    assert.match(details.textContent, /Original case snapshot: 2026-10-03T17:05:00Z.*stale cache.*freshness unknown.*source coverage unavailable/);
    details.open = false;
    details.dispatchEvent(new win.Event('toggle'));
    details.open = true;
    details.dispatchEvent(new win.Event('toggle'));
    const domain = doc.getElementById('domain');
    domain.value = 'energy';
    domain.dispatchEvent(new win.Event('change'));
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    send(compact);
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    assert.match(doc.querySelector('details').textContent, /Supporting observation/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1, 'loaded evidence and filter navigation must reuse the original case');
  });
  it('delivers an in-flight original case to the current filtered row without a duplicate read', async () => {
    const { win, doc, messages } = await mount({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'signed-panel' } });
    const reply = (id, result) => win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id, result } }));
    reply(1, { hostCapabilities: { serverTools: {} } });
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    const call = messages.find(m => m.method === 'tools/call');
    const domain = doc.getElementById('domain');
    domain.value = 'energy';
    domain.dispatchEvent(new win.Event('change'));
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
    reply(call.id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast } } } });
    assert.match(doc.querySelector('details').textContent, /Supporting observation \(80%\)/);
  });
  it('does not use a missing capability, unsigned result, or absent case as permission to fetch', async () => {
    const compact = { ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'signed-panel' } };
    const { win, doc, messages, send } = await mount(compact);
    win.dispatchEvent(new win.MessageEvent('message', { source: win, data: { jsonrpc: '2.0', id: 1, result: { hostCapabilities: { serverTools: {} } } } }));
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    assert.match(doc.querySelector('details').textContent, /host does not support/);
    win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id: 1, result: { hostCapabilities: { serverTools: {} } } } }));
    send(payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]));
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    assert.match(doc.querySelector('details').textContent, /signed panel request/);
    send({ ...compact, data: { predictions: { generatedAt: Date.parse('2026-10-03T16:55:00Z'), predictions: [{ ...forecast, caseFile: undefined, hasCaseFile: false }] } } });
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    assert.match(doc.querySelector('details').textContent, /No case evidence/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 0);
  });
  it('retries failed details only on user action and rejects an unrelated case or changed generation', async () => {
    const { win, doc, messages } = await mount({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'signed-panel' } });
    const reply = (id, result) => win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id, result } }));
    reply(1, { hostCapabilities: { serverTools: {} } });
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    const call = () => messages.filter(m => m.method === 'tools/call').at(-1);
    assert.ok(call(), 'original case detail call is required before testing its failure');
    reply(call().id, { structuredContent: { _budget_exceeded: true } });
    assert.match(doc.querySelector('details').textContent, /too large/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
    doc.querySelector('details button').click();
    assert.equal(call().params.arguments.panel_request, 'signed-panel');
    reply(call().id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast: { ...forecast, id: 'wrong-case' } } } } });
    assert.match(doc.querySelector('details').textContent, /does not match/);
    assert.doesNotMatch(doc.querySelector('details').textContent, /Supporting observation/);
    doc.querySelector('details button').click();
    reply(call().id, { structuredContent: { data: { forecastCase: { status: 'generation_changed', generatedAt: 'new-generation', forecast: null } } } });
    assert.match(doc.querySelector('details').textContent, /generation changed.*ask to refresh forecasts.*1 new panel allocation/i);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 3);
  });
  it('bounds a stalled detail call and keeps unavailable and missing original cases explicit', async () => {
    const { win, doc, messages } = await mount({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'signed-panel' } });
    const reply = (id, result) => win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id, result } }));
    reply(1, { hostCapabilities: { serverTools: {} } });
    let expire;
    const nativeSetTimeout = win.setTimeout.bind(win);
    win.setTimeout = (callback, delay, ...args) => {
      if (delay === 15000) expire = callback;
      return nativeSetTimeout(callback, delay, ...args);
    };
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    assert.equal(typeof expire, 'function', 'a detail request must have a bounded 15-second timeout');
    expire();
    assert.match(doc.querySelector('details').textContent, /timed out/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
    for (const status of ['unavailable', 'missing']) {
      doc.querySelector('details button').click();
      const call = messages.filter(m => m.method === 'tools/call').at(-1);
      reply(call.id, { structuredContent: { data: { forecastCase: { status, generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast: null } } } });
      assert.match(doc.querySelector('details').textContent, status === 'missing' ? /no longer available/ : /source unavailable/);
      assert.doesNotMatch(doc.querySelector('details').textContent, /Supporting observation/);
    }
  });
  it('discards late original-case replies after a new list generation replaces the card', async () => {
    const { win, doc, messages, send } = await mount({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'old-panel' } });
    const reply = (id, result) => win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id, result } }));
    reply(1, { hostCapabilities: { serverTools: {} } });
    doc.querySelector('details').open = true;
    doc.querySelector('details').dispatchEvent(new win.Event('toggle'));
    const call = messages.find(m => m.method === 'tools/call');
    assert.ok(call, 'a correlated request must exist to test late-response isolation');
    send({ ...payload([{ title: 'New generation forecast', id: 'new-case', hasCaseFile: false }], { generatedAt: '2026-10-04T00:00:00Z' }), panelRequest: { panel: 'forecasts', token: 'new-panel' } });
    reply(call.id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast } } } });
    assert.match(doc.getElementById('list').textContent, /New generation forecast/);
    assert.doesNotMatch(doc.getElementById('list').textContent, /Supporting observation|Controlled actor/);
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
    assert.doesNotMatch(doc.getElementById('count').textContent, /0 of 0/);
    send(payload([]));
    assert.match(doc.getElementById('list').textContent, /No forecasts available/);
    send(payload({ count: 30, sample: [{ title: 'Sample forecast', probability: null, hasCaseFile: true }] }));
    assert.match(doc.getElementById('count').textContent, /1 of 30/);
    assert.match(doc.querySelector('details').textContent, /Case evidence is not included in this result/);
    assert.equal(doc.querySelector('.pbar'), null);
    assert.match(doc.querySelector('.fc-prob').textContent, /—/);
    assert.doesNotMatch(doc.querySelector('.fc').textContent, /AI backed|AI flagged|AI skeptical/);
  });
  it('shows degraded and stale source state without calling it fresh', async () => {
    const { doc } = await mount({ ...payload([forecast], { degraded: true, stale: true, error: 'upstream_unavailable' }), stale: true });
    assert.match(doc.getElementById('foot').textContent, /source degraded/);
    assert.match(doc.getElementById('foot').textContent, /stale/);
    assert.match(doc.getElementById('foot').textContent, /2026-10-03T16:55:00\.000Z/);
  });
  it('handles numeric and ISO generation times without a blank or invented date', async () => {
    const { doc, send } = await mount();
    assert.match(doc.getElementById('foot').textContent, /Generated: 2026-10-03T16:55:00\.000Z/);
    send(payload([forecast], { generatedAt: '2026-10-03T16:55:00Z' }));
    assert.match(doc.getElementById('foot').textContent, /Generated: 2026-10-03T16:55:00\.000Z/);
    for (const generatedAt of [0, 'invalid-date', 1e30, null]) {
      send(payload([forecast], { generatedAt }));
      assert.doesNotMatch(doc.getElementById('foot').textContent, /Generated:|1970/);
    }
  });
  it('keeps hostile fields as text and ignores non-text optional fields', async () => {
    const { doc } = await mount(payload([{ ...forecast, title: '<img src=x onerror=alert(1)>', scenario: '<script>alert(1)</script>', caseFile: { ...forecast.caseFile, triggers: [{ bad: 'object' }, '<img src=x>'], baseCase: { bad: 'object' } } }]));
    assert.equal(doc.getElementById('list').querySelector('img,script'), null);
    assert.match(doc.getElementById('list').textContent, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(doc.getElementById('list').textContent, /\[object Object\]/);
  });
  it('keeps unknown calibration odds unknown and preserves skeptical and negative simulation verdicts', async () => {
    const { doc, send } = await mount(payload([{ ...forecast, calibration: { marketTitle: 'Unknown market', marketPrice: null }, demotedBySimulation: true, simulationAdjustment: -0.12 }]));
    assert.match(doc.getElementById('list').textContent, /Unknown market \(probability unknown\)/);
    assert.doesNotMatch(doc.getElementById('list').textContent, /Unknown market \(0%\)/);
    assert.match(doc.querySelector('.fc-meta').textContent, /AI skeptical.*AI flag: dropped.*−12%/);
    send(payload([{ ...forecast, simulationAdjustment: -0.05 }]));
    assert.match(doc.querySelector('.fc-meta').textContent, /AI flagged.*AI caution.*−5%/);
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
