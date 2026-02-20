import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './aggregate.js';

function makeRequest(query = '', options = {}) {
  const headers = new Headers(options.headers || {});
  return new Request(`https://worldmonitor.app/api/aggregate${query}`, {
    method: options.method || 'GET',
    headers,
  });
}

test('returns default aggregate payload with aliased endpoints', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    return new Response(JSON.stringify({ source: path }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await handler(makeRequest());
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.completed, 6);
    assert.equal(body.failed, 0);
    assert.equal(body.payload.news.ok, true);
    assert.equal(body.payload.signals.data.source, '/api/macro-signals');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('supports explicit endpoints list and tracks failed endpoint calls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(url).pathname;
    if (pathname === '/api/risk-scores') {
      return new Response(JSON.stringify({ error: 'upstream unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ pathname }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await handler(makeRequest('?endpoints=cii,signals'));
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.completed, 1);
    assert.equal(body.failed, 1);
    assert.equal(body.payload.cii.ok, false);
    assert.equal(body.payload.signals.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects invalid endpoint aliases', async () => {
  const response = await handler(makeRequest('?endpoints=signals,badalias'));
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.deepEqual(body.invalidEndpoints, ['badalias']);
});
