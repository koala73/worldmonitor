import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { gstime } from 'satellite.js';
import rocketLaunchesLayer, {
  _setRocketMissionOverlayHostForTest,
  _setSelectedRocketMissionForTest,
  approximateOrbitPath,
  buildMissionPaths,
  cameraHeadingForPath,
  compactLaunchSiteName,
  createRocketMissionElementOverlayEntry,
  createRocketMissionMarkerOverlayEntry,
  formatMissionEventTime,
  LAUNCH_PAD_ZONE_RADIUS_M,
  launchPadZoneVisible,
  launchStatusAllowsOrbit,
  missionAnchorHorizonVisible,
  missionAnchorVisible,
  missionHoverPreviewRange,
  missionDataCompleteness,
  missionMarkerColor,
  missionPathPresentation,
  missionRosterEntries,
  missionZoomPitch,
  orbitProgressAtTime,
  normalizeReplaySpeed,
  normalizeRocketLaunches,
  parseMissionDurationSeconds,
  replayState,
  replayCameraView,
  replayChaseCameraHeading,
  replayOrbitFrameSphere,
  replayOrbitGlobeAnchor,
  replayOrbitCameraTarget,
  replayOrbitCameraPose,
  replayOrbitGlobeRange,
  replayOverlayMode,
  replayInitialCameraHeading,
  smoothReplayWindowPosition,
  replayAscentDurationSeconds,
  replayStartAfterPause,
  replayVehicleScreenRotation,
  releaseAircraftTracking,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  samplePath,
  satelliteParamsAfterSpaceMissions,
  satelliteParamsForSpaceMissions,
  shouldRetryAfterActiveTle,
  selectRocketMissionMarkerOverlayCohort,
  smoothReplayCameraHeading,
} from './rocketLaunches.js';
import {
  findSatelliteOrbitTrackInTle,
  orbitFrameModelMatrix,
  satelliteCatalogModeChanged,
  scoreSatelliteNameMatch,
} from './satellites.js';

const NOW = new Date('2026-07-27T00:00:00Z');

test('mission anchors are hidden behind Earth and restored on the facing hemisphere', () => {
  const camera = Cesium.Cartesian3.fromDegrees(-75, 20, 18000000);
  const front = Cesium.Cartesian3.fromDegrees(-75, 20);
  const rear = Cesium.Cartesian3.fromDegrees(105, -20);
  assert.equal(missionAnchorHorizonVisible(camera, front), true);
  assert.equal(missionAnchorHorizonVisible(camera, rear), false);
});

test('selecting one mission hides every other front-facing launch anchor', () => {
  const camera = Cesium.Cartesian3.fromDegrees(-75, 20, 18000000);
  const first = Cesium.Cartesian3.fromDegrees(-75, 20);
  const second = Cesium.Cartesian3.fromDegrees(-80, 25);

  assert.equal(missionAnchorVisible(camera, first, 'first', null), true);
  assert.equal(missionAnchorVisible(camera, second, 'second', null), true);
  assert.equal(missionAnchorVisible(camera, first, 'first', 'first'), true);
  assert.equal(missionAnchorVisible(camera, second, 'second', 'first'), false);
});

test('advances the live orbit marker between whole seconds', () => {
  assert.equal(orbitProgressAtTime(10_000, 100), 0.1);
  assert.equal(orbitProgressAtTime(10_250, 100), 0.1025);
  assert.ok(orbitProgressAtTime(10_250, 100) > orbitProgressAtTime(10_000, 100));
});

test('samples replay paths uniformly by distance rather than vertex count', () => {
  const path = [
    new Cesium.Cartesian3(0, 0, 0),
    new Cesium.Cartesian3(1, 0, 0),
    new Cesium.Cartesian3(101, 0, 0),
  ];
  assert.ok(Math.abs(samplePath(path, 0.5).x - 50.5) < 1e-9);
  assert.ok(Math.abs(samplePath(path, 0.75).x - 75.75) < 1e-9);
});

test('transitions selected mission zoom from globe nadir to an oblique site view', () => {
  assert.ok(Math.abs(missionZoomPitch(5000000) - Cesium.Math.toRadians(-90)) < 1e-10);
  assert.ok(Math.abs(missionZoomPitch(180000) - Cesium.Math.toRadians(-42)) < 1e-10);
  const midPitch = Cesium.Math.toDegrees(missionZoomPitch(1000000));
  assert.ok(midPitch < -42 && midPitch > -90);
});

test('pulls replay camera from close ascent tracking into a globe-scale orbit view', () => {
  const ascent = replayCameraView({ ascending: true, phaseProgress: 0.9 }, 120000);
  const contextualAscent = replayCameraView({ ascending: true, phaseProgress: 0.9 }, 420000);
  const orbitStart = replayCameraView({ ascending: false, phaseProgress: 0 }, 550000);
  const orbitMidPullback = replayCameraView({ ascending: false, phaseProgress: 0.1 }, 550000);
  const orbitGlobe = replayCameraView({ ascending: false, phaseProgress: 0.2 }, 550000);

  assert.ok(ascent.pitch < Cesium.Math.toRadians(-20));
  assert.ok(ascent.pitch > Cesium.Math.toRadians(-34));
  assert.ok(contextualAscent.range > 1000000);
  assert.equal(contextualAscent.pitch, Cesium.Math.toRadians(-34));
  assert.equal(orbitStart.pitch, Cesium.Math.toRadians(-34));
  assert.ok(orbitMidPullback.range > orbitStart.range);
  assert.ok(orbitMidPullback.pitch < orbitStart.pitch);
  assert.equal(orbitGlobe.range, 18000000);
  assert.equal(orbitGlobe.pitch, Cesium.Math.toRadians(-45));
});

test('limits replay camera yaw through heading wraps', () => {
  const previous = Cesium.Math.toRadians(359);
  const desired = Cesium.Math.toRadians(181);
  const next = smoothReplayCameraHeading(previous, desired);
  assert.ok(Math.abs(Cesium.Math.negativePiToPi(next - previous)) <= Cesium.Math.toRadians(2));

  const wrapped = smoothReplayCameraHeading(
    Cesium.Math.toRadians(359),
    Cesium.Math.toRadians(1),
  );
  assert.ok(Cesium.Math.negativePiToPi(wrapped - previous) > 0);
});

