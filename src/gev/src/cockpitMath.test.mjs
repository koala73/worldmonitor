import test from 'node:test';
import assert from 'node:assert/strict';
import {
  altitudeRulerStep,
  altitudeRulerTicks,
  altitudeRulerCurveInset,
  bearingBetweenCoordinates,
  cockpitAnchorCorrectionStep,
  cockpitAltitudeDisplayFt,
  cockpitGroundSafeHeight,
  cockpitSurfaceWaitExpired,
  cockpitUiUpdateDue,
  compassDivisions,
  formatAltitudeRulerTick,
  formatCockpitContextScope,
  formatCompassDivision,
  formatSpeedRulerTick,
  normalizeHeading,
  relativeBearing,
  resolveCockpitContextReadout,
  resolveHudRailLayout,
  resolveTrackedAircraftInfo,
  slewHeading,
  speedRulerStep,
  speedRulerTicks,
} from './cockpitMath.js';

test('cockpit presentation updates are throttled independently of camera frames', () => {
  assert.equal(cockpitUiUpdateDue(1000, 0, 100), true);
  assert.equal(cockpitUiUpdateDue(1099, 1000, 100), false);
  assert.equal(cockpitUiUpdateDue(1100, 1000, 100), true);
  assert.equal(cockpitUiUpdateDue(10, 1000, 100), true);
});

test('grounded cockpit surface acquisition has a bounded wait', () => {
  assert.equal(cockpitSurfaceWaitExpired(5999, 1000, 5000), false);
  assert.equal(cockpitSurfaceWaitExpired(6000, 1000, 5000), true);
});

test('cockpit anchor correction cannot turn a forward step into a reversal', () => {
  const speedMps = 200;
  const dtSec = 0.1;
  const forwardStepM = speedMps * dtSec;
  const backwardCorrectionM = cockpitAnchorCorrectionStep(1000, speedMps, dtSec);
  assert.ok(backwardCorrectionM > 0);
  assert.ok(backwardCorrectionM < forwardStepM);
});

test('cockpit anchor correction bounds late-fix catch-up and render stalls', () => {
  assert.ok(cockpitAnchorCorrectionStep(5000, 250, 2) <= 5.5);
  assert.equal(cockpitAnchorCorrectionStep(0, 250, 0.1), 0);
  assert.equal(cockpitAnchorCorrectionStep(Number.NaN, 250, 0.1), 0);
});

test('cockpit camera clearance never falls below the rendered ground floor', () => {
  assert.equal(cockpitGroundSafeHeight(47, 57, 12), 69);
  assert.equal(cockpitGroundSafeHeight(1200, 57, 12), 1200);
  assert.equal(cockpitGroundSafeHeight(47, null, 12), 47);
  assert.equal(cockpitGroundSafeHeight(47, 57, -4), 57);
});

test('cockpit altitude reads zero on the ground without changing airborne MSL', () => {
  assert.equal(cockpitAltitudeDisplayFt(200.56, true), 0);
  assert.ok(Math.abs(cockpitAltitudeDisplayFt(3048, false) - 10000) < 0.01);
  assert.equal(cockpitAltitudeDisplayFt(null, false), null);
});

test('cockpit Context scope distinguishes radius-complete feeds from viewport installations', () => {
  assert.equal(
    formatCockpitContextScope('TEST123', 250000, 'CURRENT VIEWPORT ONLY'),
    'TEST123 · 250 KM AIR/SEA WINDOW · INSTALLATIONS CURRENT VIEWPORT ONLY',
  );
  assert.equal(
    formatCockpitContextScope('TEST123', 250000),
    'TEST123 · 250 KM AIR/SEA WINDOW',
  );
});

test('cockpit Context scope preserves zero and replaces missing values intentionally', () => {
  assert.equal(
    formatCockpitContextScope('', 0),
    '— · 0 KM AIR/SEA WINDOW',
  );
  assert.equal(
    formatCockpitContextScope(undefined, Number.NaN, {}),
    '— · — KM AIR/SEA WINDOW',
  );
});

