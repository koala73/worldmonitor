import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { REFRESH_INTERVALS } from '../src/config/variants/base.ts';

// The dashboard polls earthquakes on REFRESH_INTERVALS.natural. A quake USGS
// published between two polls must appear on the next poll, not one poll
// later: the client cache used to answer the poll itself, or show the old list
// while refreshing in the background.

function quake(id: string) {
  return { id, place: id, magnitude: 6.1, depthKm: 10, location: { latitude: 1, longitude: 2 }, occurredAt: 1, sourceUrl: '' };
}

afterEach(() => mock.restoreAll());

describe('earthquake polling freshness', () => {
  it('shows a quake published since the last poll on the very next poll', async () => {
    let served = [quake('first')];
    mock.method(globalThis, 'fetch', async () => Response.json({ earthquakes: served }));
    let now = Date.parse('2026-10-18T06:00:00Z');
    mock.method(Date, 'now', () => now);

    const { fetchEarthquakes } = await import(`../src/services/earthquakes.ts?t=${Date.now()}`);

    assert.deepEqual((await fetchEarthquakes()).map((q: { id: string }) => q.id), ['first']);

    served = [quake('first'), quake('new')];
    now += REFRESH_INTERVALS.natural;
    assert.deepEqual(
      (await fetchEarthquakes()).map((q: { id: string }) => q.id),
      ['first', 'new'],
      'the next poll shows the new quake',
    );
  });
});
