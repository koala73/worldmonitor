import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { COUNTRY_RISK_APP_HTML } from '../api/mcp/ui/country-risk-app.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { applyJmespath } from '../api/mcp/jmespath.ts';

const windows = [];
const risk = {
  countryCode: 'RU', countryName: 'Russia',
  cii: { combinedScore: 78.4, trend: 'TREND_DIRECTION_RISING', components: { newsActivity: 71, ciiContribution: 44, geoConvergence: 88, militaryActivity: 65 } },
  advisoryLevel: 'do-not-travel', sanctionsActive: true, sanctionsCount: 3417,
  fetchedAt: 1756288800000, upstreamUnavailable: false,
};
const outage = { countryCode: 'DE', countryName: 'Germany', advisoryLevel: '', sanctionsActive: false, sanctionsCount: 0, fetchedAt: 0, upstreamUnavailable: true };
const untracked = { ...outage, countryCode: 'LU', countryName: 'Luxembourg', upstreamUnavailable: false };
const subset = '{countryCode: countryCode, countryName: countryName, cii: cii, advisoryLevel: advisoryLevel, sanctionsActive: sanctionsActive, sanctionsCount: sanctionsCount, fetchedAt: fetchedAt, upstreamUnavailable: upstreamUnavailable}';
const wire = (value, reshaped = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: buildStructuredContent(value, { reshaped, rider: null }) });
const textWire = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

async function mount(result) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  const messages = [];
  let requests = 0;
  win.eval('window.parent').postMessage = message => messages.push(message);
  win.fetch = async () => { requests++; throw new Error('Unexpected read'); };
  win.document.write(COUNTRY_RISK_APP_HTML);
  win.eval(win.document.querySelector('script').textContent);
  const send = (next, overrides = {}) => win.dispatchEvent(new win.MessageEvent('message', {
    source: win.eval('window.parent'),
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: next } },
    ...overrides,
  }));
  send(result);
  await win.happyDOM.waitUntilComplete();
  return { doc: win.document, win, send, messages, requests: () => requests };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });
const text = (doc, id) => doc.getElementById(id).textContent;
function assertRisk(doc) {
  assert.equal(text(doc, 'country'), 'Russia');
  assert.equal(text(doc, 'cii'), '78');
  assert.equal(text(doc, 'level'), 'Severe');
  assert.equal(doc.querySelectorAll('#components .comp').length, 4);
  assert.match(text(doc, 'components'), /Domestic unrest44.*Armed conflict88.*Security & mobility65.*Information environment71/);
  assert.equal(text(doc, 'advisory'), 'do not travel');
  assert.equal(text(doc, 'sanctions'), '3417 OFAC-listed');
  assert.equal(text(doc, 'trend'), 'Rising');
  assert.equal(text(doc, 'foot'), 'Snapshot: 2025-08-27T10:00:00.000Z');
}
function assertUnknownScore(doc) {
  assert.equal(text(doc, 'cii'), '—');
  assert.equal(text(doc, 'level'), 'Unknown');
  assert.equal(doc.getElementById('level').style.color, '');
  assert.equal(doc.getElementById('ciibar').style.width, '0%');
  assert.equal(doc.getElementById('ciibar').style.background, '');
  assert.equal(doc.querySelectorAll('#components .comp').length, 0);
}

