import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SATELLITE_CLASSES,
  SATELLITE_CLASS_ORDER,
  satelliteClassColor,
  satelliteClassLabel,
  satelliteClassLegend,
  satelliteClassOf,
  tallySatelliteClasses,
} from './satelliteClass.js';
import satellitesLayer, {
  _catalogGroupForTest,
  _clearDenseCatalogStateForTest,
  _setDenseCatalogStateForTest,
} from './satellites.js';

/**
 * A real, parseable TLE under an arbitrary 5-digit catalog number, so the dense
 * load exercises the production path. Both fixtures deliberately avoid 25544 —
 * that is the ISS, and the ISS is force-classified as a STATION everywhere.
 * @param {string} satnum Five-digit catalog number.
 * @param {string} name Object name line.
 */
const tleFor = (satnum, name) => [
  name,
  `1 ${satnum}U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927`,
  `2 ${satnum}  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`,
].join('\n');

const DENSE_TLE = tleFor('44444', 'STARLINK-TEST');
const ALT_TLE = tleFor('33333', 'DRIFTER-1');
const ISS_TLE = tleFor('25544', 'ISS (ZARYA)');

/** Poll the chip until the async dense load settles (or give up). */
async function settleChip(maxTicks = 50) {
  for (let i = 0; i < maxTicks; i++) {
    const chip = satellitesLayer.getRowControls().chips[0];
    if (chip && !chip.busy) return chip;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return satellitesLayer.getRowControls().chips[0];
}

/** Every CelesTrak group the catalog ingests, plus the dense-mode tag. */
const INGESTED_GROUPS = ['stations', 'visual', 'gps-ops', 'glonass', 'galileo', 'geo', 'dense'];

test('every ingested CelesTrak group resolves to a real class', () => {
  // Guards against drift: adding a group to CATALOG_GROUPS without classifying
  // it would silently dump those satellites into the catch-all bucket.
  for (const group of INGESTED_GROUPS) {
    const { klass } = satelliteClassOf(group);
    assert.ok(SATELLITE_CLASSES[klass], `${group} maps to an unknown class ${klass}`);
    assert.ok(SATELLITE_CLASS_ORDER.includes(klass), `${klass} is missing from the legend order`);
  }
});

test('the three GNSS constellations share one NAV color and split by subtype', () => {
  const navGroups = ['gps-ops', 'glonass', 'galileo'];
  const colors = new Set(navGroups.map(satelliteClassColor));
  assert.equal(colors.size, 1, 'GPS, GLONASS and Galileo must read as one NAV family');
  assert.equal([...colors][0], SATELLITE_CLASSES.nav.color);

  assert.equal(satelliteClassLabel('gps-ops'), 'NAV · GPS');
  assert.equal(satelliteClassLabel('glonass'), 'NAV · GLONASS');
  assert.equal(satelliteClassLabel('galileo'), 'NAV · GALILEO');
});

test('class labels name the type, and the ISS names itself', () => {
  assert.equal(satelliteClassLabel('geo'), 'GEO');
  assert.equal(satelliteClassLabel('stations'), 'STATION');
  assert.equal(satelliteClassLabel('visual'), 'VISUAL');
  assert.equal(satelliteClassLabel('dense'), 'COMMS · STARLINK');
  assert.equal(satelliteClassLabel('stations', { isIss: true }), 'STATION · ISS');
});

test('the ISS is a STATION whichever group a partial outage ingested it from', () => {
  // CelesTrak lists the ISS in `visual` as well as `stations`, and a rebuild
  // survives a partial group failure. If the stations feed drops, the ISS is
  // ingested as `visual` — its card must not then read "VISUAL · ISS" beside
  // the red station dot.
  assert.equal(satelliteClassLabel('visual', { isIss: true }), 'STATION · ISS');
  assert.equal(satelliteClassLabel('geo', { isIss: true }), 'STATION · ISS');
  assert.equal(satelliteClassLabel(undefined, { isIss: true }), 'STATION · ISS');
  // Non-ISS satellites in those groups are unaffected.
  assert.equal(satelliteClassLabel('visual'), 'VISUAL');
});

test('an unknown group falls back to the neutral bucket instead of vanishing', () => {
  assert.equal(satelliteClassOf('weather').klass, 'visual');
  assert.equal(satelliteClassOf(undefined).klass, 'visual');
  assert.equal(satelliteClassColor(null), SATELLITE_CLASSES.visual.color);
  assert.equal(satelliteClassLabel('some-new-celestrak-group'), 'VISUAL');
});

test('class colors are distinct, valid, and never borrow the military amber', () => {
  const colors = SATELLITE_CLASS_ORDER.map((k) => SATELLITE_CLASSES[k].color);
  assert.equal(new Set(colors).size, colors.length, 'two classes share a color');
  for (const color of colors) {
    assert.match(color, /^#[0-9a-f]{6}$/, `${color} is not a 6-digit hex`);
  }
  // Amber 40-48deg is the app-wide known-military convention (flights.js
  // MIL_TINT #FFB800 / militaryFlights.js #FFB800 + #FFD166). A satellite
  // class landing there would read as a military air contact.
  const hueOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const saturationOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0) return 0;
    return (max - min) / max;
  };
  for (const klass of SATELLITE_CLASS_ORDER) {
    const color = SATELLITE_CLASSES[klass].color;
    const amberish = hueOf(color) >= 35 && hueOf(color) <= 50 && saturationOf(color) > 0.45;
    assert.equal(amberish, false, `${klass} (${color}) sits in the military amber band`);
  }
});

