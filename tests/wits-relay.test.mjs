import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Execute the real router and inline handler without starting the relay's workers.
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing relay section: ${start}`);
  return source.slice(from, to);
}
const routeSource = [
  section('function safeEnd(', 'const WORLD_BANK_COUNTRY_ALLOWLIST'),
  section('function safeTokenEquals(', 'function getRateLimitForPath('),
  section('async function handleWitsRequest(', '// ── World Bank proxy'),
  section('const server = http.createServer(', '// ─── Google Flights ─'),
  'server;',
].join('\n');

const SDMX = '/API/V1/SDMX/V21/datasource/TRN';
const META = '/API/V1/wits/datasource/trn';
const reported = `${SDMX}/reporter/840/partner/all/product/870380/year/2023/datatype/reported`;
const ave = `${SDMX}/reporter/840/partner/000/product/220421/year/2021/datatype/aveestimated`;
const availability = `${META}/dataavailability/country/840/year/all`;
const groups = `${META}/country/all`;
const relayUrl = (path) => `/wits?path=${encodeURIComponent(path)}`;

function harness({ upstream = () => new Response('<xml/>'), secret = 'test-secret', limited = false, timeout } = {}) {
  const calls = [];
  const deadlines = [];
  const route = vm.runInNewContext(routeSource, {
    URL, Buffer, crypto,
    AbortSignal: { timeout(ms) { deadlines.push(ms); return timeout ? timeout(ms) : AbortSignal.timeout(ms); } },
    http: { createServer: callback => callback },
    RELAY_SHARED_SECRET: secret,
    RELAY_AUTH_HEADER: 'x-relay-key',
    ALLOW_UNAUTHENTICATED_RELAY: true,
    getCorsOrigin: () => null,
    consumeRateLimit: () => ({ limited, resetInMs: 1000 }),
    recordRelayOutcome() {},
    fetch: async (url, init) => { calls.push({ url, init }); return upstream(url, init); },
  });
  return {
    calls, deadlines,
    async request(url = relayUrl(reported), { method = 'GET', headers = { 'x-relay-key': 'test-secret' } } = {}) {
      const result = { status: 0, headers: {}, body: '' };
      const res = {
        setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
        writeHead(status, headers = {}) {
          result.status = status;
          for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
          this.headersSent = true;
        },
        end(body) { result.body = body?.toString() || ''; this.writableEnded = true; },
      };
      await route({ url, method, headers }, res);
      return result;
    },
  };
}

test('WITS route requires the configured relay secret, including in global auth bypass mode', async () => {
  const h = harness();
  for (const headers of [{}, { 'x-relay-key': 'wrong' }, { authorization: 'Bearer wrong' }]) {
    assert.equal((await h.request(undefined, { headers })).status, 401);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request(undefined, { headers: { authorization: 'Bearer test-secret' } })).status, 200);
  const noSecret = harness({ secret: '' });
  assert.equal((await noSecret.request()).status, 401);
  assert.equal(noSecret.calls.length, 0);
});

test('WITS route uses shared rate limiting before contacting upstream', async () => {
  const h = harness({ limited: true });
  const result = await h.request();
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '1');
  assert.equal(h.calls.length, 0);
});

test('only the four TRN operations reach a fixed WITS origin without relay credentials', async () => {
  const xml = readFileSync(new URL('./fixtures/wits-trains/sdmx-840-870323-2021-reported.xml', import.meta.url), 'utf8');
  const h = harness({ upstream: () => new Response(xml, { headers: { 'Content-Type': 'application/xml' } }) });
  for (const path of [reported, ave, availability, groups]) {
    const result = await h.request(relayUrl(path));
    assert.equal(result.status, 200);
    assert.equal(result.body, xml);
    assert.equal(result.headers['content-type'], 'application/xml');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['cdn-cache-control'], 'no-store');
    const call = h.calls.at(-1);
    assert.equal(call.url.href, `https://wits.worldbank.org${path}`);
    assert.equal(call.url.origin, 'https://wits.worldbank.org');
    assert.equal(call.init.redirect, 'error');
    const headers = new Headers(call.init.headers);
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'user-agent']);
    assert.match(headers.get('accept'), /application\/xml/);
    assert.match(headers.get('user-agent'), /Chrome\/131/);
  }
  assert.deepEqual(h.deadlines, [9000, 9000, 9000, 9000]);
});

test('invalid methods, parameters, destinations and non-TRN paths never fetch', async () => {
  const h = harness();
  const method = await h.request(undefined, { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'GET');
  for (const path of [
    '', 'https://evil.test/', '//evil.test/',
    `${META}/country/all?url=https://evil.test`,
    `${META}/country/all#fragment`,
    `${META}/../country/all`,
    availability.replace('840', 'US'),
    reported.replace('870380', '8703'),
    reported.replace('/2023/', '/0/'),
    reported.replace('/2023/', '/2101/'),
    reported.replace('partner/all', 'partner/000'),
    ave.replace('partner/000', 'partner/all'),
    reported.replace('TRN', 'TRADE'),
    `${reported}/extra`,
  ]) {
    assert.equal((await h.request(relayUrl(path))).status, 400, path);
  }
  for (const query of ['', '?path=', `?path=${encodeURIComponent(groups)}&path=${encodeURIComponent(groups)}`, `?path=${encodeURIComponent(groups)}&url=https://evil.test`]) {
    assert.equal((await h.request(`/wits${query}`)).status, 400, query);
  }
  assert.equal((await h.request('/wits-other')).status, 404);
  assert.equal(h.calls.length, 0);
});

test('upstream errors and valid empty XML preserve status and body', async () => {
  for (const [status, body] of [[403, 'Forbidden'], [404, 'NoRecordsFound'], [429, 'Too Many Requests'], [200, '<wits:error>No data</wits:error>']]) {
    const h = harness({ upstream: () => new Response(body, { status }) });
    const result = await h.request();
    assert.equal(result.status, status);
    assert.equal(result.body, body);
  }
});

test('redirect and transport errors fail closed without exposing error details', async () => {
  const h = harness({ upstream: (_url, init) => {
    assert.equal(init.redirect, 'error');
    throw new TypeError('redirect to https://private.test/?secret=sensitive');
  } });
  const result = await h.request();
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.body), { error: 'WITS request failed' });
  assert.equal(h.calls.length, 1);
});

test('the upstream deadline covers stalled bodies after headers arrive', async () => {
  const h = harness({
    timeout: () => AbortSignal.timeout(10),
    upstream: (_url, { signal }) => new Response(new ReadableStream({
      start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
    })),
  });
  // AbortSignal.timeout is unref'd; keep this controlled test alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await h.request();
    assert.equal(result.status, 504);
    assert.equal(JSON.parse(result.body).error, 'WITS request timed out');
  } finally { clearTimeout(keepAlive); }
});

test('oversized XML cancels upstream and returns no partial data', async () => {
  let cancelled = false;
  const h = harness({ upstream: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })) });
  const result = await h.request();
  assert.equal(result.status, 502);
  assert.equal(cancelled, true);
  assert.equal(result.body, '{"error":"WITS request failed"}');
});
