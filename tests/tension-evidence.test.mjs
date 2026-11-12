import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  AIRPORTS,
  CHANNELS,
  PAIR_EVIDENCE,
  SOURCES,
  STRIKE_FEED_CAP,
  STRIKE_SEVERITIES,
  buildEvidence,
  buildEvidencePayload,
  isNotable,
  mergeEvidenceHistory,
} from '../scripts/_tension-evidence.mjs';
import { AIRPORTS as SEEDED_AIRPORTS } from '../scripts/seed-aviation.mjs';

const require = createRequire(import.meta.url);

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fresh = (data, ageMin = 5) => ({ data, fetchedAt: NOW - ageMin * MIN });
const item = (live, pairId, channel) => live[pairId].find(entry => entry.channel === channel);

// Shapes below copy production payloads read on 2026-10-25; values are chosen
// so every expected number can be worked out by hand.
function strikeEvent(countryCode, hoursAgo) {
  const timestamp = NOW - hoursAgo * HOUR;
  return {
    id: `tg:${countryCode}:${countryCode}:place:${timestamp}`,
    title: 'Strike report', category: 'airstrike', sourceUrl: 'https://t.me/example/1',
    latitude: 24.69, longitude: 46.72, locationName: 'Riyadh',
    countryCode, timestamp, severity: 'high',
  };
}

function strikeSources({ priorDates = 10 } = {}) {
  const days = {};
  for (let i = 0; i < priorDates; i += 1) {
    const date = new Date(Date.parse('2026-10-21T00:00:00Z') - i * DAY).toISOString().slice(0, 10);
    days[date] = { SA: [0, 1, 1, 1], YE: [0, 0, 1, 0], IL: [0, 0, 1, 0], IR: [1, 0, 1, 0] };
  }
  days['2026-10-22'] = { SA: [0, 3, 0, 0] };
  days['2026-10-23'] = { SA: [0, 3, 0, 0] };
  days['2026-10-24'] = { SA: [1, 2, 2, 0], YE: [0, 1, 1, 0] };
  days['2026-10-25'] = { SA: [0, 1, 0, 0], YE: [0, 0, 0, 1], IR: [0, 0, 2, 2] };
  const events = [
    ...Array.from({ length: 15 }, (_, i) => strikeEvent('SA', i + 1)),
    ...[2, 3, 4, 5].map(h => strikeEvent('YE', h)),
    ...Array.from({ length: 6 }, (_, i) => strikeEvent('IR', i + 1)),
    ...[1, 2, 3].map(h => strikeEvent('IL', h)),
    strikeEvent('SA', 73),
    strikeEvent('IQ', 1),
  ];
  return {
    strikeEvents: fresh({ events, scrapedAt: NOW - 6 * MIN }),
    strikeTally: fresh({ version: 1, days, updatedAt: NOW - 5 * MIN }),
  };
}

function delayAlert(iata, icao, name, city, country, delayType, extra = {}) {
  return {
    id: `avstack-${iata}`, iata, icao, name, city, country,
    location: { latitude: 0, longitude: 0 }, region: 'AIRPORT_REGION_MENA',
    delayType, severity: 'FLIGHT_DELAY_SEVERITY_MAJOR', avgDelayMinutes: 25, delayedFlightsPct: 40,
    cancelledFlights: 0, totalFlights: 60, reason: 'Avg 25min delay', source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
    updatedAt: NOW - 40 * MIN, ...extra,
  };
}

function airportSources({ closed = ['OIIE'], restricted = ['OISS'] } = {}) {
  return {
    airportDelays: fresh({
      alerts: [
        delayAlert('RUH', 'OERK', 'King Khalid International', 'Riyadh', 'Saudi Arabia', 'FLIGHT_DELAY_TYPE_GROUND_STOP',
          { cancelledFlights: 66, totalFlights: 100, reason: '66% flights cancelled' }),
        delayAlert('DOH', 'OTHH', 'Hamad International', 'Doha', 'Qatar', 'FLIGHT_DELAY_TYPE_GENERAL'),
        delayAlert('TLV', 'LLBG', 'Ben Gurion Airport', 'Tel Aviv', 'Israel', 'FLIGHT_DELAY_TYPE_GENERAL'),
      ],
      coverage: [],
    }, 40),
    notamClosures: fresh({
      closedIcaos: closed, restrictedIcaos: restricted,
      reasons: Object.fromEntries([...closed, ...restricted].map(icao => [icao, 'AD CLSD'])),
      coveredIcaos: ['OIIE', 'OISS', 'OERK', 'OTHH'],
    }, 12),
  };
}