test('starts replay camera broadside to the ascent path', () => {
  const path = [
    Cesium.Cartesian3.fromDegrees(-120, 34, 0),
    Cesium.Cartesian3.fromDegrees(-120, 35, 1000),
  ];
  const chaseHeading = cameraHeadingForPath(path, 0);
  const heading = replayInitialCameraHeading(path);
  assert.ok(Math.abs(Cesium.Math.negativePiToPi(chaseHeading)) < 0.02);
  assert.ok(Math.abs(Cesium.Math.negativePiToPi(heading - Cesium.Math.toRadians(90))) < 0.02);
});

test('keeps the chase camera in a rear-quarter view of the forward path', () => {
  assert.ok(Math.abs(
    Cesium.Math.negativePiToPi(replayChaseCameraHeading(0, 0) - Cesium.Math.toRadians(30)),
  ) < 1e-10);
  assert.ok(Math.abs(
    Cesium.Math.negativePiToPi(replayChaseCameraHeading(0, 1) - Cesium.Math.toRadians(45)),
  ) < 1e-10);
});

test('centers orbit follow on a globe-side anchor while retaining vehicle clearance', () => {
  const position = Cesium.Cartesian3.fromDegrees(20, 10, 550000);
  const anchor = replayOrbitGlobeAnchor(position, 1);
  const anchorHeight = Cesium.Ellipsoid.WGS84.cartesianToCartographic(anchor).height;
  assert.ok(Math.abs(anchorHeight - 55000) < 1);
  const target = replayOrbitCameraTarget(anchor, Cesium.Cartesian3.ZERO, 1);
  assert.ok(Cesium.Cartesian3.magnitude(target) > Cesium.Ellipsoid.WGS84.maximumRadius * 0.3);
  assert.ok(Cesium.Cartesian3.distance(target, anchor) > 0);
  assert.ok(Cesium.Cartesian3.distance(target, anchor) < Cesium.Cartesian3.magnitude(anchor));
  assert.equal(replayOrbitGlobeRange(18000000, 550000, 1), 18000000);
  assert.ok(replayOrbitGlobeRange(18000000, 35786000, 1) > 50000000);
});

