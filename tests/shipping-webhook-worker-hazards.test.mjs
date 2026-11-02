import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeRedis } from './_lib/fake-webhook-redis.mjs';
import {
  BACKFILL_CURSOR_KEY,
  CHOKEPOINT_STATUS_KEY,
  EARTHQUAKES_KEY,
  HAZARD_INIT_KEY,
  HAZARD_RULE,
  LOCK_KEY,
  NATURAL_EVENTS_KEY,
  OCCURRENCE_RULES,
  WORKER_META_KEY,
  diffHazards,
  earthquakeCandidate,
  matchOccurrence,
  naturalEventCandidate,
  parseHazardSeen,
  planTick,
  runTick,
  seenKey,
  stableHazardId,
  stateKey,
  stormKey,
} from '../scripts/shipping-webhook-worker.mjs';

// natural.hazard: the worker diffs seismology:earthquakes:v1 and
// natural:events:v1 against its own seen set and delivers each new hazard once
// per subscriber through the occurrence pipeline news.breaking and market.move
// already use (pending retry, caps, occ: tombstones).

const NOW = Date.parse('2026-10-16T03:40:02.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const HAZARD_DEFAULTS = { hazardTypes: [], minMagnitude: 5.5, minAlertLevel: 'Orange', countries: [] };
const SEEN = seenKey('natural.hazard');

function quake(overrides = {}) {
  return {
    id: 'us6000u2mq',
    place: '76 km NE of Ozernovskiy, Russia',
    magnitude: 6.9,
    depthKm: 135,
    location: { latitude: 51.98, longitude: 157.27 },
    occurredAt: NOW - 5 * MIN,
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2mq',
    source: 'usgs',
    ...overrides,
  };
}

function natural(overrides = {}) {
  return {
    id: 'EONET_25339',
    title: 'Super Typhoon Champi',
    description: '',
    category: 'severeStorms',
    categoryTitle: 'Severe Storms',
    lat: 13.1,
    lon: 143.4,
    date: NOW - HOUR,
    magnitude: 130,
    magnitudeUnit: 'kts',
    sourceUrl: 'https://www.metoc.navy.mil/jtwc/products/wp3026.tcw',
    sourceName: 'JTWC',
    closed: false,
    ...overrides,
  };
}

/** A seen set that already knows one id per feed, so neither feed bootstraps. */
const warmSeen = (...members) => parseHazardSeen(['eq:us0000warm', 'nat:EONET_1', ...members]);
const ids = (result) => result.occurrences.map((o) => o.eventId);

describe('hazard candidates', () => {
  it('an earthquake row becomes the documented payload with an eq: id and the place\'s country', () => {
    const candidate = earthquakeCandidate(quake({ nearTestSite: true }));
    assert.equal(candidate.eventId, 'eq:us6000u2mq');
    assert.deepEqual(candidate.payload, {
      eventId: 'eq:us6000u2mq',
      hazardType: 'earthquakes',
      title: 'M6.9 - 76 km NE of Ozernovskiy, Russia',
      source: 'usgs',
      sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2mq',
      lat: 51.98,
      lon: 157.27,
      countryCodes: ['RU'],
      occurredAt: new Date(NOW - 5 * MIN).toISOString(),
      magnitude: 6.9,
      depthKm: 135,
      nearTestSite: true,
      alertLevel: null,
      stormName: null,
      stormCategory: null,
      windKt: null,
    });
    assert.equal(earthquakeCandidate(quake({ source: 'nrcan', id: 'nrcan:20261016.0335001' })).payload.source, 'nrcan');
    assert.equal(earthquakeCandidate(quake({ location: null })), null);
  });

  it('NHC ids lose the advisory number, so every advisory of one storm is one event', () => {
    assert.equal(stableHazardId('nhc-AL09-12'), 'nhc-AL09');
    assert.equal(stableHazardId('nhc-EP14-7A'), 'nhc-EP14');
    assert.equal(stableHazardId('EONET_25339'), 'EONET_25339');
    assert.equal(stableHazardId('gdacs-TC-1001234'), 'gdacs-TC-1001234');
    const a = naturalEventCandidate(natural({ id: 'nhc-AL09-12', sourceName: 'NHC', title: 'Hurricane Melissa', stormName: 'Melissa', windKt: 120, stormCategory: 4 }));
    const b = naturalEventCandidate(natural({ id: 'nhc-AL09-13', sourceName: 'NHC', title: 'Hurricane Melissa', stormName: 'Melissa', windKt: 125, stormCategory: 4 }));
    assert.equal(a.eventId, 'nat:nhc-AL09');
    assert.equal(b.eventId, a.eventId);
    assert.equal(a.payload.source, 'nhc');
    assert.equal(a.payload.stormName, 'Melissa');
    assert.equal(a.payload.stormCategory, 4);
    assert.equal(a.payload.windKt, 120);
  });

  it('storm names drop the classification and the GDACS season suffix', () => {
    assert.equal(stormKey('Super Typhoon Champi'), 'champi');
    assert.equal(stormKey('CHAMPI-26'), 'champi');
    assert.equal(stormKey('Tropical Cyclone 01P'), '01p');
    assert.equal(stormKey('Hurricane Melissa'), 'melissa');
  });

  it('an EONET storm reads its name from the title and its wind from the knots magnitude', () => {
    const candidate = naturalEventCandidate(natural());
    assert.equal(candidate.eventId, 'nat:EONET_25339');
    assert.equal(candidate.payload.source, 'eonet');
    assert.equal(candidate.payload.stormName, 'Champi');
    assert.equal(candidate.payload.windKt, 130);
    assert.equal(candidate.payload.magnitude, null);
    assert.equal(candidate.payload.alertLevel, null);
    assert.equal(candidate.storm, 'champi');
    const fire = naturalEventCandidate(natural({ id: 'EONET_25232', title: 'Wildfire CYRUS, Kern, California', category: 'wildfires', lat: 35.7, lon: -118.42, magnitude: 543, magnitudeUnit: 'acres', sourceName: 'IRWIN' }));
    assert.equal(fire.payload.windKt, null, 'acres are not knots');
    assert.equal(fire.payload.stormName, null);
    assert.deepEqual(fire.payload.countryCodes, ['US']);
  });

  it('GDACS rows carry their alert level (or the title emoji of an older row) and lose the emoji from the title', () => {
    const red = naturalEventCandidate(natural({ id: 'gdacs-FL-1103', title: '\u{1F534} Flood in Nigeria', category: 'floods', sourceName: 'GDACS', alertLevel: 'Red', lat: 9, lon: 7 }));
    assert.equal(red.payload.alertLevel, 'Red');
    assert.equal(red.payload.title, 'Flood in Nigeria');
    assert.equal(red.payload.source, 'gdacs');
    assert.deepEqual(red.payload.countryCodes, ['NG']);
    const legacy = naturalEventCandidate(natural({ id: 'gdacs-DR-1', title: '\u{1F7E0} Drought in Kenya', category: 'drought', sourceName: 'GDACS', lat: 0, lon: 38 }));
    assert.equal(legacy.payload.alertLevel, 'Orange');
    assert.equal(naturalEventCandidate(natural({ id: 'cyclone:wp:2026:gdacs:gdacs-tc-1001', sourceName: 'GDACS', title: 'Typhoon CHAMPI-26', stormName: 'CHAMPI-26' })).payload.alertLevel, null, 'western-Pacific cyclones carry no level');
  });

  it('skips GDACS earthquake rows: the earthquake feed carries the same quakes', () => {
    assert.equal(naturalEventCandidate(natural({ id: 'gdacs-EQ-1500', category: 'earthquakes', title: '\u{1F7E0} Earthquake in Russia' })), null);
  });
});

describe('diffHazards', () => {
  it('bootstraps a feed with no seen id: every id is marked seen and nothing is delivered', () => {
    const result = diffHazards({ earthquakes: [quake()], naturalEvents: [natural()] }, new Map(), NOW);
    assert.deepEqual(result.occurrences, []);
    assert.equal(result.counters.bootstrapped, 2);
    assert.deepEqual(result.writes.map(([, member]) => member.split('|')[0]).sort(), ['eq:us6000u2mq', 'nat:EONET_25339']);
    assert.ok(result.writes.every(([score]) => score === NOW));
  });

  it('an initialized feed never bootstraps again, even with every seen id pruned; the first-ever read does and asks to be marked', () => {
    const pruned = diffHazards({ earthquakes: [quake()], naturalEvents: [], initialized: ['eq', 'nat'] }, new Map(), NOW);
    assert.deepEqual(ids(pruned), ['eq:us6000u2mq'], 'a quiet feed whose seen ids were all pruned still delivers its next event');
    assert.deepEqual(pruned.initWrites, []);
    const first = diffHazards({ earthquakes: [quake()], naturalEvents: null }, new Map(), NOW);
    assert.deepEqual(first.occurrences, []);
    assert.deepEqual(first.initWrites, ['eq'], 'only the readable feed is marked');
    const legacy = diffHazards({ earthquakes: [quake()], naturalEvents: [] }, parseHazardSeen(['eq:us0000warm']), NOW);
    assert.deepEqual(ids(legacy), ['eq:us6000u2mq'], 'seen ids written before the marker existed still count');
    assert.deepEqual(legacy.initWrites, ['eq', 'nat']);
  });

  it('bootstraps each feed on its own: an earthquake-only seen set still swallows the first natural-events read', () => {
    const seen = parseHazardSeen(['eq:us0000warm']);
    const result = diffHazards({ earthquakes: [quake()], naturalEvents: [natural()] }, seen, NOW);
    assert.deepEqual(ids(result), ['eq:us6000u2mq']);
    assert.equal(result.counters.bootstrapped, 1);
  });

  it('delivers an unseen id within its new window, refreshes a seen one and leaves an unreadable feed alone', () => {
    const seen = warmSeen('eq:us6000old1|q:1,1,1,6');
    const result = diffHazards({ earthquakes: [quake(), quake({ id: 'us6000old1', occurredAt: NOW - 2 * HOUR })], naturalEvents: null }, seen, NOW);
    assert.deepEqual(ids(result), ['eq:us6000u2mq']);
    assert.ok(result.writes.some(([score, member]) => score === NOW && member === 'eq:us6000old1|q:1,1,1,6'), 'a seen id keeps its member and gets a fresh score');
    assert.equal(result.writes.some(([, member]) => member.startsWith('nat:')), false, 'nothing of an unreadable feed is touched');
  });

  it('an unseen id older than its window (24 h for quakes, 72 h otherwise), undated or closed is marked seen, not delivered', () => {
    const result = diffHazards({
      earthquakes: [quake({ id: 'old', occurredAt: NOW - 25 * HOUR }), quake({ id: 'undated', occurredAt: 0 })],
      naturalEvents: [natural({ id: 'EONET_9', date: NOW - 71 * HOUR, title: 'Wildfire A, Elko, Nevada', category: 'wildfires' }), natural({ id: 'EONET_10', date: NOW - 73 * HOUR, category: 'volcanoes', title: 'Etna Volcano, Italy' }), natural({ id: 'EONET_11', closed: true, category: 'floods', title: 'Flood' })],
    }, warmSeen(), NOW);
    assert.deepEqual(ids(result), ['nat:EONET_9']);
    assert.equal(result.counters.stale, 3);
    assert.equal(result.counters.closed, 1);
    assert.equal(result.writes.length, 5, 'every candidate is written seen; warm ids absent from the feeds are not refreshed');
    assert.equal(HAZARD_RULE.quakeNewWithinMs, 24 * HOUR);
    assert.equal(HAZARD_RULE.otherNewWithinMs, 72 * HOUR);
  });

  it('a magnitude revision of a seen quake does not refire', () => {
    const seen = warmSeen(`eq:us6000u2mq|q:${NOW - 5 * MIN},51.98,157.27,5.4`);
    const result = diffHazards({ earthquakes: [quake({ magnitude: 5.8 })], naturalEvents: [] }, seen, NOW);
    assert.deepEqual(result.occurrences, []);
  });

  it('another agency\'s id for a seen quake is the same quake; a separate quake nearby is not', () => {
    const seen = warmSeen(`eq:nrcan:20261016.0335|q:${NOW - 5 * MIN},51.9,157.1,6.7`);
    const result = diffHazards({
      earthquakes: [quake(), quake({ id: 'us6000aftr', occurredAt: NOW - 1 * MIN, magnitude: 6.8 })],
      naturalEvents: [],
    }, seen, NOW);
    assert.deepEqual(ids(result), ['eq:us6000aftr'], 'four minutes later is a different quake, even at the same place');
    assert.equal(result.counters.crossSource, 1);
  });

  it('two separate quakes that are both still in the feed are two events, however close', () => {
    const seen = warmSeen(`eq:us6000frst|q:${NOW - 6 * MIN},51.98,157.27,5.8`);
    const result = diffHazards({
      earthquakes: [quake({ id: 'us6000frst', occurredAt: NOW - 6 * MIN, magnitude: 5.8 }), quake({ id: 'us6000scnd', occurredAt: NOW - 5 * MIN, magnitude: 5.8, location: { latitude: 52.3, longitude: 157.6 } })],
      naturalEvents: [],
    }, seen, NOW);
    assert.deepEqual(ids(result), ['eq:us6000scnd'], 'a doublet is not a replacement: the first id is still published');
    const sameTick = diffHazards({
      earthquakes: [quake({ id: 'us6000aaaa', magnitude: 5.8 }), quake({ id: 'us6000bbbb', occurredAt: NOW - 4 * MIN, magnitude: 5.9 })],
      naturalEvents: [],
    }, warmSeen(), NOW);
    assert.deepEqual(ids(sameTick).sort(), ['eq:us6000aaaa', 'eq:us6000bbbb']);
  });

  it('a USGS id that replaces a seen one (the old id gone from the feed) is the same quake', () => {
    const seen = warmSeen(`eq:ak0261abcd|q:${NOW - 5 * MIN},51.98,157.27,6.9`);
    const result = diffHazards({ earthquakes: [quake()], naturalEvents: [] }, seen, NOW);
    assert.deepEqual(result.occurrences, []);
    assert.equal(result.counters.crossSource, 1);
  });

  it('one storm from NHC and EONET in one tick is one delivery, from NHC', () => {
    const result = diffHazards({ earthquakes: [], naturalEvents: [
      natural({ id: 'EONET_25063', title: 'Hurricane Melissa', sourceName: 'NOAA_NHC', lat: 17.9, lon: -76.5 }),
      natural({ id: 'nhc-AL13-30', title: 'Hurricane Melissa', stormName: 'Melissa', sourceName: 'NHC', lat: 18, lon: -76.6, windKt: 140, stormCategory: 5 }),
    ] }, warmSeen(), NOW);
    assert.deepEqual(ids(result), ['nat:nhc-AL13']);
    assert.equal(result.counters.crossSource, 1);
  });

  it('a GDACS cyclone already seen under its season name stops the EONET copy in a later tick', () => {
    const seen = warmSeen('nat:cyclone:wp:2026:gdacs:gdacs-tc-1001|s:champi');
    const result = diffHazards({ earthquakes: [], naturalEvents: [natural()] }, seen, NOW);
    assert.deepEqual(result.occurrences, []);
    assert.equal(result.counters.crossSource, 1);
  });

  it('a GDACS event is new when first seen at Orange or Red, however long ago GDACS opened it (it may have been Green, which is not stored)', () => {
    const flood = natural({ id: 'gdacs-FL-1001', title: '\u{1F7E0} Flood in Nigeria', category: 'floods', sourceName: 'GDACS', alertLevel: 'Orange', lat: 9, lon: 7, date: NOW - 10 * 24 * HOUR });
    const result = diffHazards({ earthquakes: [], naturalEvents: [flood] }, warmSeen(), NOW);
    assert.deepEqual(ids(result), ['nat:gdacs-FL-1001']);
  });

  it('a GDACS escalation from Orange to Red is a second event; a Red event that falls back to Orange is not new', () => {
    const orange = natural({ id: 'gdacs-FL-1001', title: '\u{1F7E0} Flood in Nigeria', category: 'floods', sourceName: 'GDACS', alertLevel: 'Orange', lat: 9, lon: 7, date: NOW - 4 * 24 * HOUR });
    const red = { ...orange, title: '\u{1F534} Flood in Nigeria', alertLevel: 'Red' };
    const first = diffHazards({ earthquakes: [], naturalEvents: [orange] }, warmSeen(), NOW);
    assert.deepEqual(ids(first), ['nat:gdacs-FL-1001']);
    const escalated = diffHazards({ earthquakes: [], naturalEvents: [red] }, parseHazardSeen(['eq:us0000warm', ...first.writes.map(([, m]) => m)]), NOW + HOUR);
    assert.deepEqual(ids(escalated), ['nat:gdacs-FL-1001:red']);
    assert.equal(escalated.occurrences[0].payload.alertLevel, 'Red');
    const back = diffHazards({ earthquakes: [], naturalEvents: [orange] }, parseHazardSeen(['eq:us0000warm', ...escalated.writes.map(([, m]) => m)]), NOW + 2 * HOUR);
    assert.deepEqual(back.occurrences, []);

    const redFirst = diffHazards({ earthquakes: [], naturalEvents: [red] }, warmSeen(), NOW);
    assert.deepEqual(ids(redFirst), ['nat:gdacs-FL-1001:red'], 'first seen at Red: one event');
    const thenOrange = diffHazards({ earthquakes: [], naturalEvents: [orange] }, parseHazardSeen(['eq:us0000warm', ...redFirst.writes.map(([, m]) => m)]), NOW + HOUR);
    assert.deepEqual(thenOrange.occurrences, [], 'a de-escalation is not a new event');
  });

  it('a GDACS cyclone\'s escalation to Red is not swallowed as a copy of itself by the storm-name match', () => {
    const tc = natural({ id: 'gdacs-TC-1000', title: '\u{1F7E0} Tropical Cyclone KIKO-26', stormName: 'KIKO-26', sourceName: 'GDACS', alertLevel: 'Orange', lat: 15, lon: -125 });
    const first = diffHazards({ earthquakes: [], naturalEvents: [tc] }, warmSeen(), NOW);
    const escalated = diffHazards({ earthquakes: [], naturalEvents: [{ ...tc, alertLevel: 'Red' }] }, parseHazardSeen(['eq:us0000warm', ...first.writes.map(([, m]) => m)]), NOW + HOUR);
    assert.deepEqual(ids(escalated), ['nat:gdacs-TC-1000:red']);
  });

  it('skips Hong Kong Observatory warning signals: the id names the signal, not the storm, which the cyclone feeds carry', () => {
    assert.equal(naturalEventCandidate(natural({ id: 'hko-warning:TC8NE', title: 'Hong Kong No. 8 Northeast Gale or Storm Signal', sourceName: 'HKO', lat: 22.3, lon: 114.17 })), null);
  });

  it('skips prescribed burns: EONET titles them "Prescribed Fire … RX", and a planned burn is not a wildfire alert', () => {
    for (const title of ['Prescribed Fire Newman Piles RX, Coconino, Arizona', 'Prescribed Fire SRF 2026 Rx Implementation, Humboldt, California', 'Prescribed Burn Unit 4, Lake, Oregon', 'Jane 102 RX, Harney, Oregon']) {
      assert.equal(naturalEventCandidate(natural({ id: 'EONET_30001', title, category: 'wildfires', sourceName: 'IRWIN', lat: 35, lon: -111 })), null, title);
    }
    assert.ok(naturalEventCandidate(natural({ id: 'EONET_30002', title: 'Wildfire Buckhorn 2, Cassia, Idaho', category: 'wildfires', sourceName: 'IRWIN', lat: 42.3, lon: -113.6 })), 'a wildfire is kept');
    assert.ok(naturalEventCandidate(natural({ id: 'EONET_30003', title: 'Wildfire Rxford, Kern, California', category: 'wildfires', sourceName: 'IRWIN', lat: 35.4, lon: -118.9 })), 'RX only as a whole word');
    assert.ok(naturalEventCandidate(natural({ id: 'EONET_30004', title: 'Prescribed Fire RX near the Sava, Croatia', category: 'floods', sourceName: 'EO', lat: 45, lon: 16 })), 'only wildfire rows are filtered');
  });

  it('keeps an id seen for 30 days after it leaves the feeds, so an EONET event that drops out and returns is not new again', () => {
    assert.equal(HAZARD_RULE.seenWindowMs, 30 * 24 * HOUR);
  });

  it('a storm renamed after first sight keeps both names, so a later copy under the new name is still the same storm', () => {
    let seen = warmSeen('nat:nhc-AL19|s:nineteen');
    const renamed = natural({ id: 'nhc-AL19-5', title: 'Tropical Storm Melissa', stormName: 'Melissa', sourceName: 'NHC' });
    const first = diffHazards({ earthquakes: [], naturalEvents: [renamed] }, seen, NOW);
    assert.deepEqual(first.occurrences, []);
    const members = first.writes.map(([, member]) => member);
    assert.ok(members.includes('nat:nhc-AL19|s:nineteen') && members.includes('nat:nhc-AL19|s:melissa'));
    seen = parseHazardSeen(members);
    const later = diffHazards({ earthquakes: [], naturalEvents: [renamed, natural({ id: 'gdacs-TC-1002', title: '\u{1F7E0} Tropical Storm MELISSA-26', stormName: 'MELISSA-26', sourceName: 'GDACS' })] }, seen, NOW + 3 * HOUR);
    assert.deepEqual(later.occurrences, []);
    assert.equal(later.counters.crossSource, 1);
  });
});

describe('matchOccurrence: natural.hazard', () => {
  const record = (scope = {}) => ({ subscriberId: 'wh_h', eventType: 'natural.hazard', scope: { ...HAZARD_DEFAULTS, ...scope } });
  const occ = (candidate) => ({ event: 'natural.hazard', eventId: candidate.eventId, payload: candidate.payload });
  const eq = (overrides) => occ(earthquakeCandidate(quake(overrides)));
  const nat = (overrides) => occ(naturalEventCandidate(natural(overrides)));

  it('the magnitude floor applies to earthquakes only', () => {
    assert.ok(matchOccurrence(record(), eq({ magnitude: 5.5 })));
    assert.equal(matchOccurrence(record(), eq({ magnitude: 5.4 })), null);
    assert.ok(matchOccurrence(record({ minMagnitude: 4.5 }), eq({ magnitude: 4.6 })));
    assert.ok(matchOccurrence(record({ minMagnitude: 9 }), nat()), 'a storm has no magnitude to floor');
  });

  it('hazard types filter, empty accepts all', () => {
    assert.ok(matchOccurrence(record({ hazardTypes: ['severeStorms'] }), nat()));
    assert.equal(matchOccurrence(record({ hazardTypes: ['wildfires', 'floods'] }), nat()), null);
    assert.equal(matchOccurrence(record({ hazardTypes: ['severeStorms'] }), eq()), null);
  });

  it('Red admits only GDACS rows GDACS marked Red; other sources ignore the level', () => {
    const gdacs = (alertLevel) => nat({ id: 'gdacs-FL-1', category: 'floods', title: 'Flood in Nigeria', sourceName: 'GDACS', alertLevel });
    assert.ok(matchOccurrence(record(), gdacs('Orange')));
    assert.ok(matchOccurrence(record({ minAlertLevel: 'Red' }), gdacs('Red')));
    assert.equal(matchOccurrence(record({ minAlertLevel: 'Red' }), gdacs('Orange')), null);
    assert.equal(matchOccurrence(record({ minAlertLevel: 'Red' }), nat({ id: 'cyclone:wp:2026:gdacs:x', sourceName: 'GDACS' })), null, 'unknown level is not Red');
    assert.ok(matchOccurrence(record({ minAlertLevel: 'Red' }), nat()), 'EONET rows carry no GDACS level');
  });

  it('country scope is strict: a hazard placed in no country never matches it', () => {
    assert.ok(matchOccurrence(record({ countries: ['RU'] }), eq()));
    assert.equal(matchOccurrence(record({ countries: ['JP'] }), eq()), null);
    const midOcean = eq({ place: 'central Mid-Atlantic Ridge', location: { latitude: 0.17, longitude: -19.86 } });
    assert.deepEqual(midOcean.payload.countryCodes, []);
    assert.equal(matchOccurrence(record({ countries: ['BR'] }), midOcean), null);
    assert.ok(matchOccurrence(record(), midOcean), 'no country scope, no filter');
  });

  it('never matches another event\'s subscription', () => {
    assert.equal(matchOccurrence({ subscriberId: 'wh_n', eventType: 'news.breaking', scope: {} }, eq()), null);
  });
});

describe('planTick: natural.hazard records', () => {
  const hazardRecord = (scope = {}) => ({
    subscriberId: 'wh_hhhhhhhhhhhhhhhhhhhhhhhh', ownerTag: 'o', callbackUrl: 'https://hooks.example.com/wm', chokepointIds: [], alertThreshold: 50,
    createdAt: '2026-10-01T00:00:00.000Z', active: true, secret: 'a'.repeat(64), eventType: 'natural.hazard', scope: { ...HAZARD_DEFAULTS, ...scope },
  });

  it('caps at 30 an hour and counts the overflow as suppressed (an aftershock swarm)', () => {
    assert.equal(OCCURRENCE_RULES['natural.hazard'].maxPerHour, 30);
    assert.equal(OCCURRENCE_RULES['natural.hazard'].maxPerDay, 150);
    assert.equal(OCCURRENCE_RULES['natural.hazard'].pendingTtlMs, 24 * HOUR);
    const swarm = Array.from({ length: 31 }, (_, i) => quake({ id: `us60swarm${String(i).padStart(2, '0')}`, occurredAt: NOW - (40 - i) * 3 * MIN }));
    const { occurrences } = diffHazards({ earthquakes: swarm, naturalEvents: [] }, warmSeen(), NOW);
    assert.equal(occurrences.length, 31);
    let n = 0;
    const { deliveries, counters } = planTick({ chokepoints: null, hazards: occurrences, records: [hazardRecord()], states: new Map(), now: NOW, scoresFetchedAt: null, makeId: () => `whd_${String(n++).padStart(32, '0')}` });
    assert.equal(deliveries.length, 30);
    assert.equal(counters.suppressed, 1);
    assert.ok(deliveries.every((d) => d.event === 'natural.hazard' && d.payload.reason === 'new_hazard'));
  });

  it('leaves hazard records untouched when neither hazard feed was readable', () => {
    const { deliveries, nextStates } = planTick({ chokepoints: null, occurrences: [], hazards: null, records: [hazardRecord()], states: new Map(), now: NOW, scoresFetchedAt: null });
    assert.equal(deliveries.length, 0);
    assert.equal(nextStates.size, 0);
  });
});

// End to end through runTick with the in-memory pipeline.

const TOKEN = 'run-1';
const SUB = 'wh_hhhhhhhhhhhhhhhhhhhhhhhh';
function lockStub(store) {
  return {
    acquire: async () => { store.set(LOCK_KEY, TOKEN); return true; },
    fence: () => ({ key: LOCK_KEY, token: TOKEN }),
    release: async () => {},
  };
}

const envelope = (data) => JSON.stringify({ _seed: { fetchedAt: NOW - MIN, recordCount: 1, sourceVersion: 't', schemaVersion: 1, state: 'OK' }, data });

function seeded({ scope = {}, earthquakes = [quake({ id: 'us6000base', occurredAt: NOW - 3 * HOUR })], naturalEvents = [natural({ id: 'EONET_1' })], chokepoints = null, extra = [] } = {}) {
  const rec = {
    subscriberId: SUB, ownerTag: 'o', callbackUrl: 'https://hooks.example.com/wm', chokepointIds: ['suez'], alertThreshold: 50,
    createdAt: '2026-10-01T00:00:00.000Z', active: true, secret: 'a'.repeat(64), eventType: 'natural.hazard', scope: { ...HAZARD_DEFAULTS, ...scope },
  };
  const records = [rec, ...extra];
  const initial = { 'webhook:all:v1': new Set(records.map((r) => r.subscriberId)), [BACKFILL_CURSOR_KEY]: 'done' };
  for (const r of records) initial[`webhook:sub:${r.subscriberId}:v1`] = JSON.stringify(r);
  if (earthquakes) initial[EARTHQUAKES_KEY] = envelope({ earthquakes });
  if (naturalEvents) initial[NATURAL_EVENTS_KEY] = envelope({ events: naturalEvents });
  if (chokepoints) initial[CHOKEPOINT_STATUS_KEY] = JSON.stringify({ chokepoints, fetchedAt: 'x' });
  return fakeRedis(initial);
}

function deliverStub(outcomes = []) {
  const sent = [];
  const deliver = async (rec, payload, deliveryId, event) => {
    sent.push({ rec, payload, deliveryId, event });
    return outcomes.shift() ?? { ok: true, status: 200 };
  };
  return { sent, deliver };
}

const tick = (fake, deliver, now = NOW) => runTick({ redis: fake.redis, lock: lockStub(fake.store), deliver, env: {}, fetchImpl: async () => { throw new Error('unexpected fetch'); }, now: () => now });
const setFeed = (fake, { earthquakes, naturalEvents }) => {
  if (earthquakes) fake.store.set(EARTHQUAKES_KEY, envelope({ earthquakes }));
  if (naturalEvents) fake.store.set(NATURAL_EVENTS_KEY, envelope({ events: naturalEvents }));
};

describe('runTick: natural.hazard deliveries', () => {
  it('the first tick only marks the current feeds seen; a quake that appears later is delivered once, then never again', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub();
    const first = await tick(fake, deliver);
    assert.equal(sent.length, 0, 'bootstrap delivers nothing');
    assert.equal(first.hazardSourceState, 'ok');
    assert.deepEqual(first.hazards, { feedIds: 2, new: 0, bootstrapped: 2, stale: 0, closed: 0, crossSource: 0 });
    assert.deepEqual([...fake.store.get(SEEN).keys()].map((m) => m.split('|')[0]).sort(), ['eq:us6000base', 'nat:EONET_1']);

    setFeed(fake, { earthquakes: [quake({ id: 'us6000base', occurredAt: NOW - 3 * HOUR }), quake()] });
    const second = await tick(fake, deliver, NOW + 5 * MIN);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'natural.hazard');
    assert.equal(sent[0].payload.eventId, 'eq:us6000u2mq');
    assert.equal(sent[0].payload.subscriberId, SUB);
    assert.equal(sent[0].payload.triggeredAt, new Date(NOW + 5 * MIN).toISOString());
    assert.equal(second.hazards.new, 1);
    assert.equal(second.occurrences.matched, 1);
    assert.deepEqual(JSON.parse(fake.store.get(WORKER_META_KEY)).hazards, second.hazards);
    assert.equal(JSON.parse(fake.store.get(WORKER_META_KEY)).hazardSourceState, 'ok');
    assert.ok(fake.store.get(stateKey(SUB))['occ:eq:us6000u2mq'], 'the delivered tombstone is stored');

    await tick(fake, deliver, NOW + 10 * MIN);
    assert.equal(sent.length, 1, 'a seen id never fires again');
  });

  it('the first tick marks both feeds initialized with no TTL; with the seen set lost afterwards, the next quake is still delivered', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    assert.deepEqual(Object.keys(fake.store.get(HAZARD_INIT_KEY)).sort(), ['eq', 'nat']);
    assert.equal(fake.store.get(HAZARD_INIT_KEY).eq, String(NOW));
    assert.equal(fake.ttl.has(HAZARD_INIT_KEY), false, 'the marker never expires');
    fake.store.delete(SEEN);
    setFeed(fake, { earthquakes: [quake()] });
    await tick(fake, deliver, NOW + 5 * MIN);
    assert.deepEqual(sent.map((s) => s.payload.eventId).sort(), ['eq:us6000u2mq', 'nat:EONET_1'],
      'the trade the marker makes: a lost seen set re-delivers what is still inside its new window, once, rather than swallow the next real event');
    assert.equal(fake.store.get(HAZARD_INIT_KEY).eq, String(NOW), 'HSETNX keeps the first-read time');
  });

  it('a failed delivery is retried next tick under the same id from the stored payload, though the id is now seen', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub([{ ok: false, status: 502, error: 'http_502' }]);
    await tick(fake, deliver);
    setFeed(fake, { earthquakes: [quake({ id: 'us6000base', occurredAt: NOW - 3 * HOUR }), quake()] });
    const failed = await tick(fake, deliver, NOW + 5 * MIN);
    assert.equal(failed.failures, 1);
    const retried = await tick(fake, deliver, NOW + 10 * MIN);
    assert.equal(retried.deliveries, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].deliveryId, sent[0].deliveryId);
    assert.deepEqual(sent[1].payload, sent[0].payload);
  });

  it('scope applies: a quake below the subscription floor and one outside its countries are not delivered', async () => {
    const fake = seeded({ scope: { minMagnitude: 6, countries: ['JP'] } });
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    setFeed(fake, { earthquakes: [
      quake({ id: 'us6000base', occurredAt: NOW - 3 * HOUR }),
      quake({ id: 'us6000smal', magnitude: 5.9, place: '20 km E of Iwaki, Japan', location: { latitude: 37, longitude: 141.1 } }),
      quake({ id: 'us6000rus1' }),
      quake({ id: 'us6000jpn1', magnitude: 6.2, place: '20 km E of Iwaki, Japan', location: { latitude: 37, longitude: 141.1 }, occurredAt: NOW - 30 * MIN }),
    ] });
    await tick(fake, deliver, NOW + 5 * MIN);
    assert.deepEqual(sent.map((s) => s.payload.eventId), ['eq:us6000jpn1']);
    assert.deepEqual(sent[0].payload.countryCodes, ['JP']);
  });

  it('with both hazard keys missing, hazard records are untouched and a chokepoint record still delivers', async () => {
    const cp = { subscriberId: 'wh_cccccccccccccccccccccccc', ownerTag: 'o', callbackUrl: 'https://hooks.example.com/cp', chokepointIds: ['suez'], alertThreshold: 50, createdAt: '2026-10-01T00:00:00.000Z', active: true, secret: 'b'.repeat(64) };
    const fake = seeded({ earthquakes: null, naturalEvents: null, extra: [cp], chokepoints: [{ id: 'suez', name: 'Suez', disruptionScore: 75, warRiskTier: 'WAR_RISK_TIER_NORMAL', navigationalWarningsAvailable: true }] });
    const { sent, deliver } = deliverStub();
    const summary = await tick(fake, deliver);
    assert.equal(summary.hazardSourceState, 'error');
    assert.deepEqual(sent.map((s) => s.event), ['chokepoint.disruption']);
    assert.equal(fake.store.has(stateKey(SUB)), false);
    assert.equal(fake.store.has(SEEN), false, 'nothing is marked seen when nothing was read');
  });

  it('one missing key is partial: the readable feed is diffed and its ids alone are refreshed', async () => {
    const fake = seeded({ naturalEvents: null });
    const { deliver } = deliverStub();
    const summary = await tick(fake, deliver);
    assert.equal(summary.hazardSourceState, 'partial');
    assert.deepEqual([...fake.store.get(SEEN).keys()].map((m) => m.split('|')[0]), ['eq:us6000base']);
  });

  it('an id gone from both feeds for the seen window is pruned; one still in a feed is kept by its refreshed score', async () => {
    const fake = seeded();
    const { deliver } = deliverStub();
    await tick(fake, deliver);
    fake.store.get(SEEN).set('nat:EONET_gone', NOW - HAZARD_RULE.seenWindowMs - HOUR);
    await tick(fake, deliver, NOW + MIN);
    const members = [...fake.store.get(SEEN).keys()];
    assert.equal(members.includes('nat:EONET_gone'), false);
    assert.equal(fake.store.get(SEEN).get(members.find((m) => m.startsWith('eq:us6000base'))), NOW + MIN);
  });

  it('a lost lock leaves the hazard seen set unwritten, so the next tick re-diffs the same rows', async () => {
    const fake = seeded();
    const { deliver: ok } = deliverStub();
    await tick(fake, ok);
    setFeed(fake, { earthquakes: [quake({ id: 'us6000base', occurredAt: NOW - 3 * HOUR }), quake()] });
    const deliver = async () => {
      fake.store.set(LOCK_KEY, 'someone-else');
      return { ok: true, status: 200 };
    };
    await assert.rejects(tick(fake, deliver, NOW + 5 * MIN), /lock lost/);
    assert.equal([...fake.store.get(SEEN).keys()].some((m) => m.startsWith('eq:us6000u2mq')), false);
  });
});
