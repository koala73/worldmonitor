import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ECCC_ALERTS_URL,
  ECCC_ALERTS_URLS,
  ECCC_HOST,
  ECCC_LIVE_STATUSES,
  ECCC_MAX_BYTES,
  MAX_ALERTS,
  PER_SOURCE_FLOOR,
  WEATHER_ALERTS_SOURCE_VERSION,
  calculateCentroid,
  eligibleAlertCount,
  extractCoordinates,
  fetchApprovedWeatherJson,
  fetchEcccAlertFeatures,
  formatTruncationWarning,
  mapEcccRiskToSeverity,
  mergeAlertSources,
  requireAlertFeatures,
  selectAlerts,
  selectEcccAlerts,
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

const ECCC_POLYGON = {
  type: 'Polygon',
  coordinates: [[[-80, 43], [-79, 43], [-79, 44], [-80, 44], [-80, 43]]],
};
function ecccFeature({ id, status_en = 'issued', risk_colour_en = 'red', alert_type = 'warning', geometry = ECCC_POLYGON, overrides = {} } = {}) {
  return {
    id,
    geometry,
    properties: {
      alert_code: 'TOR',
      alert_type,
      alert_name_en: 'tornado warning',
      alert_short_name_en: 'Tornado',
      alert_text_en: 'A tornado warning is in effect.',
      risk_colour_en,
      feature_name_en: 'Toronto',
      province: 'ON',
      status_en,
      validity_datetime: '2026-08-13T18:00:00.000Z',
      expiration_datetime: '2026-08-13T22:00:00.000Z',
      ...overrides,
    },
  };
}

describe('ECCC weather alert normalisation', () => {
  it('maps an issued polygon feature onto the existing record with CA/eccc stamps and a centroid', () => {
    const [alert] = selectEcccAlerts([ecccFeature({ id: 'ca-issued-1' })]);
    assert.equal(alert.id, 'ca-issued-1');
    assert.equal(alert.countryCode, 'CA');
    assert.equal(alert.source, 'eccc');
    assert.equal(alert.severity, 'Extreme');
    assert.equal(alert.event, 'tornado warning');
    assert.match(alert.headline, /tornado warning/);
    assert.equal(alert.areaDesc, 'Toronto, ON');
    assert.equal(alert.coordinates.length, 5);
    assert.ok(Array.isArray(alert.centroid));
    assert.equal(alert.centroid.length, 2);
    // TRUE centre of the closed ring, not the closing-vertex-biased average.
    // ECCC_POLYGON repeats its first vertex to close; averaging all five points
    // counts it twice and yields -79.6 / 43.4. main fixed calculateCentroid to
    // drop the duplicate (the same fix the NWS fixture pins), so this branch's
    // original expectation was the biased value.
    assert.equal(alert.centroid[0], -79.5);
    assert.equal(alert.centroid[1], 43.5);
  });

  it('drops status_en=ended and status_en=active; keeps issued and continued', () => {
    const features = [
      ecccFeature({ id: 'ended-keep-out', status_en: 'ended' }),
      ecccFeature({ id: 'issued-keep', status_en: 'issued' }),
      ecccFeature({ id: 'continued-keep', status_en: 'continued' }),
      ecccFeature({ id: 'active-keep-out', status_en: 'active' }),
      ecccFeature({ id: 'ended-2', status_en: 'ended', risk_colour_en: 'orange' }),
    ];
    const alerts = selectEcccAlerts(features);
    assert.deepEqual(alerts.map(a => a.id), ['issued-keep', 'continued-keep']);
    assert.ok(!alerts.some(a => a.id === 'ended-keep-out'));
    assert.ok(!alerts.some(a => a.id === 'ended-2'));
    assert.ok(!alerts.some(a => a.id === 'active-keep-out'));
  });

  it('excludes ended ids from a merged published payload', () => {
    const nws = selectAlerts([feature('Severe', 1)]);
    const eccc = selectEcccAlerts([
      ecccFeature({ id: 'ended-keep-out', status_en: 'ended' }),
      ecccFeature({ id: 'ca-issued', status_en: 'issued' }),
    ]);
    const published = mergeAlertSources({ nws, eccc });
    assert.ok(published.some(a => a.id === 'alert-1'));
    assert.ok(published.some(a => a.id === 'ca-issued' && a.countryCode === 'CA'));
    assert.ok(!published.some(a => a.id === 'ended-keep-out'));
  });

  it('maps ECCC risk colours onto the NWS severity vocabulary', () => {
    assert.equal(mapEcccRiskToSeverity('red'), 'Extreme');
    assert.equal(mapEcccRiskToSeverity('orange'), 'Severe');
    assert.equal(mapEcccRiskToSeverity('yellow'), 'Moderate');
    assert.equal(mapEcccRiskToSeverity('green'), 'Minor');
    assert.equal(mapEcccRiskToSeverity(undefined, 'warning'), 'Severe');
    assert.equal(mapEcccRiskToSeverity('purple'), 'Unknown');
  });

  it('drops unmapped ECCC severity so it cannot pass isEligible', () => {
    const alerts = selectEcccAlerts([
      ecccFeature({ id: 'unknown-colour', risk_colour_en: 'purple', alert_type: 'other' }),
      ecccFeature({ id: 'yellow-ok', risk_colour_en: 'yellow' }),
    ]);
    assert.deepEqual(alerts.map(a => a.id), ['yellow-ok']);
    assert.equal(alerts[0].severity, 'Moderate');
  });
});

describe('NWS + ECCC merge and per-source caps', () => {
  it('still publishes ECCC when NWS is missing (failed source)', () => {
    const eccc = selectEcccAlerts([ecccFeature({ id: 'ca-only' })]);
    const published = mergeAlertSources({ nws: null, eccc });
    assert.deepEqual(published.map(a => a.id), ['ca-only']);
    assert.equal(published[0].source, 'eccc');
  });

  it('still publishes NWS when ECCC is missing (failed source)', () => {
    const nws = selectAlerts([feature('Severe', 7)]);
    const published = mergeAlertSources({ nws, eccc: undefined });
    assert.deepEqual(published.map(a => a.id), ['alert-7']);
    assert.equal(published[0].source, 'nws');
  });

  it('keeps a per-source floor so CA alerts are not dropped behind US small-craft', () => {
    const nws = Array.from({ length: MAX_ALERTS }, (_, i) => selectAlerts([feature('Minor', i)])[0]);
    const eccc = Array.from({ length: 10 }, (_, i) => selectEcccAlerts([
      ecccFeature({ id: `ca-extreme-${i}`, risk_colour_en: 'red' }),
    ])[0]);
    const published = mergeAlertSources({ nws, eccc });
    assert.equal(published.length, MAX_ALERTS);
    const ca = published.filter(a => a.source === 'eccc');
    assert.equal(ca.length, 10, 'all 10 Extreme CA alerts must survive the US Minor flood');
    assert.ok(published.filter(a => a.source === 'nws').length >= PER_SOURCE_FLOOR);
  });

  it('publishes an empty merged set as valid quiet (zeroIsValid purge path)', () => {
    const published = mergeAlertSources({ nws: [], eccc: [] });
    assert.deepEqual(published, []);
    assert.equal(validateSelectedAlerts({ alerts: published }), true);
  });
});
