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
  assert.match(html, /&lt;b&gt;N&lt;\/b&gt;/);
  assert.match(html, /Danger area/);
});

test('notamAirspaceTooltip reads as plain language, not a raw NOTAM', () => {
  const html = notamAirspaceTooltip({
    ...ROW,
    kind: 'reserved',
    number: 'W1177/26',
    location: 'OEJD',
    lower: 'SFC',
    upper: 'FL250',
    startsAt: Date.UTC(2026, 8, 19),
    endsAt: Date.UTC(2026, 9, 28, 23, 59),
    radiusNm: 92,
    text: 'AIRSPACE RESERVATION WILL TAKE PLACE WI FLW COORD: 245200N0475200E 240000N0485900E',
  }, text, Date.UTC(2026, 9, 25, 12));
  assert.match(html, /Airspace reservation/);
  assert.match(html, /Ground to 25,000 ft/);
  assert.match(html, /Until 28 Oct/);
  assert.match(html, /FAA NOTAM W1177\/26/);
  // The shape is on the map; codes, coordinates and the raw text are not for most readers.
  for (const gone of [/COORD/, /245200N/, /OEJD/, /92 NM/, /FL250/, /SFC/, /\d{2}:\d{2}Z/]) assert.doesNotMatch(html, gone);
});

test('notamAirspaceTooltip spells out every altitude format the feed sends', () => {
  const band = (lower: string | undefined, upper: string | undefined) =>
    notamAirspaceTooltip({ ...ROW, lower, upper }, text, ROW.startsAt! + 1);
  assert.match(band('GND', '5000FT AMSL'), /Ground to 5,000 ft</);
  assert.match(band('FL100', 'FL245'), /10,000 to 24,500 ft</);
  assert.match(band('5000FT AMSL', 'UNL'), /5,000 ft and higher/);
  assert.match(band('SFC', 'UNL)'), /Any altitude/);
  assert.match(band('SFC', '3000M AMSL'), /Ground to 9,800 ft</);
  assert.match(band('SFC', '400 FT AGL'), /Up to 400 ft above ground/);
  assert.match(band('FL250', 'FL250'), /At 25,000 ft</);
  // Heights above the ground keep that reference, and mixed references are not compared.
  assert.match(band('1500FT AGL', 'UNL'), /1,500 ft above ground and higher/);
  assert.match(band('SFC', '120M AGL)\r\r\nDUPE'), /Up to 390 ft above ground/);
  assert.match(band('500FT AGL', '2000FT AGL'), /500 to 2,000 ft above ground/);
  assert.match(band('3000FT AGL', '2000FT AMSL'), /3,000 ft above ground to 2,000 ft</);
  // An unreadable limit drops the line rather than showing a code.
  assert.doesNotMatch(band('GNG', 'XYZ'), /XYZ|GNG/);
  assert.doesNotMatch(band(undefined, undefined), / ft/);
});

test('notamAirspaceTooltip says when in plain terms', () => {
  const at = (row: Partial<NotamAirspaceRestriction>, now: number) => notamAirspaceTooltip({ ...ROW, ...row }, text, now);
  const now = Date.UTC(2026, 9, 24, 9, 0);
  assert.match(at({}, now), /Until 18:00 UTC today/);
  assert.match(at({ endsAt: null }, now), /Permanent/);
  assert.match(at({ upcoming: true, startsAt: Date.UTC(2026, 9, 25, 6, 30) }, now), /Starts 25 Oct, 06:30 UTC/);
  assert.match(at({ schedule: 'DAILY 0800-1600', endsAt: Date.UTC(2026, 10, 3) }, now), /At set times until 3 Nov/);
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
