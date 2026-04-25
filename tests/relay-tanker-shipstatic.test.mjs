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

  test('processShipStaticDataForMeta reads ShipType from sd.Type (NOT meta.ShipType)', () => {
    // Pre-fix root cause was reading from meta.ShipType which AISStream
    // never populates on PositionReport. ShipStaticData puts ShipType under
    // the message body as `Type` (capital T), not the wrapper MetaData. A
    // typo regression (e.g., `Number(sd.Typ)`, `Number(sd.shipType)`,
    // `Number(meta.ShipType)`) would re-empty the tanker layer silently —
    // the tests in this file depend on the FIELD NAME being correct, so
    // pin it explicitly.
    assert.match(
      RELAY,
      /Number\(sd\.Type\)/,
      'shipType must be parsed from sd.Type (the message-body field)',
    );
    assert.match(
      RELAY,
      /sd\.Name/,
      'shipName should fall back to sd.Name from the message body',
    );
  });

  test('processShipStaticDataForMeta accepts MMSI from meta.MMSI OR sd.UserID', () => {
    // AISStream's ShipStaticData payload mirrors MMSI as UserID on the
    // message body. Defense in depth against a wrapper-schema variant
    // that omits MetaData.MMSI on Type 5 frames — without the fallback,
    // such a frame would early-return and silently re-empty vesselMeta.
    assert.match(
      RELAY,
      /String\(\s*meta\.MMSI\s*\|\|\s*sd\.UserID\s*\|\|\s*['"]['"]?\s*\)/,
      'MMSI extraction must fall back to sd.UserID',
    );
  });

  test('tanker capture falls back to vesselMeta when position-report meta lacks ShipType', () => {
    // Scope the order assertion to the body of processPositionReportForSnapshot
    // so a future change adding an earlier vesselMeta.get(...) elsewhere in
    // the file can't satisfy the order check while removing the in-tanker-path
    // lookup. The body extends until the next top-level function declaration.
    const fnStart = RELAY.indexOf('function processPositionReportForSnapshot');
    assert.ok(fnStart > -1, 'processPositionReportForSnapshot must exist');
    // Find next top-level `function ` after the start (matches column-0 `function`)
    const nextFnRel = RELAY.slice(fnStart + 1).search(/\nfunction\s/);
    const fnEnd = nextFnRel > -1 ? fnStart + 1 + nextFnRel : RELAY.length;
    const fnBody = RELAY.slice(fnStart, fnEnd);
    const cacheLookupIdx = fnBody.indexOf('vesselMeta.get(mmsi)');
    const tankerSetIdx = fnBody.indexOf('tankerReports.set(mmsi');
    assert.ok(cacheLookupIdx > -1, 'vesselMeta.get(mmsi) must appear inside processPositionReportForSnapshot');
    assert.ok(tankerSetIdx > -1, 'tankerReports.set(mmsi) must appear inside processPositionReportForSnapshot');
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
