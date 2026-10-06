import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Ratelimit } from '@upstash/ratelimit';
import { NATURAL_DISASTERS_APP_HTML } from '../api/mcp/ui/natural-disasters-app.ts';
import { HMAC_SECRET, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';

const original = { fetch: globalThis.fetch, env: { ...process.env }, limiter: Ratelimit.slidingWindow };
const snapshot = Date.now();
const occurredAt = Date.parse('2026-10-02T12:34:56Z');
const detectedAt = Date.parse('2026-10-01T11:22:33Z');
const sourceUrl = 'https://earthquake.usgs.gov/earthquakes/eventpage/controlled';
const earthquakes = Array.from({ length: 10 }, (_, index) => ({
  id: 'quake-' + index, place: 'Controlled quake ' + index, magnitude: 5.1, occurredAt, sourceUrl,
}));
const fireDetections = Array.from({ length: 8 }, (_, index) => ({
  id: 'fire-' + index, region: 'Controlled fire ' + index, confidence: 'FIRE_CONFIDENCE_HIGH', detectedAt, brightness: 330,
}));
const events = [{ title: 'Controlled active volcano', type: 'volcano', country: 'Canada', closed: false, magnitude: 6 },
  { title: 'Controlled closed flood', type: 'flood', country: 'Canada', closed: true, magnitude: 2 }];
let handler;
let sources;
const seeded = data => ({ _seed: { fetchedAt: snapshot, state: 'OK' }, data });
function fixture(mode = 'populated') {
  return new Map([
    ['seismology:earthquakes:v1', seeded({ earthquakes: mode === 'other' || mode === 'empty' ? [] : earthquakes })],
    ['wildfire:fires:v1', seeded({ fireDetections: mode === 'other' || mode === 'empty' ? [] : fireDetections,
      _firmsState: 'ok', _cwfisState: 'ok', _bcState: 'ok' })],
    ['natural:events:v1', seeded({ events: mode === 'empty' ? [] : events, westernPacific: { dataAvailable: true }, hkoWarnings: { dataAvailable: true } })],
    ['seed-meta:seismology:earthquakes', { fetchedAt: snapshot }],
  ]);
}
before(async () => {
  Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false',
    UPSTASH_REDIS_REST_URL: 'https://disaster-render-fixture.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture-only' });
  for (const key of ['LOCAL_API_MODE', 'VERCEL_ENV', 'AXIOM_TOKEN', 'AXIOM_DATASET']) delete process.env[key];
  Ratelimit.slidingWindow = () => () => ({ limit: async () => ({ success: true, limit: 100, remaining: 99, reset: snapshot + 60000, pending: Promise.resolve() }) });
  globalThis.fetch = async input => {
    const address = new URL(String(input));
    assert.equal(address.origin, 'https://disaster-render-fixture.invalid', 'no external reads');
    assert.ok(address.pathname.startsWith('/get/'));
    const key = decodeURIComponent(address.pathname.slice(5));
    assert.ok(sources.has(key), key);
    const value = sources.get(key);
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  };
  handler = (await import('../api/mcp.ts')).mcpHandler;
});
after(() => {
  globalThis.fetch = original.fetch;
  Ratelimit.slidingWindow = original.limiter;
  for (const key of Object.keys(process.env)) if (!(key in original.env)) delete process.env[key];
  Object.assign(process.env, original.env);
});
async function result(args = {}, mode = 'populated', mutate = () => {}) {
  sources = fixture(mode);
  mutate(sources);
  const { deps } = makeProDeps();
  const response = await handler(proReq('POST', callBody('get_natural_disasters', args)), deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, undefined);
  return body.result;
}
async function mount(wire, check) {
  const window = new Window({ url: 'https://worldmonitor.app/' });
  try {
    const messages = [];
    window.fetch = async () => { throw new Error('No browser reads'); };
    window.document.write(NATURAL_DISASTERS_APP_HTML);
    window.eval('window.parent').postMessage = message => messages.push(message);
    window.eval(window.document.querySelector('script').textContent);
    const send = async value => {
      window.dispatchEvent(new window.MessageEvent('message', { source: window.eval('window.parent'),
        data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: value } } }));
      await window.happyDOM.waitUntilComplete();
    };
    await send(wire);
    await check(window.document, send);
    assert.equal(messages.some(message => ['tools/call', 'ui/call-tool'].includes(message.method)), false);
  } finally { await window.happyDOM.close(); }
}
const groups = document => document.getElementById('groups').textContent;

