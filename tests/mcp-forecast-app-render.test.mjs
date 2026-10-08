import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

describe('forecast public request errors', () => {
  const publicErrors = [
    [-32602, 'Invalid panel request.'],
    [-32602, 'Panel request expired. Open or refresh the panel.'],
    [-32602, 'Open a forecast panel before reading original evidence.'],
    [-32602, 'Panel request only covers bounded forecast lists, original cases and latest theater summaries.'],
    [-32029, 'This panel reached its read budget. Refresh to start another request.'],
    [-32029, 'Too many requests'],
    [-32603, 'Service temporarily unavailable, retry in a moment.'],
    [-32603, 'Service temporarily unavailable'],
    [-32603, 'Internal error: data fetch failed'],
    [-32003, 'Required data inputs are unavailable'],
  ];
  for (const kind of ['case', 'theater']) {
    async function start() {
      const state = await mount({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'controlled-forecast-receipt' } });
      enableTools(state.win);
      if (kind === 'case') {
        const details = state.doc.querySelector('#list details');
        details.open = true; details.dispatchEvent(new state.win.Event('toggle'));
      } else state.doc.getElementById('load-theaters').click();
      return { ...state, target: kind === 'case' ? state.doc.querySelector('#list details') : state.doc.getElementById('theaters'), request: state.messages.find(m => m.method === 'tools/call') };
    }
    it('preserves allowlisted public ' + kind + ' errors without exposing response data or making another call', async () => {
      for (const [code, message] of publicErrors) {
        const { win, doc, target, request, messages } = await start();
        const error = { code, message, data: { token: 'private-token-sentinel', account: 'private-account-sentinel', message: '<img src=x onerror=alert(1)>' } };
        const reply = id => win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id, error } }));
        reply('unrelated-request'); assert.match(target.textContent, /Loading/);
        reply(request.id);
        assert.ok(target.textContent.includes(message), target.textContent);
        assert.ok(target.textContent.includes(String(code)), target.textContent);
        assert.doesNotMatch(doc.getElementById('root').textContent, /private-token-sentinel|private-account-sentinel|onerror/);
        assert.equal(doc.querySelector('img'), null);
        assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
        assert.match(target.textContent, /Retry/);
      }
    });
    it('keeps the generic ' + kind + ' fallback for unclassified or mismatched errors', async () => {
      for (const envelope of [
        { error: { code: -32602, message: 'private-token-sentinel <img src=x>' } },
        { error: { code: -32603, message: publicErrors[1][1] } },
        { error: { code: '-32602', message: publicErrors[1][1] } },
        { result: { isError: true, content: [{ type: 'text', text: 'private-token-sentinel <img src=x>' }] } },
        { result: { isError: true, structuredContent: { error: 'private-token-sentinel' } } },
      ]) {
        const { win, doc, target, request, messages } = await start();
        win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', id: request.id, ...envelope } }));
        assert.match(target.textContent, new RegExp('Original ' + kind + ' request failed\\.'));
        assert.doesNotMatch(doc.getElementById('root').textContent, /private-token-sentinel|Panel request expired/);
        assert.equal(doc.querySelector('img'), null);
        assert.equal(messages.filter(m => m.method === 'tools/call').length, 1);
      }
    });
  }
});

