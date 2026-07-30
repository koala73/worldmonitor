import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  GEO_CONVERGENCE_THRESHOLD,
  GEO_CONVERGENCE_WINDOW_MS,
  GEO_EVENT_TYPE_LABELS,
  GEO_NEARBY_MIN_TYPES,
  GeoConvergenceEngine,
  geoConvergenceToSignal,
  getCellId,
  getLocationName,
  haversineKm,
  scoreGeoCell,
} from '../shared/analysis-geo-convergence.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Engine bound to a mutable clock so every window/prune assertion is deterministic. */
function makeEngine(startMs = 1_700_000_000_000, options = {}) {
  const clock = { now: startMs };
  const engine = new GeoConvergenceEngine({ now: () => clock.now, ...options });
  return { engine, clock };
}

describe('geo convergence cells', () => {
  it('buckets coordinates into whole-degree cells', () => {
    assert.equal(getCellId(32.4, 44.9), '32,44');
    assert.equal(getCellId(32.9, 44.1), '32,44');
    assert.equal(getCellId(33.0, 45.0), '33,45');
    // Math.floor, not truncation: negatives round away from zero.
    assert.equal(getCellId(-0.5, -0.5), '-1,-1');
    assert.equal(getCellId(-33.2, -70.7), '-34,-71');
  });

  it('places the cell centroid at the middle of its degree square', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    const [cell] = engine.snapshot();
    assert.equal(cell.id, '32,44');
    assert.equal(cell.lat, 32.5);
    assert.equal(cell.lon, 44.5);
  });

  it('accumulates repeat events per type and tracks the latest timestamp', () => {
    const { engine, clock } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    clock.now += HOUR_MS;
    engine.ingest(32.1, 44.1, 'protest');

    const [cell] = engine.snapshot();
    assert.equal(cell.events.length, 1);
    assert.equal(cell.events[0].type, 'protest');
    assert.equal(cell.events[0].count, 2);
    assert.equal(cell.events[0].lastSeen, clock.now);
    // firstSeen is pinned at cell creation, not refreshed by later events.
    assert.equal(cell.firstSeen, clock.now - HOUR_MS);
  });

  it('reports cell count and clears without pruning', () => {
    const { engine, clock } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(10.0, 10.0, 'earthquake');
    assert.equal(engine.cellCount(), 2);

    // Well past the window: counting/snapshotting must NOT prune (debug helpers stay cheap).
    clock.now += GEO_CONVERGENCE_WINDOW_MS * 2;
    assert.equal(engine.cellCount(), 2);
    assert.equal(engine.snapshot().length, 2);

    engine.clear();
    assert.equal(engine.cellCount(), 0);
  });

  it('ingests bulk events with a per-event timestamp, falling back to the clock', () => {
    const { engine, clock } = makeEngine();
    engine.ingestEvents(
      [
        { lat: 32.4, lon: 44.9, time: clock.now - HOUR_MS },
        { lat: 32.6, lon: 44.2 },
      ],
      'protest',
    );
    const [cell] = engine.snapshot();
    assert.equal(cell.events[0].count, 2);
    assert.equal(cell.events[0].lastSeen, clock.now);
    assert.equal(cell.firstSeen, clock.now - HOUR_MS);
  });
});

