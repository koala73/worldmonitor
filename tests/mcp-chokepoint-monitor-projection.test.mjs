import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { CHOKEPOINT_MONITOR_APP_HTML } from '../api/mcp/ui/chokepoint-monitor-app.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { summarizeData } from '../api/mcp/filters.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { buildUiResourceRead, isUiResourceUri, UI_RESOURCE_LIST_RESPONSE } from '../api/mcp/ui/registry.ts';
import { mcpHandler } from '../api/mcp.ts';
import { makeProDeps } from './helpers/mcp-pro-deps.mjs';

const row = (overrides = {}) => ({ todayTotal: 18, todayTanker: 4, wowChangePct: 12.5, riskLevel: 'normal', dataAvailable: true, ...overrides });
const payload = (summaries = { hormuz: row({ todayTotal: null, dataAvailable: false, wowChangePct: -80, riskLevel: 'high' }), suez: row() }) => ({
  cached_at: '2026-10-04T12:00:00.000Z', stale: true,
  data: { 'transit-summaries': { summaries, fetchedAt: '2026-10-04T12:00:00.000Z' } },
});
const result = (value, reshaped = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: buildStructuredContent(value, { reshaped, rider: null }) });
async function mount(wire, callback) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  let reads = 0;
  const messages = [];
  try {
    win.document.write(CHOKEPOINT_MONITOR_APP_HTML);
    win.eval('window.parent').postMessage = message => messages.push(message);
    win.fetch = async () => { reads++; throw new Error('Unexpected data read'); };
    win.eval(win.document.querySelector('script').textContent);
    const send = value => win.dispatchEvent(new win.MessageEvent('message', { source: win.eval('window.parent'), data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: value } } }));
    send(wire);
    await win.happyDOM.waitUntilComplete();
    await callback(win.document, send);
    assert.equal(reads, 0);
    assert.equal(messages.filter(message => ['tools/call', 'ui/call-tool'].includes(message?.method)).length, 0);
  } finally { await win.happyDOM.close(); }
}
const rows = document => document.querySelectorAll('.crow');
const footer = document => document.getElementById('foot').textContent;

