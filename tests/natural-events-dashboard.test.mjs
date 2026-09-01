import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  NATURAL_EVENTS_CONE_MAX_POINTS,
  compactNaturalEventsDashboardPayload,
  simplifyNaturalEventConeRing,
} from '../scripts/_natural-events-dashboard.mjs';
import {
  CAPTURED_KEY_DECODED_BYTES,
  BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST,
} from '../scripts/_bootstrap-payload-budget.mjs';

function circleRing(count, lon0, lat0, radiusDeg) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * Math.PI * 2;
    points.push({
      lon: lon0 + Math.cos(theta) * radiusDeg + i * 1e-9,
      lat: lat0 + Math.sin(theta) * radiusDeg,
    });
  }
  points.push({ ...points[0] });
  return { points };
}

describe('natural-events dashboard cone compact', () => {
  it('packages the helper with the publisher and keeps the Edge mirror in sync', () => {
    const publisher = readFileSync(new URL('../scripts/publish-bootstrap-tiers.mjs', import.meta.url), 'utf8');
    const edge = readFileSync(new URL('../api/bootstrap.js', import.meta.url), 'utf8');
    const scriptsHelper = readFileSync(new URL('../scripts/_natural-events-dashboard.mjs', import.meta.url), 'utf8');
    const edgeHelper = readFileSync(new URL('../api/_natural-events-dashboard.js', import.meta.url), 'utf8');

    assert.match(publisher, /from '\.\/_natural-events-dashboard\.mjs'/);
    assert.match(edge, /from '\.\/_natural-events-dashboard\.js'/);
    assert.equal(edgeHelper, scriptsHelper, 'Edge helper mirror must match the scripts-packaged source');
  });

  it('returns the same object when there are no forecast cones to compact', () => {
    const emptyCone = {
      events: [{ id: 'EONET_1', title: 'Iceberg', conePolygon: [] }],
      fetchedAt: 1,
    };
    assert.equal(compactNaturalEventsDashboardPayload(emptyCone), emptyCone);

    const plain = { events: [{ id: 'plain' }] };
    assert.equal(compactNaturalEventsDashboardPayload(plain), plain);
  });

  it('does not mutate the input events or rings', () => {
    const ring = circleRing(400, -40, 20, 2);
    const payload = { events: [{ id: 'nhc-AL04-3', conePolygon: [ring] }] };
    const before = structuredClone(payload);
    compactNaturalEventsDashboardPayload(payload);
    assert.deepEqual(payload, before);
  });

  it('reduces an NHC-scale closed cone below the dashboard vertex cap and keeps it closed', () => {
    const ring = circleRing(1939, -42.5, 13.5, 2.5);
    const simplified = simplifyNaturalEventConeRing(ring);
    assert.notEqual(simplified, ring);
    assert.ok(Array.isArray(simplified.points));
    assert.ok(simplified.points.length <= NATURAL_EVENTS_CONE_MAX_POINTS);
    assert.ok(simplified.points.length >= 4);
    const first = simplified.points[0];
    const last = simplified.points[simplified.points.length - 1];
    assert.deepEqual(first, last);
  });

  it('preserves storm identity and brings four fat cones under the frozen 5% growth allowance', () => {
    const events = [
      { id: 'nhc-AL04-3', title: 'Tropical Storm Dolly', conePolygon: [circleRing(1939, -42.5, 13.5, 2.5)] },
      { id: 'nhc-EP11-3', title: 'Tropical Storm Karina', conePolygon: [circleRing(1769, -120, 15, 2.2)] },
      { id: 'nhc-EP12-2', title: 'Tropical Storm Lowell', conePolygon: [circleRing(1718, -130, 16, 2.1)] },
      { id: 'nhc-CP01-59', title: 'Tropical Storm Lala', conePolygon: [circleRing(1214, -160, 18, 1.8)] },
      { id: 'EONET_1', title: 'Iceberg A83' },
    ];
    const payload = { events, westernPacific: { events: [] } };
    const originalBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    const compacted = compactNaturalEventsDashboardPayload(payload);
    assert.notEqual(compacted, payload);
    assert.deepEqual(compacted.events.map((event) => event.id), events.map((event) => event.id));
    assert.equal(compacted.westernPacific, payload.westernPacific);

    const compactedBytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8');
    const captured = CAPTURED_KEY_DECODED_BYTES.naturalEvents;
    const allowance = Math.max(
      BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers.slow.materialGrowthFloorBytes,
      Math.ceil(captured * BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers.slow.materialGrowthRatio),
    );
    assert.ok(originalBytes > captured + allowance, 'fixture must start above the frozen growth threshold');
    assert.ok(
      compactedBytes <= captured + allowance,
      `compacted ${compactedBytes} B still exceeds captured ${captured} B + ${allowance} B`,
    );
  });
});