function theater(theaterId, assessedAt, byCountry) {
  const totalFlights = Object.values(byCountry).reduce((sum, n) => sum + n, 0);
  return {
    theaterId, assessedAt, totalFlights, postureLevel: 'normal', strikeCapable: false,
    fighters: 0, tankers: 0, awacs: 0, reconnaissance: 0, transport: totalFlights, bombers: 0, drones: 0,
    byOperator: {}, byCountry,
  };
}

function surgeSources({ prior = 19 } = {}) {
  const snapshot = (assessedAt, sourceVersion, iran, taiwan) => ({
    assessedAt, sourceVersion,
    theaters: [theater('iran-theater', assessedAt, iran), theater('taiwan-theater', assessedAt, taiwan)],
  });
  const history = [
    ...Array.from({ length: 5 }, (_, i) => snapshot(NOW - (200 - i * 5) * MIN, 'opensky', { USA: 10 }, { USA: 10 })),
    ...Array.from({ length: prior }, (_, i) => snapshot(NOW - (prior - i + 1) * 5 * MIN, 'adsb.lol', { USA: 2, Israel: 1 }, { USA: 1 })),
    snapshot(NOW - MIN, 'adsb.lol', { USA: 7, Israel: 1, UK: 2 }, {}),
  ];
  return { surgeHistory: fresh({ history }, 1) };
}

function crossStraitSources({ reportingDay = '2026-10-25', state = 'sufficient' } = {}) {
  const category = (value, median) => ({
    current: { value, reportingDay, sourceId: 'taiwan-mnd' },
    windows: {
      30: { windowDays: 30, state, statistic: 'median', value: state === 'sufficient' ? median : null },
      90: { windowDays: 90, state, statistic: 'median', value: state === 'sufficient' ? median : null },
    },
  });
  return {
    crossStrait: fresh({
      schemaVersion: 1, generatedAt: new Date(NOW - 2 * HOUR).toISOString(), status: 'healthy',
      baselines: {
        sourceId: 'taiwan-mnd', semantics: 'prior-usable-reporting-days-excluding-current',
        categories: { plaAircraftSorties: category(31, 5), planShips: category(7, 7) },
      },
    }, 120),
  };
}

function sanction(op, list, cc, at) {
  return {
    at, effectiveAt: String(at - DAY), op, list, id: `${list}:${cc.join('')}:${at}`, name: 'Example Entity',
    et: 'entity', cc, pr: ['IRAN'],
  };
}

function sanctionsSources({ earliestDaysAgo = 49, gaps = [], extra = [] } = {}) {
  const events = [
    sanction('added', 'SDN', ['IR'], NOW - earliestDaysAgo * DAY),
    ...[10, 15, 20, 25, 30].map(d => sanction('added', 'SDN', ['IR'], NOW - Math.min(d, earliestDaysAgo - 1) * DAY)),
    sanction('added', 'SDN', ['IR'], NOW - 2 * HOUR),
    ...[1, 2, 3].map(d => sanction('added', 'SDN', ['IR'], NOW - d * DAY)),
    sanction('added', 'sema-ca', ['IR'], NOW - DAY),
    sanction('removed', 'SDN', ['IR'], NOW - DAY),
    ...[1, 2].map(d => sanction('added', 'CSL-EL', ['CN'], NOW - d * DAY)),
    sanction('added', 'CONSOLIDATED', ['RU'], NOW - DAY),
    ...extra,
  ].sort((a, b) => a.at - b.at);
  return {
    sanctions: fresh({
      version: 1, fetchedAt: NOW - 5 * MIN, sourceFetchedAt: { SDN: NOW - 5 * MIN }, heldSources: [], events, gaps,
    }),
  };
}

