import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNotamAirspace, type NotamAirspaceRestriction } from '../src/services/notam-airspace.ts';
import { notamAirspaceTooltip } from '../src/components/map/notam-airspace-style.ts';
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

test('notamAirspaceTooltip escapes every upstream field', () => {
  const html = notamAirspaceTooltip({
    ...ROW,
    kind: 'danger',
    location: '<img src=x onerror=alert(1)>',
    number: '<b>N</b>',
    schedule: '<script>s</script>',
    text: '<svg onload=alert(2)>',
  }, text);
  assert.doesNotMatch(html, /<img|<script|<svg|<b>/);
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
