import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { COUNTRY_BRIEF_APP_HTML } from '../api/mcp/ui/country-brief-app.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { applyJmespath } from '../api/mcp/jmespath.ts';

const windows = [];
const brief = {
  countryCode: 'FI', countryName: 'Finland',
  brief: 'Controlled Finland fiscal space is 28/100. [E2]\n\nControlled second paragraph retains unknown [E9].',
  generatedAt: Date.UTC(2026, 8, 23), model: 'hidden-controlled-model',
  sources: [{ title: 'Controlled Helsinki budget talks', url: 'https://example.com/finland', source: 'Controlled publisher' }],
  evidence: [
    { id: 'E2', kind: 'resilience', label: 'Fiscal space', value: '28/100', asOf: '2026-09-01T00:00:00Z', url: 'https://www.worldmonitor.app/country/FI' },
    { id: 'E3', label: 'Unsafe link', value: '5', url: 'javascript:alert(1)' },
    { id: 'E4', label: 'Plain HTTP', value: '7', url: 'http://example.com/insecure' },
    null, { label: 'Missing id', value: '1' },
  ],
};
const subset = '{countryCode: countryCode, countryName: countryName, summary: brief, sources: sources, evidence: evidence, generatedAt: generatedAt}';
const textWire = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const wire = (value, reshaped = false) => ({ ...textWire(value), structuredContent: buildStructuredContent(value, { reshaped, rider: null }) });
async function mount(result) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(COUNTRY_BRIEF_APP_HTML);
  const host = win.eval('window.parent');
  const outbound = [];
  host.postMessage = message => outbound.push(message);
  let reads = 0;
  win.fetch = async () => { reads++; throw new Error('Unexpected network read'); };
  win.eval(win.document.querySelector('script').textContent);
  const message = (data, source = host) => win.dispatchEvent(new win.MessageEvent('message', { source, data }));
  const send = next => message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: next } });
  send(result);
  await win.happyDOM.waitUntilComplete();
  return { win, doc: win.document, send, message, outbound, reads: () => reads };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });
function assertBrief(doc) {
  assert.equal(doc.getElementById('title').textContent, 'Finland Brief');
  assert.equal(doc.querySelectorAll('#brief .para').length, 2);
  assert.equal(doc.querySelector('#brief .ev-ref')?.textContent, 'E2');
  assert.match(doc.querySelector('#brief .ev-ref').title, /Fiscal space: 28\/100 \(as of 2026-09-01\)/);
  assert.match(doc.getElementById('brief').textContent, /\[E9\]/);
  assert.deepEqual([...doc.querySelectorAll('#sources a')].map(node => node.href), ['https://example.com/finland']);
  assert.deepEqual([...doc.querySelectorAll('#evidence a')].map(node => node.href), ['https://www.worldmonitor.app/country/FI']);
  assert.equal(doc.querySelectorAll('#evidence .ev-row').length, 3);
  assert.equal(doc.getElementById('foot').textContent, 'Generated 2026-09-23T00:00:00.000Z');
  assert.doesNotMatch(doc.body.textContent, /hidden-controlled-model/);
}
function assertCleared(doc) {
  assert.equal(doc.querySelectorAll('#brief .para').length, 0);
  assert.equal(doc.querySelectorAll('#brief .ev-ref').length, 0);
  assert.equal(doc.querySelectorAll('#sources .src-row').length, 0);
  assert.equal(doc.querySelectorAll('#evidence .ev-row').length, 0);
  assert.equal(doc.getElementById('foot').textContent, '');
  assert.equal(doc.getElementById('title').textContent, 'Country Brief');
  assert.match(doc.getElementById('brief').textContent, /No brief text available/);
}
describe('Country Brief exported HTML projections and replacements', () => {
  for (const query of ['@', subset]) {
    it(`retains supplied brief evidence under structured projection ${query}`, async () => {
      const projected = applyJmespath(brief, query);
      assert.equal(projected.failed, undefined);
      const { doc, reads, outbound } = await mount(wire(projected.value, true));
      assertBrief(doc);
      assert.equal(reads(), 0);
      assert.ok(outbound.every(msg => ['ui/initialize', 'ui/notifications/size-changed'].includes(msg.method)));
    });
  }
  it('retains original, text and direct subset controls', async () => {
    for (const value of [brief, applyJmespath(brief, subset).value]) {
      for (const result of [wire(value), textWire(value)]) assertBrief((await mount(result)).doc);
    }
  });
  for (const replacement of [null, false, 0, '', 'unloaded', [], {}, { brief: 5, sources: { count: 1 }, evidence: { count: 3 } }]) {
    for (const arrangement of ['projection', 'text']) {
      it(`clears prior evidence for ${arrangement} ${JSON.stringify(replacement)}`, async () => {
        const { doc, send, reads, outbound } = await mount(wire(brief));
        assertBrief(doc);
        send(arrangement === 'projection' ? { structuredContent: { projection: replacement } } : textWire(replacement));
        assertCleared(doc);
        send(wire(brief, true));
        assertBrief(doc);
        assert.equal(reads(), 0);
        assert.ok(outbound.every(msg => ['ui/initialize', 'ui/notifications/size-changed'].includes(msg.method)));
      });
    }
  }
  it('retains parent identity, JSON-RPC and message-method gates', async () => {
    const { doc, message } = await mount(wire(brief));
    const params = { result: textWire(null) };
    message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params }, {});
    message({ jsonrpc: '1.0', method: 'ui/notifications/tool-result', params });
    message({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params });
    assertBrief(doc);
  });
  it('shows soft failures before rendering and recovers through the existing bridge', async () => {
    const { doc, send, reads } = await mount(wire(brief));
    for (const [value, expected] of [
      [{ _budget_exceeded: true }, /too large/],
      [{ _jmespath_error: true }, /projection could not/],
      [{ error: 'Source unavailable' }, /Source unavailable/],
    ]) {
      send(wire(value));
      assert.equal(doc.getElementById('card').style.display, 'none');
      assert.equal(doc.getElementById('empty').style.display, 'block');
      assert.match(doc.getElementById('empty').textContent, expected);
      send(wire(brief, true));
      assertBrief(doc);
      assert.equal(doc.getElementById('empty').style.display, 'none');
    }
    assert.equal(reads(), 0);
  });
});