const allSources = () => ({
  ...strikeSources(), ...airportSources(), ...surgeSources(), ...crossStraitSources(), ...sanctionsSources(),
});

describe('notable rule', () => {
  it('marks a closure or ground stop notable with no baseline', () => {
    assert.equal(isNotable('airports', 1, null), true);
  });

  it('needs a baseline for counts that are not notable by themselves', () => {
    assert.equal(isNotable('strikes', 12, null), false);
  });

  it('compares a count with its usual level in the same units', () => {
    assert.equal(isNotable('strikes', 12, 3), true, '12 against a usual 3');
    assert.equal(isNotable('strikes', 3, 3), false, '3 against a usual 3');
    assert.equal(isNotable('strikes', 2, 0), false, 'below the channel minimum');
    assert.equal(isNotable('military_aircraft', 5, 1), false, 'below the channel minimum');
    assert.equal(isNotable('military_aircraft', 6, 1), true);
  });

  it('never marks a zero notable', () => {
    assert.equal(isNotable('airports', 0, null), false);
  });
});

describe('strikes', () => {
  it('counts strikes in the last 72 hours where they landed, against the usual for the same window', () => {
    const { live, day } = buildEvidence(strikeSources(), {}, NOW);
    assert.deepEqual(item(live, 'saudi_arabia_yemen', 'strikes'), {
      channel: 'strikes', value: 19, baseline: 12, countries: ['SA', 'YE'], airports: [],
      notable: true, observedAt: NOW - 5 * MIN,
    });
    assert.deepEqual(item(live, 'iran_gcc', 'strikes'), {
      channel: 'strikes', value: 15, baseline: 9, countries: ['SA'], airports: [],
      notable: true, observedAt: NOW - 5 * MIN,
    });
    const israel = item(live, 'israel_iran', 'strikes');
    assert.equal(israel.value, 9);
    assert.equal(israel.baseline, 9);
    assert.deepEqual(israel.countries, ['IR', 'IL']);
    assert.equal(israel.notable, false, 'nine against a usual nine is not notable');
    assert.equal(item(live, 'usa_iran', 'strikes'), undefined, 'the Middle East feed does not cover this pair');
    assert.deepEqual(day['2026-10-24'].saudi_arabia_yemen.strikes, 7);
    assert.deepEqual(day['2026-10-25'].saudi_arabia_yemen.strikes, 2);
    assert.deepEqual(day['2026-10-24'].israel_iran.strikes, 0);
    assert.deepEqual(day['2026-10-25'].israel_iran.strikes, 4);
  });

  it('records every day the tally still holds, so a missed run is repaired', () => {
    const { day } = buildEvidence(strikeSources(), {}, NOW);
    assert.equal(day['2026-10-21'].saudi_arabia_yemen.strikes, 4);
    assert.equal(day['2026-10-12'].israel_iran.strikes, 3);
    assert.equal(day['2026-10-22'].israel_iran.strikes, 0);
  });

  it('withholds the live count when the feed hit its event cap inside the window', () => {
    const sources = strikeSources();
    sources.strikeEvents.data.events = Array.from({ length: STRIKE_FEED_CAP }, (_, i) => strikeEvent('SA', (i + 1) / 10));
    const { live, day } = buildEvidence(sources, {}, NOW);
    assert.equal(item(live, 'saudi_arabia_yemen', 'strikes'), undefined, 'older strikes in the window were cut');
    assert.equal(day['2026-10-24'].saudi_arabia_yemen.strikes, 7, 'the tally is still recorded');
    sources.strikeEvents.data.events.push(strikeEvent('SA', 80));
    sources.strikeEvents.data.events = sources.strikeEvents.data.events.slice(-STRIKE_FEED_CAP);
    assert.ok(item(buildEvidence(sources, {}, NOW).live, 'saudi_arabia_yemen', 'strikes'),
      'a full feed that reaches past the window is complete');
  });

  it('has no baseline until a week of earlier days exists', () => {
    const { live } = buildEvidence(strikeSources({ priorDates: 6 }), {}, NOW);
    const saudi = item(live, 'saudi_arabia_yemen', 'strikes');
    assert.equal(saudi.value, 19);
    assert.equal(saudi.baseline, null);
    assert.equal(saudi.notable, false);
  });
});

