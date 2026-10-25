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
    await check(window.document, send, messages);
    assert.equal(messages.some(message => ['tools/call', 'ui/call-tool'].includes(message.method)), false);
  } finally { await window.happyDOM.close(); }
}
const groups = document => document.getElementById('groups').textContent;

describe('Natural Disasters actual-handler resource source truth', () => {
  it('renders supplied HTTP and HTTPS other-event sources as safe original-title links', async () => {
    const supplied = [
      { title: 'Controlled <img src=x onerror=alert(1)> storm', sourceUrl: 'https://example.invalid/advisory?id=1&source=original' },
      { title: 'Controlled flood', sourceUrl: ' http://example.invalid/flood ' },
    ];
    const wire = await result({ dataset: ['other'] }, 'other', sources => {
      sources.get('natural:events:v1').data.events = supplied;
    });
    await mount(wire, document => {
      const places = [...document.querySelectorAll('.dplace')];
      assert.equal(places.length, supplied.length);
      for (const [index, place] of places.entries()) {
        assert.equal(place.tagName, 'A', 'a supplied valid OTHER source must be actionable');
        assert.equal(place.getAttribute('href'), supplied[index].sourceUrl.trim());
        assert.equal(place.textContent, supplied[index].title);
        assert.equal(place.target, '_blank');
        assert.equal(place.rel, 'noopener noreferrer');
      }
      assert.equal(document.querySelector('#groups img'), null);
      assert.doesNotMatch(groups(document), /Earthquakes|Wildfires/);
    });
  });
  it('keeps missing and invalid other-event sources as honest plain title text', async () => {
    for (const sourceUrl of [undefined, '', 'javascript:alert(1)', 'data:text/html,unsafe', 'ftp://example.invalid/event', '/relative/event', 'not a URL']) {
      const title = 'Controlled <script>event</script>';
      const wire = await result({ dataset: ['other'] }, 'other', sources => {
        sources.get('natural:events:v1').data.events = [{ title, sourceUrl }];
      });
      await mount(wire, document => {
        assert.equal(document.querySelector('.dplace').tagName, 'SPAN');
        assert.equal(document.querySelector('.dplace').textContent, title);
        assert.equal(document.querySelectorAll('#groups a, #groups script').length, 0);
      });
    }
  });
  it('delegates an other-event source to the supported host and discloses unsupported hosts without changing observations', async () => {
    const sourceUrl = 'https://example.invalid/storm/advisory?issue=1&region=west';
    const wire = await result({ dataset: ['other'] }, 'other', sources => {
      sources.get('natural:events:v1').data.events = [{ title: 'Controlled linked storm', sourceUrl,
        magnitude: 75, magnitudeUnit: 'kt', closed: false }];
    });
    await mount(wire, document => {
      const win = document.defaultView;
      const parent = win.eval('window.parent');
      const posted = [];
      const postMessage = parent.postMessage;
      parent.postMessage = message => { posted.push(message); postMessage(message); };
      const reply = data => win.dispatchEvent(new win.MessageEvent('message', {
        source: parent, data: { jsonrpc: '2.0', ...data },
      }));
      const place = document.querySelector('.dplace');
      assert.equal(place.tagName, 'A');
      const before = groups(document);
      const footer = document.getElementById('foot').textContent;
      const usage = document.getElementById('panel-usage').textContent;
      const unsupportedClick = new win.Event('click', { bubbles: true, cancelable: true });
      place.dispatchEvent(unsupportedClick);
      assert.equal(unsupportedClick.defaultPrevented, true);
      assert.equal(posted.filter(message => message.method === 'ui/open-link').length, 0);
      assert.equal(document.getElementById('source-link-status').textContent, 'Opening source links is unavailable in this host.');
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      const supportedClick = new win.Event('click', { bubbles: true, cancelable: true });
      place.dispatchEvent(supportedClick);
      assert.equal(supportedClick.defaultPrevented, true);
      const requests = posted.filter(message => message.method === 'ui/open-link');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].params.url, sourceUrl);
      reply({ id: requests[0].id, result: {} });
      assert.equal(document.getElementById('source-link-status').textContent, '');
      assert.equal(groups(document), before);
      assert.match(before, /Measurement: 75 kt.*Active/);
      assert.equal(document.getElementById('foot').textContent, footer);
      assert.equal(document.getElementById('panel-usage').textContent, usage);
    });
  });
  it('discloses supplied event units and preserves measured zero without typing unitless values', async () => {
    const wire = await result({ dataset: ['other'] }, 'other', sources => {
      sources.get('natural:events:v1').data.events = [
        { title: 'Wind', magnitude: 75, magnitudeUnit: 'kt' },
        { title: 'Calm', magnitude: 0, magnitudeUnit: ' kt ' },
        { title: 'Placeholder or observation', magnitude: 0, magnitudeUnit: '' },
        { title: 'Untyped value', magnitude: 6 },
        { title: 'Literal unit', magnitude: 4, magnitudeUnit: '<img src=x onerror=alert(1)>' },
      ];
    });
    await mount(wire, async (document, send) => {
      assert.match(groups(document), /Wind.*Measurement: 75 kt/);
      assert.match(groups(document), /Calm.*Measurement: 0 kt/);
      assert.match(groups(document), /Placeholder or observation.*Reported value: 0; unit unavailable; measurement status unavailable/);
      assert.match(groups(document), /Untyped value.*Reported value: 6; unit unavailable/);
      assert.match(groups(document), /Literal unit.*Measurement: 4 <img src=x onerror=alert\(1\)>/);
      assert.equal(document.querySelector('img'), null);
      assert.doesNotMatch(groups(document), /Magnitude /);
      await send(await result({ dataset: ['other'] }, 'empty'));
      assert.doesNotMatch(groups(document), /Measurement:|Reported value:|Literal unit/);
    });
  });
  it('keeps absent, nonfinite and nonnumeric event measurements unavailable', async () => {
    for (const magnitude of [undefined, null, NaN, Infinity, -Infinity, '', true, false, '75']) {
      await mount({ structuredContent: { data: { events: { events: [
        { title: 'Unknown measurement', magnitude, magnitudeUnit: 'kt' },
      ] } } } }, document => {
        assert.match(groups(document), /Unknown measurement.*Measurement unavailable/);
        assert.doesNotMatch(groups(document), /Measurement:|Reported value:|Magnitude /);
      });
    }
  });
  it('shows explicit detail limits and counts safely without changing source dates, links or recovery', async () => {
    const wire = await result();
    const coverage = { count_scope: 'post_filter_snapshot', details: [
      { field: 'conePolygon', original_count: 1900, returned_count: 96, omission_reason: 'geometry_simplified' },
      { field: 'forecastTrack', original_count: 400, returned_count: 0, omission_reason: 'output_budget' },
      { field: '<img src=x onerror=alert(1)>', original_count: 9, returned_count: 0, omission_reason: 'output_budget' },
      { field: 'warnings', original_count: null, returned_count: 0, omission_reason: 'output_budget' },
    ] };
    wire.structuredContent.transportCoverage = coverage;
    wire.content[0].text = JSON.stringify(wire.structuredContent);
    await mount(wire, async (document, send) => {
      assert.match(groups(document), /Some detail was simplified or omitted for display/);
      assert.match(groups(document), /Cone points: 96 returned from 1900 original items/);
      assert.match(groups(document), /Forecast track points: 0 returned from 400 original items/);
      assert.doesNotMatch(groups(document), /Regional warnings: 0|img src|No natural-hazard events available/);
      assert.equal(document.querySelector('img'), null);
      assert.match(groups(document), /2026-10-02T12:34:56.000Z/);
      assert.equal(document.querySelector('.dplace').getAttribute('href'), sourceUrl);
      const recovered = await result(); await send(recovered);
      assert.doesNotMatch(groups(document), /Some detail was simplified|original items/);
    });
  });

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
      assert.doesNotMatch(groups(document), /partial|coverage is unavailable|temporarily unavailable/);
      assert.match(groups(document), /Reported value: 6; unit unavailable/);
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