describe('geo convergence detection', () => {
  it('stays silent below the 3-domain threshold and fires at it', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.5, 44.5, 'military_flight');
    assert.deepEqual(engine.detect(new Set()), []);

    engine.ingest(32.1, 44.1, 'military_vessel');
    const alerts = engine.detect(new Set());
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].cellId, '32,44');
    assert.equal(alerts[0].lat, 32.5);
    assert.equal(alerts[0].lon, 44.5);
    assert.deepEqual(alerts[0].types, ['protest', 'military_flight', 'military_vessel']);
    assert.equal(alerts[0].totalEvents, 3);
  });

  it('scores by domain count plus a capped event-volume boost', () => {
    // 3 domains x 25 = 75, plus min(25, 3 events x 2) = 6 -> 81.
    assert.equal(scoreGeoCell(3, 3), 81);
    assert.equal(scoreGeoCell(2, 2), 54);
    // Volume boost saturates at 25 well below the overall ceiling: 50 + 25.
    assert.equal(scoreGeoCell(2, 20), 75);
    assert.equal(scoreGeoCell(2, 2000), 75);
    // Total score saturates at 100.
    assert.equal(scoreGeoCell(3, 40), 100);
    assert.equal(scoreGeoCell(4, 4), 100);

    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.5, 44.5, 'military_flight');
    engine.ingest(32.1, 44.1, 'military_vessel');
    assert.equal(engine.detect(new Set())[0].score, 81);
  });

  it('suppresses cells already present in seenAlerts and records new ones', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.5, 44.5, 'military_flight');
    engine.ingest(32.1, 44.1, 'military_vessel');

    const seen = new Set();
    assert.equal(engine.detect(seen).length, 1);
    assert.ok(seen.has('32,44'), 'detect must record the alert it emitted');
    assert.deepEqual(engine.detect(seen), [], 'a seen cell must not re-alert');

    const preSeeded = new Set(['32,44']);
    assert.deepEqual(engine.detect(preSeeded), []);
  });

  it('sorts alerts by descending score', () => {
    const { engine } = makeEngine();
    // Weaker cell ingested first so insertion order cannot explain the result.
    engine.ingest(10.4, 10.4, 'protest');
    engine.ingest(10.4, 10.4, 'military_flight');
    engine.ingest(10.4, 10.4, 'military_vessel');

    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.4, 44.9, 'military_flight');
    engine.ingest(32.4, 44.9, 'military_vessel');
    engine.ingest(32.4, 44.9, 'earthquake');

    const alerts = engine.detect(new Set());
    assert.deepEqual(
      alerts.map((a) => [a.cellId, a.score]),
      [
        ['32,44', 100],
        ['10,10', 81],
      ],
    );
  });

  it('prunes event types older than the 24h window before detecting', () => {
    const { engine, clock } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    clock.now += GEO_CONVERGENCE_WINDOW_MS + 1;
    engine.ingest(32.5, 44.5, 'military_flight');
    engine.ingest(32.1, 44.1, 'military_vessel');

    // protest aged out -> only 2 live domains -> below threshold.
    assert.deepEqual(engine.detect(new Set()), []);
    const [cell] = engine.snapshot();
    assert.deepEqual(
      cell.events.map((e) => e.type),
      ['military_flight', 'military_vessel'],
    );
  });

  it('drops the whole cell once every event type has aged out', () => {
    const { engine, clock } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.5, 44.5, 'military_flight');
    engine.ingest(32.1, 44.1, 'military_vessel');

    clock.now += GEO_CONVERGENCE_WINDOW_MS + 1;
    assert.deepEqual(engine.detect(new Set()), []);
    assert.equal(engine.cellCount(), 0);
  });

  it('keeps an event that is exactly at the window edge', () => {
    const { engine, clock } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.5, 44.5, 'military_flight');
    engine.ingest(32.1, 44.1, 'military_vessel');

    clock.now += GEO_CONVERGENCE_WINDOW_MS;
    assert.equal(engine.detect(new Set()).length, 1, 'cutoff is exclusive: lastSeen === cutoff survives');
  });

  it('honours a custom window and threshold', () => {
    const { engine, clock } = makeEngine(0, { windowMs: HOUR_MS, convergenceThreshold: 2 });
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.5, 44.5, 'military_flight');
    assert.equal(engine.detect(new Set()).length, 1, 'threshold of 2 fires on 2 domains');

    clock.now += HOUR_MS + 1;
    assert.deepEqual(engine.detect(new Set()), [], 'custom 1h window prunes both domains');
  });
});

describe('geo convergence proximity lookup', () => {
  it('returns the strongest cell within the radius', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.4, 44.9, 'military_flight');

    const near = engine.alertsNear(32.5, 44.5, 100);
    assert.deepEqual(near, { score: 54, types: 2 });
  });

  it('excludes cells outside the radius', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.4, 44.9, 'military_flight');

    // Cell centroid is (32.5, 44.5); ~5 degrees of latitude away is ~555km.
    assert.equal(engine.alertsNear(37.5, 44.5, 100), null);
    assert.deepEqual(engine.alertsNear(37.5, 44.5, 600), { score: 54, types: 2 });
  });

  it('ignores single-domain cells', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.6, 44.6, 'protest');
    assert.equal(GEO_NEARBY_MIN_TYPES, 2);
    assert.equal(engine.alertsNear(32.5, 44.5, 500), null);
  });

  it('picks the highest scoring cell when several are in range', () => {
    const { engine } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.4, 44.9, 'military_flight');

    engine.ingest(33.4, 44.9, 'protest');
    engine.ingest(33.4, 44.9, 'military_flight');
    engine.ingest(33.4, 44.9, 'military_vessel');

    assert.deepEqual(engine.alertsNear(32.9, 44.5, 400), { score: 81, types: 3 });
  });

  it('prunes stale events before answering', () => {
    const { engine, clock } = makeEngine();
    engine.ingest(32.4, 44.9, 'protest');
    engine.ingest(32.4, 44.9, 'military_flight');
    clock.now += GEO_CONVERGENCE_WINDOW_MS + 1;
    assert.equal(engine.alertsNear(32.5, 44.5, 100), null);
  });
});