describe('public forecast scored horizons render', () => {
  const gradingNote = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url))).components.forecast.horizons.hint;
  const history = [{ forecastId: forecast.id, outcome: 'VOID', voidReason: 'judge_disagreement' }];
  const compact = (rows, reliability) => {
    const value = payload([
      { ...forecast, caseFile: undefined, hasCaseFile: true, scoredHorizons: ['d30', 'h24'] },
      { ...forecast, id: 'horizon-pending', title: 'Pending horizon case', caseFile: undefined, hasCaseFile: true, scoredHorizons: ['d7'] },
    ]);
    value.panelRequest = { panel: 'forecasts', token: 'horizon-panel' }; value.data.familyOutcomes = rows; value.data.reliability = reliability;
    return value;
  };
  it('shows the public additional horizon names without changing probability or publishing projection values', async () => {
    const { doc, messages } = await mount(payload([{ ...forecast, scoredHorizons: ['d30', 'h24'], projections: { h24: 0.91, d30: 0.77 } }]));
    assert.equal(doc.querySelector('.fc-horizons summary')?.textContent ?? '', 'Also scored at: 24h, 30d');
    assert.equal(doc.querySelector('.fc-prob').textContent, '65%');
    assert.doesNotMatch(doc.querySelector('.fc-horizons').textContent, /91%|77%|0\.91|0\.77/);
    assert.equal(messages.filter(message => message.method === 'tools/call').length, 0);
  });
  it('shows the exact website first-published-value grading note in a separate native disclosure', async () => {
    const { doc, win, messages } = await mount(compact(history)); enableTools(win);
    assert.equal(doc.querySelector('.fc-horizons-hint')?.textContent ?? '', gradingNote);
    const disclosure = doc.querySelector('.fc-horizons'); assert.equal(disclosure.tagName, 'DETAILS');
    disclosure.open = true; disclosure.dispatchEvent(new win.Event('toggle')); disclosure.open = false; disclosure.dispatchEvent(new win.Event('toggle'));
    assert.equal(doc.querySelector('#list details summary').textContent, 'Analysis');
    assert.equal(messages.filter(message => message.method === 'tools/call').length, 0);
  });
  it('uses fixed public key order and deduplication, hides malformed values, and keeps cards independent', async () => {
    const { doc, send, messages } = await mount(payload([{ ...forecast, scoredHorizons: undefined }]));
    for (const scoredHorizons of [undefined, null, {}, 'h24', [], ['unknown', '<img src=x>', null, 24]]) {
      send(payload([{ ...forecast, scoredHorizons }])); assert.equal(doc.querySelector('.fc-horizons'), null);
    }
    send(payload([{ ...forecast, scoredHorizons: ['d30', 'unknown', 'h24', 'd7', 'h24', '<script>'] }, { ...forecast, id: 'second-horizon', scoredHorizons: ['d7'] }, { ...forecast, id: 'unknown-horizon', scoredHorizons: ['unknown'] }]));
    assert.deepEqual([...doc.querySelectorAll('.fc-horizons summary')].map(summary => summary.textContent), ['Also scored at: 24h, 7d, 30d', 'Also scored at: 7d']);
    assert.equal(doc.querySelector('#list img'), null); assert.equal(messages.filter(message => message.method === 'tools/call').length, 0);
  });
  it('preserves controls while updating unchanged history for audit presentation', async () => {
    const { doc, win, messages, send } = await mount(compact(history)); enableTools(win);
    const horizon = doc.querySelector('.fc-horizons'); assert.ok(horizon, 'valid public additional horizons must be visible');
    const analyses = [...doc.querySelectorAll('#list .fc > details:not(.fc-horizons)')];
    for (const analysis of analyses) { analysis.open = true; analysis.dispatchEvent(new win.Event('toggle')); }
    const requests = messages.filter(message => message.params?.name === 'get_forecast_case');
    hostReply(win, requests[0].id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast } } } });
    doc.getElementById('load-theaters').click(); theaterReply(win, messages.find(message => message.params?.name === 'get_forecast_theaters'));
    const theaterNode = doc.querySelector('#theaters > details.fc'); theaterNode.open = true; theaterNode.dispatchEvent(new win.Event('toggle'));
    const theaterEvidence = theaterNode.querySelector('.fc-section'); const caseNode = analyses[0].lastChild;
    const originalHistory = doc.querySelector('.fc-family-history details'); originalHistory.open = true;
    function retained() {
      assert.strictEqual(doc.querySelector('.fc-horizons'), horizon);
      assert.strictEqual(doc.querySelectorAll('#list .fc > details:not(.fc-horizons)')[0], analyses[0]);
      assert.strictEqual(doc.querySelectorAll('#list .fc > details:not(.fc-horizons)')[1], analyses[1]);
      assert.strictEqual(analyses[0].lastChild, caseNode); assert.strictEqual(doc.querySelector('#theaters > details.fc'), theaterNode);
      assert.strictEqual(theaterNode.querySelector('.fc-section'), theaterEvidence); assert.equal(theaterNode.open, true);
      assert.equal(analyses[0].open, true); assert.equal(analyses[1].open, true); assert.match(analyses[0].textContent, /Supporting observation/);
      assert.match(theaterNode.textContent, /Original theater assessment/); assert.equal(doc.querySelector('.fc-family-history details').open, true);
      assert.equal(messages.filter(message => message.method === 'tools/call').length, 3);
    }
    for (const open of [true, false, true]) { horizon.open = open; horizon.dispatchEvent(new win.Event('toggle')); retained(); assert.strictEqual(doc.querySelector('.fc-family-history details'), originalHistory); }
    send(compact(history)); retained(); assert.strictEqual(doc.querySelector('.fc-family-history details'), originalHistory); assert.equal(horizon.open, true);
    const changed = ['resolver_envelope_bug', 'market_price_not_outcome', 'judged_evidence_unreliable'].map(reason => ({ forecastId: forecast.id, outcome: 'VOID', voidReason: reason })).concat(history);
    send(compact(changed)); retained(); const changedHistory = doc.querySelector('.fc-family-history details'); assert.notStrictEqual(changedHistory, originalHistory); assert.equal(horizon.open, true);
    assert.match(analyses[1].textContent, /Loading original case/);
    const audited = { status: 'unavailable', underAudit: { since: '2026-10-07' }, byDomain: [] };
    send(compact(changed, audited)); retained();
    const auditedHistory = doc.querySelector('.fc-family-history details');
    assert.notStrictEqual(auditedHistory, changedHistory, 'same windows must update their audit presentation');
    assert.equal(doc.querySelector('.fc-family-history').getAttribute('data-unverified'), 'true');
    send(compact(changed, audited)); retained(); assert.strictEqual(doc.querySelector('.fc-family-history details'), auditedHistory);
    send(compact(changed, { ...audited, underAudit: { since: '2026-10-08' } })); retained();
    assert.strictEqual(doc.querySelector('.fc-family-history details'), auditedHistory, 'date-only badge update preserves unchanged history presentation');
    assert.match(doc.querySelector('.fc-reliability').getAttribute('aria-label'), /since 2026-10-08/);
    hostReply(win, requests[1].id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast: { ...forecast, id: 'horizon-pending' } } } } });
    retained(); assert.match(analyses[1].textContent, /Supporting observation/);
    send(compact(changed)); retained(); const liftedHistory = doc.querySelector('.fc-family-history details');
    assert.notStrictEqual(liftedHistory, auditedHistory); assert.equal(doc.querySelector('.fc-family-history').getAttribute('data-unverified'), null);
    send(compact(changed)); retained(); assert.strictEqual(doc.querySelector('.fc-family-history details'), liftedHistory);
    const labels = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url))).components.forecast.resolution.void;
    for (const row of changed) assert.ok(liftedHistory.textContent.includes(labels[row.voidReason]), `retained public label for ${row.voidReason}`);
  });
});