const geoEvent = (extra = {}) => ({ id: 'duplicate', title: 'Synthetic storm', category: 'severeStorms',
  date: occurredAt, lat: 12, lon: 179, magnitude: 75, magnitudeUnit: 'kt', closed: false,
  sourceUrl: 'https://example.invalid/controlled-storm', ...extra });
const localWire = events => ({ structuredContent: { data: { events: { events } } } });
const activate = (document, selector) => {
  const button = document.querySelector(selector);
  assert.ok(button, selector + ' must exist');
  button.focus(); button.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })); return button;
};
const tick = document => document.defaultView.happyDOM.waitUntilComplete();
const rowSelect = '[data-select="events:0"]';

describe('Natural local geography and reported details', () => {
  it('keeps a distant marker visible when keyboard focus reaches it after point zoom', async () => {
    await mount(localWire([geoEvent({ lat: 12, lon: 70 }), geoEvent({ lat: 12, lon: 76 }), geoEvent({ lat: 0, lon: 0 })]), async document => {
      const selected = activate(document, '[data-marker="12,70"]');
      const map = document.getElementById('natural-map');
      const zoom = map.getAttribute('viewBox');
      const details = document.getElementById('natural-selection').textContent;
      assert.notEqual(zoom, '0 0 720 384');
      document.querySelector('[data-marker="12,76"]').focus();
      assert.equal(map.getAttribute('viewBox'), zoom, 'nearby focus retains the point zoom');
      const distant = document.querySelector('[data-marker="0,0"]');
      distant.focus();
      assert.equal(document.activeElement, distant);
      assert.equal(map.getAttribute('viewBox'), '0 0 720 384', 'distant focus restores the visible world map');
      assert.equal(selected.getAttribute('aria-pressed'), 'true');
      assert.equal(document.getElementById('natural-selection').textContent, details);
      distant.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.equal(distant.getAttribute('aria-pressed'), 'true');
      assert.notEqual(map.getAttribute('viewBox'), '0 0 720 384', 'keyboard activation can still select and zoom the distant point');
      await tick(document);
    });
  });
  it('keeps strict OTHER event dates and details readable without coordinates', async () => {
    const dates = [occurredAt, 0, undefined, null, '123', new Date(occurredAt).toISOString(), true, false, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 8640000000000001];
    for (const date of dates) await mount(localWire([geoEvent({ date, lat: undefined, lon: undefined })]), document => {
      const row = document.querySelector('.drow');
      assert.match(row.textContent, /Measurement: 75 kt.*Active/);
      assert.equal(row.querySelector('a').href, 'https://example.invalid/controlled-storm');
      assert.match(row.textContent, /No valid coordinates supplied/);
      assert.equal(row.querySelector('[data-select]'), null);
      if (date === occurredAt || date === 0) assert.ok(row.textContent.includes('Reported event time: ' + new Date(date).toISOString()));
      else assert.match(row.textContent, /Event time unavailable/);
    });
  });
  it('uses displayed rows from the actual handler for three layers, strict locations and local selection', async () => {
    const wire = await result({}, 'populated', sources => {
      sources.get('seismology:earthquakes:v1').data.earthquakes = earthquakes.map((q, i) => ({ ...q, id: 'duplicate', location: { latitude: i, longitude: 40 } }));
      sources.get('wildfire:fires:v1').data.fireDetections = fireDetections.map(f => ({ ...f, id: 'duplicate', location: { latitude: 0, longitude: 0 } }));
      sources.get('natural:events:v1').data.events = [geoEvent(), geoEvent({ lat: '12' }), geoEvent({ lat: 91 })];
    });
    await mount(wire, async (document, send, messages) => {
      assert.equal(document.querySelectorAll('[data-select]').length, 15, '8 quake + 6 fire + 1 OTHER');
      assert.match(document.getElementById('natural-map-status').textContent, /15 valid locations.*17 displayed/);
      const footer = document.getElementById('foot').textContent;
      const usage = document.getElementById('panel-usage').textContent;
      const row = activate(document, rowSelect); await tick(document);
      assert.equal(row.getAttribute('aria-pressed'), 'true');
      assert.equal(document.activeElement, row);
      assert.match(document.getElementById('natural-selection').textContent, /Synthetic storm.*Reported coordinates: 12, 179/);
      assert.notEqual(document.getElementById('natural-map').getAttribute('viewBox'), '0 0 720 384');
      assert.ok(messages.some(m => m.method === 'ui/notifications/size-changed'));
      activate(document, '[data-layer="events"]');
      assert.equal(row.getAttribute('aria-pressed'), 'false');
      assert.equal(document.getElementById('natural-selection').textContent, '');
      activate(document, '[data-layer="fires"]'); activate(document, '[data-layer="earthquakes"]');
      assert.match(document.getElementById('natural-map-status').textContent, /Layers hidden/);
      activate(document, '[data-layer="events"]');
      assert.equal(row.getAttribute('aria-pressed'), 'false');
      assert.equal(document.getElementById('foot').textContent, footer);
      assert.equal(document.getElementById('panel-usage').textContent, usage);
      row.focus();
      await send(localWire([geoEvent({ title: 'Replacement', lat: 0, lon: 0 })]));
      assert.equal(document.activeElement.id, 'natural-heading');
      assert.equal(document.querySelector('[aria-pressed="true"][data-select]'), null);
      assert.doesNotMatch(document.getElementById('natural-selection').textContent, /Synthetic/);
    });
  });
  it('keeps one identity through collocation, chooser dismissal, row selection and reset', async () => {
    await mount(localWire([geoEvent(), geoEvent({ title: 'Second same ID' }), geoEvent({ title: 'Nearby', lon: 179.1 })]), async document => {
      assert.equal(document.querySelectorAll('[data-select]').length, 3);
      const cluster = activate(document, '[data-marker="12,179"]');
      assert.equal(document.activeElement, document.querySelector('[data-choice="events:0"]'));
      activate(document, '[data-choice="events:1"]');
      assert.equal(document.activeElement, cluster);
      assert.equal(document.querySelector('[data-select="events:1"]').getAttribute('aria-pressed'), 'true');
      cluster.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      document.activeElement.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(document.activeElement, cluster);
      assert.equal(document.querySelector('[data-select="events:1"]').getAttribute('aria-pressed'), 'true');
      const nearby = activate(document, '[data-marker="12,179.1"]');
      assert.equal(document.activeElement, nearby);
      assert.equal(document.querySelector('[data-select="events:2"]').getAttribute('aria-pressed'), 'true');
      const reset = activate(document, '#natural-world');
      assert.equal(document.activeElement, reset);
      assert.equal(document.querySelector('[aria-pressed="true"][data-select]'), null);
      assert.equal(document.getElementById('natural-map').getAttribute('viewBox'), '0 0 720 384');
      await tick(document);
    });
  });
  it('preserves selection when unrelated layers toggle and supports Space on SVG controls', async () => {
    const wire = localWire([geoEvent()]);
    wire.structuredContent.data.earthquakes = { earthquakes: [{place:'Synthetic quake', location:{latitude:0,longitude:0}}] };
    await mount(wire, async document => {
      const marker = document.querySelector('[data-marker="12,179"]');
      marker.focus(); marker.dispatchEvent(new document.defaultView.KeyboardEvent('keydown',{key:' ',bubbles:true}));
      assert.equal(document.querySelector(rowSelect).getAttribute('aria-pressed'),'true');
      assert.equal(document.activeElement,marker);
      const viewport=document.getElementById('natural-map').getAttribute('viewBox');
      activate(document,'[data-layer="earthquakes"]');
      assert.equal(document.querySelector(rowSelect).getAttribute('aria-pressed'),'true');
      assert.equal(document.getElementById('natural-map').getAttribute('viewBox'),viewport);
      activate(document,'[data-layer="events"]');
      assert.equal(document.activeElement.getAttribute('data-layer'),'events');
      assert.equal(document.querySelector(rowSelect).getAttribute('aria-pressed'),'false');
      await tick(document);
    });
  });
  it('does not steal outside focus on replacement and reports every layout transition', async () => {
    await mount(localWire([geoEvent(), geoEvent({ title: 'Collocated' })]), async (document, send, messages) => {
      const outside = document.createElement('button'); document.body.appendChild(outside); outside.focus();
      await send(localWire([geoEvent(), geoEvent({ title: 'Collocated' })]));
      assert.equal(document.activeElement, outside);
      for (const selector of ['[data-marker="12,179"]','[data-choice="events:0"]','#natural-world','[data-layer="events"]','[data-layer="events"]']) {
        const n = messages.filter(m => m.method === 'ui/notifications/size-changed').length;
        activate(document, selector); await tick(document);
        assert.ok(messages.filter(m => m.method === 'ui/notifications/size-changed').length > n, selector);
      }
    });
  });
});

