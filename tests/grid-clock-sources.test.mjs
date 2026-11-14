import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGridClockSources } from '../scripts/lib/grid-clock-sources.mjs';

const now = Date.parse('2026-11-14T03:30:00Z');
const iso = minutes => new Date(now + minutes * 60_000).toISOString();
const ca = { abbr: 'CA', state_fips: '06', customers_out: 451 };
const tn = { abbr: 'TN', state_fips: '47', customers_out: 0 };
const summary = () => ({
  data: {
    national: { updated_at: iso(-5), as_of: iso(-10), stale: false, stale_out: 0 },
    states: [ca, tn],
    coverage: { tracked_customers: 90_000_000, sources_ok: 792, sources: 803 },
  },
  meta: { live: { status: 'ok', last_poll_ts: iso(-5) } },
});
const emptyCaiso = () => ({ CurrentEvents: [], UpcomingEvents: [], CurrentEventsCount: 0, UpcommingEventsCount: 0 });
const weather = () => ({ type: 'FeatureCollection', updated: iso(-2), features: [] });
const nwsFeature = extra => ({
  id: 'https://api.weather.gov/alerts/urn:oid:fixture',
  properties: {
    event: 'Ice Storm Warning', status: 'Actual', messageType: 'Alert', severity: 'Severe',
    sent: iso(-20), expires: iso(90), ends: iso(45), areaDesc: 'Affected forecast zone', ...extra,
  },
});

async function read({ mass = summary(), caiso = emptyCaiso(), caWeather = weather(), tnWeather = weather(), stateWeather = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.hostname);
    assert.ok(options.headers['User-Agent'].includes('worldmonitor.app'));
    assert.equal(options.redirect, 'error');
    let payload;
    if (parsed.hostname === 'massoutage.com') payload = mass;
    else if (parsed.hostname === 'wwwmobile.caiso.com') payload = caiso;
    else if (parsed.hostname === 'api.weather.gov') {
      const code = parsed.searchParams.get('area');
      payload = code === 'CA' ? caWeather : code === 'TN' ? tnWeather : stateWeather[code] ?? weather();
    }
    else throw new Error('Unexpected test URL');
    return payload instanceof Response ? payload : Response.json(payload);
  };
  const regions = await fetchGridClockSources({ fetchImpl, nowMs: now });
  assert.equal(calls.filter(h => h === 'massoutage.com').length, 1);
  assert.equal(calls.filter(h => h === 'api.weather.gov').length, 6);
  return regions;
}

test('CA and TN get their reported counts, preserve an explicit zero, and never borrow a national denominator', async () => {
  const [california, tennessee] = await read();
  assert.equal(california.code, 'CA');
  assert.equal(california.current.customersOut, 451);
  assert.equal(california.current.customersTracked, null);
  assert.equal(california.current.observedAt, now - 5 * 60_000);
  assert.equal(tennessee.current.customersOut, 0);
  assert.equal(tennessee.warningSources.find(s => s.kind === 'grid').status, 'not_monitored');
  assert.ok(california.warningSources.every(s => s.checkedAt === now && s.status === 'available'));
});

test('new states have independent counts and warnings without borrowing TVA operator coverage', async () => {
  const mass = summary();
  mass.data.states.push(
    { abbr: 'TX', state_fips: '48', customers_out: 123 },
    { abbr: 'FL', state_fips: '12', customers_out: 0 },
    { abbr: 'NY', state_fips: '36', customers_out: 45 },
    { abbr: 'WA', state_fips: '53', customers_out: 67 },
  );
  const stateWeather = { TX: { ...weather(), features: [nwsFeature({ event: 'Tornado Warning' })] },
    WA: new Response('unavailable', { status: 503 }) };
  const regions = await read({ mass, stateWeather });
  assert.deepEqual(regions.map(r => r.code), ['CA', 'TN', 'TX', 'FL', 'NY', 'WA']);
  assert.deepEqual(regions.slice(2).map(r => r.current.customersOut), [123, 0, 45, 67]);
  for (const region of regions.slice(2)) {
    assert.equal(region.warningSources.length, 1);
    assert.equal(region.warningSources[0].kind, 'weather');
    assert.match(region.warningSources[0].sourceUrl, new RegExp('area=' + region.code + '&'));
  }
  assert.equal(regions[2].warnings[0].title, 'Tornado Warning · Affected forecast zone');
  assert.deepEqual(regions[3].warnings, []);
  assert.equal(regions[4].current.sourceUrl, 'https://massoutage.com/new-york');
  assert.equal(regions[5].warningsCheckedAt, null);
  assert.equal(regions[4].warningsCheckedAt, now);
  mass.data.states = mass.data.states.filter(row => row.abbr !== 'TX');
  const missing = await read({ mass });
  assert.equal(missing[2].current, null);
  assert.equal(missing[3].current.customersOut, 0);
});

