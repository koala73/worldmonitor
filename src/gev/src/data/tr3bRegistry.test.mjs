// src/data/tr3bRegistry.test.mjs
// TR-3B conversion Easter egg: registry state, sprite-variant selection,
// class-label override, and the render-path invariants that keep a converted
// contact a 2D triangle across polls, style switches, and the 3D handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';

import {
  TR3B_CLASS,
  TR3B_TYPE_LABEL,
  clearTr3bRegistry,
  isTr3b,
  setTr3b,
  toggleTr3b,
  tr3bConvertedIds,
  tr3bCount,
  tr3bAircraftClass,
  tr3bIconKind,
  tr3bTypeLabel,
} from './tr3bRegistry.js';
import { aircraftIcon, TRACKED_ICON_PX } from './aircraftIcons.js';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
  mapAnalystRecord as mapFlightAnalystRecord,
} from './flights.js';
import militaryFlightsLayer, {
  _setTrackedMilitaryRefreshStateForTest,
  mapAnalystRecord as mapMilitaryAnalystRecord,
} from './militaryFlights.js';
import { findCompatibleHistoryIndex } from './militaryAwareness.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { ANALYST_LAYERS, createAnalystEngine } from './analystEngine.js';

/** Strip block and line comments so source pins scan CODE, not prose. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Decode an `aircraftIcon()` data URI back to its SVG source. */
function decodeIcon(uri) {
  const marker = 'base64,';
  return Buffer.from(uri.slice(uri.indexOf(marker) + marker.length), 'base64').toString('utf8');
}

test('tr3b registry: toggle round-trips and normalizes the contact id', () => {
  clearTr3bRegistry();
  assert.equal(isTr3b('A1B2C3'), false);

  assert.equal(toggleTr3b('A1B2C3'), true);
  assert.equal(isTr3b('A1B2C3'), true);
  assert.equal(isTr3b('a1b2c3'), true, 'ICAO hex is case-insensitive');
  assert.equal(isTr3b(' a1b2c3 '), true, 'surrounding whitespace is trimmed');
  assert.deepEqual(tr3bConvertedIds(), ['a1b2c3']);
  assert.equal(tr3bCount(), 1);

  assert.equal(toggleTr3b('a1b2c3'), false, 'a second toggle restores the contact');
  assert.equal(isTr3b('A1B2C3'), false);
  assert.equal(tr3bCount(), 0);

  clearTr3bRegistry();
});

test('tr3b registry: setTr3b is explicit and idempotent; unusable ids are inert', () => {
  clearTr3bRegistry();
  assert.equal(setTr3b('ae01ce', true), true);
  assert.equal(setTr3b('ae01ce', true), true, 'converting twice is a no-op');
  assert.equal(setTr3b('ae01ce', false), false);
  assert.equal(setTr3b('ae01ce', false), false);

  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(setTr3b(bad, true), false);
    assert.equal(toggleTr3b(bad), false);
    assert.equal(isTr3b(bad), false);
  }
  assert.equal(tr3bCount(), 0, 'no unusable id ever entered the registry');
  clearTr3bRegistry();
});

test('tr3b sprite variant: unconverted passes the class through, converted picks by style', () => {
  clearTr3bRegistry();
  // Identity for every ordinary contact — this is what lets the layers route
  // EVERY aircraftIcon() call through the resolver without behaviour change.
  assert.equal(tr3bIconKind('a1b2c3', 'airliner'), 'airliner');
  assert.equal(tr3bIconKind('a1b2c3', 'helicopter', { hot: true }), 'helicopter');
  assert.equal(tr3bIconKind('a1b2c3', undefined), undefined);

  setTr3b('a1b2c3', true);
  assert.equal(tr3bIconKind('a1b2c3', 'airliner'), 'tr3b', 'normal styles get the cold triangle');
  assert.equal(tr3bIconKind('a1b2c3', 'airliner', { hot: false }), 'tr3b');
  assert.equal(tr3bIconKind('a1b2c3', 'airliner', { hot: true }), 'tr3bHot',
    'FLIR/NVG/surveillance (irBoost) get the thermal-reactive variant');
  // Class no longer influences the glyph once converted.
  assert.equal(tr3bIconKind('a1b2c3', 'fastjet'), 'tr3b');
  clearTr3bRegistry();
});