describe('airports', () => {
  it('counts closures, ground stops and restrictions per pair and names each airport once', () => {
    const { live, day } = buildEvidence(airportSources(), {}, NOW);
    assert.deepEqual(item(live, 'iran_gcc', 'airports'), {
      channel: 'airports', value: 3, baseline: null, countries: [],
      airports: [
        { name: 'Tehran Imam Khomeini', status: 'closed' },
        { name: 'Riyadh', status: 'halted' },
        { name: 'Shiraz', status: 'restricted' },
      ],
      notable: true, observedAt: NOW - 40 * MIN,
    });
    assert.equal(item(live, 'usa_iran', 'airports').value, 2);
    assert.equal(item(live, 'israel_iran', 'airports').value, 2, 'a general delay at Tel Aviv is not counted');
    assert.deepEqual(item(live, 'saudi_arabia_yemen', 'airports').airports, [{ name: 'Riyadh', status: 'halted' }]);
    const taiwan = item(live, 'china_taiwan', 'airports');
    assert.equal(taiwan.value, 0);
    assert.equal(taiwan.notable, false);
    assert.equal(day['2026-10-25'].iran_gcc.airports, 3);
  });

  it('keeps the worst status when both feeds report the same airport', () => {
    const closed = buildEvidence(airportSources({ closed: ['OERK'], restricted: [] }), {}, NOW).live;
    assert.deepEqual(item(closed, 'saudi_arabia_yemen', 'airports').airports, [{ name: 'Riyadh', status: 'closed' }]);
    const restricted = buildEvidence(airportSources({ closed: [], restricted: ['OERK'] }), {}, NOW).live;
    assert.deepEqual(item(restricted, 'saudi_arabia_yemen', 'airports').airports, [{ name: 'Riyadh', status: 'halted' }]);
  });

  it('compares with the recorded usual once a week of days exists', () => {
    const history = {};
    for (let d = 2; d <= 8; d += 1) {
      history[new Date(NOW - d * DAY).toISOString().slice(0, 10)] = { iran_gcc: { airports: 1 }, saudi_arabia_yemen: { airports: 1 } };
    }
    const { live } = buildEvidence(airportSources(), history, NOW);
    const gulf = item(live, 'iran_gcc', 'airports');
    assert.equal(gulf.baseline, 1);
    assert.equal(gulf.notable, true, 'three disrupted airports against a usual one');
    const saudi = item(live, 'saudi_arabia_yemen', 'airports');
    assert.equal(saudi.baseline, 1);
    assert.equal(saudi.notable, false, 'one disrupted airport against a usual one');
  });

  it('still reports the feed that is up when the other is stale', () => {
    const sources = airportSources();
    sources.airportDelays.fetchedAt = NOW - 120 * MIN;
    const { live } = buildEvidence(sources, {}, NOW);
    assert.deepEqual(item(live, 'iran_gcc', 'airports').airports, [
      { name: 'Tehran Imam Khomeini', status: 'closed' },
      { name: 'Shiraz', status: 'restricted' },
    ]);
  });
});

