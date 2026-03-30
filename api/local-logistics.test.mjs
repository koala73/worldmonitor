import test from 'node:test';
import assert from 'node:assert/strict';

import handler from './local-logistics.js';

test('local logistics route rejects missing coordinates', async () => {
  const response = await handler(new Request('https://worldmonitor.app/api/local-logistics', {
    headers: { origin: 'https://worldmonitor.app' },
  }));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'lat and lon are required');
});

test('local logistics route maps Overpass elements into logistics nodes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method, body: String(options?.body || '') });
    return new Response(JSON.stringify({
      elements: [
        {
          type: 'node',
          id: 42,
          lat: 35.995,
          lon: -78.901,
          tags: {
            name: 'Duke Hospital',
            emergency: 'yes',
            opening_hours: '24/7',
            website: 'https://example.com/hospital',
            'addr:street': 'Main St',
            'addr:city': 'Durham',
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await handler(new Request('https://worldmonitor.app/api/local-logistics?lat=35.994&lon=-78.8986&categories=hospital&limitPerCategory=1', {
      headers: { origin: 'https://worldmonitor.app' },
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0]?.category, 'hospital');
    assert.equal(body.nodes[0]?.status, 'open');
    assert.equal(body.nodes[0]?.url, 'https://example.com/hospital');
    assert.match(calls[0]?.url ?? '', /overpass/i);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.body ?? '', /amenity|healthcare/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