test('the dense shell stays dimmer than the class it sits among', () => {
  // NVG/FLIR collapse the scene to Rec.601 luma, and DENSE mode puts thousands
  // of COMMS points in the same LEO volume as VISUAL. Luma separation is what
  // keeps the core catalog readable through the dense shell.
  const luma = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  };
  assert.ok(
    luma(SATELLITE_CLASSES.visual.color) - luma(SATELLITE_CLASSES.comms.color) > 0.2,
    'COMMS must stay well below VISUAL in luminance',
  );
  assert.ok(
    luma(SATELLITE_CLASSES.station.color) > luma(SATELLITE_CLASSES.visual.color),
    'STATION is the brightest core class',
  );
});

test('tallying groups counts by class, folding the GNSS constellations together', () => {
  const counts = tallySatelliteClasses([
    'gps-ops', 'gps-ops', 'glonass', 'galileo',
    'geo', 'geo', 'geo',
    'stations',
    'visual',
    'dense', 'dense',
  ]);
  assert.equal(counts.nav, 4, 'all three GNSS groups fold into NAV');
  assert.equal(counts.geo, 3);
  assert.equal(counts.station, 1);
  assert.equal(counts.visual, 1);
  assert.equal(counts.comms, 2);
});

test('tallying tolerates an empty or missing input', () => {
  assert.deepEqual({ ...tallySatelliteClasses([]) }, {});
  assert.deepEqual({ ...tallySatelliteClasses(undefined) }, {});
});

test('the tally files the ISS under STATION even when a partial outage moved it', () => {
  // The legend and the card must never disagree. With the stations feed down,
  // the ISS is ingested as `visual`; counting it there would let STATION vanish
  // from the legend while the tracked card still reads "STATION · ISS".
  const outage = tallySatelliteClasses([
    { group: 'visual', isIss: true },
    { group: 'visual' },
    { group: 'visual' },
  ]);
  assert.equal(outage.station, 1, 'the ISS is counted as a STATION');
  assert.equal(outage.visual, 2, 'and is not double-counted under VISUAL');

  const legend = satelliteClassLegend(outage);
  assert.equal(legend.some((row) => row.klass === 'station'), true,
    'STATION stays in the legend, matching the card');

  // Bare group tags still work — the descriptor form is additive.
  assert.deepEqual({ ...tallySatelliteClasses(['visual', 'visual']) }, { visual: 2 });
  assert.equal(satelliteClassOf('visual', { isIss: true }).klass, 'station',
    'one helper owns the rule for every consumer');
});

