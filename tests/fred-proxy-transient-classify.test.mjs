import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { CHROME_UA, fredFetchJson, httpsProxyFetchRaw, isExitRefusalError, isTransientProxyError } from '../scripts/_seed-utils.mjs';

// fredFetchJson retries the Decodo proxy only when the error is classified
// transient; otherwise it breaks to a direct FRED fetch, which a datacenter IP
// gets rate-limited/blocked on → the whole seed-economy batch fails and
// fredBatch/economicStress/macroSignals go stale. The TLS-handshake tear
// signatures below are the EXACT strings seen in the failing-run logs and MUST
// be retried — they did not match the original 5xx/timeout-only regex.
//
// The exit does NOT rotate on its own. A Decodo sticky port pins one exit for
// the life of the session, so a retry lands on a different IP only because the
// CALLER advances the attempt index (#7963). Reading it the other way round is
// what let three retries pile onto one dead exit during the 2026-09-10 outage.
//
// Run: node --test tests/fred-proxy-transient-classify.test.mjs

const originalFetch = globalThis.fetch;
const proxyUtils = createRequire(import.meta.url)('../scripts/_proxy-utils.cjs');

test('FRED retries a failed sticky exit on a different port before falling back direct', async (t) => {
  const routes = [];
  t.mock.method(proxyUtils, 'proxyFetch', async (_url, config) => {
    routes.push(config);
    if (config.port === 10001) throw new Error('Proxy CONNECT: HTTP/1.1 522 Server Error');
    return { ok: true, buffer: Buffer.from('{"observations":[{"value":"1"}]}') };
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('direct must not be needed'); });
  const result = await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:10001');
  assert.deepEqual(routes.map((route) => route.port), [10001, 10002]);
  assert.ok(routes.every((route) => route.host === 'gate.decodo.com' && route.tls && route.auth === 'fake:secret'));
  assert.equal(result.observations[0].value, '1');
});

test('FRED exhausts three distinct sticky exits then retains the direct fallback', async (t) => {
  const ports = [];
  t.mock.method(proxyUtils, 'proxyFetch', async (_url, config) => {
    ports.push(config.port);
    throw new Error('Proxy CONNECT: HTTP/1.1 522 Server Error');
  });
  const direct = t.mock.method(globalThis, 'fetch', async () => new Response('{"observations":[]}'));
  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:49999');
  assert.deepEqual(ports, [49999, 10001, 10002]);
  assert.equal(direct.mock.callCount(), 1);
});

test('FRED leaves non-sticky and other-provider routes unchanged on retry', async (t) => {
  // The direct leg is stubbed even though the proxy leg is meant to succeed on
  // attempt 2. This suite exists to catch isTransientProxyError
  // misclassification, and that is exactly the regression that would exhaust
  // the proxy leg instead — at which point fredDirectFetchJson calls the real
  // global fetch and this test starts reaching api.stlouisfed.org from CI.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('direct must not be needed'); });
  for (const proxy of ['http://fake:secret@gate.decodo.com:7000', 'http://fake:secret@proxy.test:10001']) {
    const routes = [];
    const mocked = t.mock.method(proxyUtils, 'proxyFetch', async (_url, config) => {
      routes.push(config);
      if (routes.length === 1) throw new Error('HTTP 503');
      return { ok: true, buffer: Buffer.from('{}') };
    });
    await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', proxy);
    assert.equal(routes.length, 2);
    assert.deepEqual(routes[1], routes[0]);
    assert.equal(routes[0].tls, false);
    mocked.mock.restore();
  }
});

test('FRED does not retry a permanent proxy authentication failure', async (t) => {
  const proxy = t.mock.method(proxyUtils, 'proxyFetch', async () => { throw new Error('HTTP 407'); });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:10001');
  assert.equal(proxy.mock.callCount(), 1);
  // One call cannot demonstrate the ABSENCE of rotation — attempt 0 resolves to
  // the configured port either way — so pin that the single attempt really did
  // use the operator's exit rather than a rotated one.
  assert.equal(proxy.mock.calls[0].arguments[1].port, 10001);
});

// FRED blocks datacenter IPs — that is the entire reason the proxy leg exists
// (#2911). So a 403 the origin returns through a healthy tunnel is the most
// exit-specific failure there is: this exit is unwelcome, and the next sticky
// exit may well be fine. Before this, rotation was gated solely on
// isTransientProxyError, which matches no 4xx at all, so the retry loop broke
// after ONE attempt and fell to the direct leg — from the Railway datacenter IP
// that FRED blocks hardest. The rotation added in #7963 never fired for it.
//
// The mock RESOLVES `{ ok: false, status }` rather than throwing a pre-tagged
// error. That matters: `.status` is attached by httpsProxyFetchRaw, and a mock
// that throws its own tagged error supplies the very field whose production
// construction this test is supposed to prove — stripping that attachment left
// the whole suite green. Resolving here routes through the real seam.
test('FRED rotates to a new exit when the origin refuses this one (403)', async (t) => {
  const ports = [];
  t.mock.method(proxyUtils, 'proxyFetch', async (_url, config) => {
    ports.push(config.port);
    if (config.port === 10001) return { ok: false, status: 403, buffer: Buffer.from('blocked'), contentType: 'text/plain' };
    return { ok: true, buffer: Buffer.from('{"observations":[{"value":"7"}]}') };
  });
  const direct = t.mock.method(globalThis, 'fetch', async () => { throw new Error('direct must not be needed'); });
  const result = await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:10001');
  assert.deepEqual(ports, [10001, 10002], 'an origin 403 must move to the next exit');
  assert.equal(result.observations[0].value, '7');
  assert.equal(direct.mock.callCount(), 0, 'an origin 403 must not reach the direct leg');
});