describe('Chokepoint Monitor supplied projections', () => {
  it('preserves full, text and direct-data controls', async () => {
    const full = payload();
    for (const [wire, snapshot] of [[result(full), true], [{ content: result(full).content }, true], [result(full.data), false]]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 2);
        assert.equal(footer(document).includes('Snapshot: 2026-10-04T12:00:00.000Z (stale)'), snapshot);
      });
    }
  });
  it('renders whole-envelope and direct-data projections with original partial-source and unknown counts', async () => {
    const full = payload();
    for (const [wire, snapshot] of [[result(full, true), true], [result(full.data, true), false]]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 2, 'Supplied projected summaries must remain visible');
        const hormuz = rows(document)[0];
        assert.match(hormuz.textContent, /PortWatch history unavailable/);
        assert.doesNotMatch(hormuz.textContent, /-80/);
        assert.equal(hormuz.querySelector('.cstat .v').textContent, '—');
        assert.match(rows(document)[1].textContent, /\+12\.50%/);
        assert.equal(footer(document).includes('Snapshot: 2026-10-04T12:00:00.000Z (stale)'), snapshot);
      });
    }
  });
  it('renders summary results that retain the original small summary map', async () => {
    const full = payload();
    const summary = { ...full, data: summarizeData(full.data) };
    await mount(result(summary, true), document => { assert.equal(rows(document).length, 2); });
  });
  it('discloses actual key-only summary shape without fabricating transit rows', async () => {
    const full = payload(Object.fromEntries(Array.from({ length: 7 }, (_, i) => ['controlled_' + i, row()])));
    const summary = { ...full, data: summarizeData(full.data) };
    assert.deepEqual(summary.data['transit-summaries'].summaries, { count: 7, sample_keys: ['controlled_0', 'controlled_1', 'controlled_2'] });
    for (const wire of [result(summary, true), { content: result(summary).content }]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 0);
        assert.match(document.getElementById('rows').textContent, /Summary reports 7 chokepoints/);
        assert.match(document.getElementById('rows').textContent, /Transit records are not loaded/);
        assert.doesNotMatch(document.getElementById('rows').textContent, /No chokepoint transit data available/);
        assert.match(footer(document), /Snapshot: .*\(stale\)/);
      });
    }
  });
  it('keeps the original 20-row cap on complete supplied maps', async () => {
    await mount(result(payload(Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['controlled_' + i, row()]))), true), document => { assert.equal(rows(document).length, 20); });
  });
  it('does not claim an invalid or contradictory summary count', async () => {
    for (const count of [null, '7', -1, 1.5, 1]) {
      await mount(result(payload({ count, sample_keys: ['hormuz', 'suez'] }), true), document => {
        assert.equal(rows(document).length, 0);
        assert.match(document.getElementById('rows').textContent, /Summary count is unavailable/);
      });
    }
  });
  it('replaces previous rows and stale snapshot on missing, empty and scalar projected results', async () => {
    await mount(result(payload(), true), async (document, send) => {
      assert.equal(rows(document).length, 2);
      for (const value of [null, 'no data', [], {}, { 'transit-summaries': { summaries: {} } }]) {
        send(result(value, true));
        assert.equal(rows(document).length, 0);
        assert.equal(footer(document), '');
      }
      send(result(payload()));
      assert.equal(rows(document).length, 2);
    });
  });
  it('does not make fake rows from malformed array summaries or row values', async () => {
    for (const summaries of [[], [row()], { valid: row(), bad: [], absent: null }]) {
      await mount(result(payload(summaries), true), document => { assert.equal(rows(document).length, Array.isArray(summaries) ? 0 : 1); });
    }
  });
  it('renders hostile source prose literally', async () => {
    const hostile = '<img src=x onerror="globalThis.pwned=true">';
    await mount(result(payload({ controlled: row({ riskSummary: hostile }) }), true), document => {
      assert.match(document.getElementById('rows').textContent, /<img src=x onerror=/);
      assert.equal(document.querySelectorAll('#rows img, #rows script').length, 0);
    });
  });
});

describe('Chokepoint Monitor current resource and private legacy read', () => {
  const current = 'ui://worldmonitor/chokepoint-monitor-v2.html';
  const legacy = 'ui://worldmonitor/chokepoint-monitor.html';
  it('advertises one current URI and preserves both data-free static reads', async () => {
    assert.equal(CACHE_TOOLS.find(tool => tool.name === 'get_chokepoint_status')._uiResourceUri, current);
    assert.ok(UI_RESOURCE_LIST_RESPONSE.some(resource => resource.uri === current));
    assert.ok(!UI_RESOURCE_LIST_RESPONSE.some(resource => resource.uri === legacy));
    assert.equal(UI_RESOURCE_LIST_RESPONSE.filter(resource => resource.name === 'Chokepoint Monitor (interactive)').length, 1);
    for (const uri of [current, legacy]) {
      assert.ok(isUiResourceUri(uri));
      const body = await (await buildUiResourceRead(1, uri, {})).json();
      assert.equal(body.result.contents[0].uri, uri);
      assert.equal(body.result.contents[0].text, CHOKEPOINT_MONITOR_APP_HTML);
      assert.equal(body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    }
  });
  it('serves current and legacy anonymously without reservations or data calls', async () => {
    const { deps, pipe } = makeProDeps();
    const original = globalThis.fetch;
    let reads = 0;
    try {
      globalThis.fetch = async () => { reads++; throw new Error('Static read must not acquire data'); };
      for (const uri of [current, legacy]) {
        const response = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
        }), deps);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.result.contents[0].uri, uri);
        assert.equal(body.result.contents[0].text, CHOKEPOINT_MONITOR_APP_HTML);
      }
      assert.equal(reads, 0);
      assert.equal(pipe.count, 0);
      assert.deepEqual(pipe.ops, []);
    } finally { globalThis.fetch = original; }
  });
});
