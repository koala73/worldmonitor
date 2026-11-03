import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geoEquirectangular, geoPath } from 'd3';
import { feature } from 'topojson-client';
import { Window } from 'happy-dom';
import { Ratelimit } from '@upstash/ratelimit';
import { makeProDeps, proReq, callBody, HMAC_SECRET } from './helpers/mcp-pro-deps.mjs';
import { CONFLICT_EVENTS_APP_HTML } from '../api/mcp/ui/conflict-events-app.ts';
import { CONFLICT_MAP_BASE } from '../api/mcp/ui/_conflict-map-base.ts';

const originalFetch = globalThis.fetch;
const originalLimiter = Ratelimit.slidingWindow;
const originalEnv = { ...process.env };
const attemptedNetwork = [];
const fixtureReads = [];
const limiterCalls = [];
const fetchedAt = Date.parse('2026-10-03T16:00:00Z');
const sourceOriginal = 'Controlled UCDP cited publisher';
const events = Array.from({ length: 8 }, (_, i) => ({
  id: 'controlled-' + i,
  sideA: 'Controlled side A ' + (i + 1), sideB: 'Controlled side B',
  violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', country: 'Controlled country',
  deathsBest: i === 0 ? undefined : i === 1 ? 0 : i * 10,
  dateStart: i === 0 ? 'unknown' : '2026-10-02T12:00:00Z',
  sourceOriginal,
  ...(i === 2 ? { location: { latitude: 15.905545, longitude: 48.672436 } }
    : i === 3 ? { location: { latitude: 0, longitude: 0 } } : {}),
}));
const twentyEvents = Array.from({ length: 20 }, (_, eventIndex) => ({ ...events[2], id: 'twenty-' + eventIndex, sideA: 'Twenty event ' + eventIndex }));
const largeEvents = Array.from({ length: 160 }, (_, i) => ({
  ...events[2], id: 'large-' + i, sideA: 'Large event ' + i + ' ' + 'x'.repeat(1500),
}));
let activeEvents = events;
let missingUcdp = false;
let missingUcdpMeta = false;
let payloadAnnualFailedPages;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
let handler;
before(async () => {
process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
process.env.MCP_TELEMETRY = 'false';
process.env.UPSTASH_REDIS_REST_URL = 'https://fixture-only.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-only-no-credential';
delete process.env.LOCAL_API_MODE;
delete process.env.VERCEL_ENV;
delete process.env.AXIOM_TOKEN;
delete process.env.AXIOM_DATASET;
Ratelimit.slidingWindow = (tokens, window) => () => ({
  async limit(_ctx, key) {
    limiterCalls.push({ tokens, window, key });
    return { success: true, limit: tokens, remaining: tokens - 1, reset: Date.now() + 60000, pending: Promise.resolve() };
  },
});
globalThis.fetch = async (url, opts) => {
  const address = new URL(String(url));
  if (address.origin !== 'https://fixture-only.upstash.invalid' || !address.pathname.startsWith('/get/')) {
    attemptedNetwork.push({ url: String(url), method: opts?.method || 'GET' });
    throw new Error('Unexpected network call');
  }
  const key = decodeURIComponent(address.pathname.slice(5));
  fixtureReads.push(key);
  let value = null;
  if (key === 'conflict:ucdp-events:v1') value = missingUcdp ? null : { events: activeEvents, fetchedAt, version: 'controlled', candidateVersion: 'controlled+partial', candidateComplete: false, ...(payloadAnnualFailedPages === undefined ? {} : { annualFailedPages: payloadAnnualFailedPages }) };
  else if (key === 'unrest:events:v1') value = { events: [] };
  else if (key === 'risk:scores:sebuf:stale:v14') value = { ciiScores: [] };
  else if (key === 'conflict:iran-events:v1') value = { events: [] };
  else if (key === 'seed-meta:conflict:ucdp-events') value = missingUcdpMeta ? null : { fetchedAt, recordCount: activeEvents.length, candidateVersion: 'controlled+partial', candidateComplete: false, annualFailedPages: 2 };
  else if (key === 'seed-meta:unrest:events') value = { fetchedAt, recordCount: activeEvents.length };
  else throw new Error('Unexpected fixture key ' + key);
  return json({ result: value === null ? null : JSON.stringify(value) });
};
  ({ mcpHandler: handler } = await import('../api/mcp.ts'));
});
after(() => {
  globalThis.fetch = originalFetch;
  Ratelimit.slidingWindow = originalLimiter;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  assert.deepEqual(attemptedNetwork, []);
});

