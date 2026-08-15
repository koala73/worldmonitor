import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MAX_ALERTS,
  calculateCentroid,
  eligibleAlertCount,
  extractCoordinates,
  formatTruncationWarning,
  requireAlertFeatures,
  selectAlerts,
  validateSelectedAlerts,
  weatherAlertNotifyLocation,
} from '../scripts/_weather-alert-select.mjs';

const SEEDER_SOURCE = readFileSync(
  new URL('../scripts/seed-weather-alerts.mjs', import.meta.url),
  'utf8',
);

const POLYGON = {
  type: 'Polygon',
  coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 41], [-100, 40]]],
};

function feature(severity, index, overrides = {}, geometry = POLYGON) {
  return {
    id: `alert-${index}`,
    geometry,
    properties: {
      severity,
      event: `${severity} event ${index}`,
      headline: `${severity} headline ${index}`,
      description: 'x',
      areaDesc: 'Somewhere',
      onset: '2026-08-06T00:00:00Z',
      expires: '2026-08-06T06:00:00Z',
      ...overrides,
    },
  };
}

// Mirrors the live NWS feed shape: alerts arrive in issuance order, so the
// low-severity advisories issued early sit ahead of the warnings issued later.
function feedWithHighSeverityPastTheCap() {
  const features = [];
  for (let i = 0; i < MAX_ALERTS; i += 1) features.push(feature('Minor', i));
  features.push(feature('Extreme', 100));
  for (let i = 0; i < 5; i += 1) features.push(feature('Severe', 200 + i));
  return features;
}

