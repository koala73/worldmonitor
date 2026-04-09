import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = readFileSync(resolve(root, 'scripts/seed-portwatch-disruptions.mjs'), 'utf-8');
const flowsSrc = readFileSync(resolve(root, 'scripts/seed-chokepoint-flows.mjs'), 'utf-8');

// ── seeder source assertions ──────────────────────────────────────────────────

describe('seed-portwatch-disruptions.mjs exports', () => {
  it('exports fetchAll', () => {
    assert.match(src, /export\s+async\s+function\s+fetchAll/);
  });

  it('exports validateFn', () => {
    assert.match(src, /export\s+function\s+validateFn/);
  });

  it('writes to portwatch:disruptions:active:v1', () => {
    assert.match(src, /portwatch:disruptions:active:v1/);
  });

  it('uses ArcGIS portwatch_disruptions_database endpoint', () => {
    assert.match(src, /portwatch_disruptions_database.*FeatureServer/);
  });

  it('fetches 30 days of recent + active events (including NULL todate)', () => {
    assert.match(src, /DAYS_BACK\s*=\s*30/);
    assert.match(src, /todate > .* OR todate IS NULL/);
  });

  it('has TTL of 7200 (2 hours)', () => {
    assert.match(src, /7[_\s]*200/);
  });

  it('extracts eventId, eventType, eventName, alertLevel, lat, lon fields', () => {
    assert.match(src, /eventId/);
    assert.match(src, /eventType/);
    assert.match(src, /alertLevel/);
    assert.match(src, /a\.lat/);
    assert.match(src, /a\.long/);
  });

  it('parses affectedPorts from comma-separated string', () => {
    assert.match(src, /split\(','\)/);
  });

  it('computes active flag (todate in future or null)', () => {
    assert.match(src, /active:/);
    assert.match(src, /a\.todate > now/);
  });

  it('wraps runSeed in isMain guard', () => {
    assert.match(src, /isMain.*=.*process\.argv/s);
    assert.match(src, /if\s*\(isMain\)/);
  });
});

describe('seed-chokepoint-flows.mjs hazard integration', () => {
  it('reads portwatch:disruptions:active:v1 key', () => {
    assert.match(flowsSrc, /portwatch:disruptions:active:v1/);
  });

  it('reads disruptions in parallel with other keys', () => {
    assert.match(flowsSrc, /DISRUPTIONS_KEY/);
  });

  it('only matches RED and ORANGE alerts for hazard badge', () => {
    assert.match(flowsSrc, /alertLevel.*RED/s);
    assert.match(flowsSrc, /alertLevel.*ORANGE/s);
  });

  it('uses haversine 500km radius for hazard matching', () => {
    assert.match(flowsSrc, /HAZARD_RADIUS_KM\s*=\s*500/);
    assert.match(flowsSrc, /haversineKm/);
  });

  it('CHOKEPOINT_MAP entries include lat/lon coordinates', () => {
    assert.match(flowsSrc, /hormuz.*lat:\s*26\.\d+/s);
    assert.match(flowsSrc, /babelm.*lat:\s*12\.\d+/s);
  });

  it('disruptions read is non-fatal (catch → null)', () => {
    assert.match(flowsSrc, /DISRUPTIONS_KEY.*catch.*null/s);
  });
});

// ── unit tests for disruption event parsing ───────────────────────────────────

function parseAffectedPorts(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function isActive(todateMs, now) {
  return !todateMs || todateMs > now;
}

describe('disruption event parsing', () => {
  it('parses comma-separated affectedPorts correctly', () => {
    assert.deepEqual(parseAffectedPorts('port137,port138, port139'), ['port137', 'port138', 'port139']);
  });

  it('returns empty array for null affectedPorts', () => {
    assert.deepEqual(parseAffectedPorts(null), []);
    assert.deepEqual(parseAffectedPorts(''), []);
  });

  it('marks event as active when todate is in the future', () => {
    assert.equal(isActive(Date.now() + 86400_000, Date.now()), true);
  });

  it('marks event as inactive when todate is in the past', () => {
    assert.equal(isActive(Date.now() - 86400_000, Date.now()), false);
  });

  it('marks event as active when todate is null (no end date)', () => {
    assert.equal(isActive(null, Date.now()), true);
  });
});

// ── haversine + hazard matching ────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestHazard(events, cpLat, cpLon, radiusKm = 500) {
  if (!Array.isArray(events)) return null;
  let best = null;
  let bestDist = radiusKm;
  for (const ev of events) {
    if (ev.alertLevel !== 'RED' && ev.alertLevel !== 'ORANGE') continue;
    if (!ev.active) continue;
    const dist = haversineKm(cpLat, cpLon, ev.lat, ev.lon);
    if (dist < bestDist) { bestDist = dist; best = ev; }
  }
  return best;
}

describe('hazard matching', () => {
  const hormuzLat = 26.56;
  const hormuzLon = 56.25;

  it('matches RED event within 500km of chokepoint', () => {
    const events = [{ alertLevel: 'RED', active: true, lat: 25.0, lon: 57.0, eventName: 'CYCLONE-X' }];
    const dist = haversineKm(hormuzLat, hormuzLon, 25.0, 57.0);
    assert.ok(dist < 500, `event should be within 500km (${dist.toFixed(1)}km)`);
    assert.ok(findNearestHazard(events, hormuzLat, hormuzLon) !== null);
  });

  it('does NOT match event beyond 500km', () => {
    // Mumbai: ~1600km from Hormuz
    const events = [{ alertLevel: 'RED', active: true, lat: 19.0, lon: 72.8, eventName: 'FAR-FLOOD' }];
    const dist = haversineKm(hormuzLat, hormuzLon, 19.0, 72.8);
    assert.ok(dist > 500, `event should be beyond 500km (${dist.toFixed(1)}km)`);
    assert.equal(findNearestHazard(events, hormuzLat, hormuzLon), null);
  });

  it('does NOT match YELLOW or GREEN alerts', () => {
    const events = [{ alertLevel: 'YELLOW', active: true, lat: 25.0, lon: 57.0, eventName: 'YELLOW-EV' }];
    assert.equal(findNearestHazard(events, hormuzLat, hormuzLon), null);
  });

  it('does NOT match inactive (ended) events', () => {
    const events = [{ alertLevel: 'RED', active: false, lat: 25.0, lon: 57.0, eventName: 'OLD-EV' }];
    assert.equal(findNearestHazard(events, hormuzLat, hormuzLon), null);
  });

  it('returns closest RED/ORANGE event when multiple qualify', () => {
    const events = [
      { alertLevel: 'ORANGE', active: true, lat: 26.0, lon: 56.5, eventName: 'CLOSE-FLOOD' },
      { alertLevel: 'RED',    active: true, lat: 24.0, lon: 58.0, eventName: 'FAR-STORM' },
    ];
    const result = findNearestHazard(events, hormuzLat, hormuzLon);
    assert.equal(result?.eventName, 'CLOSE-FLOOD', 'should return closest qualifying event');
  });

  it('returns null when events array is empty or absent', () => {
    assert.equal(findNearestHazard([], hormuzLat, hormuzLon), null);
    assert.equal(findNearestHazard(null, hormuzLat, hormuzLon), null);
  });
});
