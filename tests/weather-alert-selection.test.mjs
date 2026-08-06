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
} from '../scripts/_weather-alert-select.mjs';

const SEEDER_SOURCE = readFileSync(
  new URL('../scripts/seed-weather-alerts.mjs', import.meta.url),
  'utf8',
);

const POLYGON = {
  type: 'Polygon',
  coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 41], [-100, 40]]],
};

function feature(severity, index, overrides = {}) {
  return {
    id: `alert-${index}`,
    geometry: POLYGON,
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