describe('public forecast family history render', () => {
  const history = [
    { forecastId: forecast.id, outcome: 'YES' },
    { forecastId: forecast.id, outcome: 'NO' },
    { forecastId: forecast.id, outcome: 'VOID', voidReason: 'judge_disagreement' },
  ];
  const compact = rows => {
    const value = payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }, { ...forecast, id: 'pending-case', title: 'Pending original case', caseFile: undefined, hasCaseFile: true }]);
    value.panelRequest = { panel: 'forecasts', token: 'history-panel' }; value.data.familyOutcomes = rows;
    return value;
  };
  for (const [reason, label] of [
    ['resolver_envelope_bug', 'Scored against a data feed we could not read correctly'],
    ['market_price_not_outcome', 'The feed showed the market price, not how the market resolved'],
    ['judged_evidence_unreliable', "Held out of scoring while the judges' evidence is being fixed"],
  ]) {
    it(`renders the exact label for new public VOID reason ${reason}`, async () => {
      const { doc, win, messages } = await mount(compact([{ forecastId: forecast.id, outcome: 'VOID', voidReason: reason }]));
      const disclosure = doc.querySelector('.fc-family-history details');
      assert.ok(disclosure, 'public VOID disclosure must be present');
      disclosure.open = true; disclosure.dispatchEvent(new win.Event('toggle'));
      const sentence = disclosure.querySelector('.fc-res-reasons');
      assert.ok(sentence, 'public VOID sentence must be present');
      assert.equal(sentence.textContent, `Recent windows, newest first: VOID (${label})`);
      assert.equal(messages.filter(message => message.method === 'tools/call').length, 0);
    });
  }
  it('shows previous-window words and distinct newest-first marks with a local VOID disclosure', async () => {
    const { doc, win, messages } = await mount(compact(history)); enableTools(win);
    const slot = doc.querySelector('.fc-family-history');
    assert.match(slot?.textContent ?? '', /Last: YES/, 'valid public history must be visible');
    assert.match(slot.querySelector('[aria-label]').getAttribute('aria-label'), /previous window.*YES/);
    assert.deepEqual([...slot.querySelectorAll('.fc-res-mark')].map(mark => [mark.dataset.outcome, mark.textContent]), [['YES', '✓'], ['NO', '✗'], ['VOID', '∅']]);
    const disclosure = slot.querySelector('details'); disclosure.open = true; disclosure.dispatchEvent(new win.Event('toggle'));
    assert.match(disclosure.textContent, /Recent windows, newest first: YES, NO, VOID \(The judges disagreed\)/);
    assert.equal(doc.querySelector('#list details summary').textContent, 'Analysis');
    assert.equal(messages.filter(message => message.method === 'tools/call').length, 0);
  });
  it('preserves loaded and pending Analysis, theaters, open history and call counts across history-only updates', async () => {
    const { doc, win, messages, send } = await mount(compact(history)); enableTools(win);
    const analyses = [...doc.querySelectorAll('#list .fc > details')];
    for (const details of analyses) { details.open = true; details.dispatchEvent(new win.Event('toggle')); }
    const requests = messages.filter(message => message.params?.name === 'get_forecast_case');
    hostReply(win, requests[0].id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast } } } });
    doc.getElementById('load-theaters').click(); theaterReply(win, messages.find(message => message.params?.name === 'get_forecast_theaters'));
    const caseNode = analyses[0].lastChild; const theaterNode = doc.getElementById('theaters').firstChild;
    const disclosure = doc.querySelector('.fc-family-history details'); assert.ok(disclosure, 'valid history has a VOID disclosure'); disclosure.open = true;
    const next = [{ forecastId: forecast.id, outcome: 'VOID', voidReason: 'all_judges_void' }, ...history]; send(compact(next));
    const updated = doc.querySelector('.fc-family-history details'); assert.equal(updated.open, true);
    assert.strictEqual(doc.querySelectorAll('#list .fc > details')[0], analyses[0]); assert.strictEqual(doc.querySelectorAll('#list .fc > details')[1], analyses[1]);
    assert.strictEqual(analyses[0].lastChild, caseNode); assert.strictEqual(doc.getElementById('theaters').firstChild, theaterNode);
    assert.equal(analyses[0].open, true); assert.equal(analyses[1].open, true); assert.match(analyses[0].textContent, /Supporting observation/); assert.match(analyses[1].textContent, /Loading original case/);
    hostReply(win, requests[1].id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast: { ...forecast, id: 'pending-case' } } } } });
    assert.match(analyses[1].textContent, /Supporting observation/);
    send(compact(next)); assert.strictEqual(doc.querySelector('.fc-family-history details'), updated, 'unchanged normalized history retains its node');
    assert.equal(messages.filter(message => message.method === 'tools/call').length, 3);
  });
  it('hides malformed/unrelated history, recovers locally, caps five, and uses fixed safe public reasons', async () => {
    const { doc, win, send, messages } = await mount(compact(undefined)); enableTools(win);
    for (const rows of [undefined, null, {}, [], [{ forecastId: 'different', outcome: 'YES' }], [{ forecastId: forecast.id, outcome: 'PENDING' }]]) { send(compact(rows)); assert.equal(doc.querySelector('.fc-family-history'), null); }
    const rows = [{ forecastId: forecast.id, outcome: 'VOID', voidReason: '<img src=x onerror=alert(1)>' }, ...Array.from({ length: 7 }, () => ({ forecastId: forecast.id, outcome: 'NO' }))];
    send(compact(rows)); assert.ok(doc.querySelector('.fc-family-history'), 'history recovers from absence'); assert.match(doc.querySelector('.fc-family-history').textContent, /Could not be resolved/); assert.equal(doc.querySelector('#list img'), null);
    assert.equal(doc.querySelectorAll('.fc-res-mark').length, 5);
    const domain = doc.getElementById('domain'); domain.value = 'energy'; domain.dispatchEvent(new win.Event('change')); assert.match(doc.querySelector('.fc-family-history').textContent, /Last: VOID/);
    send(compact(undefined)); assert.equal(doc.querySelector('.fc-family-history'), null); send(compact(history)); assert.match(doc.querySelector('.fc-family-history').textContent, /Last: YES/);
    const labels = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url))).components.forecast.resolution.void;
    for (const [reason, label] of Object.entries(labels)) {
      send(compact([{ forecastId: forecast.id, outcome: 'VOID', voidReason: reason }]));
      assert.ok(doc.querySelector('.fc-family-history').textContent.includes(label), `public label for ${reason}`);
    }
    assert.equal(messages.filter(message => message.method === 'tools/call').length, 0);
  });
});

