// Static-analysis regression tests for the relay's tanker-classification
// dependency on ShipStaticData (AIS Type 5).
//
// Background: AISStream's PositionReport messages do NOT carry ShipType in
// MetaData. PR #3402 shipped tanker capture predicated on `meta.ShipType`,
// which evaluated to NaN on every PositionReport, so tankerReports stayed
// permanently empty and the live-tanker layer rendered zero vessels on
// energy.worldmonitor.app.
//
// These tests pin the fix shape so a regression can't flip the relay back
// to PositionReport-only and silently re-empty the tanker layer:
//   1. AISStream subscription includes ShipStaticData in FilterMessageTypes.
//   2. Relay dispatches ShipStaticData → processShipStaticDataForMeta.
//   3. Tanker capture predicate falls back to vesselMeta cache when the
//      position-report meta lacks ShipType.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = readFileSync(
  resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'),
  'utf-8',
);

describe('ais-relay — tanker classification depends on ShipStaticData', () => {
  test('AISStream subscription requests both PositionReport AND ShipStaticData', () => {
    // Without ShipStaticData, ShipType is never populated and tanker capture
    // fails on every position report.
    assert.match(
      RELAY,
      /FilterMessageTypes:\s*\[\s*['"]PositionReport['"]\s*,\s*['"]ShipStaticData['"]\s*\]/,
      'AISStream subscription must request both PositionReport and ShipStaticData',
    );
  });

  test('relay dispatches ShipStaticData → processShipStaticDataForMeta', () => {
    assert.match(
      RELAY,
      /MessageType\s*===\s*['"]ShipStaticData['"]/,
      'relay must branch on MessageType === ShipStaticData',
    );
    assert.match(
      RELAY,
      /processShipStaticDataForMeta\s*\(/,
      'relay must invoke processShipStaticDataForMeta on Type 5 frames',
    );
  });

  test('vesselMeta cache is declared and populated by ShipStaticData handler', () => {
    assert.match(RELAY, /const\s+vesselMeta\s*=\s*new Map\(\)/);
    assert.match(
      RELAY,
      /vesselMeta\.set\([^)]+,\s*\{[^}]*shipType/,
      'processShipStaticDataForMeta must write shipType into vesselMeta',
    );
  });

  test('tanker capture falls back to vesselMeta when position-report meta lacks ShipType', () => {
    // Order matters: cachedMeta lookup must precede tanker classification.
    const cacheLookupIdx = RELAY.indexOf('vesselMeta.get(mmsi)');
    const tankerSetIdx = RELAY.indexOf('tankerReports.set(mmsi');
    assert.ok(cacheLookupIdx > -1, 'vesselMeta.get(mmsi) must appear in tanker capture path');
    assert.ok(tankerSetIdx > -1, 'tankerReports.set(mmsi) must appear');
    assert.ok(
      cacheLookupIdx < tankerSetIdx,
      'vesselMeta lookup must precede tanker insertion so the fallback informs the predicate',
    );
  });

  test('vesselMeta has TTL eviction so it cannot grow unbounded', () => {
    assert.match(RELAY, /VESSEL_META_TTL_MS/);
    assert.match(
      RELAY,
      /vesselMeta\.delete\(/,
      'cleanup must delete stale vesselMeta entries',
    );
  });
});
