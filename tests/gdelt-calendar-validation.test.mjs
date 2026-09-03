import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdeltSeenDateToIso, gdeltSeenDateToMs, mapGdeltArticlesToEvents } from '../scripts/_conflict-gdelt.mjs';

test('rejects impossible calendar days instead of rolling into another month', () => {
  for (const stamp of ['20260229T120000Z', '20260431T120000Z', '20260231T120000Z',
    '20261301T120000Z', '20260001T120000Z', '20260100T120000Z']) {
    assert.equal(gdeltSeenDateToIso(stamp), '');
    assert.ok(Number.isNaN(gdeltSeenDateToMs(stamp)));
  }
});

test('preserves leap days, date-only inputs and both supported timestamp forms', () => {
  assert.equal(gdeltSeenDateToIso('20240229'), '2024-02-29');
  for (const stamp of ['20240229T123456Z', '20240229123456']) {
    assert.equal(gdeltSeenDateToIso(stamp), '2024-02-29');
    assert.equal(gdeltSeenDateToMs(stamp), Date.parse('2024-02-29T12:34:56Z'));
  }
});

test('rejects overflowing clock components in full-precision timestamps', () => {
  for (const stamp of ['20260430T240000Z', '20260430T126000Z', '20260430T125960Z']) {
    assert.ok(Number.isNaN(gdeltSeenDateToMs(stamp)));
  }
});

test('does not emit conflict events for articles with impossible dates', () => {
  const events = mapGdeltArticlesToEvents([
    { seendate: '20260231T120000Z', title: 'invalid', url: 'https://example.com/invalid' },
    { seendate: '20260228T120000Z', title: 'valid', url: 'https://example.com/valid' },
  ], 'SD');
  assert.equal(events.length, 1);
  assert.equal(events[0].event_date, '2026-02-28');
});