test('the legend lists present classes in order and omits absent ones', () => {
  const legend = satelliteClassLegend(tallySatelliteClasses(['geo', 'gps-ops', 'stations']));
  assert.deepEqual(legend.map((row) => row.klass), ['station', 'nav', 'geo'],
    'legend follows SATELLITE_CLASS_ORDER, not input order');
  // COMMS only exists in DENSE mode — the legend must not advertise a class
  // that has nothing on screen.
  assert.equal(legend.some((row) => row.klass === 'comms'), false);

  const row = legend.find((entry) => entry.klass === 'nav');
  assert.equal(row.label, 'NAV');
  assert.equal(row.color, SATELLITE_CLASSES.nav.color);
  assert.equal(row.count, 1);
  assert.ok(row.blurb.length > 0, 'every legend row carries a plain-language gloss');
});

test('the legend drops zero and negative counts', () => {
  assert.deepEqual(satelliteClassLegend({ nav: 0, geo: -1, station: 2 }).map((r) => r.klass), ['station']);
  assert.deepEqual(satelliteClassLegend(null), []);
});

test('the DENSE row chip is stateless and declares the params to apply', () => {
  // The chip never carries its own state: it declares the params to apply, so
  // whatever else drives the catalog param (Space Missions capture/restore)
  // stays authoritative. Whether it reads ACTIVE is decided by the dense LOAD,
  // not the param — see the load-lifecycle tests below.
  try {
    _setDenseCatalogStateForTest({});
    const chip = satellitesLayer.getRowControls().chips.find((entry) => entry.id === 'catalog');
    assert.equal(chip.id, 'catalog');
    assert.equal(chip.label, 'DENSE');
    assert.equal(chip.active, false);
    assert.equal(chip.busy, false);
    assert.equal(chip.state, 'idle');
    assert.deepEqual(chip.params, { catalog: 'dense' }, 'clicking from core requests dense');
    assert.ok(chip.title.length > 0, 'the chip explains itself on hover');
  } finally {
    _clearDenseCatalogStateForTest();
  }
});

test('an invalid catalog mode is rejected without disturbing the chip', () => {
  satellitesLayer.setParams({ catalog: 'core' });
  satellitesLayer.setParams({ catalog: 'everything' });
  assert.equal(satellitesLayer.getParams().catalog, 'core');
  const chip = satellitesLayer.getRowControls().chips.find((entry) => entry.id === 'catalog');
  assert.equal(chip.active, false);
});

test('DENSE reports loading, then ACTIVE only once the points exist', async () => {
  const originalFetch = globalThis.fetch;
  const refreshes = [];
  try {
    globalThis.fetch = async () => ({ ok: true, text: async () => DENSE_TLE });
    _setDenseCatalogStateForTest({});
    satellitesLayer.setRowControlsListener(() => refreshes.push(satellitesLayer.getRowControls()));

    satellitesLayer.setParams({ catalog: 'dense' });
    // The param flips synchronously, but the shell has not arrived yet — the
    // chip must say BUSY, never ACTIVE.
    const pending = satellitesLayer.getRowControls().chips[0];
    assert.equal(pending.busy, true);
    assert.equal(pending.disabled, true);
    assert.equal(pending.active, false, 'never active before the points exist');
    assert.equal(pending.state, 'loading');

    const settled = await settleChip();
    assert.equal(settled.active, true, 'active once the dense points are on screen');
    assert.equal(settled.state, 'active');
    assert.equal(settled.label, 'DENSE');
    assert.deepEqual(settled.params, { catalog: 'core' }, 'a settled chip toggles back off');

    // The completion pushed a refresh, and the legend gained COMMS with it —
    // without that push the row would keep the pre-load counts for 5 minutes.
    assert.ok(refreshes.length >= 2, 'load start and load completion each pushed a refresh');
    const legend = satellitesLayer.getRowControls().legend;
    assert.equal(legend.some((row) => row.klass === 'comms'), true);
  } finally {
    globalThis.fetch = originalFetch;
    _clearDenseCatalogStateForTest();
  }
});