async function result(args = {}, state = 'normal') {
  activeEvents = state === 'large' ? largeEvents : state === 'twenty' ? twentyEvents : state === 'empty' ? [] : events;
  missingUcdp = state === 'missing';
  missingUcdpMeta = state === 'metadata-missing';
  payloadAnnualFailedPages = missingUcdpMeta ? 5 : undefined;
  const { deps } = makeProDeps();
  const response = await handler(proReq('POST', callBody('get_conflict_events', args)), deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, undefined);
  return body.result;
}
async function mount(wire, check) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  try {
    win.document.write(CONFLICT_EVENTS_APP_HTML);
    win.eval(win.document.querySelector('script').textContent);
    const messages = [];
    win.eval('window.parent').postMessage = message => messages.push(message);
    let reads = 0;
    win.fetch = async () => { reads++; throw new Error('Unexpected browser read'); };
    const send = async value => {
      win.dispatchEvent(new win.MessageEvent('message', {
        source: win.eval('window.parent'),
        data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: value } },
      }));
      await win.happyDOM.waitUntilComplete();
    };
    await send(wire);
    await check(win.document, send, messages);
    assert.equal(reads, 0);
    assert.equal(messages.filter(m => ['tools/call', 'ui/call-tool'].includes(m?.method)).length, 0);
  } finally { await win.happyDOM.close(); }
}

describe('Conflict Events actual-handler supported envelopes', () => {
  it('selects the supplied Yemen replay row and its same-event marker, detail and viewport', async () => {
    await mount(await result(), doc => {
      const row = doc.querySelectorAll('.evt')[2];
      assert.equal(row.getAttribute('role'), 'button');
      assert.equal(row.tabIndex, 0);
      const map = doc.getElementById('conflict-map');
      const world = map.getAttribute('viewBox');
      row.click();
      assert.equal(row.getAttribute('aria-pressed'), 'true');
      assert.equal(doc.querySelectorAll('.conflict-marker[aria-pressed="true"]').length, 1);
      assert.notEqual(map.getAttribute('viewBox'), world);
      assert.match(doc.getElementById('conflict-selection').textContent,
        /Controlled side A 3.*State-based.*2 Oct 2026.*20 deaths/);
      assert.doesNotMatch(doc.getElementById('conflict-selection').textContent, /15\.905545|48\.672436/, 'coordinates stay out of reader text');
      assert.equal(doc.getElementById('conflict-locations').textContent, '2 of 8 events have map locations.');
    });
  });
  for (const [name, args, count] of [
    ['full', {}, 8], ['summary', { summary: true }, 3],
    ['whole-envelope projection', { jmespath: '@' }, 8],
    ['summary whole-envelope projection', { summary: true, jmespath: '@' }, 3],
  ]) {
    it(name + ' preserves supplied events and selected-envelope snapshot metadata', async () => {
      const wire = await result(args);
      await mount(wire, doc => {
        const rows = doc.querySelectorAll('.evt');
        assert.equal(rows.length, count);
        assert.match(rows[0].textContent, /Controlled side A 1/);
        assert.equal(rows[0].querySelector('.evt-deaths'), null);
        assert.doesNotMatch(rows[0].textContent, /unknown|Invalid Date/);
        assert.equal(rows[1].querySelector('.evt-deaths').textContent, '0 deaths');
        assert.match(rows[1].textContent, /Controlled country.*State-based.*2 Oct 2026/);
        assert.match(doc.getElementById('foot').textContent, /Updated 3 Oct 2026, 16:00 UTC \(out of date\)\./);
      });
    });
  }
  it('does not invent events from an arbitrary side-name projection', async () => {
    const wire = await result({ jmespath: 'data."ucdp-events".events[].sideA' });
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.match(doc.getElementById('list').textContent, /temporarily unavailable/);
      assert.equal(doc.getElementById('foot').textContent, '');
    });
  });
  it('keeps the byte-fitted full list partial and the existing 14-row display cap', async () => {
    const wire = await result({ limit: 0 }, 'large');
    const data = wire.structuredContent.data;
    assert.ok(Buffer.byteLength(wire.content[0].text) <= 131072);
    assert.equal(data.partial, true);
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 14);
      assert.ok(doc.getElementById('conflict-note').textContent.includes('This response includes ' + data.truncation.returned_event_count + ' of 160 events because of its size limit.'));
      assert.match(doc.getElementById('foot').textContent, /\(out of date\)/);
    });
  });
  it('keeps an authoritative empty projected list distinct from a missing source', async () => {
    const wire = await result({ jmespath: '@' }, 'empty');
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.equal(doc.getElementById('list').textContent, 'No conflict events available.');
    });
  });
  it('replaces loaded rows with a later missing-source result', async () => {
    const full = await result({ jmespath: '@' });
    const missing = await result({}, 'missing');
    await mount(full, async (doc, send) => {
      assert.equal(doc.querySelectorAll('.evt').length, 8);
      await send(missing);
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.match(doc.getElementById('list').textContent, /temporarily unavailable/);
      assert.doesNotMatch(doc.getElementById('list').textContent, /No conflict events available/);
    });
  });
});

