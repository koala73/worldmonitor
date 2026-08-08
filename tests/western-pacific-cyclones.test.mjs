import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import {
  buildWesternPacificCycloneSnapshot,
  canonicalizeWesternPacificCyclones,
  fetchApprovedJson,
  parseHkoWarningSummary,
} from '../scripts/natural/western-pacific-cyclones.mjs';

const fixture = (name) => JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/natural', name), 'utf8'));
const NOW = Date.parse('2026-07-13T12:00:00.000Z');

function storm(overrides = {}) {
  return {
    agency: 'JMA',
    agencyId: '2605',
    basin: 'WP',
    season: 2026,
    aliases: ['Nari'],
    stormName: 'Nari',
    lat: 19.8,
    lon: 128.6,
    observedAt: NOW,
    windKt: 55,
    windAveragingPeriodMinutes: 10,
    sourceUrl: 'https://www.jma.go.jp/',
    sourceName: 'JMA',
    ...overrides,
  };
}

describe('western Pacific cyclone identity', () => {
  it('uses the JMA agency identifier as canonical identity while preserving separate wind periods', () => {
    const [cyclone] = canonicalizeWesternPacificCyclones([
      storm(),
      storm({
        agency: 'JTWC', agencyId: '05W', aliases: ['Nari'], lat: 19.9, lon: 128.5,
        windKt: 65, windAveragingPeriodMinutes: 1, sourceName: 'JTWC',
        sourceUrl: 'https://www.metoc.navy.mil/',
      }),
    ]);

    assert.equal(cyclone.canonicalId, 'wp:2026:jma:2605');
    assert.equal(cyclone.matchingConfidence, 'alias-bounded');
    assert.equal(cyclone.windKt, 55);
    assert.equal(cyclone.windAveragingPeriodMinutes, 10);
    assert.deepEqual(
      cyclone.agencyObservations.map(({ agency, agencyId, windKt, windAveragingPeriodMinutes }) => ({ agency, agencyId, windKt, windAveragingPeriodMinutes })),
      [
        { agency: 'JMA', agencyId: '2605', windKt: 55, windAveragingPeriodMinutes: 10 },
        { agency: 'JTWC', agencyId: '05W', windKt: 65, windAveragingPeriodMinutes: 1 },
      ],
    );
  });

  it('uses the first reported wind and its matching averaging period when the primary agency omits wind', () => {
    const [cyclone] = canonicalizeWesternPacificCyclones([
      storm({ windKt: null, windAveragingPeriodMinutes: 10 }),
      storm({
        agency: 'JTWC', agencyId: '05W', aliases: ['Nari'], lat: 19.9, lon: 128.5,
        windKt: 65, windAveragingPeriodMinutes: 1, sourceName: 'JTWC',
        sourceUrl: 'https://www.metoc.navy.mil/',
      }),
    ]);

    assert.equal(cyclone.sourceName, 'JMA', 'the higher-priority agency remains the canonical source');
    assert.equal(cyclone.windKt, 65);
    assert.equal(cyclone.windAveragingPeriodMinutes, 1);
  });

  it('rejects missing or non-numeric coordinates instead of coercing them to zero', () => {
    assert.deepEqual(canonicalizeWesternPacificCyclones([storm({ lat: null })]), []);
    assert.deepEqual(canonicalizeWesternPacificCyclones([storm({ lon: false })]), []);
    assert.deepEqual(canonicalizeWesternPacificCyclones([storm({ lat: '' })]), []);
    assert.deepEqual(canonicalizeWesternPacificCyclones([storm({ lon: '  ' })]), []);
  });

  it('keeps wind null without crashing when no observation reports wind', () => {
    const [cyclone] = canonicalizeWesternPacificCyclones([
      storm({ windKt: null, windAveragingPeriodMinutes: null }),
    ]);

    assert.equal(cyclone.windKt, null);
    assert.equal(cyclone.windAveragingPeriodMinutes, undefined);
  });

  it('never takes wind from a cancelled observation while an active one exists', () => {
    const [cyclone] = canonicalizeWesternPacificCyclones([
      storm({ windKt: null, windAveragingPeriodMinutes: null }),
      storm({
        agency: 'JTWC', agencyId: '05W', aliases: ['Nari'], lat: 19.9, lon: 128.5,
        windKt: 65, windAveragingPeriodMinutes: 1, sourceName: 'JTWC',
        sourceUrl: 'https://www.metoc.navy.mil/', status: 'cancelled',
      }),
    ]);

    assert.equal(cyclone.sourceName, 'JMA');
    assert.equal(cyclone.windKt, null, 'a cancelled advisory must not supply the canonical wind');
    assert.equal(cyclone.windAveragingPeriodMinutes, undefined);
  });

  it('does not merge concurrent nearby storms with distinct aliases', () => {
    const cyclones = canonicalizeWesternPacificCyclones([
      storm({ agencyId: '2605', aliases: ['Nari'], stormName: 'Nari' }),
      storm({ agency: 'JTWC', agencyId: '06W', aliases: ['Wutip'], stormName: 'Wutip', lat: 20.1, lon: 128.9 }),
    ]);

    assert.equal(cyclones.length, 2);
  });

  it('replaces a cancelled observation only for its own agency identifier', () => {
    const [cyclone] = canonicalizeWesternPacificCyclones([
      storm({ agency: 'HKO', agencyId: 'WTCSGNL', aliases: ['Nari'], sourceName: 'HKO', status: 'active' }),
      storm({ agency: 'HKO', agencyId: 'WTCSGNL', aliases: ['Nari'], sourceName: 'HKO', status: 'cancelled', observedAt: NOW + 60_000 }),
      storm({ agency: 'JTWC', agencyId: '05W', aliases: ['Nari'], sourceName: 'JTWC', windAveragingPeriodMinutes: 1 }),
    ]);

    assert.equal(cyclone.agencyObservations.length, 2);
    assert.equal(cyclone.agencyObservations.find((item) => item.agency === 'HKO')?.status, 'cancelled');
    assert.equal(cyclone.agencyObservations.find((item) => item.agency === 'JTWC')?.status, 'active');
  });
});

