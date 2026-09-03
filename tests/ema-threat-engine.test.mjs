import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEmaWindows, updateWindow } from '../scripts/_ema-threat-engine.mjs';

const now = Date.parse('2026-09-04T12:00:00Z');
const day = 24 * 60 * 60 * 1000;

for (const source of ['acled', 'ucdp']) {
  test(`${source}: counts only observations inside the inclusive 24-hour window`, () => {
    const dates = [now - day - 1, now - day, now - 1, now, now + 1, now + day];
    const events = dates.map(timestamp => ({
      country: 'Sudan',
      [source === 'acled' ? 'event_date' : 'date_start']: new Date(timestamp).toISOString(),
    }));
    events.push({ country: 'Sudan', event_date: 'invalid', date_start: 'invalid' });
    const windows = computeEmaWindows(new Map(),
      source === 'acled' ? events : [], source === 'ucdp' ? events : [], now);
    assert.deepEqual(windows.get('sudan').window, [3]);
  });

  test(`${source}: future-only observations do not create a country window`, () => {
    const events = [{ country: 'Sudan', event_date: '2026-09-05', date_start: '2026-09-05' }];
    const windows = computeEmaWindows(new Map(),
      source === 'acled' ? events : [], source === 'ucdp' ? events : [], now);
    assert.equal(windows.size, 0);
  });
}

test('existing countries receive zero when their only new observations are in the future', () => {
  const prior = updateWindow('sudan', 2, null);
  const windows = computeEmaWindows(new Map([['sudan', prior]]),
    [{ country: 'Sudan', event_date: '2026-09-05' }],
    [{ country_name: 'Sudan', date_start: '2026-09-05' }], now);
  assert.deepEqual(windows.get('sudan').window, [2, 0]);
  assert.deepEqual(prior.window, [2]);
});

test('both sources retain current-day date-only observations and country-name fallback', () => {
  const windows = computeEmaWindows(new Map(),
    [{ country: ' Sudan ', event_date: '2026-09-04' }],
    [{ country_name: 'SUDAN', date_start: '2026-09-04' }], now);
  assert.deepEqual(windows.get('sudan').window, [2]);
});