describe('military aircraft', () => {
  it('compares the latest snapshot with the mean of earlier snapshots from the same feed', () => {
    const { live, day } = buildEvidence(surgeSources(), {}, NOW);
    assert.deepEqual(item(live, 'usa_iran', 'military_aircraft'), {
      channel: 'military_aircraft', value: 7, baseline: 2, countries: ['US'], airports: [],
      notable: true, observedAt: NOW - MIN,
    });
    const israel = item(live, 'israel_iran', 'military_aircraft');
    assert.equal(israel.value, 1);
    assert.equal(israel.baseline, 1, 'Israeli aircraft are counted once, in the theater that contains Israel');
    assert.equal(israel.notable, false);
    assert.equal(item(live, 'usa_china', 'military_aircraft').value, 0);
    assert.equal(day['2026-10-25'].usa_iran.military_aircraft, 7);
  });

  it('has no baseline from under an hour of snapshots', () => {
    const { live } = buildEvidence(surgeSources({ prior: 5 }), {}, NOW);
    const usa = item(live, 'usa_iran', 'military_aircraft');
    assert.equal(usa.baseline, null);
    assert.equal(usa.notable, false);
  });
});

describe('Taiwan Strait', () => {
  it('compares the latest daily report with its 90-day median', () => {
    const { live, day } = buildEvidence(crossStraitSources(), {}, NOW);
    assert.deepEqual(item(live, 'china_taiwan', 'pla_aircraft'), {
      channel: 'pla_aircraft', value: 31, baseline: 5, countries: [], airports: [],
      notable: true, observedAt: NOW - 120 * MIN,
    });
    assert.equal(item(live, 'china_taiwan', 'pla_ships').notable, false);
    assert.equal(day['2026-10-25'].china_taiwan.pla_aircraft, 31);
    assert.equal(day['2026-10-25'].china_taiwan.pla_ships, 7);
  });

  it('ignores the median until the window has enough reporting days', () => {
    const { live } = buildEvidence(crossStraitSources({ state: 'insufficient_data' }), {}, NOW);
    const aircraft = item(live, 'china_taiwan', 'pla_aircraft');
    assert.equal(aircraft.baseline, null);
    assert.equal(aircraft.notable, false);
  });

  it('drops a report more than two days old', () => {
    const { live, day } = buildEvidence(crossStraitSources({ reportingDay: '2026-10-22' }), {}, NOW);
    assert.equal(item(live, 'china_taiwan', 'pla_aircraft'), undefined);
    assert.equal(day['2026-10-22'], undefined);
  });
});

describe('sanctions', () => {
  it('counts US designations added this week against the weekly average of earlier weeks', () => {
    const { live, day } = buildEvidence(sanctionsSources(), {}, NOW);
    assert.deepEqual(item(live, 'usa_iran', 'sanctions'), {
      channel: 'sanctions', value: 4, baseline: 1, countries: ['IR'], airports: [],
      notable: true, observedAt: NOW - 5 * MIN,
    });
    const china = item(live, 'usa_china', 'sanctions');
    assert.equal(china.value, 2);
    assert.equal(china.notable, false, 'two designations are below the channel minimum');
    assert.equal(item(live, 'usa_russia', 'sanctions').value, 1);
    assert.equal(day['2026-10-25'].usa_iran.sanctions, 1);
    assert.equal(day['2026-10-24'].usa_iran.sanctions, 1);
  });

  it('leaves time a list lost its changes out of that list\'s usual rate only', () => {
    const gaps = [
      { list: 'SDN', from: NOW - 35 * DAY, to: NOW - 21 * DAY, reason: 'unavailable' },
      { list: 'sema-ca', from: NOW - 45 * DAY, to: NOW - 40 * DAY, reason: 'unavailable' },
    ];
    const extra = [sanction('added', 'CSL-EL', ['IR'], NOW - 28 * DAY)];
    const { live } = buildEvidence(sanctionsSources({ gaps, extra }), {}, NOW);
    // SDN: 4 designations outside its gap over 4 recorded weeks. CSL-EL kept
    // publishing during the SDN gap: 1 designation over all 6 weeks.
    assert.equal(item(live, 'usa_iran', 'sanctions').baseline, 1.17);
  });

  it('keeps the time of a retained gap, whose changes are recorded when the list returns', () => {
    const gaps = [{ list: 'SDN', from: NOW - 35 * DAY, to: NOW - 21 * DAY, reason: 'retained' }];
    const { live } = buildEvidence(sanctionsSources({ gaps }), {}, NOW);
    assert.equal(item(live, 'usa_iran', 'sanctions').baseline, 1, 'six designations over six weeks');
  });

  it('has no baseline from under three earlier weeks', () => {
    const { live } = buildEvidence(sanctionsSources({ earliestDaysAgo: 20 }), {}, NOW);
    const iran = item(live, 'usa_iran', 'sanctions');
    assert.equal(iran.baseline, null);
    assert.equal(iran.notable, false);
  });
});