test('tr3b sprites are real distinct glyphs, not the airliner fallback', () => {
  const cold = aircraftIcon('tr3b');
  const hot = aircraftIcon('tr3bHot');
  const airliner = aircraftIcon('airliner');
  assert.notEqual(cold, airliner, 'tr3b is a registered kind, not the unknown-kind fallback');
  assert.notEqual(hot, airliner);
  assert.notEqual(cold, hot, 'the thermal variant is a separate sprite');
  // Both rasters exist so the tracked billboard can use the crisp 192 px source.
  assert.notEqual(aircraftIcon('tr3b', TRACKED_ICON_PX), cold);

  const coldSvg = decodeIcon(cold);
  const hotSvg = decodeIcon(hot);
  for (const svg of [coldSvg, hotSvg]) {
    // Nose-up isosceles triangle (apex toward -Y) so the shared screen-projected
    // rotation pipeline points it along the display course like every sprite.
    assert.match(svg, /M0,-38 L 40,30 L -40,30 Z/);
    // Three corner lights plus one dimmer centre light.
    assert.equal((svg.match(/cx="0" cy="-24"/g) || []).length >= 1, true);
    assert.equal((svg.match(/cx="-28" cy="21"/g) || []).length >= 1, true);
    assert.equal((svg.match(/cx="28" cy="21"/g) || []).length >= 1, true);
    assert.equal((svg.match(/cx="0" cy="6"/g) || []).length >= 1, true);
  }
  // Cold: a near-black hull with only subtly visible lights (no pure white).
  assert.match(coldSvg, /fill="#0d1014"/);
  assert.doesNotMatch(coldSvg, /fill="#ffffff"/);
  // Hot: cold hull, white emitter cores, and a baked glow halo for bloom/FLIR.
  assert.match(hotSvg, /fill="#0b0e12"/);
  assert.match(hotSvg, /radialGradient id="tr3bGlow"/);
  assert.equal((hotSvg.match(/fill="url\(#tr3bGlow\)"/g) || []).length, 4,
    'all four emitters carry a glow halo');
  assert.match(hotSvg, /fill="#ffffff"/);
});

test('tr3b class label overrides the real type only for converted contacts', () => {
  clearTr3bRegistry();
  assert.equal(TR3B_TYPE_LABEL, 'TR-3B');
  assert.equal(tr3bTypeLabel('a1b2c3', 'Boeing 737-800'), 'Boeing 737-800');
  assert.equal(tr3bTypeLabel('a1b2c3'), null, 'default fallback is null, never a label');

  setTr3b('a1b2c3', true);
  assert.equal(tr3bTypeLabel('a1b2c3', 'Boeing 737-800'), 'TR-3B');
  assert.equal(tr3bTypeLabel('A1B2C3', null), 'TR-3B');
  assert.equal(tr3bTypeLabel('deadbe', 'Boeing 737-800'), 'Boeing 737-800',
    'conversion is per-contact, never global');
  clearTr3bRegistry();
});