describe('recorded history audit presentation', () => {
  const warning = 'Recorded outcome, not verified while accuracy is under audit.';
  const history = ['YES', 'NO', 'VOID'].map(outcome => ({ forecastId: forecast.id, outcome, ...(outcome === 'VOID' ? { voidReason: 'resolver_envelope_bug' } : {}) }));
  function received(underAudit = { since: '2026-10-07' }, rows = history) {
    const value = payload([{ ...forecast, scoredHorizons: ['h24', 'd7'] }]);
    value.data.familyOutcomes = rows;
    value.data.reliability = { status: 'unavailable', underAudit, byDomain: [] };
    return value;
  }
  it('marks recorded history unverified only under received audit presentation', async () => {
    const { doc, send } = await mount(received());
    const slot = doc.querySelector('.fc-family-history'); assert.ok(slot, 'recorded history must be present');
    assert.equal(slot.getAttribute('data-unverified'), 'true');
    assert.equal(doc.querySelector('.fc-reliability').textContent, 'Accuracy under audit');
    assert.match(slot.textContent, /Scored against a data feed we could not read correctly/);
    send(received(undefined, undefined)); assert.equal(doc.querySelector('.fc-family-history').getAttribute('data-unverified'), 'true');
    send(received(null)); assert.equal(doc.querySelector('.fc-family-history').getAttribute('data-unverified'), null);
    for (const rows of [null, [], {}]) { send(received({ since: '2026-10-07' }, rows)); assert.equal(doc.querySelector('.fc-family-history'), null); assert.equal(doc.querySelector('.fc-reliability').textContent, 'Accuracy under audit'); }
    send(received()); assert.equal(doc.querySelector('.fc-family-history').getAttribute('data-unverified'), 'true');
  });
  it('adds safe unverified tooltip and accessible text for audit presentation', async () => {
    const { doc, send } = await mount(received());
    const chip = doc.querySelector('.fc-res-chip'); assert.ok(chip, 'recorded chip must be present');
    assert.ok(chip.getAttribute('aria-label').includes(warning));
    assert.ok((chip.getAttribute('title') ?? '').includes(warning));
    send(received(null)); const lifted = doc.querySelector('.fc-res-chip');
    assert.doesNotMatch(lifted.getAttribute('aria-label'), /not verified/);
    assert.equal(lifted.getAttribute('title'), null);
    send(received({ since: '<img src=x>' })); assert.equal(doc.querySelector('#list img'), null);
  });
  it('defines scoped neutral outcome styling for audit presentation', () => {
    assert.match(FORECASTS_APP_HTML, /\.fc-family-history\[data-unverified="true"\] \.fc-res-chip/);
    assert.match(FORECASTS_APP_HTML, /\.fc-family-history\[data-unverified="true"\] \.fc-res-mark/);
  });
});

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
  it('retains partial evidence on unavailable retries, then replaces it with an authoritative empty result', async () => {
    const { doc, win, messages } = await mount(signedForecasts());
    enableTools(win);
    doc.getElementById('load-theaters').click();
    theaterReply(win, messages.find(m => m.method === 'tools/call'), { ...theaterResponse, status: 'partial', completionStatus: 'partial', eligibleTheaterCount: 2, failedTheaterCount: 1 });
    const empty = { ...theaterResponse, theaterCount: 0, theaterSummariesJson: '', eligibleTheaterCount: 0, completionStatus: '' };
    const missing = { ...empty, found: false, runId: '', generatedAt: 0 };
    for (const source of [
      { ...missing, status: 'unavailable', error: 'redis_unavailable' },
      { ...missing, status: 'missing' },
      { ...missing, status: 'processing', processing: true },
      { ...empty, status: 'failed', eligibleTheaterCount: 2, failedTheaterCount: 2, allTheatersFailed: true, completionStatus: 'all_theaters_failed' },
    ]) {
      doc.getElementById('load-theaters').click();
      theaterReply(win, messages.filter(m => m.method === 'tools/call').at(-1), source);
      assert.match(doc.getElementById('theaters').textContent, /Original theater assessment/);
      assert.match(doc.getElementById('theaters').textContent, /Previously loaded evidence remains visible/);
      assert.ok(doc.getElementById('theaters').textContent.includes(source.status));
    }
    doc.getElementById('load-theaters').click();
    theaterReply(win, messages.filter(m => m.method === 'tools/call').at(-1), { ...empty, status: 'empty', completionStatus: 'no_eligible_theaters' });
    assert.doesNotMatch(doc.getElementById('theaters').textContent, /Original theater assessment/);
    assert.match(doc.getElementById('theaters').textContent, /No eligible theaters/);
    assert.equal(messages.filter(m => m.method === 'tools/call').length, 6);
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

describe('published reliability and original evidence continuity', () => {
  const reliability = (changes = {}) => ({ status: 'ready', windowDays: 90, stale: false, freshnessUnknown: false, capturedAt: '2026-10-07T00:00:00Z', asOf: '2026-10-06T23:00:00Z', byDomain: [{ domain: 'energy', kind: 'measured', n: 45, brier: 0.213, yesShare: 0.4 }], ...changes });
  const compact = (reliabilityValue = reliability()) => ({ ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]), panelRequest: { panel: 'forecasts', token: 'reliability-panel' }, data: { ...payload([{ ...forecast, caseFile: undefined, hasCaseFile: true }]).data, reliability: reliabilityValue } });
  const caseReply = (win, request) => hostReply(win, request.id, { structuredContent: { data: { forecastCase: { status: 'ready', generatedAt: Date.parse('2026-10-03T16:55:00Z'), forecast } } } });
  function openCase(win, doc) { const details = doc.querySelector('#list details'); details.open = true; details.dispatchEvent(new win.Event('toggle')); return details; }
  it('refreshes source warnings and snapshot clocks while preserving pending then loaded Analysis', async () => {
    const { win, doc, messages, send } = await mount(compact()); enableTools(win);
    const details = openCase(win, doc);
    const request = messages.find(message => message.params?.name === 'get_forecast_case');
    doc.getElementById('load-theaters').click();
    theaterReply(win, messages.find(message => message.params?.name === 'get_forecast_theaters'));
    const theaterNode = doc.getElementById('theaters').firstChild;
    const changed = compact(); changed.cached_at = '2026-10-07T01:00:00Z'; changed.stale = true;
    Object.assign(changed.data.predictions, { stale: true, degraded: true, error: 'source_failure' });
    send(changed);
    assert.match(doc.getElementById('foot').textContent, /Snapshot: 2026-10-07T01:00:00Z.*Forecast source degraded.*stale cache.*source failure/);
    assert.ok(doc.querySelector('#list details') === details); assert.equal(details.open, true);
    assert.ok(doc.getElementById('theaters').firstChild === theaterNode);
    assert.match(details.textContent, /Loading original case/);
    caseReply(win, request);
    const recovered = compact(); recovered.cached_at = '2026-10-07T02:00:00Z'; send(recovered);
    assert.match(doc.getElementById('foot').textContent, /Snapshot: 2026-10-07T02:00:00Z/);
    assert.doesNotMatch(doc.getElementById('foot').textContent, /degraded|stale cache|source failure/);
    assert.ok(doc.querySelector('#list details') === details); assert.equal(details.open, true);
    assert.match(details.textContent, /Supporting observation/);
    assert.ok(doc.getElementById('theaters').firstChild === theaterNode);
    assert.equal(messages.filter(message => message.method === 'tools/call').length, 2);
  });
  it('matches website measured/stale/unmeasured text, baseline, accessible hint and accuracy destination', async () => {
    const { doc, send } = await mount(compact()); let badge = doc.querySelector('.fc-reliability');
    assert.equal(badge?.textContent, 'Energy n=45 · Brier 0.213 vs base rate 0.240');
    assert.equal(badge.getAttribute('href'), 'https://www.worldmonitor.app/accuracy/#by-domain');
    assert.match(badge.getAttribute('aria-label'), /45.*90/); assert.equal(badge.hasAttribute('title'), false);
    send(compact(reliability({ stale: true }))); badge = doc.querySelector('.fc-reliability');
    assert.match(badge.textContent, /^Out of date · Energy n=45/);
    send(compact(reliability({ stale: true, byDomain: [{ domain: 'energy', kind: 'unmeasured', n: 29 }] })));
    assert.equal(doc.querySelector('.fc-reliability').textContent, 'Out of date · Not yet measured');
    send(compact({ status: 'unavailable' })); assert.equal(doc.querySelector('.fc-reliability'), null);
  });
  it('shows "Accuracy under audit" with no number while the audit switch withholds the scores (#8990)', async () => {
    const audited = { status: 'unavailable', underAudit: { since: '2026-10-07', issue: 8990, reason: 'Scoring errors.' }, windowDays: 90, stale: false, freshnessUnknown: false, byDomain: [] };
    const { doc } = await mount(compact(audited)); const badge = doc.querySelector('.fc-reliability');
    assert.equal(badge?.textContent, 'Accuracy under audit');
    assert.equal(badge.getAttribute('href'), 'https://www.worldmonitor.app/accuracy/');
    assert.equal(badge.getAttribute('data-fc-reliability-state'), 'under-audit');
    assert.match(badge.getAttribute('aria-label'), /since 2026-10-07/);
    assert.doesNotMatch(badge.getAttribute('aria-label'), /Brier|\d\.\d{3}/);
  });
  it('preserves pending then loaded Analysis and original theaters across reliability-only updates and filters', async () => {
    const { win, doc, messages, send } = await mount(compact()); enableTools(win);
    const details = openCase(win, doc); const request = messages.find(message => message.params?.name === 'get_forecast_case');
    doc.getElementById('load-theaters').click(); const theaterRequest = messages.find(message => message.params?.name === 'get_forecast_theaters');
    send(compact(reliability({ stale: true })));
    assert.ok(doc.querySelector('#list details') === details, 'identical list/generation/token must retain the live Analysis node'); assert.equal(details.open, true);
    caseReply(win, request); theaterReply(win, theaterRequest);
    assert.match(details.textContent, /Supporting observation/); assert.match(doc.getElementById('theaters').textContent, /Original theater assessment/);
    const domain = doc.getElementById('domain'); domain.value = 'energy'; domain.dispatchEvent(new win.Event('change'));
    const filtered = openCase(win, doc); const theaterNode = doc.getElementById('theaters').firstChild;
    send(compact(reliability({ byDomain: [{ domain: 'energy', kind: 'measured', n: 45, brier: 0.3, yesShare: 0.4 }] })));
    assert.ok(doc.querySelector('#list details') === filtered, 'reliability-only filter update retains Analysis node'); assert.equal(filtered.open, true); assert.match(filtered.textContent, /Supporting observation/);
    assert.equal(doc.getElementById('domain').value, 'energy'); assert.ok(doc.getElementById('theaters').firstChild === theaterNode, 'reliability-only update retains theater node');
    assert.match(doc.querySelector('.fc-reliability').textContent, /Brier 0.300/); assert.equal(messages.filter(message => message.method === 'tools/call').length, 2);
  });
  for (const change of ['list', 'generation', 'token']) it(`replaces ${change} provenance and rejects the previous pending original-case response`, async () => {
    const { win, doc, messages, send } = await mount(compact()); enableTools(win);
    const original = openCase(win, doc); const request = messages.find(m => m.params?.name === 'get_forecast_case');
    const next = compact();
    if (change === 'list') next.data.predictions.predictions[0].title = 'Changed effective list';
    if (change === 'generation') next.data.predictions.generatedAt += 1;
    if (change === 'token') next.panelRequest.token = 'replacement-panel';
    send(next); const replacement = openCase(win, doc); assert.notEqual(replacement, original);
    caseReply(win, request); assert.doesNotMatch(replacement.textContent, /Supporting observation/);
    assert.equal(messages.filter(m => m.params?.name === 'get_forecast_case').length, 2);
  });
  it('does not reuse a loaded dossier after the signed token changes and keeps hostile labels as text', async () => {
    const { win, doc, messages, send } = await mount(compact()); enableTools(win); openCase(win, doc);
    caseReply(win, messages.find(m => m.params?.name === 'get_forecast_case'));
    const next = compact(); next.panelRequest.token = 'replacement-panel'; send(next);
    const details = openCase(win, doc); assert.doesNotMatch(details.textContent, /Supporting observation/);
    assert.equal(messages.filter(m => m.params?.name === 'get_forecast_case').length, 2);
    const hostile = compact(reliability({ byDomain: [{ domain: '<img src=x onerror=alert(1)>', kind: 'measured', n: 45, brier: 0.213, yesShare: 0.4 }] }));
    hostile.data.predictions.predictions[0].domain = '<img src=x onerror=alert(1)>'; send(hostile);
    assert.equal(doc.querySelector('#list img'), null); assert.match(doc.querySelector('.fc-reliability').textContent, /<img/);
  });
});
