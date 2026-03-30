import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReliefWebRequestBodies,
  collectDisasterSourceResults,
  findCountryCodeByCoordinates,
  getReliefWebAppname,
  isClimateNaturalEvent,
  mapNaturalEvent,
  toRedisDisaster,
} from '../scripts/seed-climate-disasters.mjs';

const ORIGINAL_APPNAME = process.env.RELIEFWEB_APPNAME;
const ORIGINAL_ALT_APPNAME = process.env.RELIEFWEB_APP_NAME;

afterEach(() => {
  if (ORIGINAL_APPNAME == null) delete process.env.RELIEFWEB_APPNAME;
  else process.env.RELIEFWEB_APPNAME = ORIGINAL_APPNAME;

  if (ORIGINAL_ALT_APPNAME == null) delete process.env.RELIEFWEB_APP_NAME;
  else process.env.RELIEFWEB_APP_NAME = ORIGINAL_ALT_APPNAME;
});

describe('seed-climate-disasters helpers', () => {
  it('uses the documented ReliefWeb disaster type filter', () => {
    const [body] = buildReliefWebRequestBodies();
    const typeFilter = body.filter.conditions.find((condition) => condition.field.includes('type'));

    assert.equal(typeFilter.field, 'type.code');
    assert.deepEqual(typeFilter.value, ['FL', 'TC', 'DR', 'HT', 'WF']);
  });

  it('requires an approved ReliefWeb appname to be configured', () => {
    delete process.env.RELIEFWEB_APPNAME;
    delete process.env.RELIEFWEB_APP_NAME;

    assert.throws(
      () => getReliefWebAppname(),
      /RELIEFWEB_APPNAME is required/,
    );
  });

  it('only reuses GDACS or NASA FIRMS items from natural:events:v1', () => {
    assert.equal(
      isClimateNaturalEvent({ category: 'floods', sourceName: 'GDACS', id: 'gdacs-FL-123' }),
      true,
    );
    assert.equal(
      isClimateNaturalEvent({ category: 'wildfires', sourceName: 'NASA FIRMS', id: 'EONET_1' }),
      true,
    );
    assert.equal(
      isClimateNaturalEvent({ category: 'severeStorms', sourceName: 'NHC', stormName: 'Alfred', id: 'nhc-AL01-1' }),
      false,
    );
    assert.equal(
      isClimateNaturalEvent({ category: 'wildfires', sourceName: 'Volcanic Ash Advisory', id: 'EONET_2' }),
      false,
    );
  });

  it('preserves supported natural-event provenance and rejects unsupported rows', () => {
    const firmsEvent = mapNaturalEvent({
      id: 'EONET_3',
      category: 'wildfires',
      title: 'Wildfire near Santa Clarita',
      description: '',
      sourceName: 'NASA FIRMS',
      sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/',
      magnitude: 350,
      date: 1_700_000_000_000,
      lat: 34.4,
      lon: -118.5,
    });
    assert.equal(firmsEvent.source, 'NASA FIRMS');
    assert.equal(firmsEvent.severity, 'orange');

    const gdacsEvent = mapNaturalEvent({
      id: 'gdacs-TC-123',
      category: 'severeStorms',
      title: '\u{1F534} Cyclone Jude',
      description: 'Landfall expected',
      sourceName: 'GDACS',
      sourceUrl: 'https://www.gdacs.org/',
      stormName: 'Jude',
      stormCategory: 4,
      date: 1_700_000_000_000,
      lat: -18.9,
      lon: 36.2,
    });
    assert.equal(gdacsEvent.source, 'GDACS');
    assert.equal(gdacsEvent.severity, 'red');

    assert.equal(
      mapNaturalEvent({
        id: 'nhc-AL01-1',
        category: 'severeStorms',
        title: 'Tropical Storm Alfred',
        sourceName: 'NHC',
        sourceUrl: 'https://www.nhc.noaa.gov/',
        date: 1_700_000_000_000,
        lat: 20,
        lon: -70,
      }),
      null,
    );
  });

  it('derives country codes from coordinates when natural-event text lacks a country', () => {
    assert.equal(findCountryCodeByCoordinates(35.6762, 139.6503), 'JP');

    const gdacsEvent = mapNaturalEvent({
      id: 'gdacs-TC-456',
      category: 'severeStorms',
      title: '\u{1F7E0} Tropical Cyclone',
      description: '',
      sourceName: 'GDACS',
      sourceUrl: 'https://www.gdacs.org/',
      date: 1_700_000_000_000,
      lat: 35.6762,
      lon: 139.6503,
    });
    assert.equal(gdacsEvent.countryCode, 'JP');
    assert.equal(gdacsEvent.country, 'Japan');
  });

  it('keeps successful source payloads when another source fails', () => {
    const merged = collectDisasterSourceResults([
      { status: 'fulfilled', value: [{ id: 'relief-1', source: 'ReliefWeb', type: 'flood', name: 'Floods', country: 'Japan', countryCode: 'JP', lat: 35.6, lng: 139.7, severity: 'high', startedAt: 1_700_000_000_000, status: 'alert', affectedPopulation: 0, sourceUrl: 'https://reliefweb.int/' }] },
      { status: 'rejected', reason: new Error('natural cache unavailable') },
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'ReliefWeb');
  });

  it('emits the required snake_case Redis output shape', () => {
    const row = toRedisDisaster({
      id: 'gdacs-TC-123',
      type: 'cyclone',
      name: 'Cyclone Jude',
      country: 'Japan',
      countryCode: 'JP',
      lat: 35.6,
      lng: 139.7,
      severity: 'red',
      startedAt: 1_700_000_000_000,
      status: 'alert',
      affectedPopulation: 42,
      source: 'GDACS',
      sourceUrl: 'https://www.gdacs.org/',
    });

    assert.deepEqual(Object.keys(row), [
      'id',
      'type',
      'name',
      'country',
      'country_code',
      'lat',
      'lng',
      'severity',
      'started_at',
      'status',
      'affected_population',
      'source',
      'source_url',
    ]);
    assert.equal(row.country_code, 'JP');
    assert.equal(row.started_at, 1_700_000_000_000);
    assert.equal(row.affected_population, 42);
    assert.equal(row.source_url, 'https://www.gdacs.org/');
  });
});
