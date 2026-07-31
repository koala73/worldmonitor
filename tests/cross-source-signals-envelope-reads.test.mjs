// Regression test for issue #5870: seed-cross-source-signals read its source
// keys with a bare JSON.parse and no envelope unwrap.
//
// Most of those keys are written by contract-mode seeders, which store
// `{ _seed, data }` (scripts/_seed-utils.mjs:499). So `d['<key>']` was the
// envelope, every extractor's `payload.<field>` was undefined, and the signal
// silently never fired — the seeder still exited 0 and published, just with
// fewer signals than it should. Same failure shape as the one
// tests/regional-snapshot-envelope-unwrap.test.mjs pins one layer down.
//
// The existing suites could not catch this: their vm harness deleted
// readAllSourceKeys and fed extractors hand-built bare fixtures, i.e. the
// pre-envelope world, at exactly the seam where the defect lives.
//
// Every fixture below is annotated with the writer file:line it was derived
// from. Enveloped fixtures additionally assert that the pre-fix shape (the raw
// envelope handed straight to the extractor) produces nothing, so the bug
// itself stays pinned and cannot be reintroduced silently.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACTORS,
  SOURCE_KEYS,
  extractCommodityShock,
  extractCyberEscalation,
  extractDisplacementSurge,
  extractEarthquakeSignificant,
  extractForecastDeterioration,
  extractGpsJamming,
  extractInfrastructureOutage,
  extractMarketStress,
  extractMediaToneDeterioration,
  extractMilitaryFlightSurge,
  extractOrefAlertCluster,
  extractRadiationAnomaly,
  extractRegulatoryAction,
  extractRiskScoreSpike,
  extractSanctionsSurge,
  extractShippingDisruption,
  extractThermalSpike,
  extractUnrestSurge,
  extractVixSpike,
  extractWeatherExtreme,
  extractWildfireEscalation,
  normalizeTheater,
  readAllSourceKeys,
} from '../scripts/seed-cross-source-signals.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from '../scripts/_cii-risk-cache-keys.mjs';
import { unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';

const REDIS_URL = 'https://cross-source-signals.test.upstash.io';
const HOUR = 3600 * 1000;
const now = Date.now();
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString();

function seedEnvelope(data, fetchedAt = now) {
  return {
    _seed: {
      fetchedAt,
      sourceVersion: 'test-v1',
      schemaVersion: 1,
      recordCount: 1,
    },
    data,
  };
}

// Drive a value through exactly what readAllSourceKeys does to a Redis string,
// so a fixture can never accidentally exercise a shape the reader cannot
// produce.
function asReadByTheSeeder(storedValue) {
  return unwrapEnvelope(JSON.parse(JSON.stringify(storedValue))).data;
}

describe('readAllSourceKeys envelope handling', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  // Stub the Upstash pipeline: `byKey` maps a source key to the raw string
  // Redis would return; anything unlisted comes back as a null result.
  function stubPipeline(byKey) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => SOURCE_KEYS.map((key) => ({ result: byKey[key] ?? null })),
    });
  }

  it('unwraps a contract-mode envelope down to its payload', async () => {
    const payload = { earthquakes: [{ id: 'us1', magnitude: 7.1 }] };
    stubPipeline({ 'seismology:earthquakes:v1': JSON.stringify(seedEnvelope(payload)) });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['seismology:earthquakes:v1'], payload);
  });

  it('passes a legacy bare payload through unchanged', async () => {
    const payload = { hexes: [{ region: 'Eastern Europe', level: 'high' }], fetchedAt: 1_700_000_000_000 };
    stubPipeline({ 'intelligence:gpsjam:v2': JSON.stringify(payload) });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['intelligence:gpsjam:v2'], payload);
  });

  // gdelt:intel:tone:* is the one live payload shaped like half an envelope: a
  // top-level `data` array plus a `fetchedAt`, but no `_seed`. unwrapEnvelope
  // only unwraps when `_seed.fetchedAt` is a number, so it must pass through —
  // unwrapping it would hand the tone extractor a bare array and kill the one
  // signal path that works today.
  it('does not unwrap a legacy payload that has its own top-level data field', async () => {
    const tone = { data: [{ date: '2026-07-20', value: -2.4 }], fetchedAt: iso() };
    stubPipeline({ 'gdelt:intel:tone:military': JSON.stringify(tone) });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['gdelt:intel:tone:military'], tone);
  });

  it('skips malformed JSON instead of registering the raw string as a found key', async () => {
    stubPipeline({ 'unrest:events:v1': '{"events":[' });

    const data = await readAllSourceKeys();
    assert.equal('unrest:events:v1' in data, false);
  });

  it('skips an envelope whose payload is null', async () => {
    stubPipeline({ 'infra:outages:v1': JSON.stringify(seedEnvelope(null)) });

    const data = await readAllSourceKeys();
    assert.equal('infra:outages:v1' in data, false);
  });

  it('skips a preserved contract envelope after its source freshness budget', async () => {
    const staleFetchedAt = now - 31 * 60_000;
    stubPipeline({
      'seismology:earthquakes:v1': JSON.stringify(seedEnvelope({
        earthquakes: [{ id: 'stale-us1', magnitude: 7.1, occurredAt: now - HOUR }],
      }, staleFetchedAt)),
    });

    const data = await readAllSourceKeys();
    assert.equal('seismology:earthquakes:v1' in data, false);
  });

  it('keeps recent OREF waves when the quiet-history envelope is older than 15 minutes', async () => {
    const payload = {
      history: [{ timestamp: iso(HOUR), alerts: [{ data: ['Tel Aviv'] }] }],
    };
    stubPipeline({
      'relay:oref:history:v1': JSON.stringify(seedEnvelope(payload, now - 2 * HOUR)),
    });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['relay:oref:history:v1'], payload);
  });

  it('returns no keys when every pipeline slot is empty', async () => {
    stubPipeline({});

    const data = await readAllSourceKeys();
    assert.deepEqual(Object.keys(data), []);
  });

  it('fetches the geospatial military surge key instead of inferring theater from operator nationality', () => {
    assert.ok(SOURCE_KEYS.includes('military:surges:stale:v1'));
    assert.equal(SOURCE_KEYS.includes('military:flights:stale:v1'), false);
  });
});