describe('geo reverse geocoding', () => {
  const places = {
    conflictZones: [
      { name: 'Sudan Civil War', center: [30, 15] },
      { name: 'Iran Conflict', center: [53, 32] },
    ],
    waterways: [{ name: 'STRAIT OF HORMUZ', lat: 26.5, lon: 56.5 }],
    hotspots: [
      { name: 'Tehran', lat: 35.7, lon: 51.4 },
      { name: 'Qom', lat: 34.6, lon: 50.9 },
    ],
  };

  it('measures great-circle distance in km', () => {
    assert.equal(Math.round(haversineKm(0, 0, 0, 0)), 0);
    // One degree of latitude is ~111km anywhere on the globe.
    assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111) < 1);
  });

  it('prefers conflict zones and strips the boilerplate suffix', () => {
    // Zone centers are [lon, lat] — the reversed order is load-bearing.
    assert.equal(getLocationName(15.5, 30.5, places), 'Sudan');
    assert.equal(getLocationName(32.2, 53.2, places), 'Iran');
  });

  it('falls back to strategic waterways when no conflict zone is close', () => {
    assert.equal(getLocationName(26.8, 56.6, places), 'STRAIT OF HORMUZ');
  });

  it('falls back to the nearest intel hotspot, not merely the first in range', () => {
    // Both hotspots are within 150km; Qom is closer.
    assert.equal(getLocationName(34.8, 51.0, places), 'Qom');
  });

  it('falls back to a coarse region when nothing named is near', () => {
    assert.equal(getLocationName(33, 44, {}), 'Middle East');
    assert.equal(getLocationName(35, 120, {}), 'East Asia');
    assert.equal(getLocationName(5, 100, {}), 'Southeast Asia');
    assert.equal(getLocationName(48, 10, {}), 'Europe');
    assert.equal(getLocationName(55, 100, {}), 'Russia');
    assert.equal(getLocationName(-5, 20, {}), 'Africa');
    assert.equal(getLocationName(40, -100, {}), 'North America');
    assert.equal(getLocationName(-20, -60, {}), 'South America');
  });

  it('falls back to formatted coordinates outside every region box', () => {
    assert.equal(getLocationName(80.12, -170.98, {}), '80.1°, -171.0°');
  });

  it('treats omitted datasets as empty', () => {
    assert.equal(getLocationName(33, 44), 'Middle East');
  });
});

describe('geo convergence signal projection', () => {
  const alert = {
    cellId: '32,44',
    lat: 32.5,
    lon: 44.5,
    types: ['protest', 'military_flight', 'military_vessel'],
    totalEvents: 7,
    score: 89,
  };

  it('projects an alert into a deterministic correlation signal', () => {
    const signal = geoConvergenceToSignal(alert, {
      places: {},
      generateId: () => 'sig-test',
      now: () => new Date(0),
    });

    assert.equal(signal.id, 'sig-test');
    assert.equal(signal.type, 'geo_convergence');
    assert.equal(signal.title, 'Geographic Convergence (3 types)');
    assert.equal(
      signal.description,
      'protests, military flights, naval vessels in Middle East - 7 events/24h',
    );
    assert.equal(signal.confidence, 0.89);
    assert.equal(signal.timestamp.getTime(), 0);
    assert.deepEqual(signal.data, {
      newsVelocity: 7,
      relatedTopics: ['protest', 'military_flight', 'military_vessel'],
    });
  });

  it('labels every event type', () => {
    assert.deepEqual(GEO_EVENT_TYPE_LABELS, {
      protest: 'protests',
      military_flight: 'military flights',
      military_vessel: 'naval vessels',
      earthquake: 'seismic activity',
    });
  });

  it('mints an id and timestamp when none are injected', () => {
    const signal = geoConvergenceToSignal(alert);
    assert.match(signal.id, /^sig-[0-9a-f-]{36}$/);
    assert.ok(signal.timestamp instanceof Date);
  });
});

describe('client shim stays pinned to the shared core', () => {
  it('publishes the same convergence threshold the docs guard reads', () => {
    // tests/docs-signal-alignment.test.mts asserts this literal in the client shim
    // and cross-checks it against docs/geographic-convergence.mdx; the shared core
    // owns the default, so the two must not drift.
    const shim = readFileSync(new URL('../src/services/geo-convergence.ts', import.meta.url), 'utf8');
    const literal = shim.match(/const CONVERGENCE_THRESHOLD = (\d+);/);
    assert.ok(literal, 'src/services/geo-convergence.ts must declare CONVERGENCE_THRESHOLD');
    assert.equal(Number(literal[1]), GEO_CONVERGENCE_THRESHOLD);
  });

  it('imports the core instead of re-implementing it', () => {
    const shim = readFileSync(new URL('../src/services/geo-convergence.ts', import.meta.url), 'utf8');
    assert.match(shim, /from '\.\.\/\.\.\/shared\/analysis-geo-convergence'/);
  });

  it('keeps the shared core free of client-only imports', () => {
    const core = readFileSync(new URL('../shared/analysis-geo-convergence.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(core, /from '@\//, 'core must not use the src/ path alias');
    assert.doesNotMatch(core, /import\.meta/, 'core must stay bundler-agnostic');
  });
});
