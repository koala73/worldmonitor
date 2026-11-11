import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRIORITY_COUNTRIES,
  estimateExposure,
  getRadiusForEventType,
  listCountryPopulations,
} from '../shared/analysis-population-exposure.ts';
import { densityCountryAt, estimatePointExposure } from '../shared/population-density-country-at.ts';
import { inRing, ringEdgesNearLatitude } from '../shared/population-density-geometry.ts';
import PALESTINE from '../shared/population-density-palestine.json' with { type: 'json' };
import DATA from '../shared/population-density-boundaries.json' with { type: 'json' };
import { feature } from 'topojson-client';
// Accept the old schema only to let the documented revert run reach assertions.
const BOUNDARIES = { countries: DATA.countries ?? Object.fromEntries(feature(DATA.topology, DATA.topology.objects.countries).features.map(({properties, geometry}) => [properties.code, geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates])) };
import { resolveCountryCode } from '../shared/country-code-resolve.ts';
import { getPopulationExposure } from '../server/worldmonitor/displacement/v1/get-population-exposure.ts';
import { enrichEventsWithExposure } from '../src/services/population-exposure.ts';
import { normalizeAcledProtestEvents } from '../scripts/seed-unrest-events.mjs';
import ucdpCandidate from '../scripts/shared/ucdp-candidate.cjs';
import {
  Z_THRESHOLD_LOW,
  Z_THRESHOLD_MEDIUM,
  Z_THRESHOLD_HIGH,
  getBaselineSeverity,
} from '../shared/analysis-temporal-severity.ts';