describe('HKO warning adapter', () => {
  it('keeps a local tropical-cyclone warning useful even when no named storm is active', () => {
    const warnings = parseHkoWarningSummary(fixture('hko-warnsum-tropical-cyclone.json'), { now: NOW });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].stormName, undefined);
    assert.equal(warnings[0].agency, 'HKO');
    assert.equal(warnings[0].status, 'active');

    const snapshot = buildWesternPacificCycloneSnapshot({ storms: [], hkoWarnings: warnings, now: NOW });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].sourceName, 'HKO');
    assert.match(snapshot.events[0].title, /Hong Kong Tropical Cyclone Warning Signal/);
  });

  it('keeps HKO coverage when JMA is blocked and records the blocked preflight decision', () => {
    const warnings = parseHkoWarningSummary(fixture('hko-warnsum-tropical-cyclone.json'), { now: NOW });
    const snapshot = buildWesternPacificCycloneSnapshot({ storms: [], hkoWarnings: warnings, now: NOW });

    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(
      snapshot.sourceDecisions.find((entry) => entry.source === 'JMA RSMC Tokyo')?.status,
      'blocked',
    );
  });

  it('publishes an HKO cancellation as that warning\'s latest observation', () => {
    const warnings = parseHkoWarningSummary({
      WTCSGNL: {
        ...fixture('hko-warnsum-tropical-cyclone.json').WTCSGNL,
        actionCode: 'CANCEL',
        updateTime: '2026-07-13T11:00:00+08:00',
      },
    }, { now: NOW });

    assert.equal(warnings[0].agencyId, 'WTCSGNL');
    assert.equal(warnings[0].status, 'cancelled');
    assert.equal(
      buildWesternPacificCycloneSnapshot({ storms: [], hkoWarnings: warnings, now: NOW }).events[0].closed,
      true,
    );
  });
});

describe('approved source transport', () => {
  it('pins the HKO host, rejects redirects, and caps response bytes', async () => {
    await assert.rejects(
      fetchApprovedJson('https://example.test/not-hko', { allowedHosts: ['data.weather.gov.hk'] }),
      /UNTRUSTED_SOURCE_HOST/,
    );

    let init;
    const payload = await fetchApprovedJson('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en', {
      allowedHosts: ['data.weather.gov.hk'],
      maxBytes: 100,
      fetchFn: async (_url, options) => {
        init = options;
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(init.redirect, 'error');
    assert.deepEqual(payload, { ok: true });

    await assert.rejects(
      fetchApprovedJson('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en', {
        allowedHosts: ['data.weather.gov.hk'], maxBytes: 10,
        fetchFn: async () => new Response('{"this":"payload is too large"}'),
      }),
      /RESPONSE_TOO_LARGE/,
    );
  });
});