describe('degraded sources', () => {
  it('drops only the channel whose source is stale or malformed', () => {
    const sources = allSources();
    sources.sanctions.fetchedAt = NOW - 800 * MIN;
    sources.crossStrait.data = { baselines: 'not an object' };
    const { live } = buildEvidence(sources, {}, NOW);
    assert.equal(item(live, 'usa_iran', 'sanctions'), undefined);
    assert.equal(item(live, 'china_taiwan', 'pla_aircraft'), undefined);
    assert.equal(item(live, 'usa_iran', 'military_aircraft').value, 7);
    assert.equal(item(live, 'saudi_arabia_yemen', 'strikes').value, 19);
    assert.equal(item(live, 'iran_gcc', 'airports').value, 3);
  });

  it('returns an empty reading for every pair when nothing is available', () => {
    const { live, day } = buildEvidence({}, {}, NOW);
    assert.deepEqual(Object.keys(live).sort(), Object.keys(PAIR_EVIDENCE).sort());
    assert.ok(Object.values(live).every(items => items.length === 0));
    assert.deepEqual(day, {});
  });

  it('ignores a source clock from the future', () => {
    const sources = surgeSources();
    sources.surgeHistory.fetchedAt = NOW + 30 * MIN;
    assert.equal(item(buildEvidence(sources, {}, NOW).live, 'usa_iran', 'military_aircraft'), undefined);
  });
});

describe('daily recorder', () => {
  it('keeps the daily peak for snapshot channels and the latest value for daily counts', () => {
    const previous = {
      '2026-10-24': { usa_iran: { military_aircraft: 9, sanctions: 1 } },
      '2026-10-25': { usa_iran: { military_aircraft: 5 } },
    };
    const day = {
      '2026-10-24': { usa_iran: { sanctions: 2 } },
      '2026-10-25': { usa_iran: { military_aircraft: 7 } },
    };
    const merged = mergeEvidenceHistory(previous, day, NOW);
    assert.deepEqual(merged, {
      '2026-10-24': { usa_iran: { military_aircraft: 9, sanctions: 2 } },
      '2026-10-25': { usa_iran: { military_aircraft: 7 } },
    });
    assert.deepEqual(mergeEvidenceHistory(merged, day, NOW), merged, 'running twice changes nothing');
    assert.deepEqual(
      mergeEvidenceHistory(merged, { '2026-10-25': { usa_iran: { military_aircraft: 3 } } }, NOW)['2026-10-25'],
      { usa_iran: { military_aircraft: 7 } },
      'a lower snapshot later in the day keeps the peak',
    );
  });

  it('keeps 90 days and drops values it cannot place', () => {
    const merged = mergeEvidenceHistory({
      '2026-07-27': { usa_iran: { sanctions: 1 } },
      '2026-07-28': { usa_iran: { sanctions: 2 } },
      '2026-10-20': {
        usa_iran: { sanctions: 3, unknown_channel: 1, military_aircraft: Number.NaN },
        unknown_pair: { sanctions: 1 },
      },
      'not-a-date': { usa_iran: { sanctions: 1 } },
    }, {}, NOW);
    assert.deepEqual(merged, {
      '2026-07-28': { usa_iran: { sanctions: 2 } },
      '2026-10-20': { usa_iran: { sanctions: 3 } },
    });
  });

  it('builds the same payload when a run repeats', () => {
    const previous = { updatedAt: NOW - 15 * MIN, live: {}, days: { '2026-10-24': { usa_iran: { military_aircraft: 4 } } } };
    const first = buildEvidencePayload(allSources(), previous, NOW);
    assert.equal(first.updatedAt, NOW);
    assert.equal(first.days['2026-10-24'].usa_iran.military_aircraft, 4);
    assert.equal(first.days['2026-10-25'].usa_iran.military_aircraft, 7);
    assert.deepEqual(buildEvidencePayload(allSources(), first, NOW), first);
  });
});