describe('Natural Disasters actual-handler resource source truth', () => {
  for (const args of [{ dataset: ['other'], active_only: true }, { active_only: true },
    { dataset: ['other'], active_only: true, summary: true, jmespath: '@' }]) {
    it('renders populated other hazards with selected scope ' + JSON.stringify(args), async () => {
      const wire = await result(args, 'other');
      await mount(wire, document => {
        assert.match(groups(document), /Controlled active volcano.*volcano.*Canada/);
        assert.doesNotMatch(groups(document), /Controlled closed flood|No natural-hazard events available|temporarily unavailable/);
        if (args.dataset) assert.doesNotMatch(groups(document), /Earthquakes|Wildfires/);
      });
    });
  }
  it('preserves original earthquake and fire times distinct from the retrieval snapshot and safe source URL', async () => {
    await mount(await result(), document => {
      assert.match(groups(document), /2026-10-02T12:34:56.000Z/);
      assert.match(groups(document), /Detected 2026-10-01T11:22:33.000Z/);
      assert.equal(document.querySelector('a').href, sourceUrl);
      assert.match(document.getElementById('foot').textContent, new RegExp(new Date(snapshot).toISOString().replaceAll('.', '\\.')));
    });
  });
  it('rejects unsafe source URLs and marks missing original dates as unavailable', async () => {
    const wire = await result({}, 'populated', sources => {
      sources.set('seismology:earthquakes:v1', seeded({ earthquakes: [{ place: '<script>controlled</script>', sourceUrl: 'javascript:alert(1)' }] }));
      sources.set('wildfire:fires:v1', seeded({ fireDetections: [{ region: 'Undated fire', detectedAt: 'invalid' }] }));
    });
    await mount(wire, document => {
      assert.equal(document.querySelectorAll('a').length, 0);
      assert.equal(document.querySelectorAll('#groups script').length, 0);
      assert.match(groups(document), /Event time unavailable/);
      assert.match(groups(document), /Detection time unavailable/);
      assert.doesNotMatch(groups(document), /Invalid Date/);
    });
  });
  it('discloses supplied provider partial and unavailable flags alongside populated lists', async () => {
    const wire = await result({}, 'populated', sources => {
      Object.assign(sources.get('wildfire:fires:v1').data, { _firmsPartial: true, _cwfisState: 'unavailable' });
      sources.get('natural:events:v1').data.westernPacific.dataAvailable = false;
    });
    await mount(wire, document => {
      assert.match(groups(document), /FIRMS.*partial/);
      assert.match(groups(document), /Canadian.*unavailable/);
      assert.match(groups(document), /Western Pacific.*unavailable/);
      assert.match(groups(document), /Controlled active volcano/);
      assert.doesNotMatch(groups(document), /No natural-hazard events available/);
    });
  });
  it('preserves authoritative empty, healthy and later missing states without stale rows', async () => {
    const healthy = await result();
    const empty = await result({}, 'empty');
    const missing = await result({ dataset: ['other'] }, 'other', sources => sources.set('natural:events:v1', null));
    await mount(healthy, async (document, send) => {
      assert.doesNotMatch(groups(document), /partial|unavailable/);
      await send(empty);
      assert.match(groups(document), /No natural-hazard events available/);
      await send(missing);
      assert.match(groups(document), /Other natural events.*temporarily unavailable/);
      assert.doesNotMatch(groups(document), /Earthquakes|Wildfires|Controlled|No natural-hazard events available/);
    });
  });
  it('discloses loaded row caps and reported summary counts for each family', async () => {
    await mount(await result({ limit: 0 }), document => {
      assert.match(groups(document), /Showing 8 of 10 loaded/);
      assert.match(groups(document), /Showing 6 of 8 loaded/);
      assert.match(groups(document), /Showing 2 of 2 loaded/);
    });
    await mount(await result({ summary: true, limit: 0 }), document => {
      assert.match(groups(document), /Showing 3 sampled.*10 reported/);
      assert.match(groups(document), /Showing 3 sampled.*8 reported/);
    });
  });
  it('never converts a nonzero or unknown summary total with no sample into authoritative empty', async () => {
    for (const count of [8, undefined]) {
      await mount({ structuredContent: { data: { events: { events: { count, sample: [] } } } } }, document => {
        assert.doesNotMatch(groups(document), /No natural-hazard events available/);
        assert.match(groups(document), /sampled/);
      });
    }
  });
});
