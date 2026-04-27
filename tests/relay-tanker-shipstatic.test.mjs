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

  test('vesselMeta has TTL eviction AND hard size cap so it cannot grow unbounded', () => {
    assert.match(RELAY, /VESSEL_META_TTL_MS/);
    assert.match(
      RELAY,
      /vesselMeta\.delete\(/,
      'cleanup must delete stale vesselMeta entries',
    );
    // PR #3410 review (Greptile P1): every peer Map in cleanupAggregates
    // (tankerReports, candidateReports, densityGrid, vesselHistory) follows
    // its TTL loop with an evictMapByTimestamp hard cap. vesselMeta must
    // match that pattern — TTL alone is insufficient against a hostile or
    // buggy upstream flooding unique MMSIs faster than the TTL drains them.
    assert.match(RELAY, /MAX_VESSEL_META/);
    assert.match(
      RELAY,
      /evictMapByTimestamp\(\s*vesselMeta\s*,/,
      'vesselMeta must have a hard size cap via evictMapByTimestamp',
    );
  });

  test('processShipStaticDataForMeta rejects shipType <= 0 (AIS code 0 = "Not available")', () => {
    // Number(null) === 0, which is finite. Without the > 0 gate, a Type 5
    // frame with Type=null after a valid Type=85 would overwrite the
    // cached tanker as shipType=0, downgrading classification on the next
    // PositionReport. Pin the gate so a refactor can't accidentally drop it.
    assert.match(
      RELAY,
      /!Number\.isFinite\(shipType\)\s*\|\|\s*shipType\s*<=\s*0/,
      'shipType must be guarded against <= 0 in processShipStaticDataForMeta',
    );
  });

  test('vessels record uses effectiveShipType (NOT raw meta.ShipType)', () => {
    // Without this, classifyVesselType(vessel?.shipType) at the chokepoint
    // transit logging site always returns 'other' because meta.ShipType
    // is permanently undefined on PositionReport. Same root cause as the
    // tanker layer being empty — needs the same vesselMeta fallback.
    const fnStart = RELAY.indexOf('function processPositionReportForSnapshot');
    const nextFnRel = RELAY.slice(fnStart + 1).search(/\nfunction\s/);
    const fnEnd = nextFnRel > -1 ? fnStart + 1 + nextFnRel : RELAY.length;
    const fnBody = RELAY.slice(fnStart, fnEnd);
    // The vessels.set call must reference effectiveShipType, not meta.ShipType
    const vesselsSetMatch = fnBody.match(/vessels\.set\(\s*mmsi\s*,\s*\{[^}]*shipType:\s*([^,\n}]+)/);
    assert.ok(vesselsSetMatch, 'vessels.set must include a shipType field');
    assert.match(
      vesselsSetMatch[1].trim(),
      /^effectiveShipType\b/,
      `vessels.set shipType must be effectiveShipType (was: ${vesselsSetMatch[1].trim()})`,
    );
  });

  test('isLikelyMilitaryCandidate accepts a resolved-shipType override', () => {
    // PositionReport callers must pass effectiveShipType so the type-based
    // military arms (35/55/50-59) actually fire. Without the override, the
    // classifier falls back to NAVAL_PREFIX_RE + MMSI suffix only.
    assert.match(
      RELAY,
      /function\s+isLikelyMilitaryCandidate\s*\(\s*meta\s*,\s*resolvedShipType\s*\)/,
      'isLikelyMilitaryCandidate must accept a resolvedShipType parameter',
    );
    // The PositionReport call site must pass it through
    const fnStart = RELAY.indexOf('function processPositionReportForSnapshot');
    const nextFnRel = RELAY.slice(fnStart + 1).search(/\nfunction\s/);
    const fnEnd = nextFnRel > -1 ? fnStart + 1 + nextFnRel : RELAY.length;
    const fnBody = RELAY.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /isLikelyMilitaryCandidate\(\s*meta\s*,\s*effectiveShipType\s*\)/,
      'PositionReport must invoke isLikelyMilitaryCandidate with effectiveShipType',
    );
  });

  test('candidateReports record uses effectiveShipType', () => {
    // Same fix as vessels.set — military candidate snapshots had shipType
    // permanently undefined, so any downstream consumer that filtered
    // candidates by ship type was broken too.
    const fnStart = RELAY.indexOf('function processPositionReportForSnapshot');
    const nextFnRel = RELAY.slice(fnStart + 1).search(/\nfunction\s/);
    const fnEnd = nextFnRel > -1 ? fnStart + 1 + nextFnRel : RELAY.length;
    const fnBody = RELAY.slice(fnStart, fnEnd);
    const candSetMatch = fnBody.match(/candidateReports\.set\(\s*mmsi\s*,\s*\{[^}]*shipType:\s*([^,\n}]+)/);
    assert.ok(candSetMatch, 'candidateReports.set must include a shipType field');
    assert.match(
      candSetMatch[1].trim(),
      /^effectiveShipType\b/,
      `candidateReports.set shipType must be effectiveShipType (was: ${candSetMatch[1].trim()})`,
    );
  });
});