// 429 is NOT rotated on. Nothing establishes that FRED's rate limit is
// IP-scoped, `api_key` rides in the query string, and rotating would triple the
// request count against an already-exhausted quota while Retry-After is
// discarded. If that premise is ever evidenced, this test is the thing to flip.
test('FRED does not rotate on a 429 — the quota is not known to follow the exit', async (t) => {
  const ports = [];
  t.mock.method(proxyUtils, 'proxyFetch', async (_url, config) => {
    ports.push(config.port);
    return { ok: false, status: 429, buffer: Buffer.from('slow down'), contentType: 'text/plain' };
  });
  const direct = t.mock.method(globalThis, 'fetch', async () => new Response('{"observations":[]}'));
  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:10001');
  assert.deepEqual(ports, [10001], 'a 429 must not burn extra exits');
  assert.equal(direct.mock.callCount(), 1, 'a 429 falls through to the direct leg immediately');
});

// isExitRefusalError is exported, so pin it directly rather than only through
// fredFetchJson. The black-box assertions cannot distinguish "this predicate
// returned false" from "isTransientProxyError already excluded every 4xx".
test('isExitRefusalError keys on the origin status and ignores gateway rejections', () => {
  assert.equal(isExitRefusalError(Object.assign(new Error('HTTP 403'), { status: 403 })), true);
  assert.equal(isExitRefusalError(Object.assign(new Error('HTTP 429'), { status: 429 })), false, '429 is out until the quota is shown to follow the exit');
  assert.equal(isExitRefusalError(Object.assign(new Error('CONNECT 403'), { status: 403, proxyConnect: true })), false, 'a gateway rejection is not exit-attributable');
  for (const status of [400, 404, 500, 502, undefined]) {
    assert.equal(isExitRefusalError(Object.assign(new Error('x'), { status })), false, `status=${String(status)}`);
  }
  // The footgun this signature invites: it takes the ERROR, while its neighbour
  // isTransientProxyError takes the MESSAGE. Passing a string must not silently
  // read as "not a refusal" by accident of property lookup.
  for (const notAnError of ['HTTP 403', null, undefined, 403]) {
    assert.equal(isExitRefusalError(notAnError), false, `non-error input ${String(notAnError)}`);
  }
});