describe('Country Risk exported HTML projections', () => {
  for (const query of ['@', subset]) {
    it(`preserves country, risk, evidence and date for projection ${query}`, async () => {
      const projected = applyJmespath(risk, query);
      assert.equal(projected.failed, undefined);
      const view = await mount(wire(projected.value, true));
      assertRisk(view.doc);
      assert.equal(view.requests(), 0);
      assert.ok(view.messages.every(message => ['ui/initialize', 'ui/notifications/size-changed'].includes(message.method)));
    });
  }
  it('preserves original, direct object and text controls', async () => {
    for (const result of [wire(risk), wire(applyJmespath(risk, subset).value), textWire(risk)]) assertRisk((await mount(result)).doc);
  });
  for (const replacement of [null, 7, false, '', 'unloaded', [], {}, { unexpected: 'shape' }]) {
    for (const format of ['text', 'projection']) {
      it(`clears previous Severe output for ${format} ${JSON.stringify(replacement)}`, async () => {
        const view = await mount(wire(risk));
        assertRisk(view.doc);
        view.send(format === 'text' ? textWire(replacement) : wire(replacement, true));
        assertUnknownScore(view.doc);
        assert.equal(text(view.doc, 'country'), '—');
        for (const id of ['advisory', 'sanctions', 'trend']) assert.equal(text(view.doc, id), '—');
        assert.equal(text(view.doc, 'foot'), '');
        assert.equal(view.doc.getElementById('degraded').style.display, 'none');
      });
    }
  }
  for (const advisory of [undefined, null, false, 7, [], {}]) {
    it(`keeps omitted or malformed advisory ${JSON.stringify(advisory)} unknown`, async () => {
      const view = await mount(wire({ ...risk, advisoryLevel: advisory }));
      assert.equal(text(view.doc, 'advisory'), '—');
      assert.equal(text(view.doc, 'cii'), '78');
      assert.equal(text(view.doc, 'sanctions'), '3417 OFAC-listed');
    });
  }
  it('retains outage, healthy untracked, zero and unknown numeric semantics under projections', async () => {
    const view = await mount(wire(risk));
    view.send(wire(outage, true));
    assertUnknownScore(view.doc);
    assert.equal(text(view.doc, 'country'), 'Germany');
    assert.equal(view.doc.getElementById('degraded').style.display, 'block');
    assert.equal(text(view.doc, 'advisory'), '—');
    assert.equal(text(view.doc, 'sanctions'), '—');
    assert.equal(text(view.doc, 'foot'), 'Upstream unavailable — no snapshot time.');
    assert.match(text(view.doc, 'components'), /upstream data could not be read/);
    view.send(wire(untracked, true));
    assertUnknownScore(view.doc);
    assert.equal(text(view.doc, 'country'), 'Luxembourg');
    assert.equal(text(view.doc, 'advisory'), 'None');
    assert.equal(text(view.doc, 'sanctions'), 'None');
    assert.equal(view.doc.getElementById('degraded').style.display, 'none');
    assert.equal(text(view.doc, 'foot'), '');
    view.send(wire({ ...risk, cii: { combinedScore: 0, components: { newsActivity: 0 } } }, true));
    assert.equal(text(view.doc, 'cii'), '0');
    assert.equal(text(view.doc, 'level'), 'Low');
    assert.match(text(view.doc, 'components'), /Information environment0/);
    view.send(wire({ ...risk, cii: { combinedScore: null, components: { newsActivity: null, ciiContribution: '', geoConvergence: [], militaryActivity: false } }, fetchedAt: 0 }, true));
    assertUnknownScore(view.doc);
    assert.equal(text(view.doc, 'country'), 'Russia');
    assert.equal(text(view.doc, 'sanctions'), '3417 OFAC-listed');
    assert.equal(text(view.doc, 'advisory'), 'do not travel');
    view.send(wire(risk, true));
    assertRisk(view.doc);
  });
  it('preserves parent-source and JSON-RPC trust gates without data reads', async () => {
    const view = await mount(wire(risk));
    view.send(textWire(null), { source: view.win });
    assertRisk(view.doc);
    view.send(textWire(null), { data: { method: 'ui/notifications/tool-result', params: { result: textWire(null) } } });
    assertRisk(view.doc);
    view.send(wire({ ...risk, countryName: '<img src=x onerror=alert(1)>', advisoryLevel: 'x'.repeat(5000) }, true));
    assert.equal(view.doc.querySelector('img'), null);
    assert.equal(text(view.doc, 'advisory').length, 64);
    assert.equal(view.requests(), 0);
    assert.ok(view.messages.every(message => ['ui/initialize', 'ui/notifications/size-changed'].includes(message.method)));
  });
});