test('a conversion survives a poll refresh, in both the billboard and the tracked card', async () => {
  clearTr3bRegistry();
  const icao24 = 'a1b2c3';
  setTr3b(icao24, true);

  const entity = { gevLabelModel: { title: 'OLD', details: [] } };
  const billboard = {
    position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 9_000),
    color: Cesium.Color.WHITE,
    image: aircraftIcon('tr3b'),
    show: true,
    width: 20,
    height: 20,
    scale: 1,
  };
  const viewer = { camera: { positionCartographic: null }, scene: {} };
  _setTrackedFlightRefreshStateForTest({
    icao24,
    entity,
    billboard,
    billboardCollection: { show: false, remove() {} },
    viewer,
    meta: {
      callsign: 'OLD1',
      altitude: 9_000,
      renderAltitudeM: 9_050,
      velocity: 180,
      true_track: 80,
      // A DIFFERENT class from the one the poll will derive, so the reconciler's
      // class-change branch fires and re-images the billboard. That is exactly
      // the path a conversion has to survive.
      klass: 'light',
      typeName: 'Boeing 737-800',
      airline: 'Southwest Airlines',
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 30.2,
      rawLon: -97.7,
    },
  });

  const realFetch = globalThis.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/api/gev/opensky')) {
      return { ok: true, status: 200, json: async () => ({ ac: [] }) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        time: nowSec,
        states: [[
          icao24, 'DAL123 ', 'United States', nowSec, nowSec,
          -97.6, 30.3, 10_668, false, 250, 95, 5, null, 10_700,
          null, null, null, 5,
        ]],
      }),
    };
  };

  try {
    await flightsLayer.update(viewer);
    assert.equal(billboard.image, aircraftIcon('tr3b'),
      'the poll reconciler re-images through the TR-3B resolver, not the raw class');
    // Live telemetry keeps flowing; only the class label is the operator's fiction.
    assert.match(entity.gevLabelModel.title, /^DAL123 · FL350 · 486 kts$/);
    assert.deepEqual(entity.gevLabelModel.details.slice(0, 1), ['TR-3B'],
      'the tracked card class line reports TR-3B, replacing operator/type');
    assert.equal(
      [entity.gevLabelModel.title, ...entity.gevLabelModel.details].join(' · ').includes('Southwest'),
      false,
      'the real operator is not shown alongside the TR-3B classification',
    );
  } finally {
    globalThis.fetch = realFetch;
    clearTr3bRegistry();
  }
});

test('both flight layers keep a converted contact 2D and visible (render invariants)', async () => {
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');

    // 1. The 3D model handoff is SUPPRESSED for a converted contact — there is
    //    no TR-3B GLB, so the triangle billboard stays the visual.
    assert.match(source, /modelEligible\.has\(icao24\) && !isTr3b\(icao24\)/,
      `${name}: fleet model handoff skips converted contacts`);
    // The tracked regime became default-on and camera-distance driven
    // (2026-08-19), so the suppression moved from a conjunct on
    // `_modelRegimeActive()` to an explicit early return. The invariant is
    // unchanged: a converted contact never reaches the model handoff.
    assert.match(source, /if \(!_trackedIcao \|\| _cockpitContactMode \|\| isTr3b\(_trackedIcao\)\) \{/,
      `${name}: the standalone tracked model is suppressed for a converted contact`);

    // 2. The billboard is never hidden by that suppression — it must keep
    //    satisfying the getNearby/getDetectableObjects visibility guards, so a
    //    converted contact still works in Contacts and Cockpit.
    assert.match(source, /if \(bb && id !== _trackedIcao\) bb\.show = true;|if \(modelled && id !== _trackedIcao\) modelled\.show = true;/,
      `${name}: converting restores the billboard the model handoff had hidden`);

    // 3. Every aircraftIcon() CALL SITE routes through the kind resolver, so no
    //    refresh path (poll reconciler, raster swap, presentation, tracked
    //    entity) can silently revert a conversion.
    const code = stripComments(source);
    const callSites = code.match(/aircraftIcon\(\s*[^;]*?\)/g) || [];
    assert.equal(callSites.length >= 4, true, `${name}: expected the known aircraftIcon call sites`);
    for (const call of callSites) {
      assert.match(call, /aircraftIcon\(\s*_iconKind\(/,
        `${name}: ${call.replace(/\s+/g, ' ')} must resolve its sprite kind through _iconKind`);
    }

    // 4. Orientation contract is untouched: still a screen-projected rotation
    //    with alignedAxis ZERO, and no new per-frame CallbackProperty.
    assert.match(source, /alignedAxis: Cesium\.Cartesian3\.ZERO/, `${name}: alignedAxis stays ZERO`);
    assert.doesNotMatch(source, /isTr3b[\s\S]{0,200}new Cesium\.CallbackProperty/,
      `${name}: the Easter egg adds no per-frame CallbackProperty`);
  }
});

test('conversions are session-scoped and no lifecycle path clears them', async () => {
  // PINNED DECISION: the registry holds nothing but hex strings the operator
  // personally clicked, and re-tracking the same aircraft after a layer restart
  // should still show the triangle. Only a page reload resets it — so no
  // production code may clear the registry.
  for (const name of ['flights.js', 'militaryFlights.js', '../ui.js']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /clearTr3bRegistry/,
      `${name}: teardown must not clear session conversions`);
  }
  // And nothing persists it across reloads.
  const registry = stripComments(
    await readFile(new URL('./tr3bRegistry.js', import.meta.url), 'utf8'),
  );
  assert.doesNotMatch(registry, /localStorage|sessionStorage/,
    'the Easter egg is session-only — never persisted');

  // Nothing in the registry itself reaches for a layer or a lifecycle hook.
  assert.doesNotMatch(registry, /import\s/, 'the registry depends on nothing');
  assert.doesNotMatch(registry, /destroy|teardown|addEventListener/,
    'the registry has no lifecycle hook a layer could fire');

  // Behavioural proof of the same thing: the layer dropping a contact from its
  // feed (the real-world "layer let go of it" path) leaves the conversion set.
  clearTr3bRegistry();
  const icao24 = 'a1b2c3';
  setTr3b(icao24, true);
  const viewer = { camera: { positionCartographic: null }, scene: {} };
  _setTrackedFlightRefreshStateForTest({
    icao24,
    entity: null,
    billboard: {
      position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 9_000),
      color: Cesium.Color.WHITE,
      image: aircraftIcon('tr3b'),
      show: true,
    },
    billboardCollection: { show: false, remove() {} },
    viewer,
    tracked: false,
    meta: { callsign: 'OLD1', altitude: 9_000, klass: 'airliner', rawLat: 30.2, rawLon: -97.7 },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).startsWith('/api/gev/opensky')
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: 0, states: [] }) }
    : { ok: true, status: 200, json: async () => ({ ac: [] }) });
  try {
    await flightsLayer.update(viewer);
    assert.equal(isTr3b(icao24), true, 'losing the contact does not drop its conversion');
    assert.equal(tr3bIconKind(icao24, 'airliner'), 'tr3b',
      're-acquiring the same contact renders it as a TR-3B again');
  } finally {
    globalThis.fetch = realFetch;
    clearTr3bRegistry();
  }
});