describe('dashboard population exposure', () => {
  it('names dashboard Gaza rows for the PSE estimate', () => {
    const { exposures } = enrichEventsWithExposure([{
      id: 'gaza', name: 'Gaza town, Israel', locationName: 'Gaza town', type: 'conflict',
      country: 'Israel', lat: 31.52, lon: 34.45, hasPreciseLocation: true,
    }]);
    assert.equal(exposures[0].eventName, 'Gaza town, Palestine');
    assert.equal(exposures[0].exposedPopulation, estimateExposure(31.52, 34.45, 'Palestine', 50).exposedPopulation);
  });

  it('retains point precision from the provider codes', () => {
    const coordinates = { latitude: '13.58', longitude: '44.02' };
    const acledEvents = normalizeAcledProtestEvents([1, '1', 2, 3, undefined].map((geo_precision, i) => ({
      ...coordinates, geo_precision, event_id_cnty: String(i),
    })));
    assert.deepEqual(acledEvents.map(e => e.hasPreciseLocation), [true, true, false, false, false]);
    assert.equal(ucdpCandidate.hasPreciseUcdpLocation({ ...coordinates, where_prec: '1' }), true);
    assert.equal(ucdpCandidate.hasPreciseUcdpLocation({ ...coordinates, where_prec: 2 }), false);
    assert.equal(ucdpCandidate.hasPreciseUcdpLocation(coordinates), false);
    assert.equal(ucdpCandidate.hasPreciseUcdpLocation({ ...coordinates, where_prec: 1, longitude: '' }), false);
  });

  it('only estimates precise locations with a supported country density', () => {
    const point = { id: 'point', name: 'Taiz', type: 'conflict', country: 'Yemen (North Yemen)', lat: 13.58, lon: 44.02, hasPreciseLocation: true };
    const events = [
      { ...point, id: 'country', name: 'Brazil (39 reports)', country: 'Brazil', lat: -10, lon: -55, hasPreciseLocation: undefined },
      { ...point, id: 'nested', name: 'Texas, United States (6 reports)', country: 'United States', lat: 31.11, lon: -97.65, hasPreciseLocation: undefined },
      { ...point, id: 'broad', hasPreciseLocation: false },
      { ...point, id: 'unknown-precision', hasPreciseLocation: undefined },
      { ...point, id: 'unsupported', country: 'Chile', lat: -33.45, lon: -70.6667 },
      { ...point, id: 'invalid', lat: 91 },
      { ...point, id: 'missing-coordinates', lat: 0, lon: 0 },
      point,
    ];

    const density = PRIORITY_COUNTRIES.YEM.pop / PRIORITY_COUNTRIES.YEM.area;
    assert.deepEqual(enrichEventsWithExposure(events).exposures.map(e => [e.eventId, e.exposedPopulation, e.exposureRadiusKm]), [
      ['point', Math.round(density * Math.PI * 50 ** 2), 50],
    ]);
  });

  it('folds events at the same location into one row with their count', () => {
    const kyiv = { name: 'Kyiv city, Ukraine', type: 'state-based', country: 'Ukraine', lat: 50.45, lon: 30.52333, hasPreciseLocation: true };
    const events = [
      { ...kyiv, id: '643820' },
      { ...kyiv, id: 'vyshhorod', name: 'Vyshhorod town, Ukraine', lat: 50.58476, lon: 30.4898 },
      { ...kyiv, id: '643824' },
      { ...kyiv, id: 'projected', lat: 50.4500004, eventCount: 3 },
    ];
    const density = PRIORITY_COUNTRIES.UKR.pop / PRIORITY_COUNTRIES.UKR.area;
    const estimate = Math.round(density * Math.PI * 50 ** 2);
    assert.deepEqual(enrichEventsWithExposure(events).exposures.map(e => [e.eventId, e.eventName, e.eventCount, e.exposedPopulation]), [
      ['643820', 'Kyiv city, Ukraine', 5, estimate],
      ['vyshhorod', 'Vyshhorod town, Ukraine', 1, estimate],
    ]);
  });

  it('marks unknown precision pending only when allowed and still rejects unusable points', () => {
    const point = { id: 'known', name: 'Taiz', type: 'state-based', country: 'Yemen', lat: 13.58, lon: 44.02, hasPreciseLocation: true };
    const events = [
      point,
      { ...point, id: 'legacy', hasPreciseLocation: undefined },
      { ...point, id: 'broad', hasPreciseLocation: false },
      { ...point, id: 'invalid', lat: 91, hasPreciseLocation: undefined },
      { ...point, id: 'unsupported', country: 'Chile', hasPreciseLocation: undefined },
    ];
    assert.equal(enrichEventsWithExposure(events).exposures[0].locationPending, undefined);
    const { exposures, coverage } = enrichEventsWithExposure(events, 10, true);
    assert.equal(exposures.length, 1);
    assert.equal(exposures[0].eventCount, 2);
    assert.equal(exposures[0].locationPending, true);
    assert.deepEqual(coverage, { totalEvents: 5, withoutPreciseLocation: 1, withoutEstimate: 2, atOtherPlaces: 0 });
  });

  it('spends the row limit on distinct locations and still counts later repeats', () => {
    const point = { name: 'p', type: 'conflict', country: 'Ukraine', hasPreciseLocation: true };
    const events = [
      { ...point, id: 'a1', lat: 50, lon: 30 },
      { ...point, id: 'a2', lat: 50, lon: 30 },
      { ...point, id: 'b', lat: 49, lon: 31 },
      { ...point, id: 'c', lat: 48, lon: 32 },
      { ...point, id: 'a3', lat: 50, lon: 30 },
    ];
    assert.deepEqual(enrichEventsWithExposure(events, 2).exposures.map(e => [e.eventId, e.eventCount]), [['a1', 3], ['b', 1]]);
  });

  it('counts every event it leaves out, by reason', () => {
    const point = { name: 'p', type: 'conflict', country: 'Ukraine', hasPreciseLocation: true };
    const events = [
      { ...point, id: 'a1', lat: 50, lon: 30 },
      { ...point, id: 'a2', lat: 50, lon: 30, eventCount: 2 },
      { ...point, id: 'b', lat: 49, lon: 31 },
      { ...point, id: 'c', lat: 48, lon: 32 },
      { ...point, id: 'c2', lat: 48, lon: 32 },
      { ...point, id: 'broad', hasPreciseLocation: false, lat: 50, lon: 30 },
      { ...point, id: 'unknown', hasPreciseLocation: undefined, lat: 50, lon: 30 },
      { ...point, id: 'chile', country: 'Chile', lat: -33.45, lon: -70.6667 },
      { ...point, id: 'null-island', lat: 0, lon: 0 },
    ];
    const { exposures, coverage } = enrichEventsWithExposure(events, 2);
    assert.deepEqual(exposures.map(e => [e.eventId, e.eventCount]), [['a1', 3], ['b', 1]]);
    assert.deepEqual(coverage, { totalEvents: 10, withoutPreciseLocation: 2, withoutEstimate: 2, atOtherPlaces: 2 });
  });
});