test('FRED does not rotate on a gateway rejection — no exit fixes bad credentials', async (t) => {
  // Same 403 status, but raised by the CONNECT hop rather than by FRED.
  const proxy = t.mock.method(proxyUtils, 'proxyFetch', async () => {
    throw Object.assign(new Error('Proxy CONNECT: HTTP/1.1 403 Forbidden'), { status: 403, proxyConnect: true });
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:10001');
  assert.equal(proxy.mock.callCount(), 1, 'a gateway rejection must still fail fast');
});

test('FRED still does not rotate on an origin 4xx that every exit answers alike', async (t) => {
  // A bad series id is not exit-attributable — 400 and 404 fail identically on
  // every exit, so rotating just burns the budget before the direct leg.
  for (const status of [400, 404]) {
    const proxy = t.mock.method(proxyUtils, 'proxyFetch', async () => {
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    });
    const direct = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
    await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:10001');
    assert.equal(proxy.mock.callCount(), 1, `origin ${status} must fail fast`);
    // Restore BOTH per iteration. Leaving the fetch mock installed stacked a
    // second mock on the first on the next pass through the loop.
    proxy.mock.restore();
    direct.mock.restore();
  }
});

test('the proxy-exhaustion warning names every exit it tried', async (t) => {
  // Rotation can silently no-op: parseProxyConfigForAttempt returns the route
  // untouched for any host outside its sticky map (us.decodo.com, an ISP or
  // city-targeted endpoint) or any port outside the range, with no warning. A
  // healthy run looks identical whether rotation engaged or the original exit
  // simply recovered, so the failure log is the only place an operator can see
  // which it was. Three identical ports here is the proof it is inert.
  const warnings = [];
  t.mock.method(console, 'warn', (line) => { warnings.push(String(line)); });
  t.mock.method(proxyUtils, 'proxyFetch', async () => {
    throw new Error('Proxy CONNECT: HTTP/1.1 522 Server Error');
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{"observations":[]}'));
  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations', 'https://fake:secret@gate.decodo.com:49999');
  const exhaustion = warnings.find((line) => line.includes('[fredFetch]'));
  assert.ok(exhaustion, 'the proxy leg must announce that it fell through to direct');
  // Pin the RENDERED list, not a loose /49999.*10001.*10002/ — `.*` spans the
  // whole line, so the interpolated error message alone could satisfy a loose
  // pattern and the assertion would survive the port list being dropped.
  assert.ok(
    exhaustion.includes('on exits [49999, 10001, 10002]'),
    `the warning must name the exits actually tried, in attempt order — got: ${exhaustion}`,
  );
});

test('httpsProxyFetchRaw with no options bag keeps the configured sticky exit', async (t) => {
  // #7963 swapped this helper's resolver from parseProxyConfig to
  // parseProxyConfigForAttempt for EVERY caller. About 15 seeders pass no
  // proxyAttempt, so the `proxyAttempt = 0` default is the only thing holding
  // their egress exit still — and nothing exercised it, because
  // httpsProxyFetchJson always threads the index explicitly. A regression to a
  // non-zero default would silently move every non-FRED proxy seeder onto a
  // different exit with the whole FRED suite still green.
  const routes = [];
  t.mock.method(proxyUtils, 'proxyFetch', async (_url, config) => {
    routes.push(config);
    return { ok: true, buffer: Buffer.from('{}') };
  });
  await httpsProxyFetchRaw('https://example.test/x', 'https://fake:secret@gate.decodo.com:10001');
  assert.deepEqual(routes.map((route) => route.port), [10001]);
});

// The direct leg is the LAST leg — when it drops a series, that series is gone
// for the whole cycle. On 2026-08-26 FRED returned `direct: HTTP 502` for
// T10Y2Y and UNRATE, publishing 22/24 and tripping health's minRecordCount of
// 24, while four adjacent runs fetched 24/24 and both series answered 200 when
// queried moments later. The proxy leg already retried three times; its own
// fallback got exactly one attempt.
test('direct FRED leg retries a transient 5xx instead of dropping the series', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ observations: [{ date: '2026-08-25', value: '0.47' }] }) };
  };
  const out = await fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y');
  assert.equal(calls, 2, 'a 502 must be retried once');
  assert.equal(out.observations[0].value, '0.47');
});

test('direct FRED leg does NOT retry a 4xx — a bad series id never fixes itself', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, json: async () => ({}) };
  };
  await assert.rejects(
    () => fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=NOPE'),
    /HTTP 400/,
  );
  assert.equal(calls, 1, 'a 4xx must fail fast, not burn a retry');
});

test('direct FRED leg does NOT retry a timeout — it has already burned its budget', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  await assert.rejects(
    () => fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y'),
    /timeout/i,
  );
  // Retrying a 20s timeout would double the worst case inside runSeed's
  // fetch-phase deadline for a leg that is plainly broken.
  assert.equal(calls, 1, 'a timeout must not be retried on the direct leg');
});

test('fredFetchJson direct FRED fallback sends a User-Agent header', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let seenHeaders = null;
  globalThis.fetch = async (_url, init = {}) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({ observations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=GDP');

  assert.equal(seenHeaders?.['User-Agent'], CHROME_UA);
  assert.equal(seenHeaders?.Accept, 'application/json');
});

test('fredFetchJson proxy fallback direct path sends a User-Agent header', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let seenHeaders = null;
  globalThis.fetch = async (_url, init = {}) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({ observations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=GDP', 'invalid-proxy-auth');

  assert.equal(seenHeaders?.['User-Agent'], CHROME_UA);
  assert.equal(seenHeaders?.Accept, 'application/json');
});

test('TLS-handshake tear signatures (from the real failing logs) are transient', () => {
  const tlsTears = [
    '80D38646D17F0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:ssl/record/methods/tls_common.c:662:',
    'Client network socket disconnected before secure TLS connection was established',
  ];
  for (const msg of tlsTears) {
    assert.equal(isTransientProxyError(msg), true, `should retry: ${msg}`);
  }
});

test('classic transient signatures still classify transient (no regression)', () => {
  for (const msg of [
    'HTTP 522', 'HTTP 503', 'proxy fetch timeout',
    'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'socket hang up',
  ]) {
    assert.equal(isTransientProxyError(msg), true, `should retry: ${msg}`);
  }
});

test('genuinely non-transient errors are NOT retried (fall straight to direct)', () => {
  for (const msg of ['HTTP 401', 'HTTP 403', 'HTTP 404', 'Missing FRED_API_KEY', '']) {
    assert.equal(isTransientProxyError(msg), false, `should NOT retry: "${msg}"`);
  }
  assert.equal(isTransientProxyError(undefined), false);
  assert.equal(isTransientProxyError(null), false);
});
