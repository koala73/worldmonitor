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
} from '../scripts/_weather-alert-select.mjs';

const SEEDER_SOURCE = readFileSync(
  new URL('../scripts/seed-weather-alerts.mjs', import.meta.url),
  'utf8',
);
const RELAY_SOURCE = readFileSync(
  new URL('../scripts/ais-relay.cjs', import.meta.url),
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
    assert.equal(alert.countryCode, 'US');
    assert.equal(alert.source, 'nws');
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
    assert.equal(alert.centroid[0], -79.6);
    assert.equal(alert.centroid[1], 43.4);
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

describe('ECCC host policy and sourceVersion lockstep', () => {
  it('queries status_en=issued and status_en=continued as two GETs', () => {
    assert.deepEqual([...ECCC_LIVE_STATUSES], ['issued', 'continued']);
    assert.equal(ECCC_ALERTS_URLS.length, 2);
    assert.match(ECCC_ALERTS_URLS[0], /status_en=issued/);
    assert.match(ECCC_ALERTS_URLS[1], /status_en=continued/);
    assert.equal(ECCC_ALERTS_URL, ECCC_ALERTS_URLS[0]);
    for (const url of ECCC_ALERTS_URLS) {
      assert.match(url, /[?&]f=json/);
      assert.match(url, /limit=10000/);
      assert.match(url, /api\.weather\.gc\.ca/);
      assert.doesNotMatch(url, /status_en=active/);
    }
    assert.equal(ECCC_HOST, 'api.weather.gc.ca');
    assert.ok(ECCC_MAX_BYTES >= 2 * 1024 * 1024);
    assert.ok(ECCC_MAX_BYTES <= 4 * 1024 * 1024);
  });

  it('bumps sourceVersion so NWS-only / empty-active Redis snapshots are not reused', () => {
    assert.equal(WEATHER_ALERTS_SOURCE_VERSION, 'nws+eccc-issued-continued');
    assert.match(SEEDER_SOURCE, /sourceVersion:\s*WEATHER_ALERTS_SOURCE_VERSION/);
    assert.match(RELAY_SOURCE, /sourceVersion:\s*WEATHER_ALERTS_SOURCE_VERSION/);
    assert.doesNotMatch(SEEDER_SOURCE, /sourceVersion:\s*'nws-active'/);
    assert.doesNotMatch(RELAY_SOURCE, /sourceVersion:\s*'nws-weather'/);
  });

  it('always writes the merged active set in the live relay writer (no skip-on-empty)', () => {
    assert.match(RELAY_SOURCE, /Always write the merged active set/);
    assert.doesNotMatch(RELAY_SOURCE, /existing data preserved/);
    assert.match(RELAY_SOURCE, /zeroOk:\s*true/);
    assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
  });

  // NOTE: these are SOURCE guards, not behavioural tests. `seedWeatherAlerts` is
  // not reachable from this suite (it lives inside the relay's module scope), so
  // the patterns below deliberately match CODE, never prose — the sibling
  // assertion above matches a comment and would survive deleting the behaviour.
  it('carries the surviving source forward instead of overwriting on partial failure', () => {
    assert.match(RELAY_SOURCE, /const prev = await envelopeRead\(WEATHER_REDIS_KEY/);
    assert.match(RELAY_SOURCE, /carriedNws = prevAlerts\.filter\(/);
    assert.match(RELAY_SOURCE, /carriedEccc = prevAlerts\.filter\(/);
    // The merge must consume the carried slices, not the raw per-source arrays.
    assert.match(RELAY_SOURCE, /nws:\s*nwsResult\.status === 'fulfilled' \? nwsAlerts : carriedNws/);
    assert.match(RELAY_SOURCE, /eccc:\s*ecccResult\.status === 'fulfilled' \? ecccAlerts : carriedEccc/);
  });

  it('marks the weather seed-meta degraded when a source fails', () => {
    assert.match(RELAY_SOURCE, /sourceState:\s*'degraded'/);
    assert.match(RELAY_SOURCE, /NWS_SOURCE_FAILED/);
    assert.match(RELAY_SOURCE, /ECCC_SOURCE_FAILED/);
    assert.match(RELAY_SOURCE, /failedSources/);
  });

  it('never leaves the weather-select import as an unhandled rejection', () => {
    assert.match(
      RELAY_SOURCE,
      /import\('\.\/_weather-alert-select\.mjs'\)\.catch\(/,
      'a bare import() rejects at module load and crash-loops the whole relay',
    );
  });

  it('allowlists api.weather.gov and api.weather.gc.ca on both live fetches', () => {
    assert.match(RELAY_SOURCE, /allowedHosts:\s*\[NWS_HOST\]/);
    assert.match(RELAY_SOURCE, /fetchEcccAlertFeatures/);
    assert.match(SEEDER_SOURCE, /NWS_HOST/);
    assert.match(SEEDER_SOURCE, /fetchEcccAlertFeatures/);
  });

  it('does not import the seeder entrypoint from this test file', () => {
    const testSource = readFileSync(new URL(import.meta.url), 'utf8');
    assert.doesNotMatch(testSource, /from ['\"]\.\.\/scripts\/seed-weather-alerts\.mjs['\"]/);
  });

  it('rejects untrusted hosts and asks fetch to error on redirects', async () => {
    await assert.rejects(
      () => fetchApprovedWeatherJson('https://evil.example/alerts', { allowedHosts: [ECCC_HOST] }),
      /UNTRUSTED_SOURCE_HOST/,
    );
    await assert.rejects(
      () => fetchApprovedWeatherJson('http://api.weather.gc.ca/alerts', { allowedHosts: [ECCC_HOST] }),
      /UNTRUSTED_SOURCE_HOST/,
    );

    let seen;
    const fetchFn = async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify({ type: 'FeatureCollection', features: [] }),
      };
    };
    await fetchApprovedWeatherJson(ECCC_ALERTS_URL, { allowedHosts: [ECCC_HOST], fetchFn });
    assert.equal(seen.opts.redirect, 'error');
    assert.ok(seen.opts.signal);
    assert.match(seen.opts.headers['User-Agent'], /Mozilla/);
  });

  it('enforces the byte ceiling', async () => {
    const fetchFn = async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(ECCC_MAX_BYTES + 1) : null) },
      body: { cancel: async () => {} },
      text: async () => '{"features":[]}',
    });
    await assert.rejects(
      () => fetchApprovedWeatherJson(ECCC_ALERTS_URL, { allowedHosts: [ECCC_HOST], fetchFn, maxBytes: ECCC_MAX_BYTES }),
      /RESPONSE_TOO_LARGE/,
    );
  });

  it('hits issued and continued URLs and still returns issued features if continued fails', async () => {
    const issuedFeature = ecccFeature({ id: 'issued-1', status_en: 'issued' });
    const urls = [];
    const fetchFn = async (url) => {
      urls.push(String(url));
      if (String(url).includes('status_en=continued')) {
        throw new Error('continued down');
      }
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify({ type: 'FeatureCollection', features: [issuedFeature] }),
      };
    };
    const features = await fetchEcccAlertFeatures({ fetchFn, userAgent: 'test-ua' });
    assert.equal(urls.length, 2);
    assert.ok(urls.some((url) => /status_en=issued/.test(url)));
    assert.ok(urls.some((url) => /status_en=continued/.test(url)));
    assert.ok(!urls.some((url) => /status_en=active/.test(url)));
    assert.deepEqual(features.map((feature) => feature.id), ['issued-1']);
  });
});
