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
    // The poll loop's default ±10% jitter can bring the next poll this close.
    now += REFRESH_INTERVALS.natural * 0.9;
    assert.deepEqual(
      (await fetchEarthquakes()).map((q: { id: string }) => q.id),
      ['first', 'new'],
      'the next poll shows the new quake',
    );
  });

  it('returns the saved list when the refresh stalls past its deadline', async () => {
    let stall = false;
    mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!stall) return Promise.resolve(Response.json({ earthquakes: [quake('saved')] }));
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });
    const deadline = new AbortController();
    mock.method(AbortSignal, 'timeout', () => deadline.signal);
    let now = Date.parse('2026-10-18T07:00:00Z');
    mock.method(Date, 'now', () => now);

    const { fetchEarthquakes } = await import(`../src/services/earthquakes.ts?t=${Date.now()}-stall`);
    assert.deepEqual((await fetchEarthquakes()).map((q: { id: string }) => q.id), ['saved']);

    stall = true;
    now += REFRESH_INTERVALS.natural;
    const poll = fetchEarthquakes();
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    assert.deepEqual((await poll).map((q: { id: string }) => q.id), ['saved'], 'a stalled refresh returns the saved list');
  });
});
