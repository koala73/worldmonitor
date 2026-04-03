import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpenAqHeaders,
  buildMirrorWriteCommands,
  buildAirQualityPayload,
  buildOpenAqStations,
  buildWaqiStations,
  CLIMATE_AIR_QUALITY_KEY,
  CLIMATE_META_KEY,
  classifyRiskLevel,
  computeUsAqiFromPm25,
  HEALTH_AIR_QUALITY_KEY,
  OPENAQ_META_KEY,
  mergeAirQualityStations,
} from '../scripts/seed-health-air-quality.mjs';

describe('air quality AQI helpers', () => {
  it('maps PM2.5 concentrations onto EPA AQI breakpoints', () => {
    assert.equal(computeUsAqiFromPm25(12.0), 50);
    assert.equal(computeUsAqiFromPm25(35.4), 100);
    assert.equal(computeUsAqiFromPm25(55.4), 150);
    assert.equal(computeUsAqiFromPm25(250.5), 301);
  });

  it('collapses AQI values into the requested risk buckets', () => {
    assert.equal(classifyRiskLevel(25), 'good');
    assert.equal(classifyRiskLevel(90), 'moderate');
    assert.equal(classifyRiskLevel(220), 'unhealthy');
    assert.equal(classifyRiskLevel(350), 'hazardous');
  });

  it('requires an OpenAQ API key when building request headers', () => {
    assert.throws(() => buildOpenAqHeaders(''), /OPENAQ_API_KEY/);
    assert.deepEqual(buildOpenAqHeaders('test-key'), {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'X-API-Key': 'test-key',
    });
  });
});

