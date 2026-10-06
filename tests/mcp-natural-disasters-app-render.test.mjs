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
  for (const [dataset, selected, excluded] of [
    ['wildfires', 'Active Wildfires', 'Earthquakes'],
    ['earthquakes', 'Earthquakes', 'Active Wildfires'],
  ]) {
    it('does not mark an excluded family unavailable for ' + dataset + ' selection', async () => {
      const wire = await result({ dataset: [dataset] });
      assert.deepEqual(Object.keys(wire.structuredContent.data), [dataset === 'wildfires' ? 'fires' : 'earthquakes']);
      await mount(wire, document => {
        assert.match(groups(document), new RegExp(selected));
        assert.doesNotMatch(groups(document), new RegExp(excluded + '|temporarily unavailable'));
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
  it('keeps the Canadian fire zero-date sentinel unavailable', async () => {
    const wire = await result({ dataset: ['wildfires'] }, 'populated', sources => {
      sources.set('wildfire:fires:v1', seeded({ fireDetections: [{ region: 'Undated Canadian fire', detectedAt: 0, brightness: 0 }] }));
    });
    assert.equal(wire.structuredContent.data.fires.fireDetections[0].detectedAt, 0);
    await mount(wire, document => {
      assert.match(groups(document), /Undated Canadian fire.*Detection time unavailable/);
      assert.doesNotMatch(groups(document), /1970|Detected /);
      assert.match(groups(document), /brightness 0/);
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
  it('preserves supplied earthquake epoch zero while fire zero remains unknown', async () => {
    const wire = await result({ dataset: ['earthquakes'] }, 'populated', sources => {
      sources.set('seismology:earthquakes:v1', seeded({ earthquakes: [{ place: 'Epoch quake', occurredAt: 0, magnitude: 0 }] }));
    });
    await mount(wire, document => {
      assert.match(groups(document), /Epoch quake.*1970-01-01T00:00:00.000Z/);
      assert.doesNotMatch(groups(document), /Event time unavailable|Wildfire/);
    });
  });
  it('distinguishes selected missing families and no selected data from authoritative empty', async () => {
    for (const [key, label, excluded] of [['fires', 'Wildfire', 'Earthquakes'], ['earthquakes', 'Earthquake', 'Active Wildfires']]) {
      await mount({ structuredContent: { data: { [key]: null } } }, document => {
        assert.match(groups(document), new RegExp(label + ' data is temporarily unavailable'));
        assert.doesNotMatch(groups(document), new RegExp(excluded + '|No natural-hazard events available'));
      });
    }
    await mount({ structuredContent: { data: {} } }, document => {
      assert.match(groups(document), /Natural-hazard data is temporarily unavailable/);
      assert.doesNotMatch(groups(document), /No natural-hazard events available/);
    });
  });

});

const providerDecisions = [
  { source: 'JMA RSMC Tokyo', status: 'blocked', reason: 'EXPERIMENTAL_CAP_NOT_OPERATIONAL', optional: false, requestCount: 0 },
  { source: 'JTWC', status: 'blocked', reason: 'NOT_ENABLED_PENDING_RAILWAY_PREFLIGHT', optional: true, requestCount: 0 },
  { source: 'HKO warning summary', status: 'accepted', reason: 'OK', optional: false, requestCount: 1 },
];
const providerEvaluation = '2026-10-06T17:01:00.667Z';
const providerLatest = Date.parse('2026-10-06T17:00:00.667Z');
const providerDatasetFetch = Date.parse('2026-10-06T17:02:00.667Z');
function addProviderDetails(sources) {
  Object.assign(sources.get('wildfire:fires:v1').data, {
    _firmsCount: 7246, _firmsPartial: false, _firmsFailedCalls: 0, _firmsErrorCode: null,
    _cwfisCount: 207, _cwfisActiveCount: 183, _cwfisPrescribedCount: 24, _cwfisErrorCode: null,
    _bcVia: 'wfs', _bcCount: 1444, _bcEnrichedCount: 71, _bcAppendedCount: 0, _bcErrorCode: null,
  });
  Object.assign(sources.get('natural:events:v1').data, {
    fetchedAt: providerDatasetFetch,
    westernPacific: { dataAvailable: true, evaluatedAt: providerEvaluation, latestObservationAt: providerLatest, events: [], sourceDecisions: structuredClone(providerDecisions) },
    hkoWarnings: { dataAvailable: true, evaluatedAt: providerEvaluation, latestObservationAt: providerLatest, warnings: [], sourceDecisions: [structuredClone(providerDecisions[2])] },
  });
}
const sectionText = (document, label) => Array.from(document.querySelectorAll('.dgroup'))
  .find(section => section.querySelector('.sec-label')?.textContent === label)?.textContent || '';

for (const summary of [false, true]) {
  it('shows supplied wildfire source details through the handler with summary=' + summary, async () => {
    const wire = await result({ dataset: ['wildfires'], limit: 0, summary }, 'populated', addProviderDetails);
    assert.ok(summary ? wire.structuredContent.projection : wire.structuredContent.data);
    assert.equal(summary ? wire.structuredContent.data : wire.structuredContent.projection, undefined);
    const envelope = summary ? wire.structuredContent.projection : wire.structuredContent;
    assert.equal(envelope.data.fires._firmsCount, 7246);
    assert.equal(envelope.data.fires._bcAppendedCount, 0);
    await mount(wire, document => {
      const text = sectionText(document, 'Active Wildfires');
      assert.match(text, /NASA FIRMS.*State: ok.*Source detections: 7246.*Partial: false.*Failed calls: 0.*Error: None reported/);
      assert.match(text, /CWFIS.*Source detections: 207.*Active: 183.*Prescribed: 24/);
      assert.match(text, /British Columbia.*Source records: 1444.*Transport: wfs.*Enriched: 71.*Appended: 0/);
      assert.doesNotMatch(groups(document), /Earthquakes|Other natural events|Source total|1444 fires|Canada cohort/);
      assert.match(text, summary ? /Showing 3 sampled.*8 reported/ : /Showing 6 of 8 loaded/);
    });
  });
}

it('shows regional decision reasons without equating accepted HKO with complete coverage', async () => {
  for (const summary of [false, true]) {
    const wire = await result({ dataset: ['other'], limit: 0, summary }, 'populated', addProviderDetails);
    assert.ok(summary ? wire.structuredContent.projection : wire.structuredContent.data);
    assert.equal(summary ? wire.structuredContent.data : wire.structuredContent.projection, undefined);
    const envelope = summary ? wire.structuredContent.projection : wire.structuredContent;
    assert.equal(envelope.data.events.westernPacific.dataAvailable, true);
    assert.ok(Array.isArray(envelope.data.events.westernPacific.sourceDecisions));
    assert.ok(Array.isArray(envelope.data.events.hkoWarnings.sourceDecisions));
    assert.equal(envelope.data.events.fetchedAt, providerDatasetFetch);
    assert.equal(envelope.data.events.westernPacific.evaluatedAt, providerEvaluation);
    assert.equal(envelope.data.events.westernPacific.latestObservationAt, providerLatest);
    assert.equal(envelope.cached_at, new Date(snapshot).toISOString());
    await mount(wire, document => {
    const text = sectionText(document, 'Other natural events');
    assert.match(text, /JMA RSMC Tokyo.*blocked.*EXPERIMENTAL_CAP_NOT_OPERATIONAL.*Optional: false.*Requests: 0/);
    assert.match(text, /JTWC.*blocked.*NOT_ENABLED_PENDING_RAILWAY_PREFLIGHT.*Optional: true.*Requests: 0/);
    assert.match(text, /HKO warning summary.*accepted.*OK.*Optional: false.*Requests: 1/);
    assert.match(text, /Decision check time: Unknown/);
    assert.match(text, /Western Pacific source coverage is incomplete/);
    assert.match(text, /Evaluation time: 2026-10-06T17:01:00.667Z/);
    assert.match(text, /Dataset fetch time: 2026-10-06T17:02:00.667Z/);
    assert.match(text, /latestObservationAt \(supplied\): 2026-10-06T17:00:00.667Z/);
    assert.match(text, /latestObservationAt.*publication.*not established/);
    assert.doesNotMatch(text, /JMA activated|JTWC activated|0 events|Provider publication time/);
    assert.equal(document.getElementById('foot').textContent, 'Snapshot: ' + new Date(snapshot).toISOString());
    assert.doesNotMatch(text, new RegExp(new Date(snapshot).toISOString().replaceAll('.', '\\.')));
    });
    const fallback = structuredClone(wire);
    const fallbackEnvelope = summary ? fallback.structuredContent.projection : fallback.structuredContent;
    fallbackEnvelope.data.events.westernPacific.latestObservationAt = Date.parse(providerEvaluation);
    await mount(fallback, document => {
      const text = sectionText(document, 'Other natural events');
      assert.match(text, /May use evaluation time as a fallback/);
      assert.match(text, /latestObservationAt \(supplied\): 2026-10-06T17:01:00.667Z/);
      assert.match(text, /publication.*not established/);
      assert.match(text, /Dataset fetch time: 2026-10-06T17:02:00.667Z/);
      assert.equal(document.getElementById('foot').textContent, 'Snapshot: ' + new Date(snapshot).toISOString());
    });
  }
});

it('labels an explicitly projected decision sample without claiming a complete list', async () => {
  const actual = await result({ dataset: ['other'], limit: 0 }, 'populated', addProviderDetails);
  assert.ok(Array.isArray(actual.structuredContent.data.events.westernPacific.sourceDecisions));
  for (const count of [3, 0, undefined, false, -1, 1.5, NaN]) {
    const data = structuredClone(actual.structuredContent.data);
    data.events.westernPacific.sourceDecisions = { count, sample: [providerDecisions[0]] };
    await mount({ structuredContent: { projection: { data } } }, document => {
    const text = sectionText(document, 'Other natural events');
    assert.match(text, count === 3 ? /Showing 1 sampled source decision.*3 reported.*Full decision list is not loaded/ : /Showing 1 sampled source decision.*total.*Unknown.*Full decision list is not loaded/);
    assert.match(text, /EXPERIMENTAL_CAP_NOT_OPERATIONAL/);
    assert.doesNotMatch(text, /NOT_ENABLED_PENDING_RAILWAY_PREFLIGHT|All 3 decisions loaded|complete provider list|0 reported/);
    });
  }
  const unsupported = await result({ dataset: ['other'], limit: 0, summary: true }, 'populated', sources => {
    addProviderDetails(sources);
    sources.get('natural:events:v1').data.westernPacific.controlledExtra = 'sixth-field-fixture';
  });
  assert.ok(unsupported.structuredContent.projection);
  assert.equal(unsupported.structuredContent.data, undefined);
  const regional = unsupported.structuredContent.projection.data.events.westernPacific;
  assert.equal(regional.count, 6);
  assert.ok(Array.isArray(regional.sample_keys));
  assert.equal(regional.sourceDecisions, undefined);
  await mount(unsupported, document => {
    const text = sectionText(document, 'Other natural events');
    assert.match(text, /Western Pacific.*Provider detail: Unknown/);
    assert.doesNotMatch(text, /JMA RSMC Tokyo|JTWC|complete provider list|6 source decisions/);
  });
});

it('keeps zero counters distinct from malformed counters and missing errors', async () => {
  for (const value of [0, null, '', false, -1, 1.5, '0']) {
    const wire = await result({ dataset: ['wildfires'] }, 'populated', sources => {
      addProviderDetails(sources);
      sources.get('wildfire:fires:v1').data._firmsCount = value;
      delete sources.get('wildfire:fires:v1').data._firmsErrorCode;
    });
    await mount(wire, document => {
      const text = sectionText(document, 'Active Wildfires');
      assert.match(text, value === 0 ? /NASA FIRMS.*Source detections: 0/ : /NASA FIRMS.*Source detections: Unknown/);
      assert.match(text, /NASA FIRMS.*Partial: false.*Failed calls: 0.*Error: Unknown/);
    });
  }
});

it('renders supplied hostile reason text safely while retaining original event and snapshot clocks', async () => {
  const wire = await result({ dataset: ['other'] }, 'populated', sources => {
    addProviderDetails(sources);
    sources.get('natural:events:v1').data.westernPacific.sourceDecisions[0].reason = '<script>provider-reason</script>';
    sources.get('natural:events:v1').data.westernPacific.sourceDecisions[0].checkedAt = 'invalid';
  });
  await mount(wire, document => {
    assert.match(groups(document), /<script>provider-reason<\/script>/);
    assert.equal(document.querySelectorAll('#groups script').length, 0);
    assert.match(groups(document), /Decision check time: Unknown/);
    assert.doesNotMatch(groups(document), /Invalid Date|1970-01-01/);
  });
});

it('renders unknown provider detail without adding excluded families or inventing zero detections', async () => {
  const wire = await result({ dataset: ['wildfires'] }, 'populated', sources => {
    const fire = sources.get('wildfire:fires:v1').data;
    for (const key of Object.keys(fire)) if (key.startsWith('_')) delete fire[key];
  });
  await mount(wire, document => {
    const text = sectionText(document, 'Active Wildfires');
    assert.match(text, /Provider detail: Unknown/);
    assert.doesNotMatch(text, /Source detections: 0|No natural-hazard events available/);
    assert.doesNotMatch(groups(document), /Earthquakes|Other natural events/);
  });
});

it('preserves actual booleans and does not coerce malformed optional or partial flags', async () => {
  for (const value of [false, true, null, '', 0, 'false']) {
    const wire = await result({}, 'populated', sources => {
      addProviderDetails(sources);
      sources.get('wildfire:fires:v1').data._firmsPartial = value;
      sources.get('natural:events:v1').data.westernPacific.sourceDecisions[0].optional = value;
    });
    await mount(wire, document => {
      const label = typeof value === 'boolean' ? String(value) : 'Unknown';
      assert.match(sectionText(document, 'Active Wildfires'), new RegExp('NASA FIRMS.*Partial: ' + label));
      assert.match(sectionText(document, 'Other natural events'), new RegExp('JMA RSMC Tokyo.*Optional: ' + label));
    });
  }
});