test('analyst records report the class the contact RENDERS as, in both layers', () => {
  clearTr3bRegistry();
  assert.equal(TR3B_CLASS, 'tr3b');
  // Style-independent on purpose: an analyst answer must not change with FLIR.
  assert.notEqual(TR3B_CLASS, 'tr3bHot');

  const civil = { callsign: 'SWA696', klass: 'airliner', rawLat: 30.2, rawLon: -97.7 };
  const mil = { callsign: 'RCH451', klass: 'fastjet', rawLat: 30.2, rawLon: -97.7 };
  assert.equal(mapFlightAnalystRecord('a1b2c3', civil).aircraftClass, 'airliner');
  assert.equal(mapMilitaryAnalystRecord('ae01ce', mil).aircraftClass, 'fastjet');

  setTr3b('a1b2c3', true);
  setTr3b('ae01ce', true);
  assert.equal(mapFlightAnalystRecord('a1b2c3', civil).aircraftClass, 'tr3b');
  assert.equal(mapMilitaryAnalystRecord('ae01ce', mil).aircraftClass, 'tr3b');
  // Per-contact, never global.
  assert.equal(mapFlightAnalystRecord('deadbe', civil).aircraftClass, 'airliner');

  setTr3b('a1b2c3', false);
  setTr3b('ae01ce', false);
  assert.equal(mapFlightAnalystRecord('a1b2c3', civil).aircraftClass, 'airliner',
    'unconverting restores the real class');
  assert.equal(mapMilitaryAnalystRecord('ae01ce', mil).aircraftClass, 'fastjet');

  assert.equal(tr3bAircraftClass('a1b2c3', 'airliner'), 'airliner');
  assert.equal(tr3bAircraftClass('a1b2c3'), null, 'default fallback is null');
  clearTr3bRegistry();
});