test('altitude ruler chooses tighter intervals close to the surface', () => {
  assert.equal(altitudeRulerStep(1200), 100);
  assert.equal(altitudeRulerStep(9000), 250);
  assert.equal(altitudeRulerStep(34000), 500);
  assert.equal(altitudeRulerStep(Number.NaN), 500);
});

test('altitude ruler ticks move fractionally behind the fixed pointer', () => {
  const ticks = altitudeRulerTicks(34875);
  assert.equal(ticks.length, 9);
  assert.equal(ticks[4].valueFt, 34500);
  assert.equal(ticks[4].slot, -0.75);
  assert.equal(ticks[5].valueFt, 35000);
  assert.equal(ticks[5].slot, 0.25);
  assert.equal(ticks[5].major, true);
});

test('altitude ruler clamps below ground and formats fixed-width labels', () => {
  assert.equal(altitudeRulerTicks(-20)[4].valueFt, 0);
  assert.equal(formatAltitudeRulerTick(900), '00900');
  assert.equal(formatAltitudeRulerTick(34874.6), '34875');
  assert.equal(formatAltitudeRulerTick(null), '-----');
});

test('altitude ruler curve follows the circular keyhole at wide aspect ratios', () => {
  assert.equal(altitudeRulerCurveInset(0), 0);
  assert.equal(altitudeRulerCurveInset(-4), altitudeRulerCurveInset(4));
  assert.ok(Math.abs(altitudeRulerCurveInset(4) - 0.231625) < 0.00001);
});

test('speed ruler chooses useful taxi, regional, and cruise intervals', () => {
  assert.equal(speedRulerStep(45), 10);
  assert.equal(speedRulerStep(180), 20);
  assert.equal(speedRulerStep(460), 25);
  assert.equal(speedRulerStep(Number.NaN), 25);
});

test('speed ruler ticks move smoothly behind a fixed pointer', () => {
  const ticks = speedRulerTicks(467);
  assert.equal(ticks.length, 9);
  assert.equal(ticks[4].valueKt, 450);
  assert.ok(Math.abs(ticks[4].slot + 0.68) < 0.00001);
  assert.equal(ticks[5].valueKt, 475);
  assert.ok(Math.abs(ticks[5].slot - 0.32) < 0.00001);
  assert.equal(formatSpeedRulerTick(8), '008');
  assert.equal(formatSpeedRulerTick(null), '---');
});

test('normalizeHeading wraps negative and oversized courses', () => {
  assert.equal(normalizeHeading(-1), 359);
  assert.equal(normalizeHeading(721), 1);
});

test('slewHeading follows the shortest arc across north', () => {
  assert.equal(slewHeading(350, 10, 5), 355);
  assert.equal(slewHeading(10, 350, 5), 5);
});

test('compass divisions remain ordered across north', () => {
  assert.deepEqual(compassDivisions(359), [270, 300, 330, 0, 30, 60, 90]);
});

test('compass labels use cardinals where exact and degrees elsewhere', () => {
  assert.equal(formatCompassDivision(270), 'W');
  assert.equal(formatCompassDivision(30), '030');
});

test('great-circle bearing resolves cardinal directions', () => {
  assert.ok(Math.abs(bearingBetweenCoordinates(0, 0, 1, 0) - 0) < 0.001);
  assert.ok(Math.abs(bearingBetweenCoordinates(0, 0, 0, 1) - 90) < 0.001);
  assert.equal(bearingBetweenCoordinates(0, 0, 0, 0), null);
});

test('relative bearing stays on the shortest signed arc', () => {
  assert.equal(relativeBearing(10, 350), 20);
  assert.equal(relativeBearing(350, 10), -20);
  assert.equal(relativeBearing(180, 0), -180);
  assert.equal(relativeBearing(null, 0), null);
});