const densityOf = (iso3) => PRIORITY_COUNTRIES[iso3].pop / PRIORITY_COUNTRIES[iso3].area;

describe('analysis-population-exposure core', () => {
  it('has an outline for every country in the density table and nothing else', () => {
    const tableCodes = Object.keys(PRIORITY_COUNTRIES).map((iso3) => resolveCountryCode(iso3)).sort();
    assert.equal(tableCodes.length, 20);
    // The browser intentionally retains its small provider-correction outline;
    // server point lookup uses the unsimplified atlas topology.
    assert.ok(PALESTINE.length > 0);
    assert.deepEqual(Object.keys(BOUNDARIES.countries).sort(), tableCodes);
  });

  it('applies the reported country density to the circle area', () => {
    for (const country of ['ISR', 'IL', 'Israel']) {
      assert.deepEqual(estimateExposure(31.0, 34.8, country, 50), {
        exposedPopulation: Math.round(densityOf('ISR') * Math.PI * 50 * 50),
        exposureRadiusKm: 50,
        country: 'ISR',
        densityPerKm2: Math.round(densityOf('ISR')),
      });
    }
  });

  it('returns null for a country outside the density table or an unusable point', () => {
    assert.equal(estimateExposure(-33.45, -70.67, 'Chile', 50), null);
    assert.equal(estimateExposure(31, 34.8, '', 50), null);
    assert.equal(estimateExposure(91, 34.8, 'ISR', 50), null);
    assert.equal(estimateExposure(0, 0, 'NGA', 50), null);
    assert.equal(estimateExposure(Number.NaN, 34.8, 'ISR', 50), null);
  });

  it('treats non-finite and negative radii as zero rather than NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const result = estimateExposure(31.0, 34.8, 'ISR', bad);
      assert.equal(result.exposedPopulation, 0);
      assert.equal(result.exposureRadiusKm, 0);
    }
  });
});