describe('pair registry', () => {
  const pairs = JSON.parse(readFileSync(new URL('../shared/gdelt-tension-pairs.json', import.meta.url), 'utf8'));
  const flights = readFileSync(new URL('../scripts/seed-military-flights.mjs', import.meta.url), 'utf8');
  const theaterBlock = flights.slice(flights.indexOf('const POSTURE_THEATERS = ['));
  const theaterIds = new Set([...theaterBlock.slice(0, theaterBlock.indexOf('];')).matchAll(/id: '([^']+)'/g)].map(m => m[1]));
  const operatorSpellings = new Set([...flights.matchAll(/operatorCountry: '([^']+)'/g)].map(m => m[1]));

  it('names only pairs on the board and channels in the registry', () => {
    const pairIds = new Set(pairs.map(pair => pair.id));
    for (const [pairId, channels] of Object.entries(PAIR_EVIDENCE)) {
      assert.ok(pairIds.has(pairId), `${pairId} is a tension pair`);
      for (const channel of Object.keys(channels)) assert.ok(channel in CHANNELS, `${pairId}.${channel} is a channel`);
    }
  });

  it('points military aircraft at real theaters and operator spellings', () => {
    for (const [pairId, { military_aircraft: params }] of Object.entries(PAIR_EVIDENCE)) {
      if (!params) continue;
      for (const id of params.theaters) assert.ok(theaterIds.has(id), `${pairId} theater ${id} exists`);
      assert.ok(operatorSpellings.has(CHANNELS.military_aircraft.operatorSpelling[params.operator]),
        `${pairId} operator ${params.operator} matches a classified operatorCountry`);
    }
  });

  it('counts live strikes with the severities the daily tally keeps', () => {
    const { PRESSURE_SEVERITIES } = require('../scripts/lib/middle-east-strikes.cjs');
    assert.deepEqual(STRIKE_SEVERITIES, PRESSURE_SEVERITIES);
  });

  it('knows the strike feed\'s event cap', () => {
    const { MAX_EVENTS } = require('../scripts/lib/middle-east-strikes.cjs');
    assert.equal(STRIKE_FEED_CAP, MAX_EVENTS);
  });

  it('holds each source to its health budget', () => {
    const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
    for (const [name, { metaKey, maxAgeMin }] of Object.entries(SOURCES)) {
      const at = health.indexOf(`'${metaKey}'`);
      assert.ok(at > 0, `${name} meta key ${metaKey} is registered in health`);
      const budget = health.slice(at, at + 200).match(/maxStaleMin:\s*(\d+)/);
      assert.equal(Number(budget?.[1]), maxAgeMin, `${name} max age matches health`);
    }
  });

  it('lists every monitored airport in the pair countries, and only those', () => {
    const iso2 = {
      'Saudi Arabia': 'SA', UAE: 'AE', Qatar: 'QA', Kuwait: 'KW', Bahrain: 'BH', Oman: 'OM', Iran: 'IR',
      Israel: 'IL', Yemen: 'YE', Taiwan: 'TW', Russia: 'RU',
    };
    const airportCountries = new Set(Object.values(PAIR_EVIDENCE).flatMap(channels => channels.airports?.countries ?? []));
    const expected = Object.fromEntries(SEEDED_AIRPORTS
      .filter(airport => airportCountries.has(iso2[airport.country]))
      .map(airport => [airport.icao, iso2[airport.country]]));
    const listed = Object.fromEntries(Object.entries(AIRPORTS).map(([icao, airport]) => [icao, airport.country]));
    assert.deepEqual(listed, expected);
    for (const country of airportCountries) {
      assert.ok(Object.values(AIRPORTS).some(airport => airport.country === country), `${country} has a monitored airport`);
    }
  });
});
