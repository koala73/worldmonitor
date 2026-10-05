import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { WORLD_BRIEF_APP_HTML } from '../api/mcp/ui/world-brief-app.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { applyJmespath } from '../api/mcp/jmespath.ts';

const windows = [];
const payload = {
  brief: 'Controlled lead [1].\n\nControlled second paragraph [2].',
  summary: 'Controlled lead [1].\n\nControlled second paragraph [2].',
  headlines: ['Headline one', 'Headline two'],
  sources: [
    { title: 'Article one', url: 'https://example.com/one', source: 'Wire One' },
    { title: 'Article two', url: 'https://example.com/two', source: 'Wire Two' },
  ],
  stale: true, ageMinutes: 90,
  provider: 'controlled-provider', model: 'controlled-model', generatedAt: '2026-10-04T23:00:00Z',
};
const summaryQuery = '{summary: summary, headlines: headlines, sources: sources, stale: stale, ageMinutes: ageMinutes, provider: provider, model: model, generatedAt: generatedAt}';
const wire = (value, reshaped = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: buildStructuredContent(value, { reshaped, rider: null }),
});
async function mount(result) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(WORLD_BRIEF_APP_HTML);
  win.eval(win.document.querySelector('script').textContent);
  const messages = [];
  win.eval('window.parent').postMessage = message => messages.push(message);
  let reads = 0;
  win.fetch = async () => { reads++; throw new Error('Unexpected read'); };
  const send = next => win.dispatchEvent(new win.MessageEvent('message', {
    source: win.eval('window.parent'),
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: next } },
  }));
  send(result);
  await win.happyDOM.waitUntilComplete();
  return { win, doc: win.document, send, messages, reads: () => reads };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });
function assertEvidence(doc) {
  assert.deepEqual([...doc.querySelectorAll('#brief .para')].map(node => node.textContent), ['Controlled lead [1].', 'Controlled second paragraph [2].']);
  assert.deepEqual([...doc.querySelectorAll('#headlines li')].map(node => node.textContent), payload.headlines);
  assert.deepEqual([...doc.querySelectorAll('#sources a')].map(node => node.href), payload.sources.map(source => source.url));
  assert.equal(doc.getElementById('stale-note').style.display, 'block');
  assert.match(doc.getElementById('stale-note').textContent, /1h 30m old/);
  assert.equal(doc.getElementById('foot').textContent, 'controlled-provider · controlled-model · Generated 2026-10-04T23:00:00Z');
}
describe('World Brief exported HTML projections', () => {
  for (const query of ['@', summaryQuery]) {
    it(`retains all supplied evidence for structured projection ${query}`, async () => {
      const projected = applyJmespath(payload, query);
      assert.equal(projected.failed, undefined);
      const { doc, messages, reads } = await mount(wire(projected.value, true));
      assertEvidence(doc);
      assert.equal(reads(), 0);
      assert.ok(messages.every(message => message.method === 'ui/notifications/size-changed'));
    });
  }
  it('preserves original, direct summary and text-only payload controls', async () => {
    for (const result of [wire(payload), wire(applyJmespath(payload, summaryQuery).value), { content: [{ type: 'text', text: JSON.stringify(payload) }] }]) {
      assertEvidence((await mount(result)).doc);
    }
  });
  for (const replacement of [null, [], {}, 7, 'unloaded', { brief: 5, headlines: { count: 2 }, sources: { count: 2, sample_keys: ['one', 'two'] } }]) {
    it(`clears loaded evidence when projection is ${JSON.stringify(replacement)}`, async () => {
      const { doc, send } = await mount(wire(payload));
      assertEvidence(doc);
      send({ structuredContent: { projection: replacement } });
      assert.equal(doc.querySelectorAll('#brief .para').length, 0);
      assert.equal(doc.querySelectorAll('#headlines li').length, 0);
      assert.equal(doc.querySelectorAll('#sources .src-row').length, 0);
      assert.equal(doc.getElementById('foot').textContent, '');
      assert.equal(doc.getElementById('stale-note').style.display, 'none');
      assert.match(doc.getElementById('brief').textContent, /No brief text available/);
    });
  }
  it('preserves safe literal prose, source order and original caps without inventing summary rows', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { doc } = await mount(wire({ ...payload, brief: hostile, headlines: Array.from({ length: 15 }, (_, i) => `Headline ${i}`), sources: Array.from({ length: 10 }, (_, i) => ({ title: hostile, source: `Wire ${i}`, url: i === 0 ? 'javascript:alert(1)' : `https://example.com/${i}` })), ageMinutes: null }, true));
    assert.equal(doc.querySelector('#brief .para').textContent, hostile);
    assert.equal(doc.querySelector('img'), null);
    assert.equal(doc.querySelectorAll('#headlines li').length, 12);
    assert.equal(doc.querySelectorAll('#sources .src-row').length, 8);
    assert.equal(doc.querySelector('#sources .src-title').tagName, 'SPAN');
    assert.deepEqual([...doc.querySelectorAll('#sources a')].map(node => node.href), Array.from({ length: 7 }, (_, i) => `https://example.com/${i + 1}`));
    assert.doesNotMatch(doc.getElementById('stale-note').textContent, /0 minutes|0h/);
  });
  it('replaces stale provenance and links with the next projected original', async () => {
    const { doc, send } = await mount(wire(payload, true));
    send(wire({ brief: 'Replacement', stale: false }, true));
    assert.equal(doc.getElementById('brief').textContent, 'Replacement');
    assert.equal(doc.querySelectorAll('#sources a').length, 0);
    assert.equal(doc.getElementById('foot').textContent, '');
    assert.equal(doc.getElementById('stale-note').style.display, 'none');
  });
});