describe('indexed country geometry', () => {
  const referenceInRing = (lon, lat, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  it('preserves ray casting at vertices, integer latitude bands, and across the dateline', () => {
    for (const polygons of Object.values(BOUNDARIES.countries)) {
      for (const ring of polygons.flat()) {
        for (const [lon, lat] of [ring[0], ring[Math.floor(ring.length / 2)]]) {
          for (const y of [lat, Math.floor(lat), lat - 0.01, lat + 0.01]) {
            assert.equal(inRing(lon, y, ring), referenceInRing(lon, y, ring));
          }
        }
      }
    }
  });

  it('visits only nearby latitude edges of the largest Russia ring', () => {
    const ring = BOUNDARIES.countries.RU.map(p => p[0]).sort((a, b) => b.length - a.length)[0];
    const edges = ringEdgesNearLatitude(ring, 45.99, 0.05);
    assert.ok(edges.length < ring.length / 8, 'a miss must not scan the full Eurasian ring');
    for (let i = 1; i < ring.length; i++) {
      const south = Math.min(ring[i - 1][1], ring[i][1]);
      const north = Math.max(ring[i - 1][1], ring[i][1]);
      if (south <= 46.04 && north >= 45.94) assert.ok(edges.includes(i), 'keep every potentially near edge');
    }
  });
});

describe('point exposure by country outline', () => {
  const places = [
    ['Eilat centre', 29.55, 34.95, 'ISR'],
    ['Eilat south', 29.54, 34.94, 'ISR'],
    ['Eilat north (raw atlas Jordan)', 29.57, 34.96, null],
    ['Moldova wrong-snap regression', 48.40742803917716, 27.510716032731192, null],
    ['Laos wrong-snap regression', 21.261407681930056, 100.77073645052123, null],
    ['Cameroon wrong-snap regression', 8.846732292626287, 12.8475151779719, null],
    ['Teknaf', 20.86, 92.30, null],
    ['Aqaba', 29.649, 35.033, null],
    ['Haifa north control', 32.82, 34.99, 'ISR'],
    ['Kyiv', 50.45, 30.52, 'UKR'],
    ['Lviv', 49.84, 24.03, 'UKR'],
    ["Sana'a", 15.37, 44.19, 'YEM'],
    ['Gaza City', 31.5, 34.47, 'PSE'],
    ['Gwadar', 25.126, 62.322, 'PAK'],
    ['Lagos Island', 6.45, 3.39, 'NGA'],
    ['Sittwe', 20.15, 92.9, 'MMR'],
    ['Aden', 12.785, 45.018, 'YEM'],
    ['Haifa', 32.794, 34.99, 'ISR'],
    ['Murmansk', 68.97, 33.075, 'RUS'],
    ['Banana', -6.02, 12.4, 'COD'],
    ['Bushehr', 28.92, 50.84, 'IRN'],
    ['Latakia', 35.52, 35.78, 'SYR'],
    ['Tartus', 34.89, 35.89, 'SYR'],
    ['Anadyr', 64.733, 177.517, 'RUS'],
    ['Penghu', 23.57, 119.58, 'TWN'],
    ['Hualien', 23.98, 121.61, 'TWN'],
    ['Crimea (atlas de facto policy)', 44.6, 33.52, 'RUS'],
    ['Kerch (atlas de facto policy)', 45.36, 36.47, 'RUS'],
    ['West Jerusalem (atlas approximation)', 31.78, 35.20, 'PSE'],
    ['West Jerusalem east point (atlas approximation)', 31.78, 35.21, 'PSE'],
    ['Jordan beside the West Bank (no cross-border snap)', 31.9, 35.55, null],
    ['Beyond coastal snap at Lagos', 6.30, 3.39, null],
    ['Tel Aviv', 32.08, 34.78, 'ISR'],
    ['Taipei', 25.03, 121.57, 'TWN'],
    ['Hargeisa', 9.56, 44.06, 'SOM'],
    ['Khartoum', 15.5, 32.56, 'SDN'],
    ['Ouagadougou', 12.37, -1.53, 'BFA'],
    ['Vladivostok', 43.12, 131.89, 'RUS'],
    ['Santiago', -33.45, -70.67, null],
    ['Brasilia', -15.79, -47.88, null],
    ['Asuncion', -25.26, -57.58, null],
    ['Austin', 30.27, -97.74, null],
    ['Berlin', 52.52, 13.405, null],
    ['Rzeszow', 50.04, 22.0, null],
    ['Niamey', 13.51, 2.11, null],
    ['Far from Russia across the dateline wrap', 64.733, 0, null],
    ['Gulf of Guinea', 2, 3, null],
  ];

  for (const [name, lat, lon, iso3] of places) {
    it(`${name} gets ${iso3 ? `${iso3} density` : 'no estimate'}`, async () => {
      const estimate = estimatePointExposure(lat, lon, 50);
      if (iso3 === null) {
        assert.equal(densityCountryAt(lat, lon), null);
        assert.equal(estimate, null);
      } else {
        assert.equal(estimate?.country, iso3);
        assert.equal(estimate.exposedPopulation, Math.round(densityOf(iso3) * Math.PI * 50 * 50));
      }

      const rest = await getPopulationExposure(/** @type {never} */ ({}), { mode: 'exposure', lat, lon, radius: 50 });
      assert.equal(rest.success, true);
      assert.equal(rest.exposure?.nearestCountry, iso3 ?? undefined);
    });
  }

  it('corrects Israel-labelled events inside the Palestinian outline', () => {
    for (const [lat, lon] of [[31.52, 34.45], [31.35, 34.26], [31.905, 35.215], [32.02, 35.35]]) {
      assert.equal(estimatePointExposure(lat, lon, 50, 'Israel')?.country, 'PSE');
      const event = { id: 'ps', name: 'Palestinian event', type: 'conflict', country: 'Israel', lat, lon, hasPreciseLocation: true };
      assert.equal(enrichEventsWithExposure([event]).exposures[0]?.exposedPopulation, Math.round(densityOf('PSE') * Math.PI * 50 ** 2));
    }
    assert.equal(estimatePointExposure(32.08, 34.78, 50, 'Israel')?.country, 'ISR');
    assert.equal(estimatePointExposure(31.5, 34.47, 50, 'Chile'), null);
  });
});

describe('population table', () => {
  it('maps event types to radii with a 50km default', () => {
    assert.equal(getRadiusForEventType('earthquake'), 100);
    assert.equal(getRadiusForEventType('flood'), 100);
    assert.equal(getRadiusForEventType('wildfire'), 30);
    assert.equal(getRadiusForEventType('fire'), 30);
    assert.equal(getRadiusForEventType('battle'), 50);
    assert.equal(getRadiusForEventType('state-based'), 50);
    assert.equal(getRadiusForEventType('unknown-thing'), 50);
  });

  it('lists country populations with rounded densities', () => {
    const countries = listCountryPopulations();
    assert.equal(countries.length, 20);
    const india = countries.find((c) => c.code === 'IND');
    assert.ok(india);
    assert.equal(india.population, PRIORITY_COUNTRIES.IND.pop);
    assert.equal(
      india.densityPerKm2,
      Math.round(PRIORITY_COUNTRIES.IND.pop / PRIORITY_COUNTRIES.IND.area),
    );
  });
});

describe('analysis-temporal-severity core', () => {
  it('exports the canonical z-score thresholds', () => {
    assert.equal(Z_THRESHOLD_LOW, 1.5);
    assert.equal(Z_THRESHOLD_MEDIUM, 2.0);
    assert.equal(Z_THRESHOLD_HIGH, 3.0);
  });

  it('classifies severity bands exactly at the boundaries', () => {
    assert.equal(getBaselineSeverity(3.0), 'critical');
    assert.equal(getBaselineSeverity(4.7), 'critical');
    assert.equal(getBaselineSeverity(2.999), 'high');
    assert.equal(getBaselineSeverity(2.0), 'high');
    assert.equal(getBaselineSeverity(1.999), 'medium');
    assert.equal(getBaselineSeverity(1.5), 'medium');
    assert.equal(getBaselineSeverity(1.499), 'normal');
    assert.equal(getBaselineSeverity(0), 'normal');
  });
});

describe('v1 population-exposure compatibility', () => {
  it('preserves the existing unbounded REST radius contract', async () => {
    const radius = 1001;
    const result = await getPopulationExposure(
      /** @type {never} */ ({}),
      { mode: 'exposure', lat: 31.0, lon: 34.8, radius },
    );

    const { country, ...estimate } = estimateExposure(31.0, 34.8, 'ISR', radius);
    assert.deepEqual(result.exposure, { ...estimate, nearestCountry: country });
    assert.equal(result.exposure.exposureRadiusKm, radius);
  });
});
