import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { currentRestrictions, parseNotamAirspace, type NotamAirspaceRestriction } from '../src/services/notam-airspace.ts';
import { NOTAM_AIRSPACE_COLORS, NOTAM_AIRSPACE_KIND_LABELS, notamAirspaceTooltip } from '../src/components/map/notam-airspace-style.ts';
import { AIRSPACE_KINDS } from '../scripts/lib/nms-notam.mjs';
import { escapeHtml } from '../src/utils/sanitize.ts';

// The same escaper DeckGLMap passes to the tooltip builder.
const text = (value: unknown): string => escapeHtml(String(value ?? ''));

const ROW: NotamAirspaceRestriction = {
  id: 'NMS_ID_1',
  kind: 'danger',
  location: 'EGNV',
  fir: 'EGTT',
  number: 'H1234/26',
  qcode: 'QRDCA',
  startsAt: Date.UTC(2026, 9, 24, 8, 0),
  endsAt: Date.UTC(2026, 9, 24, 18, 0),
  lower: 'SFC',
  upper: 'FL050',
  center: [-1.43, 54.51],
  radiusNm: 2,
  text: 'DANGER AREA ACTIVE',
};

test('parseNotamAirspace keeps valid rows and drops malformed ones', () => {
  const snapshot = parseNotamAirspace({
    generatedAt: 1_000,
    notams: [
      ROW,
      { ...ROW, id: 'bad-kind', kind: 'weather' },
      { ...ROW, id: 'bad-center', center: [200, 10] },
      { ...ROW, id: 'no-text', text: undefined },
      null,
    ],
  });
  assert.equal(snapshot.generatedAt, 1_000);
  assert.deepEqual(snapshot.notams.map((row) => row.id), ['NMS_ID_1']);
});

test('parseNotamAirspace drops polygon rings that are open or out of range', () => {
  const closed: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];
  const [row] = parseNotamAirspace({
    notams: [{ ...ROW, polygons: [closed, [[0, 0], [1, 1]], [[0, 0], [1, 0], [1, 95], [0, 0]]] }],
  }).notams;
  assert.deepEqual(row?.polygons, [closed]);
});

test('parseNotamAirspace tolerates a missing or non-object payload', () => {
  assert.deepEqual(parseNotamAirspace(undefined), { generatedAt: null, notams: [] });
  assert.deepEqual(parseNotamAirspace({ notams: 'x' }), { generatedAt: null, notams: [] });
});

test('currentRestrictions drops ended NOTAMs and re-derives upcoming from the clock', () => {
  // The client can hold a snapshot for hours: a failed refresh keeps it, and
  // runSeed keeps last-good alive while NMS is down.
  const now = Date.UTC(2026, 9, 24, 12, 0);
  const rows = currentRestrictions([
    ROW,
    { ...ROW, id: 'ended', endsAt: now - 1 },
    { ...ROW, id: 'ends-now', endsAt: now },
    { ...ROW, id: 'perm', endsAt: null },
    { ...ROW, id: 'started', startsAt: now - 60_000, upcoming: true },
    { ...ROW, id: 'later', startsAt: now + 60_000 },
  ], now);
  assert.deepEqual(rows.map((row) => [row.id, row.upcoming]), [
    ['NMS_ID_1', false], ['perm', false], ['started', false], ['later', true],
  ]);
});

test('the browser renders every airspace kind the seeder emits', () => {
  assert.deepEqual(Object.keys(NOTAM_AIRSPACE_COLORS).sort(), [...AIRSPACE_KINDS].sort());
  assert.deepEqual(Object.keys(NOTAM_AIRSPACE_KIND_LABELS).sort(), [...AIRSPACE_KINDS].sort());
  for (const kind of AIRSPACE_KINDS) {
    assert.equal(parseNotamAirspace({ notams: [{ ...ROW, kind }] }).notams.length, 1, kind);
  }
});

test('notamAirspaceTooltip escapes every upstream field', () => {
  const html = notamAirspaceTooltip({
    ...ROW,
    kind: 'danger',
    location: '<img src=x onerror=alert(1)>',
    number: '<b>N</b>',
    schedule: '<script>s</script>',
    text: '<svg onload=alert(2)>',
  }, text);
  assert.doesNotMatch(html, /<(img|script|svg|b)\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Danger area/);
  assert.match(html, /SFC – FL050/);
  assert.match(html, /2 NM/);
  assert.match(html, /Active 2026-10-24 08:00Z → 2026-10-24 18:00Z/);
});

test('notamAirspaceTooltip labels permanent and upcoming NOTAMs', () => {
  const html = notamAirspaceTooltip({ ...ROW, upcoming: true, endsAt: null }, text);
  assert.match(html, /Starts 2026-10-24 08:00Z → PERM/);
});

const DECK_SOURCE = new URL('../src/components/DeckGLMap.ts', import.meta.url);

test('DeckGLMap draws the restriction areas under every clickable layer', () => {
  // A pickable area drawn above a marker steals its hover and click.
  const source = readFileSync(DECK_SOURCE, 'utf8');
  const at = (call: string) => {
    const index = source.indexOf(`layers.push(${call}`);
    assert.ok(index > 0, `${call} is pushed in buildLayers`);
    return index;
  };
  const notam = at('...this.createNotamAirspaceLayers(');
  for (const above of [
    '...this.createChinaCorridorSelectionLayers(',
    'this.createCablesLayer(',
    'this.createEnergyPipelinesLayer(',
    'storageLayer)',
    'shortageLayer)',
    'this.createLiveTankersLayer(',
    'this.createConflictZonesLayer(',
    'this.createBasesLayer(',
    'this.createNuclearLayer(',
    '...this.createHotspotsLayers(',
    'this.createEarthquakesLayer(',
    'this.createFiresLayer(',
    'this.createOutagesLayer(',
    'this.createPortsLayer(',
    'this.createFlightDelaysLayer(',
    'this.createAircraftPositionsLayer(',
    '...this.createProtestClusterLayers(',
    'this.createMilitaryVesselsLayer(',
    'this.createMilitaryFlightsLayer(',
    'this.createMilitaryFlightClustersLayer(',
    "new ScatterplotLayer<import('../../shared/aircraft-emergencies')",
  ]) {
    assert.ok(notam < at(above), `NOTAM areas must be pushed before ${above}`);
  }
});

test('a click on a NOTAM area or marker still reaches the country under it', () => {
  // NOTAM shapes are hover-only; without this route a 250 NM circle swallows
  // every country click inside it, and a marker click does nothing.
  const source = readFileSync(DECK_SOURCE, 'utf8');
  const overlays = source.match(/AREA_OVERLAY_LAYER_IDS = new Set\(\[([^\]]*)\]/)?.[1] ?? '';
  for (const id of ['notam-airspace-polygons', 'notam-airspace-circles', 'notam-airspace-markers']) {
    assert.match(overlays, new RegExp(`'${id}'`));
    assert.match(source, new RegExp(`id: '${id}'`), `${id} is the layer id createNotamAirspaceLayers uses`);
  }
  assert.match(source, /if \(!info\.object \|\| isChoropleth \|\| isAreaOverlay\)/);
});