test('the analyst engine filters and aggregates a tr3b class without choking', async () => {
  clearTr3bRegistry();
  setTr3b('a1b2c3', true);
  const records = [
    mapFlightAnalystRecord('a1b2c3', {
      callsign: 'SWA696', klass: 'airliner', rawLat: 30.20, rawLon: -97.70,
      altitude: 10_000, velocity: 200,
    }),
    mapFlightAnalystRecord('deadbe', {
      callsign: 'AAL100', klass: 'airliner', rawLat: 30.21, rawLon: -97.71,
      altitude: 11_000, velocity: 240,
    }),
  ];
  const engine = createAnalystEngine({
    getRecords: (key) => (key === 'flights' ? records : []),
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 30.2, lon: -97.7, viewRadiusKm: 150 }),
  });

  // aircraftClass is a declared free-text field, so 'tr3b' is just another value.
  assert.equal(ANALYST_LAYERS.flights.text.includes('aircraftClass'), true);

  const hits = await engine.query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'aircraftClass', op: 'eq', value: 'tr3b' }], limit: 50,
  });
  assert.equal(hits.ok, true);
  assert.equal(hits.count, 1, 'filtering for TR-3B finds the converted contact');
  assert.equal(hits.items[0].icao24, 'a1b2c3');

  // The ordinary contact is still reachable by its real class.
  const airliners = await engine.query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'aircraftClass', op: 'eq', value: 'airliner' }], limit: 50,
  });
  assert.equal(airliners.count, 1, 'the converted contact no longer answers to airliner');

  // A numeric sort/summary still runs over the mixed set — aircraftClass is
  // free text, so there is no enum lookup an unknown value could break.
  const fastest = await engine.query({
    layers: ['flights'], scope: { kind: 'anywhere' }, sortBy: 'speedMps', limit: 5,
  });
  assert.equal(fastest.ok, true);
  assert.equal(fastest.count, 2);
  assert.equal(fastest.summary.speedMpsMax, 240);
  clearTr3bRegistry();
});

test('a converted contact never consumes a 3D model CAP SLOT', async () => {
  // The cap is applied to the `cand` list the eligibility pre-pass builds, so
  // excluding converted contacts BEFORE `cand.push` is what frees the slot for
  // an ordinary contact. Structural pin: the eligibility loop itself is inline
  // in the fleet tick (no seam to drive headlessly), so this asserts the guard's
  // POSITION rather than replaying the four-pass selection.
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    // Anchor on the MODEL-eligibility loop (keepDistSq), not the unrelated
    // ambient-enrichment candidate loop that also builds a `cand`.
    const loop = /const cand = \[\];\s*\n\s*for \(const \[icao, bb\] of _billboards\)[\s\S]*?cand\.push\(/.exec(source)?.[0];
    assert.ok(loop, `${name}: the model-eligibility candidate loop is present`);
    assert.match(loop, /keepDistSq/, `${name}: matched the model-eligibility loop`);
    assert.match(loop, /if \(isTr3b\(icao\)\) continue;/,
      `${name}: converted contacts are dropped BEFORE entering the capped candidate list`);
    // ...and the cap really is applied to that list, so a dropped candidate is a freed slot.
    assert.match(source, /modelEligible\.size >= cap/,
      `${name}: the cap bounds the candidate-derived eligible set`);
  }
});