test('keeps the forward orbit tangent moving toward screen-left', () => {
  const earthRadius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const position = new Cesium.Cartesian3(earthRadius + 550000, 0, 0);
  const tangentPosition = new Cesium.Cartesian3(earthRadius + 550000, 10000, 0);
  const target = new Cesium.Cartesian3(earthRadius * 0.35, 0, 0);
  const pose = replayOrbitCameraPose(
    position,
    tangentPosition,
    target,
    18000000,
    Cesium.Math.toRadians(-45),
  );
  assert.ok(pose);
  const screenRight = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(pose.direction, pose.up, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const tangent = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(
      tangentPosition,
      position,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.dot(screenRight, tangent) < -0.999);
  assert.ok(Math.abs(
    Cesium.Cartesian3.distance(pose.destination, target) - 18000000,
  ) < 1e-5);
});

test('frames the complete high-apogee orbit together with Earth', () => {
  const earthRadius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const orbit = [
    new Cesium.Cartesian3(earthRadius + 300000, 0, 0),
    new Cesium.Cartesian3(0, earthRadius + 35786000, 0),
    new Cesium.Cartesian3(-(earthRadius + 300000), 0, 0),
    new Cesium.Cartesian3(0, -(earthRadius + 35786000), 0),
  ];
  const frame = replayOrbitFrameSphere(orbit);
  const range = replayOrbitGlobeRange(18000000, 300000, 1, frame.radius);
  assert.ok(frame.radius > earthRadius + 30000000);
  assert.ok(range >= frame.radius * 3);
});

test('holds the completed replay on its final orbit frame instead of wrapping to launch', () => {
  const launch = { launchTime: '2026-07-01T00:00:00Z', timeline: [] };
  const completed = replayState(
    launch,
    0,
    12,
    28,
    5400,
    1,
    40000,
    0,
    false,
  );
  assert.equal(completed.ascending, false);
  assert.ok(completed.phaseProgress > 0.999);
});

test('smooths small replay marker reprojection jitter but snaps camera jumps', () => {
  const smoothed = smoothReplayWindowPosition({ x: 100, y: 100 }, { x: 104, y: 103 });
  assert.ok(smoothed.x > 100 && smoothed.x < 104);
  assert.deepEqual(
    smoothReplayWindowPosition({ x: 100, y: 100 }, { x: 140, y: 100 }),
    { x: 140, y: 100 },
  );
});

test('shows the screen-space rocket only while replay is active', () => {
  assert.equal(replayOverlayMode({
    replayActive: false,
    closeSelected: false,
    ascending: true,
    countdownActive: false,
  }), null);
  assert.equal(replayOverlayMode({
    replayActive: false,
    closeSelected: true,
    ascending: false,
    countdownActive: false,
  }), null);
  assert.equal(replayOverlayMode({
    replayActive: true,
    closeSelected: false,
    ascending: true,
    countdownActive: true,
  }), 'countdown');
  assert.equal(replayOverlayMode({
    replayActive: true,
    closeSelected: false,
    ascending: true,
    countdownActive: false,
  }), 'ascent');
  assert.equal(replayOverlayMode({
    replayActive: true,
    closeSelected: false,
    ascending: false,
    countdownActive: false,
  }), 'orbit');
});

test('aligns the replay rocket nose to the projected path tangent', () => {
  assert.equal(replayVehicleScreenRotation({ x: 10, y: 10 }, { x: 10, y: 0 }), 0);
  assert.ok(Math.abs(
    replayVehicleScreenRotation({ x: 10, y: 10 }, { x: 20, y: 10 })
      - Math.PI / 2,
  ) < 1e-10);
  assert.ok(Math.abs(
    replayVehicleScreenRotation({ x: 10, y: 10 }, { x: 0, y: 10 })
      + Math.PI / 2,
  ) < 1e-10);
});

test('clamps and snaps ascent replay speed to supported quarter steps', () => {
  assert.equal(normalizeReplaySpeed(0.1), 0.25);
  assert.equal(normalizeReplaySpeed(0.62), 0.5);
  assert.equal(normalizeReplaySpeed('1.75'), 1.75);
  assert.equal(normalizeReplaySpeed(8), 4);
  assert.equal(normalizeReplaySpeed('invalid'), 1);
});

test('shifts replay start time so pause duration does not advance the mission', () => {
  assert.equal(replayStartAfterPause(1000, 4000, 9500), 6500);
  assert.equal(replayStartAfterPause(1000, 9500, 4000), 1000);
  assert.equal(replayStartAfterPause(1000, Number.NaN, 9500), 1000);
});

test('restores the complete standalone Satellite style after mission mode', () => {
  const standalone = {
    catalog: 'core',
    showPoints: true,
    showOrbits: true,
    labelDensity: 'operator',
  };
  assert.deepEqual(satelliteParamsForSpaceMissions(standalone), {
    ...standalone,
    catalog: 'dense',
    showPoints: false,
    showOrbits: false,
  });
  assert.deepEqual(satelliteParamsAfterSpaceMissions(standalone), standalone);
  assert.deepEqual(satelliteParamsAfterSpaceMissions(null), {
    catalog: 'core',
    showPoints: true,
    showOrbits: true,
  });
});

test('suppresses every orbital representation for failed launches', () => {
  assert.equal(launchStatusAllowsOrbit('Launch Successful'), true);
  assert.equal(launchStatusAllowsOrbit('Go for Launch'), true);
  assert.equal(launchStatusAllowsOrbit('Launch Failure'), false);
  assert.equal(launchStatusAllowsOrbit('Partial Failure'), false);
  assert.equal(launchStatusAllowsOrbit('Failed'), false);
});

test('keeps failed-launch mission details truthful without inventing paths', () => {
  assert.deepEqual(missionPathPresentation({
    status: 'Launch Failure',
    orbit: { name: 'Geostationary Transfer Orbit' },
    trajectory: [],
  }, false), {
    orbit: 'PLANNED · Geostationary Transfer Orbit',
    ascent: 'UNAVAILABLE',
    replayAvailable: false,
  });
  assert.deepEqual(missionPathPresentation({
    status: 'Partial Failure',
    orbit: { name: 'Low Earth Orbit' },
    trajectory: [
      { latitude: 28.5, longitude: -80.5 },
      { latitude: 29, longitude: -79.5 },
    ],
  }, false), {
    orbit: 'PLANNED · Low Earth Orbit',
    ascent: 'SUPPLIED TRAJECTORY POINTS',
    replayAvailable: false,
  });
});

test('describes only renderable successful mission paths', () => {
  assert.deepEqual(missionPathPresentation({
    status: 'Launch Successful',
    orbit: { name: 'Low Earth Orbit' },
    trajectory: [],
  }, true), {
    orbit: 'Low Earth Orbit',
    ascent: 'RECONSTRUCTED ESTIMATE',
    replayAvailable: true,
  });
  assert.deepEqual(missionPathPresentation({
    status: 'Launch Successful',
    orbit: null,
    trajectory: [{ latitude: 28.5, longitude: -80.5 }],
  }, false), {
    orbit: null,
    ascent: 'UNAVAILABLE',
    replayAvailable: false,
  });
});

test('bounds the post-TLE refresh to one resolved-catalog rebuild', () => {
  const base = {
    enabled: true,
    retryCount: 0,
    activeTleText: 'ACTIVE TLE',
    renderedTleText: null,
  };
  assert.equal(shouldRetryAfterActiveTle(base), true);
  assert.equal(shouldRetryAfterActiveTle({ ...base, retryCount: 1 }), false);
  assert.equal(shouldRetryAfterActiveTle({ ...base, activeTleText: null }), false);
  assert.equal(shouldRetryAfterActiveTle({ ...base, renderedTleText: 'ACTIVE TLE' }), false);
  assert.equal(shouldRetryAfterActiveTle({ ...base, enabled: false }), false);
});

test('replay releases aircraft tracking through both owning layer APIs', () => {
  const calls = [];
  const dataManager = {
    layers: new Map([
      ['flights', { module: { stopTracking: () => calls.push('flights') } }],
      ['military', { module: { stopTracking: () => calls.push('military') } }],
      ['satellites', { module: { stopTracking: () => calls.push('satellites') } }],
    ]),
  };
  assert.equal(releaseAircraftTracking(dataManager), 2);
  assert.deepEqual(calls, ['flights', 'military']);
});

test('uses the core GMST frame transform for mission orbit primitives', () => {
  const bakeDate = new Date('2026-07-20T10:00:00Z');
  const nowDate = new Date('2026-07-20T10:10:00Z');
  const gmstAtBake = gstime(bakeDate);
  const matrix = orbitFrameModelMatrix(gmstAtBake, nowDate);
  const actual = Cesium.Matrix4.multiplyByPoint(
    matrix,
    Cesium.Cartesian3.UNIT_X,
    new Cesium.Cartesian3(),
  );
  const expectedAngle = -(gstime(nowDate) - gmstAtBake);
  assert.ok(Math.abs(actual.x - Math.cos(expectedAngle)) < 1e-12);
  assert.ok(Math.abs(actual.y - Math.sin(expectedAngle)) < 1e-12);
  assert.ok(Math.abs(actual.z) < 1e-12);
});

test('treats an already-active Satellite catalog mode as idempotent', () => {
  assert.equal(satelliteCatalogModeChanged('dense', 'dense'), false);
  assert.equal(satelliteCatalogModeChanged('core', 'core'), false);
  assert.equal(satelliteCatalogModeChanged('core', 'dense'), true);
  assert.equal(satelliteCatalogModeChanged('dense', 'core'), true);
  assert.equal(satelliteCatalogModeChanged('core', undefined), false);
});

test('holds replay at the pad for a real-time countdown independent of replay speed', () => {
  const launch = { launchTime: '2026-07-20T10:00:00Z', timeline: [] };
  const tilePreparation = replayState(launch, 115000, 12, 28, 5400, 4, 100000, 5);
  assert.equal(tilePreparation.preCountdownActive, true);
  assert.equal(tilePreparation.countdownActive, false);
  const countdown = replayState(launch, 110000, 12, 28, 5400, 4, 100000);
  assert.equal(countdown.countdownActive, true);
  assert.equal(countdown.countdownSeconds, 10);
  assert.equal(countdown.elapsedSinceStart, 0);
  assert.equal(countdown.phaseProgress, 0);

  const liftoff = replayState(launch, 110000, 12, 28, 5400, 4, 110500);
  assert.equal(liftoff.countdownActive, false);
  assert.equal(liftoff.countdownSeconds, 0);
  assert.equal(liftoff.elapsedSinceStart, 2);
  assert.ok(liftoff.phaseProgress > 0);
});

test('hands replay directly from ascent into orbit', () => {
  const launch = { launchTime: '2026-07-20T10:00:00Z', timeline: [] };
  const orbit = replayState(launch, 0, 12, 28, 5400, 1, 16_000);
  assert.equal(orbit.ascending, false);
  assert.equal(orbit.phaseProgress, 4 / 28);
});

test('shows launch-pad zone only for the selected close-range mission', () => {
  assert.equal(LAUNCH_PAD_ZONE_RADIUS_M, 500);
  const closeSelected = {
    layerActive: true,
    selectedLaunchId: 'mission-a',
    launchId: 'mission-a',
    cameraHeightM: 12000,
    cameraDistanceM: 14000,
  };
  assert.equal(launchPadZoneVisible(closeSelected), true);
  assert.equal(launchPadZoneVisible({ ...closeSelected, layerActive: false }), false);
  assert.equal(launchPadZoneVisible({ ...closeSelected, selectedLaunchId: 'mission-b' }), false);
  assert.equal(launchPadZoneVisible({ ...closeSelected, cameraHeightM: 120001 }), false);
  assert.equal(launchPadZoneVisible({ ...closeSelected, cameraDistanceM: 180001 }), false);
});

test('orders mission roster newest-first without losing navigation indices', () => {
  const entries = missionRosterEntries([
    { id: 'oldest', launchTime: '2026-07-01T00:00:00Z' },
    { id: 'newest', launchTime: '2026-07-20T00:00:00Z' },
    { id: 'middle', launchTime: '2026-07-10T00:00:00Z' },
  ]);
  assert.deepEqual(entries.map((entry) => entry.launch.id), ['newest', 'middle', 'oldest']);
  assert.deepEqual(entries.map((entry) => entry.index), [1, 2, 0]);
});

test('prioritizes data-rich missions before newer sparse records', () => {
  const entries = missionRosterEntries([
    { id: 'rich', launchTime: '2026-07-01T00:00:00Z', provider: 'Agency', mission: 'Detailed mission', orbit: { name: 'LEO' }, payloads: [{ name: 'Payload' }], timeline: [{ name: 'Liftoff' }] },
    { id: 'sparse-new', launchTime: '2026-07-20T00:00:00Z' },
  ]);
  assert.ok(missionDataCompleteness(entries[0].launch) > missionDataCompleteness(entries[1].launch));
  assert.equal(entries[0].launch.id, 'rich');
});

test('preserves globe scale for roster hover previews', () => {
  assert.equal(missionHoverPreviewRange(18178265), 18178265);
  assert.equal(missionHoverPreviewRange(12000), 180000);
  assert.equal(missionHoverPreviewRange(Number.NaN), 5000000);
});

test('assigns distinct stable colors to mission operators', () => {
  assert.equal(missionMarkerColor({ provider: 'NASA', name: 'Science Flight' }).toCssColorString(), 'rgb(255,159,67)');
  assert.equal(missionMarkerColor({ provider: 'SpaceX', name: 'Starlink Group' }).toCssColorString(), 'rgb(76,201,240)');
  assert.equal(missionMarkerColor({ provider: 'Private Launch Co.', name: 'Test Flight' }).toCssColorString(), 'rgb(192,132,252)');
});

test('normalizes recent launches and preserves supplied trajectory/orbit data', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'recent-1',
    name: 'Test Flight',
    net: '2026-07-20T10:00:00Z',
    status: { name: 'Launch Successful' },
    pad: { name: 'Pad A', location: { name: 'Test Range', coordinates: '12.5,45.5' } },
    trajectory: [{ latitude: 45.5, longitude: 12.5, altitude: 0 }],
    timeline: [{ type: { abbrev: 'SECO-1' }, relative_time: 'PT8M40S' }],
    mission: { description: 'Payload test', orbit: { name: 'LEO' } },
  }] }, NOW);

  assert.equal(launches.length, 1);
  assert.equal(launches[0].lat, 45.5);
  assert.equal(launches[0].lon, 12.5);
  assert.equal(launches[0].orbit.name, 'LEO');
  assert.equal(launches[0].trajectory.length, 1);
  assert.equal(launches[0].timeline[0].offsetSeconds, 520);
});

