import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchKalshiEvents,
  fetchPolymarketEventsByTag,
} from '../scripts/_prediction-upstream.mjs';

describe('prediction-market upstream coverage', () => {
  it('follows the Kalshi cursor until the last page', async () => {
    const urls = [];
    const pages = [
      { events: [{ id: 'one' }], cursor: 'next-page' },
      { events: [{ id: 'two' }], cursor: '' },
    ];
    const events = await fetchKalshiEvents({
      fetchFn: async (url) => {
        urls.push(String(url));
        return Response.json(pages.shift());
      },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
    });

    assert.deepEqual(events.map((event) => event.id), ['one', 'two']);
    assert.equal(urls.length, 2);
    assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'next-page');
  });

  it('bounds Kalshi pagination when the upstream cursor never ends', async () => {
    let calls = 0;
    const events = await fetchKalshiEvents({
      fetchFn: async () => Response.json({ events: [{ id: ++calls }], cursor: `page-${calls}` }),
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
      maxPages: 3,
    });

    assert.equal(calls, 3);
    assert.equal(events.length, 3);
  });

  it('requests 100 Polymarket events per tag instead of truncating at 20', async () => {
    let requestedUrl = '';
    await fetchPolymarketEventsByTag('politics', {
      fetchFn: async (url) => {
        requestedUrl = String(url);
        return Response.json([]);
      },
      baseUrl: 'https://polymarket.example.test',
      userAgent: 'test',
    });

    assert.equal(new URL(requestedUrl).searchParams.get('limit'), '100');
  });
});
