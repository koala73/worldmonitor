import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import flightsLayer, {
  _setCockpitDetectionSubjectForTest as setFlightsCockpitSubject,
  _setTrackedFlightRefreshStateForTest,
} from './flights.js';
import militaryFlightsLayer, {
  _setCockpitDetectionSubjectForTest as setMilitaryCockpitSubject,
  _setTrackedMilitaryRefreshStateForTest,
} from './militaryFlights.js';

const SUBJECT = 'abc123';
const NEXT_SUBJECT = 'def456';

const UI_SOURCE = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const FLIGHTS_SOURCE = readFileSync(new URL('./flights.js', import.meta.url), 'utf8');
const MILITARY_SOURCE = readFileSync(new URL('./militaryFlights.js', import.meta.url), 'utf8');

const LAYERS = [
  {
    name: 'commercial',
    layer: flightsLayer,
    setSubject: setFlightsCockpitSubject,
    seed(icao24) {
      _setTrackedFlightRefreshStateForTest({
        icao24,
        entity: null,
        billboard: candidateBillboard(icao24),
        billboardCollection: { show: true, remove() {} },
        viewer: candidateViewer(),
        tracked: false,
        meta: {
          callsign: `${icao24.toUpperCase()} `,
          altitude: 10_668,
          klass: 'airliner',
          onGround: false,
        },
      });
    },
  },
  {
    name: 'military',
    layer: militaryFlightsLayer,
    setSubject: setMilitaryCockpitSubject,
    seed(icao24) {
      _setTrackedMilitaryRefreshStateForTest({
        icao24,
        entity: null,
        billboard: candidateBillboard(icao24),
        billboardCollection: { show: true, remove() {} },
        viewer: candidateViewer(),
        tracked: false,
        meta: {
          callsign: `${icao24.toUpperCase()} `,
          altitudeFt: 35_000,
          klass: 'fighter',
          onGround: false,
        },
      });
    },
  },
];

function candidateBillboard(icao24) {
  const offset = Number.parseInt(icao24.slice(-2), 16) || 1;
  return {
    position: Cesium.Cartesian3.fromDegrees(-97.7 + offset * 0.001, 30.2, 10_668),
    color: Cesium.Color.WHITE,
    show: true,
  };
}

function candidateViewer() {
  return {
    camera: { positionCartographic: null },
    scene: {},
  };
}

function candidateIds(layer) {
  return layer.getDetectableObjects({ maxCount: 10 }).map((candidate) => candidate.sourceId);
}

test('Cockpit lifecycle publishes one normalized aircraft identity to both detection owners', () => {
  const dispatcher = /dispatchCockpitModeChanged\(active, info = null\) \{[\s\S]*?\n  \}/
    .exec(UI_SOURCE)?.[0];
  assert.ok(dispatcher, 'Cockpit event dispatcher is defined');
  assert.match(dispatcher, /info\?\.icao24/);
  assert.match(dispatcher, /\.trim\(\)\.toLowerCase\(\)/);
  assert.match(dispatcher, /\['flights', 'military'\]\.includes\(info\?\.layerId\)/);
  assert.match(dispatcher, /detail: \{ active: active === true, subjectId, layerId \}/);
  assert.match(UI_SOURCE, /this\.dispatchCockpitModeChanged\(true, info\);/,
    'entry and in-Cockpit handoff publish the active subject');
  assert.match(UI_SOURCE, /this\.dispatchCockpitModeChanged\(false\);/,
    'exit clears the active subject');

  for (const [name, source] of [
    ['commercial', FLIGHTS_SOURCE],
    ['military', MILITARY_SOURCE],
  ]) {
    const consumer = /function _applyCockpitState\(detail = \{\}\) \{[\s\S]*?\n\}/
      .exec(source)?.[0];
    assert.ok(consumer, `${name} Cockpit consumer is defined`);
    assert.match(consumer, /detail\?\.subjectId/);
    assert.match(consumer, /\.trim\(\)\.toLowerCase\(\)/);
    assert.doesNotMatch(consumer, /layerId/,
      `${name} must also suppress a duplicate subject originating in the sibling AIR feed`);
  }
});

for (const fixture of LAYERS) {
  test(`${fixture.name} detection omits only the active Cockpit AIR subject`, () => {
    try {
      // The event contract normalizes ICAO24 before storing it. Exercise that
      // boundary with the uppercase form while the real candidate key stays
      // lowercase.
      fixture.setSubject(true, SUBJECT.toUpperCase());

      fixture.seed(SUBJECT);
      assert.deepEqual(
        candidateIds(fixture.layer),
        [],
        'the active first-person subject must not emit its own moving bracket',
      );

      fixture.seed(NEXT_SUBJECT);
      assert.deepEqual(
        candidateIds(fixture.layer),
        [NEXT_SUBJECT],
        'a nearby aircraft must keep its detection bracket in Cockpit',
      );

      // A Cockpit handoff flips the suppression atomically: the old subject
      // becomes an ordinary nearby contact, and the new subject disappears.
      fixture.setSubject(true, NEXT_SUBJECT.toUpperCase());
      fixture.seed(SUBJECT);
      assert.deepEqual(candidateIds(fixture.layer), [SUBJECT], 'handoff restores the old subject');
      fixture.seed(NEXT_SUBJECT);
      assert.deepEqual(candidateIds(fixture.layer), [], 'handoff suppresses the new subject');

      // Exiting Cockpit restores the same candidate without touching Detection
      // mode or the aircraft layer.
      fixture.setSubject(false, null);
      fixture.seed(NEXT_SUBJECT);
      assert.deepEqual(candidateIds(fixture.layer), [NEXT_SUBJECT], 'Cockpit exit restores the bracket');
    } finally {
      fixture.setSubject(false, null);
    }
  });
}

test('a Cockpit subject duplicated across commercial and military feeds is suppressed in both', () => {
  const realDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        getContext() {
          return {
            clearRect() {},
            save() {},
            beginPath() {},
            arc() {},
            stroke() {},
            fill() {},
            restore() {},
          };
        },
        toDataURL() { return 'data:image/png;base64,cockpit-contact-test'; },
      };
    },
  };
  try {
    // Both layers consume the shared subject identity regardless of which
    // aircraft layer originated the Cockpit event. This prevents one feed's
    // duplicate from leaving a second bracket on the pilot's own aircraft.
    setFlightsCockpitSubject(true, SUBJECT);
    setMilitaryCockpitSubject(true, SUBJECT);
    LAYERS[0].seed(SUBJECT);
    LAYERS[1].seed(SUBJECT);

    assert.deepEqual(candidateIds(flightsLayer), []);
    assert.deepEqual(candidateIds(militaryFlightsLayer), []);
  } finally {
    setFlightsCockpitSubject(false, null);
    setMilitaryCockpitSubject(false, null);
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});