test('a missing, duplicate or malformed region cannot fabricate zero, or suppress the other state', async () => {
  for (const states of [[tn], [tn, ca, ca], [tn, { ...ca, customers_out: null }], [tn, { ...ca, state_fips: '47' }]]) {
    const mass = summary();
    mass.data.states = states;
    const [california, tennessee] = await read({ mass });
    assert.equal(california.current, null);
    assert.equal(tennessee.current.customersOut, 0);
  }
});

test('source poll outages and stale timestamps do not overwrite independent warnings', async () => {
  const delayed = summary();
  delayed.meta.live.status = 'delayed';
  const old = summary();
  old.data.national.updated_at = iso(-120);
  const future = summary();
  future.meta.live.last_poll_ts = iso(3);
  for (const mass of [delayed, old, future, new Response('denied', { status: 429 })]) {
    const [california, tennessee] = await read({ mass });
    assert.equal(california.current, null);
    assert.equal(tennessee.current, null);
    assert.equal(california.warningsCheckedAt, now);
  }
});

test('mixed-age national reports preserve state counts without claiming state-specific reporting freshness', async () => {
  const mass = summary();
  mass.data.national.stale = true;
  mass.data.national.stale_out = 2;
  mass.data.national.as_of = iso(-95);
  const [california, tennessee] = await read({ mass });
  assert.ok(california.current.partial);
  assert.equal(california.current.customersOut, 451);
  assert.ok(tennessee.current.partial);
  assert.match(tennessee.current.detail, /does not identify which states/);
});

test('NWS distinguishes issued regional weather warnings from tests, advisories, cancellations and expiries', async () => {
  const data = weather();
  data.features = [
    nwsFeature({}), nwsFeature({ status: 'Test' }), nwsFeature({ messageType: 'Cancel' }),
    nwsFeature({ severity: 'Minor' }), nwsFeature({ expires: iso(-5) }), nwsFeature({ ends: iso(-5) }),
    nwsFeature({ event: 'Small Craft Advisory' }), nwsFeature({ sent: iso(10) }),
  ];
  const [california, tennessee] = await read({ tnWeather: data });
  assert.deepEqual(california.warnings, []);
  assert.equal(tennessee.warnings.length, 1);
  assert.equal(tennessee.warnings[0].kind, 'weather');
  assert.equal(tennessee.warnings[0].issuedAt, now - 20 * 60_000);
  assert.equal(tennessee.warnings[0].expiresAt, now + 45 * 60_000);
  assert.match(tennessee.warnings[0].title, /Affected forecast zone/);
});

test('partial NWS collections or failed CAISO reads are unavailable, and a healthy sister provider still publishes', async () => {
  const data = weather();
  data.features = [nwsFeature({})];
  const [california, tennessee] = await read({
    caiso: { ...emptyCaiso(), CurrentEventsCount: 2 }, caWeather: data,
    tnWeather: { ...weather(), pagination: { next: 'https://example.invalid' } },
  });
  assert.equal(california.warnings.length, 1);
  assert.equal(california.warningsCheckedAt, null);
  assert.equal(california.warningSources[0].status, 'unavailable');
  assert.equal(tennessee.warningsCheckedAt, null);
  assert.equal(tennessee.current.customersOut, 0);
});

test('CAISO uses explicit Pacific publication and expiry, omits cancelled or test notices, and identifies upcoming notices', async () => {
  const event = {
    EventType: 'EEA Watch', StartDateTime_PT: '2026-11-13T20:00:00', EndDateTime_PT: '2026-11-13T23:00:00',
    EventMessages: [{ MessageType: 'Initiation', PostDate_PT: '2026-11-13T18:05:00' }],
  };
  const caiso = { ...emptyCaiso(), UpcommingEventsCount: 3, UpcomingEvents: [event, { ...event, EventType: 'Test' },
    { ...event, EventMessages: [...event.EventMessages, { MessageType: 'End', PostDate_PT: '2026-11-13T19:15:00' }] }] };
  const [region] = await read({ caiso });
  assert.equal(region.warnings.length, 1);
  assert.equal(region.warnings[0].issuedAt, Date.parse('2026-11-14T02:05:00Z'));
  assert.equal(region.warnings[0].expiresAt, Date.parse('2026-11-14T07:00:00Z'));
  assert.match(region.warnings[0].title, /upcoming/);
});

test('CAISO revisions are dated when published; unknown message types cannot create a watch', async () => {
  const event = {
    EventType: 'EEA 1', StartDateTime_PT: '2026-11-13T17:00:00', EndDateTime_PT: '2026-11-13T23:00:00',
    EventMessages: [{ MessageType: 'Initiation', PostDate_PT: '2026-11-13T17:00:00' },
      { MessageType: 'Update', PostDate_PT: '2026-11-13T19:15:00' }],
  };
  const caiso = { ...emptyCaiso(), CurrentEventsCount: 1, CurrentEvents: [event] };
  const [region] = await read({ caiso });
  assert.equal(region.warnings[0].issuedAt, Date.parse('2026-11-14T03:15:00Z'));
  event.EventMessages[1].MessageType = 'Unrecognized';
  const [invalid] = await read({ caiso });
  assert.equal(invalid.warningSources[0].status, 'unavailable');
  assert.deepEqual(invalid.warnings, []);
});