test('uses Launch Library 2 pad latitude/longitude fields', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'pad-fields',
    net: '2026-07-20T10:00:00Z',
    pad: { latitude: '34.632', longitude: '-120.611', location: { name: 'Vandenberg' } },
  }] }, NOW);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].lat, 34.632);
  assert.equal(launches[0].lon, -120.611);
});

test('normalizes detailed payload and stage recovery records', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'recovery-details',
    name: 'Falcon 9 | Test Payload',
    net: '2026-07-20T10:00:00Z',
    pad: { latitude: '28.608', longitude: '-80.604', name: 'LC-39A' },
    rocket: {
      payloads: [{
        id: 501,
        destination: 'Low Earth Orbit',
        amount: 2,
        payload: {
          id: 91,
          name: 'TestSat',
          type: { name: 'Earth Observation Satellite' },
          manufacturer: { name: 'Example Space' },
          operator: { name: 'Example Operator' },
          mass: 420,
        },
      }],
      launcher_stage: [{
        id: 77,
        type: 'Core',
        reused: true,
        launcher_flight_number: 8,
        launcher: { serial_number: 'B1099' },
        landing: {
          attempt: true,
          success: true,
          downrange_distance: 610,
          type: { name: 'Autonomous Spaceport Drone Ship' },
          landing_location: {
            name: 'A Shortfall of Gravitas',
            latitude: '30.1',
            longitude: '-76.2',
          },
        },
      }],
    },
    mission: { orbit: { name: 'Low Earth Orbit' } },
  }] }, NOW);

  assert.equal(launches[0].payloads[0].name, 'TestSat');
  assert.equal(launches[0].payloads[0].amount, 2);
  assert.equal(launches[0].payloads[0].massKg, 420);
  assert.equal(launches[0].recoveryStages[0].name, 'Core · B1099');
  assert.equal(launches[0].recoveryStages[0].status, 'RECOVERED');
  assert.equal(launches[0].recoveryStages[0].downrangeKm, 610);
  assert.equal(launches[0].recoveryStages[0].lat, 30.1);
  assert.equal(launches[0].recoveryStages[0].lon, -76.2);
});

test('keeps payload and recovery collections empty when LL2 does not disclose them', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'undisclosed',
    net: '2026-07-20T10:00:00Z',
    pad: { latitude: '28.608', longitude: '-80.604' },
    rocket: {},
  }] }, NOW);
  assert.deepEqual(launches[0].payloads, []);
  assert.deepEqual(launches[0].recoveryStages, []);
});

