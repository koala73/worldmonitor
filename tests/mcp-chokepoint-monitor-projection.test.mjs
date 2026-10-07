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


describe('Chokepoint Monitor supplied display truth', () => {
  it('keeps blank supplied risk unknown after mounting the supplied row', async () => {
    await mount(result(payload({ malacca: row({ riskLevel: '' }) })), document => {
      assert.equal(rows(document).length, 1, 'Supplied row must mount before semantic assertion');
      assert.match(rows(document)[0].textContent, /Malacca/);
      assert.equal(rows(document)[0].querySelector('.risk').textContent, 'Unknown');
    });
  });
  it('keeps missing and malformed risk neutral while preserving explicit risk values', async () => {
    for (const riskLevel of [undefined, null, false, 0, {}, [], '', '  ', 'unsupported', '<img src=x>']) {
      await mount(result(payload({ malacca: row({ riskLevel }) })), document => {
        const badge = rows(document)[0].querySelector('.risk');
        assert.equal(badge.textContent, 'Unknown');
        assert.equal(badge.style.color, document.defaultView.getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
      });
    }
    for (const riskLevel of ['normal', 'high', 'critical', 'severe', 'moderate', 'elevated', 'warning', 'low']) {
      await mount(result(payload({ controlled: row({ riskLevel }) })), document => {
        assert.equal(rows(document)[0].querySelector('.risk').textContent, riskLevel);
      });
    }
  });
  it('uses strict rolling counts and availability flags without coercing unknown values to zero', async () => {
    for (const value of [undefined, null, false, true, '', '0', '18', -1, 1.5, NaN, Infinity]) {
      await mount(result(payload({ controlled: row({ todayTotal: value, todayTanker: value }) })), document => {
        const stats = rows(document)[0].querySelectorAll('.cstat');
        assert.equal(stats[0].querySelector('.k').textContent, 'Last 24 hours');
        assert.equal(stats[0].querySelector('.v').textContent, '—');
        assert.equal(stats[2].querySelector('.v').textContent, '—');
        assert.doesNotMatch(rows(document)[0].textContent, /Transits today/);
      });
    }
    for (const todayCountsAvailable of [undefined, true, false, null, 'true', 1]) {
      await mount(result(payload({ controlled: row({ todayTotal: 0, todayTanker: 0, todayCountsAvailable }) })), document => {
        const values = rows(document)[0].querySelectorAll('.cstat .v');
        const expected = todayCountsAvailable === undefined || todayCountsAvailable === true ? '0' : '—';
        assert.equal(values[0].textContent, expected);
        assert.equal(values[2].textContent, expected);
      });
    }
  });
  it('separates PortWatch history from positive AIS counts and requires explicit history for change', async () => {
    for (const dataAvailable of [false, undefined, null, 'true', 1]) {
      await mount(result(payload({ hormuz: row({ todayTotal: 42, todayTanker: 11, dataAvailable, wowChangePct: -80 }) })), document => {
        const supplied = rows(document)[0];
        assert.equal(supplied.querySelector('.cstat .v').textContent, '42');
        assert.equal(supplied.querySelectorAll('.cstat .v')[1].textContent, '—');
        assert.match(supplied.textContent, dataAvailable === false ? /PortWatch history unavailable/ : /PortWatch history unknown/);
      });
    }
    for (const wowChangePct of [null, false, '', '12.5']) {
      await mount(result(payload({ controlled: row({ wowChangePct }) })), document => {
        assert.equal(rows(document)[0].querySelectorAll('.cstat .v')[1].textContent, '—');
      });
    }
  });
  it('shows supplied coverage and original fetch clocks separately from EIA baseline and snapshot', async () => {
    const full = payload({ malacca: row({ riskLevel: '' }), hormuz: row({ todayTotal: 2, todayTanker: 0 }) });
    full.cached_at = '2026-04-05T18:19:45.192Z';
    full.freshnessUnknown = true;
    full.data['transit-summaries'].fetchedAt = 1791316073219;
    full.data.chokepoint_transits = { transits: {}, fetchedAt: 1791316125447,
      transitCoverage: { covered: 5, total: 13, missing: ['suez', 'malacca_strait', 'bab_el_mandeb', 'panama', 'cape_of_good_hope', 'korea_strait', 'kerch_strait', 'lombok_strait'] } };
    full.data['chokepoint-baselines'] = { referenceYear: 2023, updatedAt: '2026-04-05T18:19:44.514Z', source: 'EIA World Oil Transit Chokepoints' };
    for (const [wire, hasEnvelope] of [[result(full), true], [{ content: result(full).content }, true], [result(full, true), true], [result(full.data, true), false]]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 2);
        assert.match(document.getElementById('coverage').textContent, /^AIS coverage: 5\/13 · Missing: Suez, Malacca strait/);
        assert.match(footer(document), /Summary fetched: 2026-10-06T19:47:53.219Z/);
        assert.match(footer(document), /AIS fetched: 2026-10-06T19:48:45.447Z/);
        assert.match(footer(document), /Baseline: EIA World Oil Transit Chokepoints · Reference year: 2023 · Updated: 2026-04-05T18:19:44.514Z/);
        if (!hasEnvelope) assert.doesNotMatch(footer(document), /Snapshot:|Freshness:/);
      });
    }
    await mount(result(full), document => {
      assert.match(footer(document), /Snapshot: 2026-04-05T18:19:45.192Z \(stale\)/);
      assert.match(footer(document), /Freshness: Unknown/);
    });
  });
  it('does not infer coverage from mounted routes and rejects invalid coverage bounds and clocks', async () => {
    for (const transitCoverage of [undefined, null, {}, { covered: null, total: 13 }, { covered: false, total: 13 },
      { covered: '5', total: 13 }, { covered: 5, total: 0 }, { covered: -1, total: 13 }, { covered: 14, total: 13 }, { covered: 5.5, total: 13 }]) {
      const full = payload();
      full.data.chokepoint_transits = { fetchedAt: false, transitCoverage };
      full.data['transit-summaries'].fetchedAt = null;
      full.data['chokepoint-baselines'] = { referenceYear: false, updatedAt: 'bad', source: '<img src=x>' };
      full.cached_at = 'bad';
      await mount(result(full), document => {
        assert.match(document.getElementById('coverage').textContent, /^AIS coverage: Unknown/);
        assert.match(footer(document), /Summary fetched: Unknown/);
        assert.match(footer(document), /AIS fetched: Unknown/);
        assert.match(footer(document), /Reference year: Unknown · Updated: Unknown/);
        assert.match(footer(document), /Snapshot: Unknown/);
        assert.equal(document.querySelectorAll('#foot img').length, 0);
      });
    }
    const full = payload();
    full.data.chokepoint_transits = { transitCoverage: { covered: 0, total: 13, missing: [] } };
    await mount(result(full), document => { assert.match(document.getElementById('coverage').textContent, /^AIS coverage: 0\/13/); });
  });
  it('accepts supplied ISO and epoch clocks while keeping invalid clock values unknown', async () => {
    for (const fetchedAt of [1791316125447, '1791316125447', '2026-10-06T19:48:45.447Z']) {
      const full = payload();
      full.data['transit-summaries'].fetchedAt = fetchedAt;
      full.data['chokepoint-baselines'] = { referenceYear: '2023' };
      await mount(result(full), document => {
        assert.match(footer(document), /Summary fetched: 2026-10-06T19:48:45.447Z/);
        assert.match(footer(document), /Reference year: 2023/);
      });
    }
    for (const fetchedAt of [undefined, false, true, null, '', '0', 0, -1, 'bad', {}, []]) {
      const full = payload();
      full.data['transit-summaries'].fetchedAt = fetchedAt;
      await mount(result(full), document => { assert.match(footer(document), /Summary fetched: Unknown/); });
    }
  });
  it('clears omitted coverage and clocks on replacement projections without acquiring data', async () => {
    const full = payload();
    full.freshnessUnknown = true;
    full.data.chokepoint_transits = { fetchedAt: 1791316125447, transitCoverage: { covered: 5, total: 13, missing: ['suez'] } };
    full.data['chokepoint-baselines'] = { referenceYear: 2023, updatedAt: '2026-04-05T18:19:44.514Z' };
    await mount(result(full), async (document, send) => {
      assert.match(document.getElementById('coverage').textContent, /5\/13/);
      send(result({ 'transit-summaries': { summaries: { suez: row() } } }, true));
      assert.equal(rows(document).length, 1);
      assert.equal(document.getElementById('coverage').textContent, '');
      assert.equal(footer(document), 'Summary fetched: Unknown');
      for (const replacement of [null, {}, 'no data', []]) {
        send(result(replacement, true));
        assert.equal(document.getElementById('coverage').textContent, '');
        assert.equal(footer(document), '');
        assert.equal(rows(document).length, 0);
      }
    });
  });
});
