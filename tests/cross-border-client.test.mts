import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EMPTY_CROSS_BORDER, toCrossBorderData } from '../src/services/displacement/cross-border.ts';

const chad = { latitude: 15.4, longitude: 18.7 };
const payload = {
  source: 'UNHCR Operational Data Portal',
  situations: [
    {
      id: 'sudan', name: 'Sudan crisis', origin: 'SD', sourceUrl: 'https://data.unhcr.org/en/situations/sudansituation', asOf: '2026-09-21', accelerating: false,
      flows: [
        { kind: 'outflow', label: 'Refugees from Sudan', origin: 'SD', originLocation: { latitude: 15.5, longitude: 32.5 }, measure: 'stock', total: 1428829, asOf: '2026-09-21',
          countries: [
            { country: 'Chad', iso2: 'TD', individuals: 959126, date: '2026-09-21', location: chad, change: { since: '2026-09-07', delta: 9126 } },
            { country: 'Libya', iso2: 'LY', individuals: 469703, date: '2026-09-21', location: { latitude: 27, longitude: 17 } },
          ] },
        { kind: 'return', label: 'Returns', origin: 'SD', measure: 'stock', total: 910362, asOf: '2026-09-21',
          countries: [{ country: 'South Sudan', iso2: 'SS', individuals: 910362, date: '2026-09-21', location: { latitude: 7, longitude: 30 } }] },
      ],
      trend: { measure: 'stock', points: [['2026-09-07', 3673123], ['2026-09-21', 3683932]], latestDelta: 10809, latestDays: 14, accelerating: false },
    },
    {
      id: 'sahel', name: 'Sahel crisis', origin: '', asOf: '2026-09-21', accelerating: false,
      flows: [{ kind: 'outflow', label: 'Hosted in the Sahel', origin: '', measure: 'stock', total: 1583656, asOf: '2026-09-21',
        countries: [{ country: 'Chad', iso2: 'TD', individuals: 1583656, date: '2026-09-21', location: chad }] }],
    },
    {
      id: 'mediterranean', name: 'Mediterranean routes', origin: '', asOf: '2026-10-04', accelerating: true,
      flows: [
        { kind: 'arrival', label: 'Sea and land arrivals', origin: '', measure: 'monthly', total: 78128, asOf: '2026-10-04', accelerating: true,
          months: [{ month: '2026-10', individuals: 349 }, { month: '2026-09', individuals: 12033 }],
          countries: [{ country: 'Spain', iso2: 'ES', individuals: 24646, date: '2026-09-30', location: { latitude: 40, longitude: -3.7 },
            months: [{ month: '2026-10', individuals: 0 }, { month: '2026-09', individuals: 4229 }], accelerating: true }] },
        { kind: 'death', label: 'Dead and missing', origin: '', measure: 'monthly', total: 129,
          countries: [{ country: 'Spain', iso2: 'ES', individuals: 129, date: '2026-05-03', location: { latitude: 40, longitude: -3.7 } }] },
      ],
    },
  ],
};

test('builds one panel row per situation with its latest change and total', () => {
  const data = toCrossBorderData(payload);
  assert.deepEqual(data.situations.map((s) => [s.id, s.total, s.latestChange, s.lastMonth, s.topCountries]), [
    ['sudan', 1428829, { delta: 10809, days: 14 }, null, ['Chad', 'Libya']],
    ['sahel', 1583656, null, null, ['Chad']],
    ['mediterranean', 78128, null, { month: '2026-09', individuals: 12033 }, ['Spain']],
  ]);
  assert.deepEqual(data.situations[0].countryCodes.sort(), ['LY', 'SD', 'SS', 'TD']);
  assert.deepEqual([data.situations[0].lat, data.situations[0].lon], [chad.latitude, chad.longitude]);
});

test('keeps the largest figure per country and kind on the map, and leaves deaths off it', () => {
  const data = toCrossBorderData(payload);
  const chadOutflow = data.points.filter((p) => p.country === 'Chad');
  assert.equal(chadOutflow.length, 1, 'Sudan and Sahel both report Chad; the map draws it once');
  assert.equal(chadOutflow[0].situation, 'Sahel crisis');
  assert.equal(chadOutflow[0].individuals, 1583656);
  const spain = data.points.filter((p) => p.country === 'Spain');
  assert.deepEqual(spain.map((p) => [p.kind, p.lastMonth, p.accelerating]), [['arrival', 4229, true]]);
  const libya = data.points.find((p) => p.country === 'Libya');
  assert.deepEqual([libya?.change, libya?.changeSince], [null, '']);
});

test('returns the empty shape for anything that is not a payload', () => {
  for (const value of [undefined, null, 'x', {}, { situations: 'nope' }]) assert.deepEqual(toCrossBorderData(value), EMPTY_CROSS_BORDER);
});