// ── Per-extractor fixture matrix ─────────────────────────────────────────────
// `enveloped` mirrors how the writer actually stores the key: true when its
// seeder passes declareRecords to runSeed (contract mode, _seed-utils.mjs:1758),
// false for the keys still written with a raw SET.

const FIXTURES = [
  {
    extractor: extractThermalSpike,
    expectTheater: 'Eastern Europe',
    expectDetectedAt: (p) => Date.parse(p.clusters[0].lastDetectedAt),
    key: 'thermal:escalation:v1',
    enveloped: true, // seed-thermal-escalation.mjs:53 declareRecords
    // Cluster shape: scripts/lib/thermal-escalation.mjs:308.
    payload: {
      clusters: [{
        id: 'ua:cell-49-36:2026073012',
        countryCode: 'UA',
        countryName: 'Ukraine',
        regionLabel: 'Ukraine',
        status: 'THERMAL_STATUS_SPIKE',
        zScore: 3.1,
        totalFrp: 210.4,
        firstDetectedAt: iso(6 * HOUR),
        lastDetectedAt: iso(2 * HOUR),
      }],
    },
  },
  {
    extractor: extractGpsJamming,
    expectTheater: 'Eastern Europe',
    expectDetectedAt: (p) => Date.parse(p.fetchedAt),
    key: 'intelligence:gpsjam:v2',
    enveloped: false, // fetch-gpsjam.mjs writes with a raw SET
    // Hex shape: scripts/_gpsjam-parse.mjs:83.
    payload: {
      hexes: [{ level: 'high', region: 'Eastern Europe', pct: 24.5, npAvg: 0.3 }],
      fetchedAt: iso(HOUR),
    },
  },
  {
    extractor: extractMilitaryFlightSurge,
    expectTheater: 'East Asia',
    expectDetectedAt: (p) => p.surges[0].assessedAt,
    key: 'military:surges:stale:v1',
    enveloped: false, // seed-military-flights.mjs:1388 raw redisSet
    // Surge shape: scripts/_military-surges.mjs:124.
    payload: {
      surges: [{
        id: 'fighter-taiwan-theater',
        theaterId: 'taiwan-theater',
        surgeType: 'fighter',
        currentCount: 8,
        baselineCount: 3,
        surgeMultiple: 2.7,
        postureLevel: 'elevated',
        strikeCapable: true,
        assessedAt: now,
      }],
      fetchedAt: now,
    },
  },
  {
    extractor: extractUnrestSurge,
    expectTheater: 'Middle East',
    key: 'unrest:events:v1',
    enveloped: true, // seed-unrest-events.mjs:525 declareRecords
    // Event shape: scripts/seed-unrest-events.mjs:211.
    payload: {
      events: ['Beirut', 'Mount Lebanon', 'North'].map((region, i) => ({
        id: `acled-${i}`,
        city: 'Beirut',
        country: 'Lebanon',
        region,
        location: { latitude: 33.88, longitude: 35.49 },
        occurredAt: now - (i + 1) * HOUR,
      })),
    },
  },
  {
    extractor: extractOrefAlertCluster,
    expectTheater: 'Middle East',
    expectDetectedAt: (p) => Date.parse(p.history[0].timestamp),
    key: 'relay:oref:history:v1',
    enveloped: true, // ais-relay.cjs:1401 envelopeWrite
    // OREF history shape: scripts/ais-relay.cjs:1352.
    payload: {
      history: [{
        timestamp: iso(3 * HOUR),
        alerts: [{
          id: '1-0-20260730120000',
          cat: '1',
          title: 'Missiles',
          data: ['Tel Aviv', 'Ramat Gan'],
        }],
      }],
      historyCount24h: 2,
      totalHistoryCount: 2,
      activeAlertCount: 0,
      persistedAt: iso(),
    },
  },
  {
    extractor: extractVixSpike,
    expectTheater: 'Global Markets',
    key: 'market:stocks-bootstrap:v1',
    enveloped: true, // seed-market-quotes.mjs:121 declareRecords
    // Quote shape: scripts/seed-market-quotes.mjs:64.
    payload: { quotes: [{ symbol: '^VIX', display: 'VIX', price: 32.4, change: 4.1 }] },
  },
  {
    extractor: extractCommodityShock,
    expectTheater: 'Persian Gulf',
    key: 'market:commodities-bootstrap:v1',
    enveloped: true, // seed-commodity-quotes.mjs:230 declareRecords
    payload: { quotes: [{ symbol: 'CL=F', display: 'Crude Oil', price: 91.2, change: 7.4 }] },
  },
  {
    extractor: extractCyberEscalation,
    expectTheater: 'Global',
    expectDetectedAt: (p) => p.threats[0].lastSeenAt,
    key: 'cyber:threats-bootstrap:v2',
    enveloped: true, // seed-cyber-threats.mjs:665 extraKeys + declareRecords
    // Threat shape: scripts/seed-cyber-threats.mjs:578 toProto.
    payload: {
      threats: [{
        id: 'otx-1',
        type: 'CYBER_THREAT_TYPE_APT',
        country: 'Ukraine',
        severity: 'CRITICALITY_LEVEL_CRITICAL',
        malwareFamily: 'Sandworm',
        firstSeenAt: now - 3 * HOUR,
        lastSeenAt: now - HOUR,
      }],
    },
  },
  {
    extractor: extractShippingDisruption,
    expectTheater: 'Global',
    key: 'supply_chain:shipping:v2',
    enveloped: true, // seed-supply-chain-trade.mjs:796 declareRecords
    // Index shape: scripts/seed-supply-chain-trade.mjs:129.
    payload: {
      indices: [{
        indexId: 'WCIDCOMP',
        name: 'Drewry World Container Index',
        currentValue: 3820,
        previousValue: 3100,
        changePct: 23.2,
        unit: 'USD/FEU',
        history: [],
        spikeAlert: true,
      }],
      fetchedAt: iso(),
      upstreamUnavailable: false,
    },
  },
  {
    extractor: extractSanctionsSurge,
    expectTheater: 'Eastern Europe',
    key: 'sanctions:pressure:v1',
    enveloped: true, // seed-sanctions-pressure.mjs:550 declareRecords
    payload: {
      totalCount: 412,
      newEntryCount: 12,
      countries: [{ countryName: 'Russia', count: 180 }],
    },
  },
  {
    extractor: extractEarthquakeSignificant,
    expectTheater: 'East Asia',
    expectDetectedAt: (p) => p.earthquakes[0].occurredAt,
    key: 'seismology:earthquakes:v1',
    enveloped: true, // seed-earthquakes.mjs:98 declareRecords
    // Quake shape: scripts/seed-earthquakes.mjs:79.
    payload: {
      earthquakes: [{
        id: 'us7000abcd',
        place: '120km E of Honshu, Japan',
        magnitude: 7.2,
        occurredAt: now - 4 * HOUR,
      }],
    },
  },
  {
    extractor: extractRadiationAnomaly,
    expectTheater: 'East Asia',
    expectDetectedAt: (p) => p.observations[0].observedAt,
    key: 'radiation:observations:v1',
    enveloped: true, // seed-radiation-watch.mjs:465 declareRecords
    // Observation shape: scripts/seed-radiation-watch.mjs:172.
    payload: {
      observations: [{
        id: 'jp-fukushima-1',
        anchorId: 'jp-fukushima',
        locationName: 'Fukushima',
        country: 'Japan',
        value: 48.2,
        unit: 'nSv/h',
        observedAt: now - 2 * HOUR,
        baselineValue: 30.1,
        delta: 18.1,
        zScore: 3.4,
        severity: 'RADIATION_SEVERITY_SPIKE',
      }],
    },
  },
  {
    extractor: extractInfrastructureOutage,
    expectTheater: 'Middle East',
    expectDetectedAt: (p) => p.outages[0].detectedAt,
    key: 'infra:outages:v1',
    enveloped: true, // seed-internet-outages.mjs:246 declareRecords
    // Outage shape: scripts/seed-internet-outages.mjs:111.
    payload: {
      outages: [{
        id: 'ioda-1',
        detectedAt: now - 90 * 60_000,
        country: 'Iran',
        region: '',
        severity: 'OUTAGE_SEVERITY_MAJOR',
        endedAt: 0,
      }],
    },
  },
  {
    extractor: extractWildfireEscalation,
    expectTheater: 'Eastern Europe',
    expectDetectedAt: (p) => p.fireDetections[0].detectedAt,
    key: 'wildfire:fires:v1',
    enveloped: true, // seed-fire-detections.mjs:121 declareRecords
    // Detection shape: scripts/seed-fire-detections.mjs:93. Five in one region
    // clears the per-theater floor.
    payload: {
      fireDetections: Array.from({ length: 5 }, (_, i) => ({
        id: `48.1-37.${i}-2026-07-30-0312`,
        location: { latitude: 48.1, longitude: 37.5 + i / 10 },
        brightness: 392.4,
        frp: 145.2,
        confidence: 'FIRE_CONFIDENCE_HIGH',
        satellite: 'N',
        detectedAt: now - 3 * HOUR,
        region: 'Ukraine',
        dayNight: 'D',
        possibleExplosion: true,
      })),
      pagination: undefined,
    },
  },
  {
    extractor: extractForecastDeterioration,
    expectTheater: 'Eastern Europe',
    key: 'forecast:predictions:v2',
    enveloped: true, // seed-forecasts.mjs:17260 declareRecords
    payload: {
      predictions: [{
        id: 'fc-1',
        title: 'Escalation along the Black Sea corridor',
        region: 'Eastern Europe',
        probability: 0.72,
        trend: 'rising',
      }],
    },
  },
  {
    extractor: extractMarketStress,
    expectTheater: 'Global Markets',
    key: 'market:stocks-bootstrap:v1',
    enveloped: true, // seed-market-quotes.mjs:121 declareRecords
    payload: { quotes: [{ symbol: '^GSPC', display: 'S&P 500', price: 5120, change: -3.4 }] },
  },
  {
    extractor: extractWeatherExtreme,
    expectTheater: 'North America',
    key: 'weather:alerts:v1',
    enveloped: true, // seed-weather-alerts.mjs:67 declareRecords
    // Alert shape: scripts/seed-weather-alerts.mjs:44.
    payload: {
      alerts: [{
        id: 'nws-1',
        event: 'Tornado Warning',
        severity: 'Extreme',
        areaDesc: 'Kern County, CA; Tulare County, CA',
      }],
    },
  },
  {
    extractor: extractMediaToneDeterioration,
    expectTheater: 'Global',
    key: 'gdelt:intel:tone:military',
    enveloped: false, // seed-gdelt-intel.mjs:613 writeExtraKey without envelopeMeta
    payload: {
      data: [
        { date: iso(72 * HOUR), value: -0.5 },
        { date: iso(36 * HOUR), value: -1.2 },
        { date: iso(HOUR), value: -2.4 },
      ],
      fetchedAt: iso(HOUR),
    },
  },
  {
    extractor: extractRiskScoreSpike,
    // 'UA' is an ISO2 code with no theater mapping — pinned so the known
    // limitation is visible rather than silently drifting.
    expectTheater: 'UA',
    key: CII_RISK_SCORE_CACHE_KEYS.stale,
    enveloped: false, // written by get-risk-scores.ts via setCachedJson, not a seeder
    payload: {
      ciiScores: [{ region: 'UA', combinedScore: 84.2, trend: 'TREND_DIRECTION_RISING' }],
      degraded: false,
      stale: true,
    },
  },
  {
    extractor: extractRegulatoryAction,
    expectTheater: 'Global Markets',
    expectDetectedAt: (p) => Date.parse(p.actions[0].publishedAt),
    key: 'regulatory:actions:v1',
    enveloped: false, // seed-regulatory-actions.mjs:311 runSeed without declareRecords
    payload: {
      actions: [{
        id: 'sec-1',
        agency: 'SEC',
        title: 'SEC Charges Issuer',
        publishedAt: iso(2 * HOUR),
        tier: 'high',
      }],
      recordCount: 1,
    },
  },
];

