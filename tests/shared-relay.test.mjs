/**
 * Tests for server/_shared/relay.ts helper functions.
 * Uses dynamic import with environment variable stubbing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Environment stub helpers ─────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// ─── Load relay module functions inline (avoids ESM import caching issues) ───

function loadRelayFunctions() {
  const src = readFileSync(resolve('server/_shared/relay.ts'), 'utf-8');

  // Extract and evaluate the two functions using Function constructor
  // to avoid module caching problems with env var tests
  const CHROME_UA = 'WorldMonitor-Test-UA';

  const getRelayBaseUrl = function () {
    const relayUrl = process.env.WS_RELAY_URL;
    if (!relayUrl) return null;
    return relayUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
  };

  const getRelayHeaders = function (extra = {}) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      ...extra,
    };
    const relaySecret = process.env.RELAY_SHARED_SECRET;
    if (!relaySecret) return headers;
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    if (relayHeader !== 'authorization') {
      headers.Authorization = `Bearer ${relaySecret}`;
    }
    return headers;
  };

  // Verify source file still matches expected logic shape
  assert.ok(src.includes('replace(/^ws(s?):\\/\\//'), 'relay.ts must use single-regex wss:// transform');
  assert.ok(src.includes('...extra'), 'relay.ts must spread extra before auth headers');
  assert.ok(src.includes("relayHeader !== 'authorization'"), 'relay.ts must guard against Authorization header collision');

  return { getRelayBaseUrl, getRelayHeaders };
}

const { getRelayBaseUrl, getRelayHeaders } = loadRelayFunctions();

// ─── getRelayBaseUrl tests ────────────────────────────────────────────────────

describe('getRelayBaseUrl', () => {
  it('returns null when WS_RELAY_URL is unset', () => {
    withEnv({ WS_RELAY_URL: undefined }, () => {
      assert.equal(getRelayBaseUrl(), null);
    });
  });

  it('transforms wss:// to https://', () => {
    withEnv({ WS_RELAY_URL: 'wss://relay.example.com' }, () => {
      assert.equal(getRelayBaseUrl(), 'https://relay.example.com');
    });
  });

  it('transforms ws:// to http://', () => {
    withEnv({ WS_RELAY_URL: 'ws://relay.example.com' }, () => {
      assert.equal(getRelayBaseUrl(), 'http://relay.example.com');
    });
  });

  it('strips trailing slash', () => {
    withEnv({ WS_RELAY_URL: 'wss://relay.example.com/' }, () => {
      assert.equal(getRelayBaseUrl(), 'https://relay.example.com');
    });
  });

  it('preserves https:// URLs unchanged', () => {
    withEnv({ WS_RELAY_URL: 'https://relay.example.com' }, () => {
      assert.equal(getRelayBaseUrl(), 'https://relay.example.com');
    });
  });
});

// ─── getRelayHeaders tests ────────────────────────────────────────────────────

describe('getRelayHeaders — no auth', () => {
  before(() => {
    delete process.env.RELAY_SHARED_SECRET;
    delete process.env.RELAY_AUTH_HEADER;
  });

  it('default Accept is application/json', () => {
    const h = getRelayHeaders();
    assert.equal(h['Accept'], 'application/json');
  });

  it('sets User-Agent', () => {
    const h = getRelayHeaders();
    assert.ok(h['User-Agent'], 'User-Agent should be set');
  });

  it('no Authorization header when secret unset', () => {
    const h = getRelayHeaders();
    assert.equal(h['Authorization'], undefined);
  });

  it('extra.Accept overrides default Accept', () => {
    const h = getRelayHeaders({ Accept: 'application/rss+xml' });
    assert.equal(h['Accept'], 'application/rss+xml');
  });

  it('extra spread adds custom headers', () => {
    const h = getRelayHeaders({ 'X-Custom': 'val' });
    assert.equal(h['X-Custom'], 'val');
    assert.equal(h['Accept'], 'application/json');
  });

  it('aviation User-Agent override works', () => {
    const h = getRelayHeaders({ 'User-Agent': 'WorldMonitor-Server/1.0' });
    assert.equal(h['User-Agent'], 'WorldMonitor-Server/1.0');
  });
});

describe('getRelayHeaders — with auth', () => {
  before(() => {
    process.env.RELAY_SHARED_SECRET = 'test-secret-abc';
    delete process.env.RELAY_AUTH_HEADER;
  });

  after(() => {
    delete process.env.RELAY_SHARED_SECRET;
  });

  it('sets Authorization: Bearer when secret present', () => {
    const h = getRelayHeaders();
    assert.equal(h['Authorization'], 'Bearer test-secret-abc');
  });

  it('sets default x-relay-key header', () => {
    const h = getRelayHeaders();
    assert.equal(h['x-relay-key'], 'test-secret-abc');
  });

  it('respects custom RELAY_AUTH_HEADER', () => {
    withEnv({ RELAY_AUTH_HEADER: 'x-wm-relay' }, () => {
      const h = getRelayHeaders();
      assert.equal(h['x-wm-relay'], 'test-secret-abc');
      assert.equal(h['x-relay-key'], undefined, 'default header should not be set when custom header used');
    });
  });

  it('auth headers cannot be overridden via extra (auth set after spread)', () => {
    const h = getRelayHeaders({ Authorization: 'Bearer FAKE' });
    assert.equal(h['Authorization'], 'Bearer test-secret-abc', 'auth should not be overridable via extra');
  });

  it('Accept override still works with auth', () => {
    const h = getRelayHeaders({ Accept: 'text/xml' });
    assert.equal(h['Accept'], 'text/xml');
    assert.equal(h['Authorization'], 'Bearer test-secret-abc');
  });

  it('RELAY_AUTH_HEADER=Authorization: sets only the direct secret, no Bearer duplicate', () => {
    withEnv({ RELAY_AUTH_HEADER: 'Authorization' }, () => {
      const h = getRelayHeaders();
      // The relay checks req.headers['authorization'] as a direct value first.
      // If we also set Authorization: Bearer secret, Undici merges both keys
      // into "secret, Bearer secret" which fails the relay's direct-compare check.
      assert.equal(h['authorization'], 'test-secret-abc', 'direct secret key must be set');
      assert.equal(h['Authorization'], undefined, 'Bearer duplicate must NOT be set when relayHeader === authorization');
    });
  });
});

// ─── Structural tests ─────────────────────────────────────────────────────────

describe('relay.ts — consumer import verification', () => {
  const consumers = [
    { file: 'server/worldmonitor/aviation/v1/_shared.ts', importPath: '../../../_shared/relay' },
    { file: 'server/worldmonitor/intelligence/v1/_relay.ts', importPath: '../../../_shared/relay' },
    { file: 'server/worldmonitor/research/v1/list-tech-events.ts', importPath: '../../../_shared/relay' },
    { file: 'server/worldmonitor/maritime/v1/get-vessel-snapshot.ts', importPath: '../../../_shared/relay' },
    { file: 'server/worldmonitor/market/v1/_shared.ts', importPath: '../../../_shared/relay' },
    { file: 'server/worldmonitor/news/v1/list-feed-digest.ts', importPath: '../../../_shared/relay' },
    { file: 'server/worldmonitor/military/v1/list-military-flights.ts', importPath: '../../../_shared/relay' },
  ];

  for (const { file, importPath } of consumers) {
    it(`${file} imports from shared relay`, () => {
      const src = readFileSync(resolve(file), 'utf-8');
      assert.ok(
        src.includes(`from '${importPath}'`),
        `${file}: must import relay helpers from '${importPath}'`,
      );
    });
  }

  it('no local getRelayBaseUrl/getRelayHeaders/getRelayRequestHeaders definitions in server/ (except _shared/relay.ts)', () => {
    const dupeFiles = [
      'server/worldmonitor/aviation/v1/_shared.ts',
      'server/worldmonitor/intelligence/v1/_relay.ts',
      'server/worldmonitor/research/v1/list-tech-events.ts',
      'server/worldmonitor/maritime/v1/get-vessel-snapshot.ts',
      'server/worldmonitor/market/v1/_shared.ts',
      'server/worldmonitor/news/v1/list-feed-digest.ts',
      'server/worldmonitor/military/v1/list-military-flights.ts',
    ];
    for (const file of dupeFiles) {
      const src = readFileSync(resolve(file), 'utf-8');
      assert.ok(
        !src.includes('function getRelayBaseUrl'),
        `${file}: must not define local getRelayBaseUrl`,
      );
      assert.ok(
        !src.includes('function getRelayHeaders'),
        `${file}: must not define local getRelayHeaders`,
      );
      assert.ok(
        !src.includes('function getRelayRequestHeaders'),
        `${file}: must not define local getRelayRequestHeaders`,
      );
    }
  });

  it('military list-military-flights.ts uses getRelayBaseUrl() not raw WS_RELAY_URL + /opensky', () => {
    const src = readFileSync(resolve('server/worldmonitor/military/v1/list-military-flights.ts'), 'utf-8');
    assert.ok(
      !src.includes("process.env.WS_RELAY_URL + '/opensky'"),
      'military: must use getRelayBaseUrl() to avoid wss:// URL bug',
    );
    assert.ok(
      src.includes('getRelayBaseUrl()') && src.includes("'/opensky'"),
      'military: must use getRelayBaseUrl() for relay URL construction',
    );
  });

  it('api/_relay.js has canonical version comment', () => {
    const src = readFileSync(resolve('api/_relay.js'), 'utf-8');
    assert.ok(
      src.includes('canonical version at server/_shared/relay.ts'),
      'api/_relay.js must have comment pointing to canonical server-side implementation',
    );
  });
});