describe('air quality payload assembly', () => {
  it('filters stale measurements and keeps the freshest reading per location', () => {
    const nowMs = Date.UTC(2026, 3, 3, 12, 0, 0);
    const stations = buildOpenAqStations(
      [
        {
          id: 101,
          locality: 'Delhi',
          country: { code: 'IN' },
          coordinates: { latitude: 28.61, longitude: 77.21 },
        },
        {
          id: 202,
          locality: 'Paris',
          country: { code: 'FR' },
          coordinates: { latitude: 48.85, longitude: 2.35 },
        },
      ],
      [
        {
          locationsId: 101,
          value: 82.4,
          datetime: { utc: new Date(nowMs - (10 * 60 * 1000)).toISOString() },
          coordinates: { latitude: 28.61, longitude: 77.21 },
          parameter: { name: 'pm25' },
        },
        {
          locationsId: 101,
          value: 45.2,
          datetime: { utc: new Date(nowMs - (40 * 60 * 1000)).toISOString() },
          coordinates: { latitude: 28.61, longitude: 77.21 },
          parameter: { name: 'pm25' },
        },
        {
          locationsId: 202,
          value: 18.7,
          datetime: { utc: new Date(nowMs - (3 * 60 * 60 * 1000)).toISOString() },
          coordinates: { latitude: 48.85, longitude: 2.35 },
          parameter: { name: 'pm25' },
        },
      ],
      nowMs,
    );

    assert.equal(stations.length, 1);
    assert.equal(stations[0].city, 'Delhi');
    assert.equal(stations[0].countryCode, 'IN');
    assert.equal(stations[0].aqi, computeUsAqiFromPm25(82.4));
    assert.equal(stations[0].riskLevel, 'unhealthy');
  });

  it('parses WAQI entries when PM2.5 and timestamps are present', () => {
    const nowMs = Date.UTC(2026, 3, 3, 12, 0, 0);
    const stations = buildWaqiStations(
      [
        {
          lat: 25.2,
          lon: 55.27,
          aqi: '180',
          dominentpol: 'pm25',
          iaqi: { pm25: { v: 74.1 } },
          station: {
            name: 'Dubai, AE',
            time: new Date(nowMs - (20 * 60 * 1000)).toISOString(),
          },
        },
      ],
      nowMs,
    );

    assert.equal(stations.length, 1);
    assert.equal(stations[0].city, 'Dubai');
    assert.equal(stations[0].countryCode, 'AE');
    assert.equal(stations[0].source, 'WAQI');
  });

  it('merges OpenAQ and WAQI stations without duplicating identical locations', () => {
    const openAqStations = [
      { city: 'Paris', countryCode: 'FR', lat: 48.8566, lng: 2.3522, pm25: 18, aqi: 64, riskLevel: 'moderate', pollutant: 'pm25', measuredAt: 1000, source: 'OpenAQ' },
    ];
    const waqiStations = [
      { city: 'Paris', countryCode: 'FR', lat: 48.8571, lng: 2.3519, pm25: 20, aqi: 68, riskLevel: 'moderate', pollutant: 'pm25', measuredAt: 1100, source: 'WAQI' },
      { city: 'Dubai', countryCode: 'AE', lat: 25.2048, lng: 55.2708, pm25: 50, aqi: 137, riskLevel: 'unhealthy', pollutant: 'pm25', measuredAt: 1200, source: 'WAQI' },
    ];

    const merged = mergeAirQualityStations(openAqStations, waqiStations);

    assert.equal(merged.length, 2);
    assert.equal(merged[0].city, 'Dubai');
  });

  it('builds the final payload with fetchedAt and sorted stations', () => {
    const nowMs = Date.UTC(2026, 3, 3, 12, 0, 0);
    const payload = buildAirQualityPayload({
      locations: [
        {
          id: 11,
          locality: 'Lahore',
          country: { code: 'PK' },
          coordinates: { latitude: 31.52, longitude: 74.36 },
        },
      ],
      latestMeasurements: [
        {
          locationsId: 11,
          value: 145.6,
          datetime: { utc: new Date(nowMs - (15 * 60 * 1000)).toISOString() },
          coordinates: { latitude: 31.52, longitude: 74.36 },
          parameter: { name: 'pm25' },
        },
      ],
      waqiStations: [],
      nowMs,
    });

    assert.equal(payload.fetchedAt, nowMs);
    assert.equal(payload.stations.length, 1);
    assert.equal(payload.stations[0].city, 'Lahore');
    assert.equal(payload.stations[0].country_code, 'PK');
    assert.equal(payload.stations[0].risk_level, 'unhealthy');
    assert.equal(typeof payload.stations[0].measured_at, 'number');
    assert.equal('riskLevel' in payload.stations[0], false);
  });

  it('normalizes legacy raw waqiEntries before merging them into the payload', () => {
    const nowMs = Date.UTC(2026, 3, 3, 12, 0, 0);
    const payload = buildAirQualityPayload({
      locations: [],
      latestMeasurements: [],
      waqiEntries: [
        {
          lat: 25.2,
          lon: 55.27,
          aqi: '180',
          dominentpol: 'pm25',
          iaqi: { pm25: { v: 74.1 } },
          station: {
            name: 'Dubai, AE',
            time: new Date(nowMs - (20 * 60 * 1000)).toISOString(),
          },
        },
      ],
      nowMs,
    });

    assert.equal(payload.fetchedAt, nowMs);
    assert.equal(payload.stations.length, 1);
    assert.equal(payload.stations[0].city, 'Dubai');
    assert.equal(payload.stations[0].country_code, 'AE');
    assert.equal(payload.stations[0].risk_level, 'unhealthy');
    assert.equal(typeof payload.stations[0].measured_at, 'number');
    assert.equal('riskLevel' in payload.stations[0], false);
  });

  it('builds one Redis pipeline containing both mirrored keys and both seed-meta keys', () => {
    const payload = {
      stations: [
        {
          city: 'Delhi',
          country_code: 'IN',
          lat: 28.61,
          lng: 77.21,
          pm25: 80.4,
          aqi: 164,
          risk_level: 'unhealthy',
          pollutant: 'pm25',
          measured_at: 123,
          source: 'OpenAQ',
        },
      ],
      fetchedAt: 456,
    };

    const commands = buildMirrorWriteCommands(payload, 3600, 789, 'source-v1');

    assert.equal(commands.length, 4);
    assert.deepEqual(commands.map((command) => command[1]), [
      HEALTH_AIR_QUALITY_KEY,
      CLIMATE_AIR_QUALITY_KEY,
      OPENAQ_META_KEY,
      CLIMATE_META_KEY,
    ]);
    assert.equal(commands[0][4], '3600');
    assert.equal(commands[1][4], '3600');
    assert.match(String(commands[2][2]), /"recordCount":1/);
    assert.match(String(commands[3][2]), /"sourceVersion":"source-v1"/);
  });
});