test('HUD rail layout centers between intersecting upper and lower obstacles', () => {
  assert.deepEqual(resolveHudRailLayout({
    viewportHeight: 1000,
    panelHeight: 200,
    laneLeft: 50,
    laneRight: 410,
    baseTop: 280,
    baseBottom: 940,
    gap: 10,
    obstacles: [
      { left: 40, right: 240, top: 320, bottom: 460 },
      { left: 300, right: 1000, top: 780, bottom: 930 },
      { left: 900, right: 1100, top: 300, bottom: 700 },
    ],
  }), {
    top: 520,
    maxHeight: 300,
    safeTop: 470,
    safeBottom: 770,
    constrained: false,
  });
});

test('HUD rail layout constrains an oversized panel to the safe corridor', () => {
  const layout = resolveHudRailLayout({
    viewportHeight: 800,
    panelHeight: 300,
    laneLeft: 20,
    laneRight: 340,
    baseTop: 250,
    baseBottom: 700,
    obstacles: [{ left: 0, right: 350, top: 500, bottom: 760 }],
  });
  assert.equal(layout.top, 250);
  assert.equal(layout.maxHeight, 238);
  assert.equal(layout.constrained, true);
});

test('HUD rail layout can anchor controls to the start of the safe corridor', () => {
  const layout = resolveHudRailLayout({
    viewportHeight: 1000,
    panelHeight: 100,
    laneLeft: 900,
    laneRight: 1250,
    baseTop: 260,
    baseBottom: 940,
    align: 'start',
  });
  assert.equal(layout.top, 260);
  assert.equal(layout.safeTop, 260);
  assert.equal(layout.safeBottom, 940);
});

// --- Contact panel readout (Monday recording bug: NEXT onto a non-aircraft) ---

const TRACKED_INFO = Object.freeze({
  layerId: 'flights',
  icao24: 'aaa077',
  latitude: 30.2,
  longitude: -97.7,
});

function contextSnapshot(subject, extra = {}) {
  return {
    subject,
    evaluatedAt: 1_700_000_000_000,
    radiusM: 250_000,
    cohorts: [],
    navigation: { canPrevious: true, canNext: true },
    ...extra,
  };
}

test('Contact panel hides only when there is no snapshot at all', () => {
  const readout = resolveCockpitContextReadout({ snapshot: null, info: TRACKED_INFO });
  assert.equal(readout.visible, false);
  assert.equal(readout.mode, 'standby');
  assert.equal(
    resolveCockpitContextReadout({ info: TRACKED_INFO }).visible,
    false,
    'a missing snapshot argument is the same standby case',
  );
});

test('Contact panel survives NEXT onto a vessel or installation subject', () => {
  // The panel owns the NEXT button. Hiding it because the subject is not the
  // tracked aircraft strands the operator with no way back (this was observed on
  // camera: "click next... whole left panel disappears").
  for (const subject of [
    { layerId: 'ais-live-vessels', id: '353136000', label: 'MAERSK DETROIT' },
    { layerId: 'military-installations', id: 'fort-hood', label: 'FORT CAVAZOS' },
    { layerId: 'military', id: 'ae01ce', label: 'RCH451' },
  ]) {
    const readout = resolveCockpitContextReadout({
      snapshot: contextSnapshot(subject),
      info: TRACKED_INFO,
    });
    assert.equal(readout.visible, true, `${subject.layerId} subject must keep the panel up`);
    assert.equal(readout.mode, 'foreign');
    assert.equal(readout.subjectMatchesTracked, false);
  }
});

test('a foreign subject dashes the aircraft-relative fields and keeps the rest live', () => {
  const readout = resolveCockpitContextReadout({
    snapshot: contextSnapshot({ layerId: 'ais-live-vessels', id: '353136000', label: 'MAERSK DETROIT' }),
    info: TRACKED_INFO,
  });
  assert.equal(readout.visible, true);
  assert.equal(readout.mode, 'foreign');
  // Nose-relative direction/bearing are measured in the tracked aircraft's own
  // frame while every other row value is measured from the subject; rendering
  // both live would present one mixed-frame reading as a single measurement.
  assert.equal(readout.aircraftRelative, false);
  assert.equal(readout.contactLost, false, 'subject-frame values still refresh');
});