test('a failed DENSE load reverts the mode rather than leaving an active chip', async () => {
  const originalFetch = globalThis.fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    globalThis.fetch = async () => ({ ok: false, status: 502 });
    _setDenseCatalogStateForTest({});
    let pushes = 0;
    satellitesLayer.setRowControlsListener(() => { pushes += 1; });

    satellitesLayer.setParams({ catalog: 'dense' });
    const settled = await settleChip();

    assert.equal(settled.active, false, 'a 502 must never present as a live dense catalog');
    assert.equal(settled.state, 'error');
    assert.equal(settled.label, 'DENSE ✕');
    assert.match(settled.title, /502/, 'the chip explains why');
    assert.equal(satellitesLayer.getParams().catalog, 'core', 'the mode reverts to reality');
    assert.deepEqual(settled.params, { catalog: 'dense' }, 'clicking retries');
    assert.equal(
      satellitesLayer.getRowControls().legend.some((row) => row.klass === 'comms'),
      false,
      'no COMMS class is advertised when nothing loaded',
    );
    assert.ok(pushes >= 2, 'the failure pushed its own refresh');

    // Retrying against a healthy feed clears the error — it does not latch.
    globalThis.fetch = async () => ({ ok: true, text: async () => DENSE_TLE });
    satellitesLayer.setParams(settled.params);
    const recovered = await settleChip();
    assert.equal(recovered.state, 'active');
    assert.equal(recovered.active, true);
    assert.doesNotMatch(recovered.title, /502/, 'the stale failure reason is gone');
  } finally {
    console.warn = warn;
    globalThis.fetch = originalFetch;
    _clearDenseCatalogStateForTest();
  }
});

test('a 200 that yields no usable satellites is a failure, not a live catalog', async () => {
  // The round-1 fix caught the 502. A healthy response carrying an empty body,
  // an HTML error page the proxy passed through, or only satellites the core
  // catalog already owns reaches the same lie through a different door.
  const originalFetch = globalThis.fetch;
  const warn = console.warn;
  console.warn = () => {};
  const bodies = {
    empty: '',
    html: '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
    junk: 'NOT-A-TLE\nstill not a tle\nnope',
  };
  try {
    for (const [name, body] of Object.entries(bodies)) {
      globalThis.fetch = async () => ({ ok: true, text: async () => body });
      _setDenseCatalogStateForTest({});
      satellitesLayer.setParams({ catalog: 'dense' });
      const chip = await settleChip();
      assert.equal(chip.active, false, `${name}: never active with zero dense points`);
      assert.equal(chip.state, 'error', `${name}: reported as a failure`);
      assert.equal(satellitesLayer.getParams().catalog, 'core', `${name}: mode reverted`);
      assert.match(chip.title, /no satellites/, `${name}: says why`);
      _clearDenseCatalogStateForTest();
    }

    // The same guard fires when every TLE is already in the core catalog, so
    // "added nothing" can never masquerade as "loaded".
    globalThis.fetch = async () => ({ ok: true, text: async () => DENSE_TLE });
    _setDenseCatalogStateForTest({});
    satellitesLayer.setParams({ catalog: 'dense' });
    assert.equal((await settleChip()).state, 'active', 'a real feed still loads');
    _clearDenseCatalogStateForTest();
  } finally {
    console.warn = warn;
    globalThis.fetch = originalFetch;
    _clearDenseCatalogStateForTest();
  }
});