describe('Conflict Events geographic selection', () => {
  it('keeps the checked world outline and projection equal to the existing topology', () => {
    const world = JSON.parse(readFileSync(new URL('../public/data/countries-110m.json', import.meta.url), 'utf8'));
    const width = 720;
    const height = 384;
    const scale = (width - 64) / (2 * Math.PI);
    const translate = [width / 2, height / 2];
    const projection = geoEquirectangular().scale(scale).translate(translate);
    assert.deepEqual(CONFLICT_MAP_BASE, {
      width, height, scale, translate,
      path: geoPath(projection).digits(0)(feature(world, world.objects.countries)),
    });
  });
  it('keeps every visible nearby dot above expanded hit targets and selects either event', async () => {
    const wire = await result();
    wire.structuredContent.data['ucdp-events'].events = [45, 55].map((longitude, i) => ({
      ...events[2], sideA: 'Nearby event ' + i, location: { latitude: 15, longitude },
    }));
    await mount(wire, doc => {
      const dots = [...doc.querySelectorAll('.conflict-dot')];
      const hits = [...doc.querySelectorAll('#conflict-map circle[r="24"]')];
      const markers = doc.querySelectorAll('.conflict-marker');
      const xs = [...markers].map(marker => Number(marker.getAttribute('transform').match(/[-\d.]+/g)[0]));
      assert.ok(Math.abs(xs[1] - xs[0]) < 24, 'the later expanded target covers the earlier dot location');
      assert.equal(dots.length, 2);
      assert.equal(hits.length, 2);
      for (const dot of dots) {
        for (const hit of hits) {
          assert.ok(hit.compareDocumentPosition(dot) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
            'visible dots must paint above every expanded hit target');
        }
      }
      assert.equal(doc.querySelectorAll('#conflict-map [tabindex="0"]').length, 2);
      for (let i = 0; i < 2; i++) {
        for (const target of [dots[i], hits[i]]) {
          target.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
          assert.equal(doc.querySelectorAll('.evt')[i].getAttribute('aria-pressed'), 'true');
          assert.match(doc.getElementById('conflict-selection').textContent, new RegExp('Nearby event ' + i));
        }
      }
    });
  });
  it('reports final root height after chooser, member, row selection and World view reset', async () => {
    const wire = await result();
    wire.structuredContent.data['ucdp-events'].events = [
      { ...events[2], sideA: 'Coincident first' },
      { ...events[2], sideA: 'Coincident second' },
      { ...events[3], sideA: 'Separate location' },
    ];
    await mount(wire, (doc, _send, messages) => {
      const chooser = doc.getElementById('conflict-chooser');
      const selection = doc.getElementById('conflict-selection');
      const height = () => 200.25 + chooser.children.length * 40 + selection.textContent.length;
      doc.getElementById('root').getBoundingClientRect = () => ({ height: height() });
      const expectSize = action => {
        const before = messages.length;
        action();
        const sent = messages.slice(before);
        assert.deepEqual(sent.map(message => message.method), ['ui/notifications/size-changed']);
        assert.equal(sent[0].params.height, Math.ceil(height()) + 8);
      };
      expectSize(() => doc.querySelector('.conflict-marker').dispatchEvent(new doc.defaultView.MouseEvent('click')));
      assert.equal(chooser.children.length, 2);
      expectSize(() => chooser.children[1].click());
      assert.match(selection.textContent, /Coincident second/);
      expectSize(() => doc.querySelectorAll('.evt')[2].click());
      assert.equal(chooser.children.length, 0);
      assert.match(selection.textContent, /Separate location/);
      expectSize(() => doc.getElementById('conflict-world').click());
      assert.equal(selection.textContent, '');
      assert.equal(chooser.children.length, 0);
    });
  });
  it('serves the unchanged resource URI within the existing SSE replay response budget', async () => {
    const { deps } = makeProDeps();
    const response = await handler(proReq('POST', {
      jsonrpc: '2.0', id: 99, method: 'resources/read', params: { uri: 'ui://worldmonitor/conflict-events-v2.html' },
    }), deps);
    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.result.contents[0].text, CONFLICT_EVENTS_APP_HTML);
    assert.ok(Buffer.byteLength(text) < 128 * 1024);
  });
  it('selects the same event from its marker and Enter/Space row or marker activation, then resets', async () => {
    await mount(await result(), doc => {
      const rows = doc.querySelectorAll('.evt');
      const map = doc.getElementById('conflict-map');
      const world = map.getAttribute('viewBox');
      const markers = doc.querySelectorAll('.conflict-marker');
      markers[1].dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter' }));
      assert.equal(rows[3].getAttribute('aria-pressed'), 'true');
      assert.match(doc.getElementById('conflict-selection').textContent, /Controlled side A 4.*30 deaths/);
      rows[2].dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: ' ' }));
      assert.equal(rows[3].getAttribute('aria-pressed'), 'false');
      assert.equal(rows[2].getAttribute('aria-pressed'), 'true');
      assert.equal(markers[0].getAttribute('aria-pressed'), 'true');
      markers[1].dispatchEvent(new doc.defaultView.MouseEvent('click'));
      assert.equal(rows[3].getAttribute('aria-pressed'), 'true');
      doc.getElementById('conflict-world').click();
      assert.equal(map.getAttribute('viewBox'), world);
      assert.equal(doc.querySelectorAll('[aria-pressed="true"]').length, 0);
      assert.equal(doc.getElementById('conflict-selection').textContent, '');
      assert.equal(doc.getElementById('conflict-chooser').children.length, 0);
    });
  });
  it('rejects invalid coordinates without coercion and preserves a supplied zero/zero location', async () => {
    const invalid = [null, {}, { latitude: null, longitude: 0 }, { latitude: '0', longitude: 0 },
      { latitude: true, longitude: 0 }, { latitude: 0, longitude: false }, { latitude: 0, longitude: '0' },
      { latitude: 0, longitude: Infinity }, { latitude: NaN, longitude: 0 },
      { latitude: -91, longitude: 0 }, { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: -181 }, { latitude: 0, longitude: 181 }];
    const wire = await result();
    wire.structuredContent.data['ucdp-events'].events = [...invalid, { latitude: 0, longitude: 0 }]
      .map((location, i) => ({ ...events[2], sideA: 'Coordinate case ' + i, location }));
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 14);
      assert.equal(doc.querySelectorAll('.evt[role="button"]').length, 1);
      assert.equal(doc.querySelectorAll('.conflict-marker').length, 1);
      assert.match(doc.getElementById('list').textContent, /Location unavailable/);
      assert.equal(doc.getElementById('conflict-locations').textContent, '1 of 14 events have map locations.');
      doc.querySelectorAll('.evt')[13].click();
      assert.match(doc.getElementById('conflict-selection').textContent, /Coordinate case 13/);
    });
  });
  it('retains both dateline/polar endpoints inside the world and focused viewport', async () => {
    const wire = await result();
    wire.structuredContent.data['ucdp-events'].events = [
      { ...events[2], location: { latitude: 90, longitude: 180 } },
      { ...events[3], location: { latitude: -90, longitude: -180 } },
    ];
    await mount(wire, doc => {
      const map = doc.getElementById('conflict-map');
      const [, , width, height] = map.getAttribute('viewBox').split(' ').map(Number);
      for (const marker of doc.querySelectorAll('.conflict-marker')) {
        const [x, y] = marker.getAttribute('transform').match(/[-\d.]+/g).map(Number);
        assert.ok(x >= 24 && x <= width - 24 && y >= 24 && y <= height - 24);
        marker.dispatchEvent(new doc.defaultView.MouseEvent('click'));
        const [left, top, w, h] = map.getAttribute('viewBox').split(' ').map(Number);
        assert.ok(left <= x && x <= left + w && top <= y && y <= top + h);
      }
      assert.doesNotMatch(doc.getElementById('conflict-selection').textContent, /Coordinates|-180/);
    });
  });
  it('keeps coincident events independently selectable despite duplicate or absent source IDs', async () => {
    const wire = await result();
    wire.structuredContent.data['ucdp-events'].events = [
      { ...events[2], id: 'duplicate', sideA: 'Coincident first' },
      { ...events[2], id: 'duplicate', sideA: 'Coincident second' },
      { ...events[3], id: undefined, sideA: 'Missing ID' },
    ];
    await mount(wire, doc => {
      const rows = doc.querySelectorAll('.evt');
      const markers = doc.querySelectorAll('.conflict-marker');
      assert.equal(markers.length, 2);
      assert.equal(markers[0].querySelector('text').textContent, '2');
      assert.match(markers[0].getAttribute('aria-label'), /^Choose one of 2 events here, including Coincident first/,
        'a cluster name carries event detail so same-sized clusters differ');
      for (let i = 0; i < 2; i++) {
        markers[0].dispatchEvent(new doc.defaultView.MouseEvent('click'));
        const choices = doc.querySelectorAll('#conflict-chooser button');
        assert.equal(choices.length, 2);
        choices[i].focus();
        choices[i].click();
        assert.equal(doc.activeElement, choices[i]);
        assert.equal(rows[i].getAttribute('aria-pressed'), 'true');
        assert.equal(rows[1 - i].getAttribute('aria-pressed'), 'false');
        assert.match(doc.getElementById('conflict-selection').textContent, new RegExp(i ? 'Coincident second' : 'Coincident first'));
      }
      rows[2].click();
      assert.equal(rows[2].getAttribute('aria-pressed'), 'true');
      assert.equal(markers[1].getAttribute('aria-pressed'), 'true');
    });
  });
  it('maps only the displayed full or summary window and retains the original count scopes', async () => {
    for (const [args, count] of [[{ limit: 0 }, 14], [{ limit: 0, summary: true }, 3]]) {
      await mount(await result(args, 'twenty'), doc => {
        assert.equal(doc.querySelectorAll('.evt').length, count);
        assert.equal(doc.getElementById('conflict-locations').textContent, 'All ' + count + ' events are on the map.');
        assert.equal(doc.querySelector('.conflict-marker text').textContent, String(count));
        assert.match(doc.getElementById('foot').textContent, new RegExp(count + ' of 20'));
      });
    }
  });
  it('clears selection, markers, chooser and obsolete handlers on result replacement', async () => {
    const wire = await result();
    await mount(wire, async (doc, send) => {
      const oldRow = doc.querySelectorAll('.evt')[2];
      const oldMarker = doc.querySelector('.conflict-marker');
      const world = doc.getElementById('conflict-map').getAttribute('viewBox');
      oldRow.click();
      await send(await result({}, 'twenty'));
      doc.querySelector('.conflict-marker').dispatchEvent(new doc.defaultView.MouseEvent('click'));
      assert.equal(doc.querySelectorAll('#conflict-chooser button').length, 14);
      await send(wire);
      assert.equal(doc.querySelectorAll('.conflict-marker').length, 2);
      assert.equal(doc.getElementById('conflict-selection').textContent, '');
      assert.equal(doc.getElementById('conflict-chooser').textContent, '');
      assert.equal(doc.getElementById('conflict-map').getAttribute('viewBox'), world);
      oldRow.click(); oldMarker.dispatchEvent(new doc.defaultView.MouseEvent('click'));
      assert.equal(doc.getElementById('conflict-selection').textContent, '');
      assert.equal(doc.querySelectorAll('[aria-pressed="true"]').length, 0);
    });
  });
  it('distinguishes unavailable geography from empty or missing feeds and removes prior points', async () => {
    await mount(await result(), async (doc, send) => {
      const noLocations = await result();
      noLocations.structuredContent.data['ucdp-events'].events.forEach(event => { delete event.location; });
      await send(noLocations);
      assert.equal(doc.querySelectorAll('.evt').length, 8);
      assert.equal(doc.getElementById('conflict-locations').textContent, 'None of these events has a map location.');
      assert.equal(doc.getElementById('conflict-map').style.display, 'none');
      assert.equal(doc.querySelectorAll('.conflict-marker').length, 0);
      for (const state of ['empty', 'missing']) {
        await send(await result({}, state));
        assert.equal(doc.getElementById('conflict-geography').hidden, true);
        assert.equal(doc.querySelectorAll('.evt').length, 0);
      }
    });
  });
  it('keeps malicious event content inert during marker, chooser and detail actions', async () => {
    const wire = await result();
    wire.structuredContent.data['ucdp-events'].events = [
      { ...events[2], sideA: '<img src=x onerror=alert(1)>', country: '<script>alert(1)</script>' },
      { ...events[2], sideA: '<svg onload=alert(1)>' },
    ];
    await mount(wire, doc => {
      doc.querySelector('.conflict-marker').dispatchEvent(new doc.defaultView.MouseEvent('click'));
      doc.querySelector('#conflict-chooser button').click();
      assert.match(doc.getElementById('conflict-selection').textContent, /<img src=x onerror=alert\(1\)>/);
      assert.equal(doc.querySelector('#conflict-selection img'), null);
      assert.equal(doc.querySelector('#list script'), null);
      assert.equal(doc.querySelector('#conflict-chooser svg'), null);
    });
  });
});