describe('weather alert selection', () => {
  it('retains Extreme and Severe alerts issued after the first MAX_ALERTS entries', () => {
    const alerts = selectAlerts(feedWithHighSeverityPastTheCap());

    assert.equal(alerts.length, MAX_ALERTS);
    assert.equal(
      alerts.filter(a => a.severity === 'Extreme').length,
      1,
      'the Extreme alert was dropped because it sat past the raw-feed cap',
    );
    assert.equal(
      alerts.filter(a => a.severity === 'Severe').length,
      5,
      'Severe alerts were dropped in favour of earlier-issued Minor ones',
    );
  });

  it('orders the retained set by descending severity', () => {
    const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
    const alerts = selectAlerts([
      feature('Minor', 1),
      feature('Extreme', 2),
      feature('Moderate', 3),
      feature('Severe', 4),
    ]);

    const ranks = alerts.map(a => rank[a.severity]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });

  it('preserves issuance order among equal-severity alerts', () => {
    const features = [feature('Severe', 3), feature('Severe', 1), feature('Severe', 2)];
    assert.deepEqual(
      selectAlerts(features).map(a => a.id),
      ['alert-3', 'alert-1', 'alert-2'],
      'the sort must be stable, not re-order alerts that rank equally',
    );
  });

  it('keeps the highest-severity alerts when the cap forces a choice', () => {
    const features = [
      ...Array.from({ length: MAX_ALERTS }, (_, i) => feature('Moderate', i)),
      feature('Severe', 900),
    ];
    const alerts = selectAlerts(features);
    assert.equal(alerts.length, MAX_ALERTS);
    assert.equal(alerts[0].id, 'alert-900', 'the Severe alert must outrank every Moderate one');
    assert.ok(!alerts.some(a => a.id === `alert-${MAX_ALERTS - 1}`), 'the last Moderate is the one dropped');
  });

  it('drops Unknown-severity alerts regardless of position', () => {
    const alerts = selectAlerts([feature('Unknown', 1), feature('Severe', 2)]);
    assert.deepEqual(alerts.map(a => a.severity), ['Severe']);
  });

  it('counts only eligible severities before applying the cap', () => {
    const features = [
      ...feedWithHighSeverityPastTheCap(),
      feature('Unknown', 300),
      feature('Unexpected', 301),
      { id: 'missing', geometry: POLYGON, properties: { event: 'no severity' } },
    ];

    assert.equal(eligibleAlertCount(features), MAX_ALERTS + 6);
  });

  it('formats kept/eligible/dropped warning details only when truncation occurs', () => {
    assert.equal(
      formatTruncationWarning(MAX_ALERTS + 6, MAX_ALERTS),
      `weather-alerts: kept ${MAX_ALERTS}/${MAX_ALERTS + 6} by severity rank (6 dropped)`,
    );
    assert.equal(formatTruncationWarning(MAX_ALERTS, MAX_ALERTS), null);
    assert.equal(formatTruncationWarning(MAX_ALERTS - 1, MAX_ALERTS - 1), null);
  });

  it('treats a missing severity property as Unknown and drops it', () => {
    const bare = { id: 'bare', geometry: POLYGON, properties: { event: 'no severity' } };
    assert.deepEqual(selectAlerts([bare, feature('Severe', 1)]).map(a => a.id), ['alert-1']);
  });

  it('normalises geometry into coordinates and a centroid', () => {
    const [alert] = selectAlerts([feature('Severe', 1)]);
    assert.equal(alert.coordinates.length, 5);
    assert.ok(Array.isArray(alert.centroid));
    assert.equal(alert.centroid.length, 2);
  });

  it('caps description length at 500 characters', () => {
    const [alert] = selectAlerts([feature('Severe', 1, { description: 'y'.repeat(900) })]);
    assert.equal(alert.description.length, 500);
  });

  it('survives a feature with no geometry', () => {
    const [alert] = selectAlerts([{ id: 'nogeo', geometry: null, properties: { severity: 'Severe' } }]);
    assert.deepEqual(alert.coordinates, []);
    assert.equal(alert.centroid, undefined);
  });

  it('returns an empty list for a non-array input', () => {
    assert.deepEqual(selectAlerts(undefined), []);
    assert.deepEqual(selectAlerts(null), []);
  });

  it('accepts a successfully selected empty alert list', () => {
    assert.equal(validateSelectedAlerts({ alerts: [] }), true);
    assert.equal(validateSelectedAlerts({ alerts: null }), false);
    assert.equal(validateSelectedAlerts({}), false);
  });

  it('registers selected-empty results as valid zero-record seed runs', () => {
    assert.match(SEEDER_SOURCE, /validateFn:\s*validateSelectedAlerts/);
    assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
  });

  it('requires the upstream payload to contain a features array', () => {
    const features = [];
    assert.equal(requireAlertFeatures({ features }), features);
    assert.throws(() => requireAlertFeatures({}), /missing a features array/);
    assert.throws(() => requireAlertFeatures({ features: null }), /missing a features array/);
    assert.throws(() => requireAlertFeatures({ features: {} }), /missing a features array/);
  });

  it('extracts the outer ring of a MultiPolygon', () => {
    const coords = extractCoordinates({ type: 'MultiPolygon', coordinates: [[[[1, 2], [3, 4]]]] });
    assert.deepEqual(coords, [[1, 2], [3, 4]]);
  });

  it('returns undefined centroid for an empty ring', () => {
    assert.equal(calculateCentroid([]), undefined);
  });
});

const AIS_RELAY_SOURCE = readFileSync(
  new URL('../scripts/ais-relay.cjs', import.meta.url),
  'utf8',
);

// The fixture ring is the closed square [-100,40] [-99,40] [-99,41] [-100,41]
// [-100,40], whose true centre is -99.5 / 40.5. Averaging the raw ring counts
// the repeated closing vertex twice and yields -99.6 / 40.4 — ~14km off, and
// dependent on where the ring starts. These assertions pin the TRUE centre so
// the closing-vertex bias cannot come back.
describe('weather_alert notification location payload', () => {
  it('maps a GeoJSON-order centroid onto lat/lon and carries the polygon', () => {
    const [alert] = selectAlerts([feature('Severe', 1)]);
    const location = weatherAlertNotifyLocation(alert);

    assert.equal(location.lat, 40.5);
    assert.equal(location.lon, -99.5);
    assert.deepEqual(location.geometry, {
      type: 'Polygon',
      coordinates: [alert.coordinates],
    });
  });

  it('centroid ignores the duplicated closing vertex and is rotation-invariant', () => {
    const square = [[-100, 40], [-99, 40], [-99, 41], [-100, 41], [-100, 40]];
    const rotated = [[-99, 40], [-99, 41], [-100, 41], [-100, 40], [-99, 40]];

    assert.deepEqual(calculateCentroid(square), [-99.5, 40.5]);
    // Same polygon, different start vertex -> must be the same point.
    assert.deepEqual(calculateCentroid(rotated), [-99.5, 40.5]);
    // An open ring (no repeated closing vertex) is averaged as-is.
    assert.deepEqual(calculateCentroid([[0, 0], [2, 0], [2, 2], [0, 2]]), [1, 1]);
  });

  it('omits lat/lon and geometry when the alert has no centroid', () => {
    assert.deepEqual(
      weatherAlertNotifyLocation({ coordinates: [], centroid: undefined }),
      {},
    );
  });

  it('omits geometry when only a centroid exists', () => {
    assert.deepEqual(
      weatherAlertNotifyLocation({ centroid: [-99.5, 40.5], coordinates: [] }),
      { lat: 40.5, lon: -99.5 },
    );
  });

  it('publishes every warned area of a MultiPolygon alert, not just the first', () => {
    const ringA = [[-100, 40], [-99, 40], [-99, 41], [-100, 41], [-100, 40]];
    const ringB = [[-80, 30], [-79, 30], [-79, 31], [-80, 31], [-80, 30]];
    const [alert] = selectAlerts([feature('Extreme', 1, {}, {
      type: 'MultiPolygon',
      coordinates: [[ringA], [ringB]],
    })]);

    const location = weatherAlertNotifyLocation(alert);

    // Both disjoint areas must reach the consumer: a point-in-polygon filter
    // fed only ringA drops every user inside ringB.
    assert.deepEqual(location.geometry, {
      type: 'MultiPolygon',
      coordinates: [[ringA], [ringB]],
    });
    // lat/lon stays the PRIMARY ring's centre — a representative anchor, with
    // geometry as the authoritative area.
    assert.equal(location.lat, 40.5);
    assert.equal(location.lon, -99.5);
  });

  it('still emits a plain Polygon for a single-part alert', () => {
    const [alert] = selectAlerts([feature('Severe', 1)]);
    assert.equal(alert.rings, undefined, 'single-part alerts must not carry a redundant rings field');
    assert.equal(weatherAlertNotifyLocation(alert).geometry.type, 'Polygon');
  });

  it('omits geometry for a ring that is not a valid closed LinearRing', () => {
    // RFC 7946 requires >= 4 positions with first === last. A 3-position ring
    // and an unclosed ring are both rejected by strict parsers, so publish
    // lat/lon alone rather than geometry a consumer will choke on.
    const tooShort = [[-100, 40], [-99, 40], [-100, 40]];
    const unclosed = [[-100, 40], [-99, 40], [-99, 41], [-100, 41]];

    assert.deepEqual(
      weatherAlertNotifyLocation({ centroid: [-99.5, 40.5], coordinates: tooShort }),
      { lat: 40.5, lon: -99.5 },
    );
    assert.deepEqual(
      weatherAlertNotifyLocation({ centroid: [-99.5, 40.5], coordinates: unclosed }),
      { lat: 40.5, lon: -99.5 },
    );
  });

  it('rejects a non-numeric centroid rather than coercing it to 0,0', () => {
    // Number(null) === 0 and Number.isFinite(0) is true, so a bare isFinite
    // check publishes 0,0 in the Gulf of Guinea — the exact value the
    // omit-entirely contract exists to prevent.
    for (const bad of [null, '', [], false]) {
      assert.deepEqual(
        weatherAlertNotifyLocation({ centroid: [bad, bad], coordinates: [] }),
        {},
        `centroid [${JSON.stringify(bad)}, ...] must omit, not coerce to 0`,
      );
    }
  });

  it('rejects a non-finite centroid so consumers never see 0,0 from missing geo', () => {
    assert.deepEqual(
      weatherAlertNotifyLocation({ centroid: [Number.NaN, 40], coordinates: POLYGON.coordinates[0] }),
      {},
    );
  });

  // centroid is GeoJSON order [lon, lat], so the case above only drives `lon`
  // non-finite. Without this second case, weakening the guard to check just one
  // operand (`!Number.isFinite(lon)`) still passes every other test here, and a
  // NaN latitude would serialize onto the wire as `lat: null` — the opposite of
  // the omit-entirely contract.
  it('rejects a non-finite latitude even when longitude is finite', () => {
    assert.deepEqual(
      weatherAlertNotifyLocation({ centroid: [-99.6, Number.NaN], coordinates: POLYGON.coordinates[0] }),
      {},
    );
  });

  it('threads weatherAlertNotifyLocation into the weather_alert publish payload', () => {
    assert.match(
      AIS_RELAY_SOURCE,
      // Bounded to the weather_alert payload object literal. An unbounded
      // `[\s\S]*?` gap passes as long as the token appears ANYWHERE later in
      // this 12k-line file, so deleting the spread from the payload while any
      // other reference survives keeps the guard green. The inner alternation
      // permits the one nested `{ coalesceKey }` / `{}` pair already present
      // but cannot cross the payload's closing brace.
      /eventType:\s*'weather_alert',\s*payload:\s*\{(?:[^{}]|\{[^{}]*\})*\.\.\.weatherAlertNotifyLocation\(a\),/,
      'ais-relay must spread weatherAlertNotifyLocation(a) INSIDE the weather_alert payload object so the already-computed centroid is published',
    );
  });
});