test('the tracked aircraft as subject keeps every field in its own frame', () => {
  const readout = resolveCockpitContextReadout({
    snapshot: contextSnapshot({ layerId: 'flights', id: 'aaa077', label: 'SWA1234' }),
    info: TRACKED_INFO,
  });
  assert.equal(readout.visible, true);
  assert.equal(readout.mode, 'tracked');
  assert.equal(readout.subjectMatchesTracked, true);
  assert.equal(readout.aircraftRelative, true);
  assert.equal(readout.contactLost, false);
});

test('a fast-culled subject keeps the panel up as CONTACT LOST instead of collapsing it', () => {
  for (const subject of [
    { layerId: 'flights', id: 'aaa077', label: 'SWA1234' },
    { layerId: 'ais-live-vessels', id: '353136000', label: 'MAERSK DETROIT' },
  ]) {
    const readout = resolveCockpitContextReadout({
      snapshot: contextSnapshot(subject, { subjectPresent: false }),
      info: TRACKED_INFO,
    });
    assert.equal(readout.visible, true, 'a lost contact must not take the panel down');
    assert.equal(readout.mode, 'lost');
    assert.equal(readout.contactLost, true, 'last-known values stay on screen');
  }
});

test('an explicitly present subject is never reported lost', () => {
  const present = resolveCockpitContextReadout({
    snapshot: contextSnapshot({ layerId: 'flights', id: 'aaa077' }, { subjectPresent: true }),
    info: TRACKED_INFO,
  });
  assert.equal(present.contactLost, false);
  assert.equal(present.mode, 'tracked');
  // Snapshots from before the presence field existed must not read as lost.
  const legacy = resolveCockpitContextReadout({
    snapshot: contextSnapshot({ layerId: 'flights', id: 'aaa077' }),
    info: TRACKED_INFO,
  });
  assert.equal(legacy.contactLost, false);
});

test('the tracked flight layer is resolved by normalized tracked identity', () => {
  const civilian = { icao24: 'aaa077', callsign: 'SWA1234' };
  const military = { icao24: 'ae01ce', callsign: 'RCH451' };
  // Both layers describe a tracked aircraft during a cross-layer handoff;
  // civilian-first precedence would hand the cockpit the wrong aircraft.
  assert.equal(
    resolveTrackedAircraftInfo({ civilian, military, trackedId: 'military:ae01ce' }).layerId,
    'military',
  );
  assert.equal(
    resolveTrackedAircraftInfo({ civilian, military, trackedId: 'military:ae01ce' }).icao24,
    'ae01ce',
  );
  assert.equal(
    resolveTrackedAircraftInfo({ civilian, military, trackedId: 'flights:aaa077' }).layerId,
    'flights',
  );
  // Case-insensitive: layers stamp lowercase hex, callers may not.
  assert.equal(
    resolveTrackedAircraftInfo({ civilian, military, trackedId: 'MILITARY:AE01CE' }).layerId,
    'military',
  );
});

test('tracked-identity resolution falls back to layer precedence', () => {
  const civilian = { icao24: 'aaa077' };
  const military = { icao24: 'ae01ce' };
  // No stamped identity (or one that matches neither layer) keeps the historic
  // civilian-first order so tracking paths without gevTrackedId still work.
  assert.equal(resolveTrackedAircraftInfo({ civilian, military }).layerId, 'flights');
  assert.equal(
    resolveTrackedAircraftInfo({ civilian, military, trackedId: 'satellites:25544' }).layerId,
    'flights',
  );
  assert.equal(resolveTrackedAircraftInfo({ military, trackedId: '' }).layerId, 'military');
  assert.equal(resolveTrackedAircraftInfo({ trackedId: 'flights:aaa077' }), null);
  assert.equal(resolveTrackedAircraftInfo(), null);
});
