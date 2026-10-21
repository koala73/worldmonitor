import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import handler from '../api/opensky.js';

describe('OpenSky legacy proxy product boundary', () => {
  const originalFetch = globalThis.fetch;
  const originalRelayUrl = process.env.WS_RELAY_URL;
  const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
  const originalProductKey = process.env.WORLDMONITOR_API_KEY;
  const originalLocalMode = process.env.LOCAL_API_MODE;

  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.test';
    process.env.WORLDMONITOR_VALID_KEYS = 'desktop-product-key';
    process.env.WORLDMONITOR_API_KEY = 'desktop-product-key';
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRelayUrl == null) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = originalRelayUrl;
    if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
    if (originalProductKey == null) delete process.env.WORLDMONITOR_API_KEY;
    else process.env.WORLDMONITOR_API_KEY = originalProductKey;
    if (originalLocalMode == null) delete process.env.LOCAL_API_MODE;
    else process.env.LOCAL_API_MODE = originalLocalMode;
  });

  it('requires both a product transport and its enterprise credential', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ states: [] }));
    };

    for (const headers of [
      { 'X-WorldMonitor-Key': 'wms_browser-session' },
      { 'X-Api-Key': 'desktop-product-key' },
      { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'wms_browser-session' },
      { Origin: 'tauri://localhost' },
      { Origin: 'tauri://localhost', 'X-WorldMonitor-Key': 'wrong-key' },
      { Origin: 'tauri://localhost', 'X-WorldMonitor-Key': 'wms_browser-session' },
      { Origin: 'http://127.0.0.1:43127' },
      { Origin: 'http://127.0.0.1:43127', 'X-WorldMonitor-Key': 'wrong-key' },
    ]) {
      const response = await handler(new Request('https://worldmonitor.app/api/opensky', { headers }));
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
    }
    assert.equal(upstreamCalls, 0);
  });

  it('keeps the authenticated Tauri desktop product path available', async () => {
    let upstreamUrl = '';
    globalThis.fetch = async (url) => {
      upstreamUrl = String(url);
      return new Response(JSON.stringify({ states: [['abc123']] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await handler(new Request('https://worldmonitor.app/api/opensky?icao24=abc123', {
      headers: {
        Origin: 'tauri://localhost',
        'X-WorldMonitor-Key': 'desktop-product-key',
      },
    }));
    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, 'https://relay.test/opensky?icao24=abc123');
    assert.deepEqual(await response.json(), { states: [['abc123']] });
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
    assert.doesNotMatch(response.headers.get('Cache-Control') || '', /public|s-maxage/i);
  });

  it('accepts the sidecar-rewritten local and cloud product hops', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ states: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    for (const headers of [
      { Origin: 'http://127.0.0.1:43127', 'X-WorldMonitor-Key': 'desktop-product-key' },
      { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'desktop-product-key' },
    ]) {
      const response = await handler(new Request('https://worldmonitor.app/api/opensky', { headers }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
    }
    assert.equal(upstreamCalls, 2);
  });
});