test('an explicit return to core clears a failure the user never caused', async () => {
  // Space Missions forces dense; if that load fails it reverts the param to
  // core itself. The mission's restore of an already-core snapshot then changes
  // nothing — and used to leave DENSE ✕ latched on the user's row.
  const originalFetch = globalThis.fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    globalThis.fetch = async () => ({ ok: false, status: 502 });
    _setDenseCatalogStateForTest({});
    satellitesLayer.setParams({ catalog: 'dense' });
    assert.equal((await settleChip()).state, 'error');
    assert.equal(satellitesLayer.getParams().catalog, 'core', 'the failure already reverted it');

    // A no-op restore of the pre-mission snapshot.
    satellitesLayer.setParams({ catalog: 'core', showPoints: true, showOrbits: true });
    const restored = satellitesLayer.getRowControls().chips[0];
    assert.equal(restored.state, 'idle', 'the error does not survive the restore');
    assert.equal(restored.label, 'DENSE');
    assert.doesNotMatch(restored.title, /502/);
  } finally {
    console.warn = warn;
    globalThis.fetch = originalFetch;
    _clearDenseCatalogStateForTest();
  }
});

test('a real stations-feed outage keeps STATION in the legend, matching the card', async () => {
  // End-to-end version of the tally rule: drive a real rebuild in which only
  // the `visual` group answers, so the ISS is genuinely ingested as `visual`.
  // The legend must still file it under STATION or it disagrees with the card.
  const originalFetch = globalThis.fetch;
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    _setDenseCatalogStateForTest({});
    const viewer = { scene: { primitives: { add: (p) => p, remove() {} } } };
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).endsWith('/visual') ? ISS_TLE : ''),
    });

    await satellitesLayer.update(viewer);
    assert.equal(_catalogGroupForTest(25544), 'visual',
      'the outage really did ingest the ISS from the visual group');

    const legend = satellitesLayer.getRowControls().legend;
    assert.equal(legend.find((row) => row.klass === 'station')?.count, 1,
      'STATION survives the outage because the ISS is counted there');
    assert.equal(legend.some((row) => row.klass === 'visual'), false,
      'and it is not also counted under VISUAL');
    assert.equal(satelliteClassLabel('visual', { isIss: true }), 'STATION · ISS',
      'the card says the same thing the legend does');
  } finally {
    console.log = log;
    console.warn = warn;
    globalThis.fetch = originalFetch;
    _clearDenseCatalogStateForTest();
  }
});

test('a catalog rebuild refreshes the detection overlay class strings', async () => {
  // The overlay caches one record per satellite and stamps id/class at
  // creation. A rebuild can re-tag a satellite (whichever group survives an
  // outage wins dedupe), so a cache that outlives the catalog shows the old
  // class forever.
  const originalFetch = globalThis.fetch;
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    _setDenseCatalogStateForTest({});
    const viewer = { scene: { primitives: { remove() {} } } };
    let homeGroup = 'geo';
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).endsWith(`/${homeGroup}`) ? ALT_TLE : ''),
    });

    await satellitesLayer.update(viewer);
    const first = satellitesLayer.getDetectableObjects().find((o) => o.sourceId === 33333);
    assert.ok(first, 'the seeded satellite is collectable');
    assert.equal(first.klass, 'GEO');

    homeGroup = 'visual';
    await satellitesLayer.update(viewer);
    const second = satellitesLayer.getDetectableObjects().find((o) => o.sourceId === 33333);
    assert.equal(second.klass, 'VISUAL', 'the cached record does not outlive its catalog');
  } finally {
    console.log = log;
    console.warn = warn;
    globalThis.fetch = originalFetch;
    _clearDenseCatalogStateForTest();
  }
});

test('a dependency owner hiding the points surrenders the whole row', async () => {
  try {
    _setDenseCatalogStateForTest({});
    assert.equal(satellitesLayer.getRowControls().chips.length, 1);

    // Space Missions borrows this layer for TLE lookup with showPoints:false.
    satellitesLayer.setParams({ showPoints: false });
    const owned = satellitesLayer.getRowControls();
    assert.deepEqual(owned.chips, [], 'no chip to click while the owner holds the params');
    assert.deepEqual(owned.legend, [], 'no legend describing an empty sky');

    satellitesLayer.setParams({ showPoints: true });
    assert.equal(satellitesLayer.getRowControls().chips.length, 1, 'released on restore');
  } finally {
    _clearDenseCatalogStateForTest();
  }
});