test('cockpit class filter matches a converted contact end to end', async () => {
  // The chain that was dead-ending: a spoken "TR-3B" is normalized by the voice
  // layer, then the cockpit next/previous path matches it against the
  // aircraftClass on getNearby RECORDS — which used to carry the underlying
  // airframe class, so the filter never matched. Real normalizer + real
  // getNearby record builder + real filter matcher; only the styleManager glue
  // (covered by its own ui tests) is stubbed.
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  clearTr3bRegistry();
  const icao24 = 'abc123';
  const center = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 200);

  // 1) Real voice normalization: what the cockpit path actually receives.
  const seen = [];
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: { addEventListener() {} } },
    },
    styleManager: {
      controlCockpit(action, options) {
        seen.push(options.aircraftClass);
        return { ok: true, state: { active: true, navigation: { canNext: true, canPrevious: true, canFocus: true } } };
      },
    },
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  await runner('control_cockpit', { action: 'next', aircraftClass: 'TR-3B' });
  await runner('control_cockpit', { action: 'next', aircraftClass: 'airliner' });
  const [spokenTr3b, spokenAirliner] = seen;
  assert.equal(spokenTr3b, TR3B_CLASS);
  assert.equal(spokenAirliner, 'airliner');

  // 2) Real getNearby record for a real (converted) contact in the layer.
  const seed = () => _setTrackedFlightRefreshStateForTest({
    icao24,
    entity: null,
    billboard: {
      position: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668),
      color: Cesium.Color.WHITE,
      show: true,
    },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked: false,
    meta: { callsign: 'SWA696 ', altitude: 10_668, klass: 'airliner', onGround: false },
  });
  const recordFor = () => flightsLayer.getNearby(center, 250_000, 25)
    .find((r) => r.icao24 === icao24);

  // 3) Real filter matcher over that record, via the exported navigation helper.
  const matches = (record, aircraftClass) => findCompatibleHistoryIndex(
    [{ layerId: 'flights', id: icao24 }], -1, 1,
    { aircraftClass, resolveItem: () => record },
  ) === 0;

  setTr3b(icao24, true);
  seed();
  const converted = recordFor();
  assert.ok(converted, 'the converted contact is still returned by getNearby');
  assert.equal(converted.aircraftClass, TR3B_CLASS,
    'the record reports the class it renders as');
  assert.equal(matches(converted, spokenTr3b), true,
    'a spoken "TR-3B" cockpit filter selects the converted contact');
  assert.equal(matches(converted, spokenAirliner), false,
    'the converted contact no longer answers to its underlying class');

  setTr3b(icao24, false);
  seed();
  const restored = recordFor();
  assert.equal(restored.aircraftClass, 'airliner', 'unconverting restores the real class');
  assert.equal(matches(restored, spokenTr3b), false, 'no TR-3B match once restored');
  assert.equal(matches(restored, spokenAirliner), true, 'the original class filter works again');
  clearTr3bRegistry();
});

test('military records and detection cards agree with the conversion', () => {
  clearTr3bRegistry();
  const icao24 = 'ae01ce';
  const center = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 200);
  const seed = () => _setTrackedMilitaryRefreshStateForTest({
    icao24,
    entity: null,
    billboard: {
      position: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668),
      color: Cesium.Color.WHITE,
      show: true,
    },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked: false,
    meta: { callsign: 'RCH451', altitudeFt: 35_000, klass: 'quadjet', type: 'C-17A', onGround: false },
  });

  seed();
  const before = militaryFlightsLayer.getNearby(center, 250_000, 25).find((r) => r.icao24 === icao24);
  assert.equal(before.aircraftClass, 'quadjet');
  assert.equal(before.type, 'C-17A');
  const cardBefore = militaryFlightsLayer.getDetectableObjects({ maxCount: 50 })
    .find((o) => o.sourceId === icao24);
  assert.equal(cardBefore.klass, 'C-17A', 'the card names the real airframe');

  setTr3b(icao24, true);
  seed();
  const after = militaryFlightsLayer.getNearby(center, 250_000, 25).find((r) => r.icao24 === icao24);
  assert.equal(after.aircraftClass, TR3B_CLASS, 'filter field follows the conversion');
  assert.equal(after.type, TR3B_TYPE_LABEL,
    'the display type cannot still name the airframe the triangle replaced');
  const cardAfter = militaryFlightsLayer.getDetectableObjects({ maxCount: 50 })
    .find((o) => o.sourceId === icao24);
  assert.equal(cardAfter.klass, TR3B_TYPE_LABEL,
    'detectionDraw composes its card line from src.klass — it must read TR-3B');
  clearTr3bRegistry();
});