// extractDisplacementSurge is deliberately absent from FIXTURES: its key
// publishes an annual UNHCR stock with no flow field, so the extractor is
// documented-silent rather than fixed. It is pinned separately below.
const INTENTIONALLY_SILENT = new Set([extractDisplacementSurge]);

describe('every extractor fires on the shape its writer actually publishes', () => {
  for (const { extractor, key, enveloped, payload, expectTheater, expectDetectedAt } of FIXTURES) {
    it(`${extractor.name} fires on a ${enveloped ? 'contract-mode' : 'legacy bare'} ${key}`, () => {
      const stored = enveloped ? seedEnvelope(payload) : payload;
      const signals = extractor({ [key]: asReadByTheSeeder(stored) });
      assert.ok(signals.length >= 1, `${extractor.name} produced no signal`);
      assert.ok(signals.every((s) => Number.isFinite(s.severityScore) && s.severityScore > 0));
      assert.ok(signals.every((s) => Number.isFinite(s.detectedAt) && s.detectedAt > 0));

      // Pinned rather than "non-empty": a theater that quietly collapses to
      // 'Global' is how the military-flight signal sat outside every composite,
      // and only an exact assertion catches that.
      assert.equal(signals[0].theater, expectTheater);

      // Only asserted where the extractor sources its stamp from the payload.
      // Without this, reverting to a field the writer never published still
      // passes: detectedAt just falls back to the run clock.
      if (expectDetectedAt) {
        assert.equal(signals[0].detectedAt, expectDetectedAt(payload),
          `${extractor.name} did not carry the timestamp its payload published`);
      }
    });
  }

  // The bug itself, pinned: before the unwrap the extractors were handed the
  // envelope, and this is what that produced.
  for (const { extractor, key, enveloped, payload } of FIXTURES.filter((f) => f.enveloped)) {
    it(`${extractor.name} produces nothing from the raw envelope (the pre-fix shape)`, () => {
      void enveloped;
      assert.deepEqual(extractor({ [key]: seedEnvelope(payload) }), []);
    });
  }
});

