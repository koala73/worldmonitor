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
    await callback(win.document, send, messages);
    assert.equal(reads, 0);
    assert.equal(messages.filter(message => ['tools/call', 'ui/call-tool'].includes(message?.method)).length, 0);
  } finally { await win.happyDOM.close(); }
}
const rows = document => document.querySelectorAll('.crow');
const footer = document => document.getElementById('foot').textContent;

describe('Chokepoint Monitor local route details', () => {
  const values = detail => Object.fromEntries(Array.from(detail.querySelectorAll('.cstat'), item => [item.querySelector('.k').textContent, item.querySelector('.v').textContent]));
  const supplied = row({ todayCargo: 12, todayOther: 2, incidentCount7d: 7, disruptionPct: 12.5, anomaly: { signal: true } });

  it('opens independently named native disclosures and reports host size without data calls', async () => {
    const full = payload({ hormuz: supplied, suez: supplied });
    for (const wire of [result(full), { content: result(full).content }, result(full, true), result(full.data, true)]) {
      await mount(wire, async (document, send, messages) => {
        const details = document.querySelectorAll('.crow details');
        assert.equal(details.length, 2, 'Each supplied route needs a native disclosure');
        assert.equal(details[0].open, false);
        assert.equal(details[1].open, false);
        const control = details[0].querySelector('summary');
        assert.equal(control.getAttribute('aria-label'), 'Route details for Hormuz');
        assert.equal(details[1].querySelector('summary').getAttribute('aria-label'), 'Route details for Suez Canal');
        const before = messages.filter(message => message.method === 'ui/notifications/size-changed').length;
        control.click();
        await document.defaultView.happyDOM.waitUntilComplete();
        const afterOpen = messages.filter(message => message.method === 'ui/notifications/size-changed').length;
        assert.ok(afterOpen > before, 'Opening the first route must update host height');
        assert.equal(details[0].open, true);
        assert.equal(details[1].open, false);
        assert.deepEqual(values(details[0]), {
          'Cargo, last 24 hours': '12', 'Other, last 24 hours': '2',
          'Reported incidents, 7 days': '7', 'Reported disruption': '12.5%', 'Reported anomaly signal': 'Yes',
        });
        assert.equal(details[0].querySelector('.csum').textContent, 'Summary fetched: 4 Oct 2026, 12:00 UTC');
        control.click();
        assert.equal(details[0].open, false);
        await document.defaultView.happyDOM.waitUntilComplete();
        const afterClose = messages.filter(message => message.method === 'ui/notifications/size-changed').length;
        assert.ok(afterClose > afterOpen, 'Closing the first route must update host height');
        details[1].querySelector('summary').click();
        await document.defaultView.happyDOM.waitUntilComplete();
        assert.equal(details[1].open, true);
        assert.equal(details[0].open, false);
        const afterSecondOpen = messages.filter(message => message.method === 'ui/notifications/size-changed').length;
        assert.ok(afterSecondOpen > afterClose, 'Opening the second route must update host height');
        details[1].querySelector('summary').click();
        await document.defaultView.happyDOM.waitUntilComplete();
        assert.equal(details[1].open, false);
        assert.equal(details[0].open, false);
        assert.ok(messages.filter(message => message.method === 'ui/notifications/size-changed').length > afterSecondOpen, 'Closing the second route must update host height');
      });
    }
  });

  it('preserves measured zeros and separates unavailable daily counts from independent signals', async () => {
    const zero = row({ todayCargo: 0, todayOther: 0, incidentCount7d: 0, disruptionPct: 0, anomaly: { signal: false }, dataAvailable: false });
    await mount(result(payload({ zero, unavailable: { ...zero, todayCountsAvailable: false }, missing: row() })), document => {
      const details = document.querySelectorAll('.crow details');
      assert.equal(details.length, 3);
      assert.deepEqual(values(details[0]), {
        'Cargo, last 24 hours': '0', 'Other, last 24 hours': '0',
        'Reported incidents, 7 days': '0', 'Reported disruption': '0%', 'Reported anomaly signal': 'No',
      });
      assert.deepEqual(values(details[1]), { ...values(details[0]), 'Cargo, last 24 hours': '—', 'Other, last 24 hours': '—' });
      assert.deepEqual(values(details[2]), {
        'Cargo, last 24 hours': '—', 'Other, last 24 hours': '—',
        'Reported incidents, 7 days': '—', 'Reported disruption': '—', 'Reported anomaly signal': 'Unknown',
      });
      assert.match(rows(document)[0].textContent, /No weekly history, so the weekly change is unknown\./);
    });
  });

  it('rejects malformed detail values rather than converting them to zero or a signal', async () => {
    for (const invalid of [null, '4', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const full = payload({ controlled: row({ todayCargo: invalid, todayOther: invalid, incidentCount7d: invalid, disruptionPct: 101, anomaly: { signal: invalid } }) });
      full.data['transit-summaries'].fetchedAt = 'invalid';
      await mount(result(full), document => {
        const detail = document.querySelector('.crow details');
        assert.ok(detail, 'Invalid details must not remove the route disclosure');
        assert.deepEqual(values(detail), {
          'Cargo, last 24 hours': '—', 'Other, last 24 hours': '—',
          'Reported incidents, 7 days': '—', 'Reported disruption': '—', 'Reported anomaly signal': 'Unknown',
        });
        assert.equal(detail.querySelector('.csum').textContent, 'Summary fetched: Unknown');
      });
    }
    for (const disruptionPct of [null, '0', -0.1, Infinity, NaN]) {
      await mount(result(payload({ controlled: row({ disruptionPct, anomaly: [] }) })), document => {
        const detail = document.querySelector('.crow details');
        assert.ok(detail);
        assert.equal(values(detail)['Reported disruption'], '—');
        assert.equal(values(detail)['Reported anomaly signal'], 'Unknown');
      });
    }
  });

  it('clears expanded details on result replacement and preserves literal route names and the row bound', async () => {
    await mount(result(payload({ old_route: supplied })), (document, send) => {
      const old = document.querySelector('.crow details');
      assert.ok(old);
      old.querySelector('summary').click();
      assert.equal(old.open, true);
      const hostile = '<img src=x onerror=alert(1)>';
      send(result(payload({ [hostile]: row({ todayCargo: 0 }) }), true));
      const replacement = document.querySelector('.crow details');
      assert.notEqual(replacement, old);
      assert.equal(old.isConnected, false);
      assert.equal(replacement.open, false);
      assert.equal(replacement.querySelector('summary').getAttribute('aria-label'), 'Route details for <img Src=x Onerror=alert(1)>');
      assert.equal(values(replacement)['Cargo, last 24 hours'], '0');
      assert.equal(document.querySelectorAll('#rows img, #rows script, #rows a').length, 0);
      send(result(payload(Object.fromEntries(Array.from({ length: 25 }, (_, index) => ['route_' + index, supplied]))), true));
      assert.equal(document.querySelectorAll('.crow details').length, 20);
      send(result(null, true));
      assert.equal(document.querySelectorAll('.crow details').length, 0);
      assert.equal(footer(document), '');
    });
  });
});

describe('Chokepoint Monitor supplied projections', () => {
  it('preserves full, text and direct-data controls', async () => {
    const full = payload();
    for (const [wire, snapshot] of [[result(full), true], [{ content: result(full).content }, true], [result(full.data), false]]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 2);
        assert.equal(footer(document).includes('Some of this data is out of date.'), snapshot);
        assert.match(footer(document), /^Transit counts updated 4 Oct 2026, 12:00 UTC/);
      });
    }
  });
  it('renders whole-envelope and direct-data projections with original partial-source and unknown counts', async () => {
    const full = payload();
    for (const [wire, snapshot] of [[result(full, true), true], [result(full.data, true), false]]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 2, 'Supplied projected summaries must remain visible');
        const hormuz = rows(document)[0];
        assert.match(hormuz.textContent, /No weekly history, so the weekly change is unknown\./);
        assert.doesNotMatch(hormuz.textContent, /-80/);
        assert.equal(hormuz.querySelector('.cstat .v').textContent, '—');
        assert.match(rows(document)[1].textContent, /Week over week\+12\.5%/);
        assert.equal(footer(document).includes('Some of this data is out of date.'), snapshot);
        assert.match(footer(document), /^Transit counts updated 4 Oct 2026, 12:00 UTC/);
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
        assert.equal(document.getElementById('rows').textContent, '7 chokepoints reported, but this response left out their transit figures.');
        assert.doesNotMatch(document.getElementById('rows').textContent, /No chokepoint transit data available/);
        assert.match(footer(document), /Some of this data is out of date\./);
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
        assert.equal(document.getElementById('rows').textContent, 'Chokepoints reported, but this response left out their transit figures.');
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
      assert.equal(rows(document)[0].querySelector('.risk').textContent, 'Risk unknown');
    });
  });
  it('keeps missing and malformed risk neutral while preserving explicit risk values', async () => {
    for (const riskLevel of [undefined, null, false, 0, {}, [], '', '  ', 'unsupported', '<img src=x>']) {
      await mount(result(payload({ malacca: row({ riskLevel }) })), document => {
        const badge = rows(document)[0].querySelector('.risk');
        assert.equal(badge.textContent, 'Risk unknown');
        assert.equal(badge.style.color, document.defaultView.getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
      });
    }
    await mount(result(payload({ hormuz_strait: row(), bab_el_mandeb: row(), unlisted_new_route: row() })), document => {
      assert.deepEqual([...document.querySelectorAll('.cname')].map(node => node.textContent), ['Strait of Hormuz', 'Bab el-Mandeb', 'Unlisted New Route'],
        'registry ids use their canonical names; unknown ids are title-cased');
    });
    for (const [wowChangePct, expected] of [[12.5, '+12.5%'], [-11.54, '-11.5%'], [0.04, '0.0%'], [-0.04, '0.0%'], [6, '+6.0%']]) {
      await mount(result(payload({ controlled: row({ wowChangePct }) })), document => {
        assert.equal(rows(document)[0].querySelectorAll('.cstat .v')[1].textContent, expected, String(wowChangePct));
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
        assert.match(supplied.textContent, dataAvailable === false ? /No weekly history, so the weekly change is unknown\./ : /Weekly history status unknown\./);
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
        assert.equal(document.getElementById('coverage').textContent, 'Live ship tracking covers 5 of 13 chokepoints. Not covered: '
          + 'Suez Canal, Strait of Malacca, Bab el-Mandeb, Panama Canal, Cape of Good Hope, Korea Strait, Kerch Strait, Lombok Strait.');
        const lines = footer(document).split('\n');
        assert.deepEqual(lines.slice(0, 3), ['Transit counts updated 6 Oct 2026, 19:47 UTC', 'Ship tracking updated 6 Oct 2026, 19:48 UTC',
          'Energy baseline: EIA World Oil Transit Chokepoints, 2023']);
        assert.doesNotMatch(footer(document), /5 Apr 2026|2026-04-05/, 'the old baseline cache time is not shown as the panel time');
        if (!hasEnvelope) assert.equal(lines.length, 3);
      });
    }
    await mount(result(full), document => {
      assert.deepEqual(footer(document).split('\n').slice(3), ['Some of this data is out of date.', 'Freshness could not be checked.']);
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
        assert.match(document.getElementById('coverage').textContent, /^Live ship tracking coverage is unknown\./);
        assert.deepEqual(footer(document).split('\n'), ['Transit count update time unknown', 'Ship tracking update time unknown',
          'Energy baseline: <img src=x>, reference year unknown', 'Some of this data is out of date.']);
        assert.equal(document.querySelectorAll('#foot img').length, 0);
      });
    }
    const full = payload();
    full.data.chokepoint_transits = { transitCoverage: { covered: 0, total: 13, missing: [] } };
    await mount(result(full), document => { assert.equal(document.getElementById('coverage').textContent, 'Live ship tracking covers 0 of 13 chokepoints.'); });
  });
  it('accepts supplied ISO and epoch clocks while keeping invalid clock values unknown', async () => {
    for (const fetchedAt of [1791316125447, '1791316125447', '2026-10-06T19:48:45.447Z']) {
      const full = payload();
      full.data['transit-summaries'].fetchedAt = fetchedAt;
      full.data['chokepoint-baselines'] = { referenceYear: '2023' };
      await mount(result(full), document => {
        assert.match(footer(document), /Transit counts updated 6 Oct 2026, 19:48 UTC/);
        assert.match(footer(document), /Energy baseline: source unknown, 2023/);
      });
    }
    for (const fetchedAt of [undefined, false, true, null, '', '0', 0, -1, 'bad', {}, []]) {
      const full = payload();
      full.data['transit-summaries'].fetchedAt = fetchedAt;
      await mount(result(full), document => { assert.match(footer(document), /^Transit count update time unknown/); });
    }
  });
  it('keeps the cached update time when only the energy baseline is present', async () => {
    const baselineOnly = { cached_at: '2026-10-04T12:00:00.000Z', stale: false,
      data: { 'chokepoint-baselines': { referenceYear: 2023, source: 'EIA World Oil Transit Chokepoints' } } };
    await mount(result(baselineOnly), document => {
      assert.match(footer(document), /Energy baseline: EIA World Oil Transit Chokepoints, 2023/);
      assert.match(footer(document), /Updated 4 Oct 2026, 12:00 UTC/, 'a baseline is not an update clock');
    });
  });
  it('clears omitted coverage and clocks on replacement projections without acquiring data', async () => {
    const full = payload();
    full.freshnessUnknown = true;
    full.data.chokepoint_transits = { fetchedAt: 1791316125447, transitCoverage: { covered: 5, total: 13, missing: ['suez'] } };
    full.data['chokepoint-baselines'] = { referenceYear: 2023, updatedAt: '2026-04-05T18:19:44.514Z' };
    await mount(result(full), async (document, send) => {
      assert.match(document.getElementById('coverage').textContent, /5 of 13/);
      send(result({ 'transit-summaries': { summaries: { suez: row() } } }, true));
      assert.equal(rows(document).length, 1);
      assert.equal(document.getElementById('coverage').textContent, '');
      assert.equal(footer(document), 'Transit count update time unknown');
      for (const replacement of [null, {}, 'no data', []]) {
        send(result(replacement, true));
        assert.equal(document.getElementById('coverage').textContent, '');
        assert.equal(footer(document), '');
        assert.equal(rows(document).length, 0);
      }
    });
  });
});
