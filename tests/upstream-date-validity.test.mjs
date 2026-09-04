import assert from 'node:assert/strict';
import test from 'node:test';

import { gdeltSeenDateToIso, gdeltSeenDateToMs, mapGdeltArticlesToEvents } from '../scripts/_conflict-gdelt.mjs';
import { computeEmaWindows, updateWindow } from '../scripts/_ema-threat-engine.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-04T12:00:00Z');

test('an impossible calendar day is rejected, not rolled into the next month', () => {
  // Date.parse('2026-02-31T00:00:00Z') resolves to March 3 rather than failing,
  // so slicing alone published a day the source never reported.
  for (const stamp of ['20260231T120000Z', '20260431T120000Z', '20260229T120000Z',
    '20261301T120000Z', '20260001T120000Z', '20260100T120000Z']) {
    assert.equal(gdeltSeenDateToIso(stamp), '', `accepted ${stamp}`);
    assert.ok(Number.isNaN(gdeltSeenDateToMs(stamp)), `accepted ms for ${stamp}`);
  }
});

test('a clock rollover does not move the observation to the following day', () => {
  for (const stamp of ['20260430T240000Z', '20260430T126000Z', '20260430T125960Z']) {
    assert.ok(Number.isNaN(gdeltSeenDateToMs(stamp)), `accepted ${stamp}`);
  }
});

test('leap days and both supported stamp shapes still parse', () => {
  assert.equal(gdeltSeenDateToIso('20240229'), '2024-02-29');
  for (const stamp of ['20240229T123456Z', '20240229123456']) {
    assert.equal(gdeltSeenDateToIso(stamp), '2024-02-29');
    assert.equal(gdeltSeenDateToMs(stamp), Date.parse('2024-02-29T12:34:56Z'));
  }
});

test('an article with an impossible date produces no conflict event', () => {
  const events = mapGdeltArticlesToEvents([
    { seendate: '20260231T120000Z', title: 'impossible', url: 'https://example.com/a' },
    { seendate: '20260228T120000Z', title: 'real', url: 'https://example.com/b' },
  ], 'SD');
  assert.equal(events.length, 1);
  assert.equal(events[0].event_date, '2026-02-28');
});

for (const source of ['acled', 'ucdp']) {
  const field = source === 'acled' ? 'event_date' : 'date_start';
  const split = events => (source === 'acled' ? [events, []] : [[], events]);

  test(`${source}: a corrupt far-future date cannot inflate the 24-hour count`, () => {
    const events = [now - 1, now, now + 30 * DAY].map(ms => ({
      country: 'Sudan', [field]: new Date(ms).toISOString(),
    }));
    const windows = computeEmaWindows(new Map(), ...split(events), now);
    assert.deepEqual(windows.get('sudan').window, [2]);
  });

  test(`${source}: a date-only event dated today is still counted from any timezone`, () => {
    // Kiribati is UTC+14, so its local "today" parses up to 14 hours ahead of
    // a UTC now. Clamping at nowMs would discard those real events.
    const events = [{ country: 'Sudan', [field]: '2026-09-04' },
      { country: 'Sudan', [field]: '2026-09-05' }];
    const windows = computeEmaWindows(new Map(), ...split(events), now);
    assert.deepEqual(windows.get('sudan').window, [2]);
  });
}

test('an existing country records a zero rather than keeping a stale count', () => {
  const prior = updateWindow('sudan', 2, null);
  const windows = computeEmaWindows(
    new Map([['sudan', prior]]),
    [{ country: 'Sudan', event_date: '2026-10-30' }],
    [{ country_name: 'Sudan', date_start: '2026-10-30' }],
    now,
  );
  assert.deepEqual(windows.get('sudan').window, [2, 0]);
  assert.deepEqual(prior.window, [2], 'the prior window must not be mutated');
});