test('excludes launches outside the rolling 30-day window and missing coordinates', () => {
  const launches = normalizeRocketLaunches({ results: [
    { id: 'old', net: '2026-06-26T00:00:00Z', pad: { location: { coordinates: '1,1' } } },
    { id: 'no-coordinates', net: '2026-07-20T00:00:00Z', pad: { location: {} } },
    { id: 'future', net: '2026-07-28T00:00:00Z', pad: { location: { coordinates: '1,1' } } },
  ] }, NOW);

  assert.deepEqual(launches, []);
});

test('accepts an array payload for proxy and fixture flexibility', () => {
  const launches = normalizeRocketLaunches([
    { id: 'array-1', net: '2026-07-01T00:00:00Z', pad: { location: { coordinates: '2,3' } } },
  ], NOW);
  assert.equal(launches[0].id, 'array-1');
});

test('builds a surface-safe ascent that meets the orbit without a phase jump', () => {
  const launch = Cesium.Cartesian3.fromDegrees(-120.61, 34.63, 0);
  const orbit = Array.from({ length: 37 }, (_, index) => {
    const longitude = -180 + index * 10;
    const latitude = Math.sin(Cesium.Math.toRadians(longitude)) * 35;
    return Cesium.Cartesian3.fromDegrees(longitude, latitude, 550000);
  });
  const paths = buildMissionPaths(launch, [], orbit);

  assert.ok(paths.ascentPath.length > 2);
  assert.equal(paths.ascentPath.at(-1), orbit[paths.insertionIndex]);
  assert.equal(paths.animatedOrbitPath[0], orbit[paths.insertionIndex]);
  assert.equal(paths.animatedOrbitPath.at(-1), paths.animatedOrbitPath[0]);
  const launchCartographic = Cesium.Cartographic.fromCartesian(paths.ascentPath[0]);
  const verticalCartographic = Cesium.Cartographic.fromCartesian(paths.ascentPath[12]);
  const earlyHorizontalDistance = new Cesium.EllipsoidGeodesic(
    launchCartographic,
    verticalCartographic,
  ).surfaceDistance;
  assert.ok(earlyHorizontalDistance < 2000);
  assert.ok(verticalCartographic.height > launchCartographic.height + 10000);
  const maximumTurn = Math.max(...paths.ascentPath.slice(1, -13).map((position, index) => {
    const incoming = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(position, paths.ascentPath[index], new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const outgoing = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(paths.ascentPath[index + 2], position, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    return Cesium.Math.acosClamped(Cesium.Cartesian3.dot(incoming, outgoing));
  }));
  assert.ok(Cesium.Math.toDegrees(maximumTurn) < 5);
  const ascentTangent = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(paths.ascentPath.at(-1), paths.ascentPath.at(-2), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const orbitTangent = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(paths.animatedOrbitPath[1], paths.animatedOrbitPath[0], new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.dot(ascentTangent, orbitTangent) > 0.7);
  for (const position of paths.ascentPath) {
    assert.ok(Cesium.Cartographic.fromCartesian(position).height >= -1);
  }
});

test('keeps a tangent-blended inclined ascent outside the globe', () => {
  const launch = Cesium.Cartesian3.fromDegrees(80, -60, 0);
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius + 200000;
  const inclination = Cesium.Math.toRadians(30);
  const orbit = Array.from({ length: 97 }, (_, index) => {
    const angle = (index / 96) * Cesium.Math.TWO_PI;
    return new Cesium.Cartesian3(
      radius * Math.cos(angle),
      radius * Math.sin(angle) * Math.cos(inclination),
      radius * Math.sin(angle) * Math.sin(inclination),
    );
  });
  const paths = buildMissionPaths(launch, [], orbit);
  const minimumHeight = Math.min(
    ...paths.ascentPath.map((position) => Cesium.Cartographic.fromCartesian(position).height),
  );

  assert.ok(minimumHeight >= -1);
  assert.equal(paths.ascentPath.at(-1), orbit[paths.insertionIndex]);
});

test('uses a propagated insertion reference instead of the radial nearest orbit point', () => {
  const launch = Cesium.Cartesian3.fromDegrees(-80.6, 28.5, 0);
  const orbit = approximateOrbitPath({
    lat: 28.5,
    lon: -80.6,
    orbit: { name: 'Low Earth Orbit' },
  });
  const targetIndex = 42;
  const paths = buildMissionPaths(launch, [], orbit, orbit[targetIndex]);
  assert.equal(paths.insertionIndex, targetIndex);
  assert.equal(paths.ascentPath.at(-1), orbit[targetIndex]);
  const finalAscent = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(paths.ascentPath.at(-1), paths.ascentPath.at(-2), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const firstOrbit = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(paths.animatedOrbitPath[1], paths.animatedOrbitPath[0], new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.dot(finalAscent, firstOrbit) > 0.7);
});

test('estimated mission orbit is a smooth planar ring', () => {
  const orbit = approximateOrbitPath({
    lat: 34.63,
    lon: -120.61,
    orbit: { name: 'Polar Orbit' },
  });
  const normal = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(orbit[0], orbit[24], new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const maximumPlaneResidual = Math.max(...orbit.map((position) => Math.abs(
    Cesium.Cartesian3.dot(
      normal,
      Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3()),
    ),
  )));
  assert.ok(maximumPlaneResidual < 1e-12);
  assert.ok(Cesium.Cartesian3.distance(orbit[0], orbit.at(-1)) < 1e-6);
});

test('projects a west-coast ascent forward into orbit without reversing course', () => {
  const launchInfo = {
    lat: 34.63,
    lon: -120.61,
    orbit: { name: 'Low Earth Orbit' },
  };
  const launch = Cesium.Cartesian3.fromDegrees(launchInfo.lon, launchInfo.lat, 0);
  const orbit = approximateOrbitPath(launchInfo);
  const firstDownrange = Cesium.Cartographic.fromCartesian(orbit[1]);
  assert.ok(Cesium.Math.toDegrees(firstDownrange.latitude) < launchInfo.lat);
  assert.ok(Cesium.Math.toDegrees(firstDownrange.longitude) < launchInfo.lon);

  const paths = buildMissionPaths(launch, [], orbit, orbit[10]);
  const minimumDirectionContinuity = Math.min(
    ...paths.ascentPath.slice(1, -1).map((position, index) => {
      const incoming = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(position, paths.ascentPath[index], new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      const outgoing = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(paths.ascentPath[index + 2], position, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      return Cesium.Cartesian3.dot(incoming, outgoing);
    }),
  );
  assert.ok(minimumDirectionContinuity > Math.cos(Cesium.Math.toRadians(5)));
});

test('formats the launch epoch for ascent and orbit replay labels', () => {
  assert.equal(
    formatMissionEventTime('2026-06-29T02:25:00Z'),
    '2026-06-29\n02:25:00 UTC',
  );
  assert.equal(formatMissionEventTime(null), 'UNAVAILABLE');
});

test('reduces generic launch-site names to their identifying suffix', () => {
  assert.equal(compactLaunchSiteName('Orbital Launch Pad 2'), '2');
  assert.equal(compactLaunchSiteName('Space Launch Complex 4E'), '4E');
  assert.equal(compactLaunchSiteName('Launch Area 130'), '130');
  assert.equal(
    compactLaunchSiteName('Satish Dhawan Space Centre First Launch Pad'),
    'Satish Dhawan Space Centre First Launch Pad',
  );
  assert.equal(compactLaunchSiteName('Unknown'), null);
});

test('mission overlay factories preserve all four source-formatted label roles and lane policy', () => {
  const position = Cesium.Cartesian3.fromDegrees(-80.604, 28.608);
  const launch = {
    id: 'mission-1',
    name: 'Falcon 9 | Gauntlet Payload',
    launchSite: 'Space Launch Complex 39A',
    launchTime: '2026-07-20T10:00:00Z',
  };
  const ambient = createRocketMissionMarkerOverlayEntry(launch, position);
  assert.deepEqual({
    title: ambient.title,
    details: ambient.details,
    paintLane: ambient.paintLane,
    protected: ambient.protected,
    edgeFade: ambient.edgeFade,
  }, {
    title: 'FALCON 9',
    details: [],
    paintLane: 'ambient-label',
    protected: false,
    edgeFade: 'keyhole',
  });

  const selected = createRocketMissionMarkerOverlayEntry(launch, position, true);
  assert.equal(selected.title, 'FALCON 9');
  assert.deepEqual(selected.details, ['LAUNCH SITE · 39A']);
  assert.equal(selected.paintLane, 'selected');
  assert.equal(selected.protected, true);

  const roles = [
    ['reentry', 'STAGE RE-ENTRY', '#ffd166', ['STAGE RE-ENTRY', []]],
    ['payload', 'EST. ORBIT POSITION\n2026-07-20\n10:00:00 UTC', '#ffd166', [
      'EST. ORBIT POSITION',
      ['2026-07-20', '10:00:00 UTC'],
    ]],
    ['orbit', 'PROJECTED ORBIT', '#c084fc', ['PROJECTED ORBIT', []]],
  ];
  for (const [id, text, accent, [title, details]] of roles) {
    const entry = createRocketMissionElementOverlayEntry({ id, position, text, accent });
    assert.equal(entry.title, title);
    assert.deepEqual(entry.details, details);
    assert.equal(entry.accent, accent);
    assert.equal(entry.paintLane, 'selected');
    assert.equal(entry.protected, true);
    assert.equal(entry.edgeFade, 'keyhole');
  }

  const surplus = Array.from(
    { length: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT + 12 },
    (_, index) => ({ id: `mission-${String(index).padStart(3, '0')}`, priority: index }),
  );
  const cohort = selectRocketMissionMarkerOverlayCohort(surplus);
  assert.equal(cohort.length, ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, 'mission-059');
  assert.equal(cohort.at(-1).id, 'mission-012');
});

test('parses signed Launch Library timeline durations', () => {
  assert.equal(parseMissionDurationSeconds('PT1H1M46S'), 3706);
  assert.equal(parseMissionDurationSeconds('-PT35M'), -2100);
  assert.equal(parseMissionDurationSeconds('P0D'), 0);
  assert.equal(parseMissionDurationSeconds('unknown'), null);
});

test('derives replay ascent duration from mission timing instead of a fixed constant', () => {
  const path = [
    Cesium.Cartesian3.fromDegrees(-120, 34, 0),
    Cesium.Cartesian3.fromDegrees(-116, 34, 200000),
  ];
  const fast = replayAscentDurationSeconds({
    timeline: [{ name: 'SECO-1', offsetSeconds: 360 }],
  }, path);
  const slow = replayAscentDurationSeconds({
    timeline: [{ name: 'Orbit insertion', offsetSeconds: 1200 }],
  }, path);
  assert.ok(slow > fast);
  assert.ok(fast >= 8 && slow <= 36);
});

test('matches compact payload identifiers without accepting an arbitrary constellation member', () => {
  assert.ok(scoreSatelliteNameMatch('Sirius SXM-11', 'SXM-11') >= 200);
  assert.ok(scoreSatelliteNameMatch('Starlink Group 17-40', 'STARLINK-1008') < 12);
});

test('finds a newly launched payload in the active TLE fallback catalog', () => {
  const tle = `SXM-11
1 69728U 26148A   26208.65166678  .00000015  00000+0  00000+0 0  9990
2 69728   0.0784 264.9826 0001797 240.4588 273.9506  1.00271527   440`;
  const track = findSatelliteOrbitTrackInTle(tle, 'Sirius SXM-11', {
    launchTime: '2026-06-29T02:25:00Z',
  });
  assert.equal(track?.noradId, 69728);
  assert.equal(track?.name, 'SXM-11');
  assert.ok(track?.orbitPath.length > 100);
  assert.ok(track?.periodSec > 80000);
  assert.ok(track?.current.speedMps > 1000);
  assert.ok(track?.current.speedMps < 12000);
  assert.equal(typeof track?.positionAt, 'function');
});

test('real mission build, select, refresh, deselect, disable, and destroy paths publish no native labels', async () => {
  const realDocument = globalThis.document;
  const realFetch = globalThis.fetch;
  const realHtmlCanvasElement = globalThis.HTMLCanvasElement;
  const realHtmlImageElement = globalThis.HTMLImageElement;
  const realImageBitmap = globalThis.ImageBitmap;
  const realOffscreenCanvas = globalThis.OffscreenCanvas;
  const listeners = new Map();
  const context = {
    strokeStyle: '',
    lineWidth: 1,
    lineCap: '',
    shadowColor: '',
    shadowBlur: 0,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.dataset = {};
      this.hidden = false;
      this.clientWidth = 1600;
      this.clientHeight = 900;
      this.width = 1600;
      this.height = 900;
      this.disableRootEvents = false;
    }

    addEventListener(type, handler) { listeners.set(`${this.tagName}:${type}`, handler); }
    removeEventListener(type) { listeners.delete(`${this.tagName}:${type}`); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      this.parentElement = null;
    }
    setAttribute() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 1600, height: 900 }; }
    getContext() { return this.tagName === 'CANVAS' ? context : null; }
  }
  const body = new FakeElement('body');
  const document = {
    body,
    onmousewheel: undefined,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: () => null,
    addEventListener(type, handler) { listeners.set(`document:${type}`, handler); },
    removeEventListener(type) { listeners.delete(`document:${type}`); },
  };
  const canvas = new FakeElement('canvas');
  const dataSources = [];
  const camera = {
    positionCartographic: null,
    positionWC: Cesium.Cartesian3.fromDegrees(-80.604, 28.608, 18_000_000),
    cancelFlight() {},
    lookAtTransform() {},
  };
  const scene = {
    canvas,
    camera,
    frameState: { frameNumber: 1 },
    postRender: new Cesium.Event(),
    preRender: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    primitives: { add: (primitive) => primitive, remove: () => true },
    drillPick: () => [],
  };
  const viewer = {
    camera,
    scene,
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    selectedEntity: undefined,
  };
  const hostCalls = [];
  const host = {
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  const launchTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let launchName = 'Falcon 9 | Gauntlet Payload';
  const launchPayload = () => ({ results: [{
    id: 'mission-runtime',
    name: launchName,
    net: launchTime,
    status: { name: 'Launch Successful' },
    pad: {
      latitude: '28.608',
      longitude: '-80.604',
      name: 'Space Launch Complex 39A',
    },
    rocket: {
      launcher_stage: [{
        id: 'booster-1',
        type: 'Core',
        landing: {
          attempt: true,
          success: true,
          downrange_distance: 600,
          landing_location: { latitude: '30.1', longitude: '-76.2' },
        },
      }],
    },
    mission: {
      name: 'Gauntlet Payload',
      orbit: { name: 'Low Earth Orbit' },
    },
  }] });
  globalThis.document = document;
  globalThis.HTMLCanvasElement = FakeElement;
  globalThis.HTMLImageElement = class {};
  globalThis.ImageBitmap = class {};
  globalThis.OffscreenCanvas = class {};
  globalThis.fetch = async (url) => {
    if (url === '/api/gev/celestrak/active') {
      return { ok: true, text: async () => '' };
    }
    assert.equal(url, '/api/gev/launches');
    return { ok: true, json: async () => launchPayload() };
  };
  _setRocketMissionOverlayHostForTest(host);
  let initialized = false;
  try {
    rocketLaunchesLayer.init(viewer);
    initialized = true;
    await rocketLaunchesLayer.enable();
    await rocketLaunchesLayer.update();

    const entities = dataSources[0].entities.values;
    assert.ok(entities.length >= 7, 'runtime guard requires the populated mission build path');
    assert.ok(entities.every((entity) => entity.label === undefined));
    const ambientPublication = hostCalls.findLast(([type, sourceId]) => (
      type === 'entries' && sourceId === ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID
    ));
    assert.ok(ambientPublication);
    assert.equal(ambientPublication[2].length, 1);
    assert.equal(ambientPublication[2][0].title, 'FALCON 9');
    assert.deepEqual(ambientPublication[3], {
      cohortLimit: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
      collisionCapacity: ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
    const launchEntity = dataSources[0].entities.getById('rocket-launch:mission-runtime');
    assert.deepEqual(
      ambientPublication[2][0].position,
      launchEntity.position.getValue(Cesium.JulianDate.now()),
      'ambient host marker must reuse the entity anchor Cartesian',
    );
    const frameTime = Cesium.JulianDate.now();
    scene.preRender.raiseEvent(scene, frameTime);
    assert.equal(launchEntity.point.show.getValue(frameTime), true);
    camera.positionWC = Cesium.Cartesian3.fromDegrees(99.396, -28.608, 18_000_000);
    scene.preRender.raiseEvent(scene, frameTime);
    assert.equal(
      launchEntity.point.show.getValue(frameTime),
      false,
      'pre-render horizon pass must hide a rear-side depth-free mission dot before draw and pick',
    );
    camera.positionWC = Cesium.Cartesian3.fromDegrees(-80.604, 28.608, 18_000_000);
    scene.preRender.raiseEvent(scene, frameTime);
    assert.equal(
      launchEntity.point.show.getValue(frameTime),
      true,
      'mission dot must return when its surface anchor faces the camera again',
    );

    _setSelectedRocketMissionForTest('mission-runtime');
    const selectedPublication = hostCalls.findLast(([type, sourceId]) => (
      type === 'entries' && sourceId === ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID
    ));
    assert.ok(selectedPublication);
    assert.deepEqual(selectedPublication[3], ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS);
    assert.deepEqual(selectedPublication[2].map(({ title }) => title), [
      'FALCON 9',
      'STAGE RE-ENTRY',
      'EST. ORBIT POSITION',
      'PROJECTED ORBIT',
    ]);
    assert.deepEqual(selectedPublication[2][0].details, ['LAUNCH SITE · 39A']);
    assert.match(selectedPublication[2][2].details[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.match(selectedPublication[2][2].details[1], /^\d{2}:\d{2}:\d{2} UTC$/);
    assert.ok(selectedPublication[2].every((entry) => (
      entry.selected === true
      && entry.protected === true
      && entry.paintLane === 'selected'
      && entry.edgeFade === 'keyhole'
    )));
    const satelliteEntity = dataSources[0].entities.getById('rocket-satellite:mission-runtime');
    const satellitePosition = satelliteEntity.position.getValue(Cesium.JulianDate.now());
    assert.equal(
      selectedPublication[2][2].position(),
      satellitePosition,
      'payload host getter must return the exact per-frame live-position cache',
    );

    // Jitter regression net: live-state propagation advances at most once per
    // frameNumber, and the host getter is a pure read that never advances it.
    // Without both halves, the host label and the native dot can propagate to
    // different wall-clock instants inside one frame — the documented
    // label-separation jitter class.
    const payloadEntry = selectedPublication[2][2];
    const realDateNow = Date.now;
    try {
      let nowMs = realDateNow();
      Date.now = () => nowMs;
      scene.frameState.frameNumber = 41;
      const frameA = Cesium.Cartesian3.clone(
        satelliteEntity.position.getValue(Cesium.JulianDate.now()),
      );
      nowMs += 30_000;
      assert.deepEqual(
        Cesium.Cartesian3.clone(satelliteEntity.position.getValue(Cesium.JulianDate.now())),
        frameA,
        'a second native read in the same frame must not re-propagate',
      );
      nowMs += 30_000;
      scene.frameState.frameNumber = 42;
      assert.deepEqual(
        Cesium.Cartesian3.clone(payloadEntry.position()),
        frameA,
        'host getter must not advance propagation, even on a new frame',
      );
      const frameB = Cesium.Cartesian3.clone(
        satelliteEntity.position.getValue(Cesium.JulianDate.now()),
      );
      assert.notDeepEqual(frameB, frameA, 'native read on a new frame propagates (non-vacuous)');
      assert.deepEqual(
        Cesium.Cartesian3.clone(payloadEntry.position()),
        frameB,
        'host getter reads the advanced cache after native propagation',
      );
    } finally {
      Date.now = realDateNow;
      scene.frameState.frameNumber = 1;
    }
    const reentryEntity = dataSources[0].entities.getById('rocket-reentry:mission-runtime:0');
    assert.deepEqual(
      selectedPublication[2][1].position,
      reentryEntity.polyline.positions.getValue(Cesium.JulianDate.now())[0],
      're-entry host label must reuse the recovery-path interface Cartesian',
    );
    const transferEntity = dataSources[0].entities.getById('rocket-transfer:mission-runtime');
    assert.deepEqual(
      selectedPublication[2][3].position,
      transferEntity.polyline.positions.getValue(Cesium.JulianDate.now()).at(-1),
      'orbit host label must reuse the insertion Cartesian',
    );

    launchName = 'Mission Refresh | Gauntlet Payload';
    await rocketLaunchesLayer.update();
    assert.ok(dataSources[0].entities.values.every((entity) => entity.label === undefined));
    const refreshPublication = hostCalls.findLast(([type, sourceId]) => (
      type === 'entries' && sourceId === ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID
    ));
    assert.equal(refreshPublication[2][0].title, 'MISSION REFRESH');
    assert.deepEqual(refreshPublication[2][0].details, ['LAUNCH SITE · 39A']);

    _setSelectedRocketMissionForTest(null);
    const deselectedPublication = hostCalls.findLast(([type, sourceId]) => (
      type === 'entries' && sourceId === ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID
    ));
    assert.equal(deselectedPublication[2][0].title, 'MISSION REFRESH');
    assert.equal(deselectedPublication[2][0].protected, false);

    await rocketLaunchesLayer.disable();
    assert.deepEqual(hostCalls.slice(-4), [
      ['clear', ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID],
      ['visible', ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID, false],
      ['clear', ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID],
      ['visible', ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID, false],
    ]);
    await rocketLaunchesLayer.destroy(viewer);
    initialized = false;
    assert.equal(dataSources.length, 0);
    assert.deepEqual(hostCalls.slice(-4), [
      ['clear', ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID],
      ['visible', ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID, false],
      ['clear', ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID],
      ['visible', ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID, false],
    ]);
  } finally {
    if (initialized) await rocketLaunchesLayer.destroy(viewer);
    _setRocketMissionOverlayHostForTest();
    globalThis.fetch = realFetch;
    globalThis.document = realDocument;
    globalThis.HTMLCanvasElement = realHtmlCanvasElement;
    globalThis.HTMLImageElement = realHtmlImageElement;
    globalThis.ImageBitmap = realImageBitmap;
    globalThis.OffscreenCanvas = realOffscreenCanvas;
  }
});

test('enable is transactional: a failed satellites dependency rolls the module back and a retry recaptures', async (t) => {
  const calls = [];
  let satellitesEnabled = false;
  let failNextActivation = true;
  const fakeManager = {
    isEnabled: (id) => (id === 'satellites' ? satellitesEnabled : false),
    getLayerParams: () => ({}),
    setLayerParams: () => {},
    setEnabled: (id, enabled) => {
      calls.push(['setEnabled', id, enabled]);
      if (id === 'satellites' && enabled && failNextActivation) {
        return Promise.resolve(false); // activation refused/failed
      }
      if (id === 'satellites') satellitesEnabled = enabled;
      return Promise.resolve(true);
    },
  };
  const priorDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  rocketLaunchesLayer.attachDataManager(fakeManager);
  t.after(() => {
    globalThis.document = priorDocument;
    rocketLaunchesLayer.attachDataManager(null);
  });

  // First enable: dependency activation fails -> enable() must reject and the
  // module must roll itself back (satellite snapshot restored AND cleared).
  await assert.rejects(() => rocketLaunchesLayer.enable(), /satellites layer/);
  const restoreCall = calls.filter(([, id, enabled]) => id === 'satellites' && enabled === false);
  assert.ok(restoreCall.length >= 1, 'rollback restored the pre-mission satellites state');

  // Retry with a healthy dependency: capture must run AGAIN (a retained
  // snapshot would skip it) and enable must succeed.
  calls.length = 0;
  failNextActivation = false;
  await rocketLaunchesLayer.enable();
  assert.deepEqual(
    calls.filter(([, id, enabled]) => id === 'satellites' && enabled === true).length >= 1,
    true,
    'retry recaptured the satellites dependency',
  );
  await rocketLaunchesLayer.disable();
});

test('disable reports a semantic failure while restoring the satellites dependency', async (t) => {
  let satellitesEnabled = false;
  let failRestore = false;
  const fakeManager = {
    isEnabled: (id) => (id === 'satellites' ? satellitesEnabled : false),
    isEffectivelyEnabled: (id) => (id === 'satellites' ? satellitesEnabled : false),
    getLayerParams: () => ({}),
    setLayerParams: () => {},
    setEnabled: (id, enabled) => {
      if (id === 'satellites' && !enabled && failRestore) return Promise.resolve(false);
      if (id === 'satellites') satellitesEnabled = enabled;
      return Promise.resolve(true);
    },
  };
  const priorDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  rocketLaunchesLayer.attachDataManager(fakeManager);
  t.after(() => {
    globalThis.document = priorDocument;
    rocketLaunchesLayer.attachDataManager(null);
  });

  await rocketLaunchesLayer.enable();
  failRestore = true;
  await assert.rejects(
    () => rocketLaunchesLayer.disable(),
    /could not restore the satellites layer/,
  );
});