describe('newly readable sources preserve semantics and time', () => {
  it('does not turn a high-probability ceasefire into forecast deterioration', () => {
    assert.deepEqual(extractForecastDeterioration({
      'forecast:predictions:v2': {
        predictions: [{
          id: 'ceasefire',
          title: 'Will the Sudan conflict reach a ceasefire by Q3?',
          region: 'Africa',
          probability: 0.85,
          trend: 'rising',
        }],
      },
    }), []);
  });

  it('still emits a high-probability failed ceasefire as deterioration', () => {
    const signals = extractForecastDeterioration({
      'forecast:predictions:v2': {
        predictions: [{
          id: 'ceasefire-failure',
          title: 'Will the Sudan ceasefire fail by Q3?',
          region: 'Africa',
          probability: 0.85,
          trend: 'rising',
        }],
      },
    });
    assert.equal(signals.length, 1);
  });

  it('does not invert renewed ceasefires or resumed peace talks', () => {
    for (const title of [
      'Will the ceasefire agreement be renewed?',
      'Will peace talks resume this quarter?',
    ]) {
      assert.deepEqual(extractForecastDeterioration({
        'forecast:predictions:v2': {
          predictions: [{ id: title, title, region: 'Africa', probability: 0.8 }],
        },
      }), []);
    }
  });

  it('does treat resumed hostilities as deterioration', () => {
    const signals = extractForecastDeterioration({
      'forecast:predictions:v2': {
        predictions: [{
          id: 'hostilities-resume',
          title: 'Will hostilities resume after the ceasefire?',
          region: 'Africa',
          probability: 0.8,
        }],
      },
    });
    assert.equal(signals.length, 1);
  });

  it('does not invert a forecast that renewed fighting will end', () => {
    assert.deepEqual(extractForecastDeterioration({
      'forecast:predictions:v2': {
        predictions: [{
          id: 'fighting-ends',
          title: 'Will renewed fighting end this month?',
          region: 'Africa',
          probability: 0.8,
        }],
      },
    }), []);
  });

  it('does not revive a week-old earthquake as a current critical signal', () => {
    assert.deepEqual(extractEarthquakeSignificant({
      'seismology:earthquakes:v1': {
        earthquakes: [{
          id: 'old-quake',
          place: 'Japan',
          magnitude: 7.2,
          occurredAt: now - 6 * 24 * HOUR,
        }],
      },
    }), []);
  });

  it('does not revive an outage that already ended', () => {
    assert.deepEqual(extractInfrastructureOutage({
      'infra:outages:v1': {
        outages: [{
          id: 'ended-outage',
          country: 'Iran',
          severity: 'OUTAGE_SEVERITY_TOTAL',
          detectedAt: now - 9 * 24 * HOUR,
          endedAt: now - 8 * 24 * HOUR,
        }],
      },
    }), []);
  });

  it('maps every military surge theater id to a composite-compatible theater', () => {
    const expected = {
      'iran-theater': 'Middle East',
      'taiwan-theater': 'East Asia',
      'baltic-theater': 'Eastern Europe',
      'blacksea-theater': 'Eastern Europe',
      'korea-theater': 'East Asia',
      'south-china-sea': 'East Asia',
      'east-med-theater': 'Middle East',
      'israel-gaza-theater': 'Middle East',
      'yemen-redsea-theater': 'Red Sea',
    };
    for (const [theaterId, theater] of Object.entries(expected)) {
      assert.equal(normalizeTheater(theaterId.replace(/-/g, ' ')), theater);
    }
  });

  it('ranks military surges before applying the three-signal cap', () => {
    const signals = extractMilitaryFlightSurge({
      'military:surges:stale:v1': {
        fetchedAt: now,
        surges: [
          { id: 'weak-1', theaterId: 'iran-theater', surgeType: 'fighter', surgeMultiple: 1.1, assessedAt: now },
          { id: 'weak-2', theaterId: 'taiwan-theater', surgeType: 'fighter', surgeMultiple: 1.2, assessedAt: now },
          { id: 'weak-3', theaterId: 'baltic-theater', surgeType: 'fighter', surgeMultiple: 1.3, assessedAt: now },
          { id: 'strong', theaterId: 'yemen-redsea-theater', surgeType: 'fighter', surgeMultiple: 2.0, assessedAt: now },
        ],
      },
    });
    assert.equal(signals.length, 3);
    assert.equal(signals[0].id, 'mil-surge:strong');
  });

  it('does not revive old wildfire or cyber records with the run clock', () => {
    const old = now - 20 * 24 * HOUR;
    assert.deepEqual(extractWildfireEscalation({
      'wildfire:fires:v1': {
        fireDetections: Array.from({ length: 5 }, (_, i) => ({
          id: `old-fire-${i}`,
          region: 'Ukraine',
          possibleExplosion: true,
          detectedAt: old,
        })),
      },
    }), []);
    assert.deepEqual(extractCyberEscalation({
      'cyber:threats-bootstrap:v2': {
        threats: [{
          id: 'old-ioc',
          country: 'Ukraine',
          severity: 'CRITICALITY_LEVEL_CRITICAL',
          firstSeenAt: old,
          lastSeenAt: old,
        }],
      },
    }), []);
  });

  it('does not treat travel advisories as kinetic OREF alerts', () => {
    assert.deepEqual(extractOrefAlertCluster({
      'intelligence:advisories-bootstrap:v1': {
        advisories: [{ country: 'Syria', level: 'do-not-travel' }],
      },
    }), []);
  });
});