describe('Conflict Events supplied coverage and attribution', () => {
  for (const [name, args, shown, countText] of [
    ['full', { limit: 0 }, 14, 'Showing 14 of 20 returned events.'],
    ['summary', { limit: 0, summary: true }, 3, 'Showing 3 of 20 events.'],
    ['projected', { limit: 0, jmespath: '@' }, 14, 'Showing 14 of 20 returned events.'],
    ['projected summary', { limit: 0, summary: true, jmespath: '@' }, 3, 'Showing 3 of 20 events.'],
  ]) {
    it(name + ' preserves coverage, loaded counts and each original publisher', async () => {
      const wire = await result(args, 'twenty');
      const envelope = wire.structuredContent.projection || wire.structuredContent;
      assert.equal(envelope.conflict_source.ucdp.candidateComplete, false);
      assert.equal(envelope.conflict_source.ucdp.annualFailedPages, 2);
      await mount(wire, doc => {
        assert.equal(doc.querySelectorAll('.evt').length, shown);
        assert.ok(doc.getElementById('foot').textContent.includes(countText));
        assert.equal(doc.getElementById('conflict-note').textContent, 'Recent events may be incomplete: a monthly UCDP release was only partly loaded. '
          + '2 pages of older UCDP events failed to load, so some may be missing.');
        assert.equal(doc.getElementById('conflict-note').hidden, false);
        for (const row of doc.querySelectorAll('.evt')) assert.ok(row.textContent.includes(sourceOriginal));
      });
    });
  }
  it('retains a known payload failed-page count through the real relay when metadata is missing', async () => {
    for (const args of [{}, { summary: true }, { jmespath: '@' }]) {
      const wire = await result(args, 'metadata-missing');
      const envelope = wire.structuredContent.projection || wire.structuredContent;
      assert.equal(envelope.data['ucdp-events'].annualFailedPages, 5);
      assert.notEqual(envelope.conflict_source.ucdp.annualFailedPages, 5);
      await mount(wire, doc => {
        assert.match(doc.getElementById('conflict-note').textContent, /5 pages of older UCDP events failed to load/);
        assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /loaded fully is unknown/);
      });
    }
  });
  it('keeps both valid failure counts visible when metadata and payload disagree', async () => {
    for (const [metadataCount, payloadCount] of [[0, 5], [5, 0], [2, 5]]) {
      const wire = await result();
      wire.structuredContent.conflict_source.ucdp.annualFailedPages = metadataCount;
      wire.structuredContent.data['ucdp-events'].annualFailedPages = payloadCount;
      await mount(wire, doc => {
        const text = doc.getElementById('conflict-note').textContent;
        assert.ok(text.includes('Some older events may be missing; two load reports disagree (' + metadataCount + ' and ' + payloadCount + ' failed pages).'));
      });
    }
  });
  it('uses only valid failure counts and preserves an agreed zero', async () => {
    const wire = await result();
    for (const [metadataCount, payloadCount, expected] of [[null, 5, 5], ['2', 5, 5], [2, -1, 2], [0, 0, 0], [2, 2, 2]]) {
      wire.structuredContent.conflict_source.ucdp.annualFailedPages = metadataCount;
      wire.structuredContent.data['ucdp-events'].annualFailedPages = payloadCount;
      await mount(wire, doc => {
        if (expected) assert.ok(doc.getElementById('conflict-note').textContent.includes(expected + ' pages of older UCDP events failed to load'));
        else assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /older UCDP events/, 'an agreed zero is not a problem to report');
        assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /disagree|loaded fully is unknown/);
      });
    }
  });
  it('allows literal long publisher tokens to wrap within the attribution row', async () => {
    const wire = await result();
    const publisher = 'publisher'.repeat(60);
    wire.structuredContent.data['ucdp-events'].events[0].sourceOriginal = publisher;
    await mount(wire, doc => {
      const attribution = [...doc.querySelectorAll('.evt-meta')].find(node => node.textContent === 'Source: ' + publisher);
      assert.ok(attribution);
      assert.equal(doc.defaultView.getComputedStyle(attribution).overflowWrap, 'anywhere');
    });
  });
  it('does not call an unfetched candidate partial and does not claim unknown metadata complete', async () => {
    const wire = await result();
    const envelope = wire.structuredContent;
    envelope.conflict_source = { ucdp: { candidateComplete: false, candidateVersion: null, annualFailedPages: 0 } };
    envelope.data['ucdp-events'].candidateVersion = null;
    await mount(wire, async (doc, send) => {
      assert.match(doc.getElementById('conflict-note').textContent, /not confirmed complete/);
      assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /partly loaded/);
      delete envelope.conflict_source;
      delete envelope.data['ucdp-events'].candidateComplete;
      await send(wire);
      assert.match(doc.getElementById('conflict-note').textContent, /Whether recent events are complete is unknown/);
      assert.match(doc.getElementById('conflict-note').textContent, /Whether older events loaded fully is unknown/);
      assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /not confirmed complete|partly loaded/);
    });
  });
  it('keeps an explicit incomplete flag when supplied metadata conflicts', async () => {
    const wire = await result();
    const envelope = wire.structuredContent;
    for (const [source, payload] of [[true, false], [false, true]]) {
      envelope.conflict_source = { ucdp: { candidateComplete: source, candidateVersion: 'controlled', annualFailedPages: 0 } };
      envelope.data['ucdp-events'].candidateComplete = payload;
      envelope.data['ucdp-events'].candidateVersion = 'controlled';
      await mount(wire, doc => {
        assert.match(doc.getElementById('conflict-note').textContent, /not confirmed complete/);
        assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /partly loaded/);
      });
    }
    envelope.conflict_source.ucdp.candidateComplete = true;
    envelope.data['ucdp-events'].candidateComplete = true;
    await mount(wire, doc => {
      assert.equal(doc.getElementById('conflict-note').textContent, '', 'a confirmed, fully loaded source needs no note');
      assert.equal(doc.getElementById('conflict-note').hidden, true);
    });
  });
  it('does not confirm completeness when a supplied version explicitly says partial', async () => {
    const wire = await result();
    wire.structuredContent.conflict_source = { ucdp: { candidateComplete: true, candidateVersion: 'controlled+partial', annualFailedPages: 0 } };
    wire.structuredContent.data['ucdp-events'].candidateComplete = true;
    await mount(wire, doc => {
      assert.match(doc.getElementById('conflict-note').textContent, /only partly loaded/);
    });
  });
  it('shows authoritative zero counts for empty full and summary lists', async () => {
    for (const args of [{}, { summary: true }]) {
      const wire = await result(args, 'empty');
      await mount(wire, doc => {
        assert.equal(doc.getElementById('list').textContent, 'No conflict events available.');
        assert.doesNotMatch(doc.getElementById('foot').textContent, /Showing/, 'an empty list needs no count');
      });
    }
  });
  it('renders publisher markup as literal text and omits absent publishers', async () => {
    const wire = await result();
    const rows = wire.structuredContent.data['ucdp-events'].events;
    const hostile = '<img src=x onerror="alert(1)"> original publisher';
    rows[0].sourceOriginal = hostile;
    delete rows[1].sourceOriginal;
    await mount(wire, doc => {
      assert.ok(doc.querySelectorAll('.evt')[0].textContent.includes(hostile));
      assert.equal(doc.querySelectorAll('.evt img').length, 0);
      assert.doesNotMatch(doc.querySelectorAll('.evt')[1].textContent, /Source:/);
    });
  });
  it('treats malformed summary totals and source metadata as unknown', async () => {
    const wire = await result({ summary: true }, 'twenty');
    const envelope = wire.structuredContent.projection;
    envelope.conflict_source = { ucdp: { candidateComplete: 'true', annualFailedPages: '2' } };
    delete envelope.data['ucdp-events'].candidateComplete;
    delete envelope.data['ucdp-events'].candidateVersion;
    for (const [count, failedPages] of [[undefined, undefined], [null, null], ['20', '2'], [-1, -1], [1, 1.5], [1.5, NaN]]) {
      envelope.data['ucdp-events'].events.count = count;
      envelope.conflict_source.ucdp.annualFailedPages = failedPages;
      await mount(wire, doc => {
        assert.match(doc.getElementById('foot').textContent, /Showing 3 events; total unknown\./);
        assert.match(doc.getElementById('conflict-note').textContent, /Whether recent events are complete is unknown/);
        assert.match(doc.getElementById('conflict-note').textContent, /Whether older events loaded fully is unknown/);
        assert.doesNotMatch(doc.getElementById('conflict-note').textContent, /2 pages/);
      });
    }
  });
  it('does not turn an empty summary sample into authoritative no-events', async () => {
    const wire = await result({ summary: true }, 'twenty');
    const envelope = wire.structuredContent.projection;
    envelope.data['ucdp-events'].events.sample = [];
    await mount(wire, doc => {
      assert.match(doc.getElementById('list').textContent, /This response left out the event list/);
      assert.match(doc.getElementById('foot').textContent, /Showing 0 of 20 events\./);
      assert.doesNotMatch(doc.getElementById('list').textContent, /No conflict events available/);
    });
  });
  it('omits a zero or unreadable event date instead of showing 1970', async () => {
    const wire = await result();
    const rows = wire.structuredContent.data['ucdp-events'].events;
    rows[1].dateStart = 0;
    rows[2].dateStart = 'not a date';
    rows[3].dateStart = Date.UTC(2026, 8, 30);
    await mount(wire, doc => {
      const shown = doc.querySelectorAll('.evt');
      assert.doesNotMatch(shown[1].textContent, /1970|Invalid/);
      assert.doesNotMatch(shown[2].textContent, /Invalid|not a date/);
      assert.match(shown[3].textContent, /30 Sep 2026/);
    });
  });
  it('keeps byte-budget truncation separate from the local display cap', async () => {
    const wire = await result({ limit: 0 }, 'large');
    const loaded = wire.structuredContent.data['ucdp-events'].events.length;
    await mount(wire, doc => {
      assert.ok(doc.getElementById('foot').textContent.includes('Showing 14 of ' + loaded + ' returned events.'));
      assert.ok(doc.getElementById('conflict-note').textContent.includes('This response includes ' + loaded + ' of 160 events because of its size limit.'));
    });
  });
  it('counts appended rows and clears coverage and attribution after missing data', async () => {
    const full = await result({}, 'twenty');
    full.structuredContent.data['ucdp-events'].events[0] = null;
    const missing = await result({}, 'missing');
    await mount(full, async (doc, send) => {
      assert.match(doc.getElementById('foot').textContent, /Showing 13 of 20 returned events/);
      await send(missing);
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.doesNotMatch(doc.getElementById('foot').textContent, /Showing/);
      assert.equal(doc.getElementById('conflict-note').textContent, '');
      assert.equal(doc.getElementById('conflict-note').hidden, true);
      assert.doesNotMatch(doc.getElementById('list').textContent, /Controlled UCDP cited publisher|No conflict events/);
    });
  });
});