const pathSegments = document => [...document.querySelectorAll('[data-geometry] path')];
function assertFinitePaths(document, maxVertices = 8192) {
  let vertices = 0, chars = 0;
  for (const path of pathSegments(document)) {
    const pathData = path.getAttribute('d'); chars += pathData.length;
    assert.doesNotMatch(pathData, /NaN|Infinity|undefined/);
    const pairs = [...pathData.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map(match => [+match[1], +match[2]]);
    vertices += pairs.length;
    for (const [projectedX,projectedY] of pairs) { assert.ok(projectedX >= 31 && projectedX <= 689); assert.ok(projectedY >= 27 && projectedY <= 357); }
    for (let pointIndex=1;pointIndex<pairs.length;pointIndex++) assert.ok(Math.abs(pairs[pointIndex][0]-pairs[pointIndex-1][0]) <= 329, 'no false world chord');
  }
  assert.ok(vertices <= maxVertices); assert.ok(chars <= 400000);
}
describe('Natural bounded returned geometry', () => {
  for (const direction of [1,-1]) it('clips both exact cone forms and tracks across the dateline ' + direction, async () => {
    const startLongitude=179*direction, endLongitude=-179*direction;
    for (const conePolygon of [[{points:[{lon:startLongitude,lat:10},{lon:endLongitude,lat:10},{lon:endLongitude,lat:15},{lon:startLongitude,lat:15}]}],
      [[[startLongitude,10],[endLongitude,10],[endLongitude,15],[startLongitude,15],[startLongitude,10]]]]) {
      await mount(localWire([geoEvent({forecastTrack:[{lat:11,lon:startLongitude},{lat:12,lon:endLongitude}],pastTrack:[{lat:9,lon:startLongitude},{lat:10,lon:endLongitude}],conePolygon})]), async document => {
        activate(document,rowSelect);
        assert.equal(document.getElementById('natural-map').getAttribute('viewBox'),'0 0 720 384');
        assert.ok(pathSegments(document).length >= 6);
        assertFinitePaths(document);
        for(const group of document.querySelectorAll('[data-geometry]')) {
          assert.equal(group.getAttribute('aria-hidden'),'true');
          assert.equal(group.getAttribute('pointer-events'),'none');
          assert.equal(group.hasAttribute('tabindex'),false);
        }
        const selected=document.querySelector(rowSelect);
        const toggle=activate(document,'[data-overlay="conePolygon"]'); await tick(document);
        assert.equal(document.activeElement,toggle);
        assert.equal(selected.getAttribute('aria-pressed'),'true');
        assert.equal(document.getElementById('natural-map').getAttribute('viewBox'),'0 0 720 384');
      });
    }
  });
  it('splits invalid track points without closing/joining and rejects malformed cone vertices', async () => {
    await mount(localWire([geoEvent({forecastTrack:[{lat:0,lon:0},{lat:1,lon:1}, {lat:'2',lon:2},{lat:3,lon:3},{lat:4,lon:4}],
      conePolygon:[[[0,0],['1',1],[2,2]],[[10,10],[12,10],[12,12],[10,10]]]})]), document => {
      activate(document,rowSelect);
      assert.equal(document.querySelectorAll('[data-geometry="forecastTrack"] path').length,2);
      for(const geometryPath of document.querySelectorAll('[data-geometry="forecastTrack"] path')) assert.doesNotMatch(geometryPath.getAttribute('d'),/Z/);
      assert.match(document.getElementById('natural-selection').textContent,/partial|invalid/i);
      assertFinitePaths(document);
    });
  });
  const rejected = [
    {forecastTrack:Array.from({length:513},(_,pointIndex)=>({lat:0,lon:pointIndex%10}))},
    {forecastTrack:[{lat:0,lon:0},{lat:0,lon:120},{lat:0,lon:-120},{lat:0,lon:0}]},
    {forecastTrack:[{lat:0,lon:0},{lat:0,lon:180}]},
    {conePolygon:Array.from({length:17},()=>[[0,0],[1,0],[1,1]])},
    {conePolygon:[Array.from({length:513},(_,pointIndex)=>[pointIndex%10,pointIndex%5])]},
    {conePolygon:[[[0,0],[120,0],[-120,10]]]},
  ];
  for (const [pointIndex,geometry] of rejected.entries()) it('qualifies rejected whole fields without a partial prefix '+pointIndex,async()=>{
    await mount(localWire([geoEvent(geometry)]),document=>{
      activate(document,rowSelect);
      assert.equal(pathSegments(document).length,0);
      assert.match(document.getElementById('natural-selection').textContent,/local display limit|ambiguous geometry/i);
    });
  });
  it('distinguishes missing, empty, malformed, local rejection and unchanged transport omissions',async()=>{
    for(const [geometry,label] of [[{},/Geometry not supplied/],[{forecastTrack:[]},/No geometry points supplied/],
      [{forecastTrack:[{lat:null,lon:2}]},/invalid/i]]) await mount(localWire([geoEvent(geometry)]),document=>{
        activate(document,rowSelect);assert.match(document.getElementById('natural-selection').textContent,label);
      });
    const wire=localWire([geoEvent({forecastTrack:[]})]);
    wire.structuredContent.transportCoverage={count_scope:'post_filter_snapshot',details:[
      {dataset:'events',collection:'events.events',event_index:0,field:'forecastTrack',state:'available',original_count:400,returned_count:0,omitted_count:400,omission_reason:'output_budget',geometry_simplified:false}]};
    await mount(wire,document=>{
      activate(document,rowSelect);
      assert.match(document.getElementById('natural-selection').textContent,/omitted by transport/);
      assert.match(groups(document),/0 returned from 400 original items/);
      assert.match(groups(document),/Full original detail is not loaded/);
    });
  });
  it('keeps maximum allowed input/output bounded, respects tuple longitude order and rejects invalid rings',async()=>{
    await mount(localWire([geoEvent({forecastTrack:Array.from({length:512},(_,pointIndex)=>({lat:10+pointIndex/1000,lon:30+pointIndex/1000})),
      conePolygon:[[[30,10],[31,10],[31,11],[30,10]]]} )]),document=>{
      activate(document,rowSelect);assertFinitePaths(document,8192+2048);
      const pathData=document.querySelector('[data-geometry="conePolygon"] path').getAttribute('d');
      assert.match(pathData,/M414\.667,173\.778/,'longitude 30, latitude 10 uses the shared projection');
    });
    for(const point of [[null,2],['1',2],[true,2],[Infinity,2],[181,2],[2,91]]) await mount(localWire([geoEvent({conePolygon:[[[0,0],point,[1,1]] ]})]),document=>{
      activate(document,rowSelect);assert.equal(pathSegments(document).length,0);assert.match(document.getElementById('natural-selection').textContent,/invalid/i);
    });
  });
});

it('bounds cone maximum input, rejects repeated ring vertices, and never coerces track coordinates', async () => {
  const ring=Array.from({length:512},(_,pointIndex)=>[30+Math.cos(pointIndex*Math.PI/256),10+Math.sin(pointIndex*Math.PI/256)]);
  await mount(localWire([geoEvent({conePolygon:[ring]})]),document=>{
    activate(document,rowSelect);assert.ok(pathSegments(document).length);assertFinitePaths(document);
  });
  for(const conePolygon of [[[[0,0],[1,0],[0,0],[1,1]]],[[[0,0],[0,0],[1,0],[1,1],[0,0],[0,0]]]]) {
    await mount(localWire([geoEvent({conePolygon})]),document=>{
      activate(document,rowSelect);
      if(conePolygon[0][2][0]===0) { assert.equal(pathSegments(document).length,0);assert.match(document.getElementById('natural-selection').textContent,/invalid/); }
      else assert.ok(pathSegments(document).length);
    });
  }
  for(const invalid of [null,true,'0',NaN,Infinity,181]) await mount(localWire([geoEvent({forecastTrack:[{lon:0,lat:0},{lon:invalid,lat:1},{lon:2,lat:2}]})]),document=>{
    activate(document,rowSelect);assert.equal(pathSegments(document).length,0);assert.match(document.getElementById('natural-selection').textContent,/invalid/);
  });
});

describe('Natural independent review regressions', () => {
  const omission = { dataset: 'events', collection: 'events.events', event_index: 0, event_id: 'duplicate',
    field: 'forecastTrack', state: 'available', original_count: 400, returned_count: 0, omitted_count: 400,
    omission_reason: 'output_budget', geometry_simplified: false };
  it('attributes transport omissions only to valid metadata for the selected main source index', async () => {
    const variations = [{}, { event_index: 1 }, { collection: 'events.westernPacific.events' }, { dataset: 'fires' },
      { event_index: '0' }, { event_index: -1 }, { state: 'unknown' }, { original_count: null },
      { original_count: 0, omitted_count: 0 }, { original_count: 1.5 }, { returned_count: '0' },
      { omitted_count: 399 }, { geometry_simplified: true }];
    for (const changes of variations) {
      const wire = localWire([geoEvent({title:'First duplicate'}), geoEvent({title:'Second duplicate'})]);
      const detail = { ...omission, ...changes };
      wire.structuredContent.transportCoverage = { count_scope:'post_filter_snapshot', details:[detail] };
      await mount(wire, document => {
        for (const index of [0,1]) {
          activate(document, '[data-select="events:' + index + '"]');
          const expected = Object.keys(changes).length === 0 && index === 0 || changes.event_index === 1 && index === 1;
          assert.equal(document.getElementById('natural-selection').textContent.includes('Forecast track: Geometry not loaded: omitted by transport.'), expected, JSON.stringify({changes,index}));
        }
      });
    }
  });
  it('restores removed layer-button focus on replacement but retains outside focus', async () => {
    await mount(localWire([geoEvent()]), async (document, send) => {
      const oldLayer = document.querySelector('[data-layer="events"]'); oldLayer.focus();
      await send(localWire([geoEvent({title:'New result'})]));
      assert.equal(oldLayer.isConnected,false);
      assert.equal(document.activeElement.id,'natural-heading');
      const outside=document.createElement('button');document.body.appendChild(outside);outside.focus();
      await send(localWire([geoEvent()]));assert.equal(document.activeElement,outside);
    });
  });
  it('reserves known-empty layer copy for real emptiness, not unreturned samples', async () => {
    for (const [supplied,knownEmpty] of [[{count:12,sample:[]},false],[{sample:[]},false],[{count:0,sample:[]},true],[[],true]]) {
      await mount({structuredContent:{data:{events:{events:supplied}}}},document=>{
        const label=document.querySelector('[data-layer="events"]').textContent;
        assert.equal(label.includes('No events in this supplied snapshot'),knownEmpty,JSON.stringify(supplied));
        if(!knownEmpty) assert.match(label,/No sample rows loaded/);
      });
    }
  });
  it('retains formatted earthquake magnitude and fire confidence in selected details', async () => {
    for (const magnitude of [5.1,undefined]) {
      await mount({structuredContent:{data:{earthquakes:{earthquakes:[{place:'Same label',magnitude,occurredAt,location:{latitude:12,longitude:179}}]},
        fires:{fireDetections:[{region:'Same label',confidence:'FIRE_CONFIDENCE_HIGH',brightness:330,detectedAt,location:{latitude:12,longitude:179}}]}}}},document=>{
        activate(document,'[data-select="earthquakes:0"]');
        assert.ok(document.getElementById('natural-selection').textContent.includes(magnitude === undefined ? '—' : 'M5.1'));
        assert.equal(document.querySelector('#natural-selection [data-select]'),null);
        activate(document,'[data-select="fires:0"]');
        assert.match(document.getElementById('natural-selection').textContent,/High.*brightness 330/);
      });
    }
  });
  it('identifies same-title collocated choices and selected marker members by dataset', async () => {
    await mount({structuredContent:{data:{earthquakes:{earthquakes:[{place:'Same label',magnitude:5.1,location:{latitude:12,longitude:179}}]},
      fires:{fireDetections:[{region:'Same label',confidence:'FIRE_CONFIDENCE_HIGH',location:{latitude:12,longitude:179}}]}}}},document=>{
      activate(document,'[data-marker="12,179"]');
      assert.deepEqual([...document.querySelectorAll('[data-choice]')].map(button=>button.textContent),['Earthquakes · Same label','Wildfires · Same label']);
      const marker=document.querySelector('[data-marker="12,179"]');
      assert.match(marker.getAttribute('aria-label'),/Earthquakes.*Wildfires/);
      activate(document,'[data-choice="fires:0"]');
      assert.match(marker.getAttribute('aria-label'),/selected Wildfires · Same label/);
      assert.equal(document.querySelector('[data-select="fires:0"]').getAttribute('aria-pressed'),'true');
    });
  });
});