describe('extractor registry stays covered', () => {
  it('every registered extractor has a fixture or a documented reason not to', () => {
    const covered = new Set([...FIXTURES.map((f) => f.extractor), ...INTENTIONALLY_SILENT]);
    const uncovered = EXTRACTORS.filter((e) => !covered.has(e)).map((e) => e.name);
    assert.deepEqual(uncovered, []);
  });

  it('every fixture key is registered in SOURCE_KEYS', () => {
    const unregistered = FIXTURES.map((f) => f.key).filter((key) => !SOURCE_KEYS.includes(key));
    assert.deepEqual(unregistered, []);
  });

  it('the media-tone fallback key is gone now that the fallback is gone', () => {
    assert.equal(SOURCE_KEYS.includes('intelligence:gdelt-intel:v1'), false);
  });
});

describe('extractDisplacementSurge is intentionally silent', () => {
  // displacement:summary:v1:<year> publishes summary.countries[] — an annual
  // UNHCR stock with no flow, delta or trend field (seed-displacement-summary.mjs:175).
  // A surge is not derivable from it, so the extractor stays silent rather than
  // firing off an invented totalDisplaced threshold. See #5870.
  it('emits nothing for a realistic annual stock payload', () => {
    const payload = {
      summary: {
        year: 2026,
        globalTotals: { refugees: 43_000_000, asylumSeekers: 6_900_000, idps: 68_000_000, stateless: 4_400_000, total: 122_300_000 },
        countries: [{ code: 'SYR', name: 'Syria', refugees: 6_400_000, idps: 7_200_000, totalDisplaced: 13_600_000 }],
        topFlows: [],
      },
    };
    assert.deepEqual(extractDisplacementSurge({
      [`displacement:summary:v1:${new Date().getFullYear()}`]: asReadByTheSeeder(seedEnvelope(payload)),
    }), []);
  });
});
