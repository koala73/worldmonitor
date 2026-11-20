import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectFoodSource } from '../scripts/lib/food-prices-fetch.mjs';
import { CHROME_UA } from '../scripts/_seed-utils.mjs';

// FEWS NET answers Railway's egress with 403 and Railway cannot resolve makstat.stat.gov.mk, so both take
// the shared PROXY_URL tunnel. The credential below is a placeholder in the Decodo host:port form.
const PROXY_AUTH = 'user:secret@gate.decodo.com:10001';
const now = new Date('2026-11-05T02:00:00Z');
const fixture = name => readFileSync(new URL(`./fixtures/food-prices/${name}`, import.meta.url));
const directForbidden = async url => { throw new Error(`direct fetch must not run for ${url}`); };
const answer = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, buffer: Buffer.from(body), contentType: 'application/json', headers });

function recordingProxy(handler) {
  const calls = [];
  const proxyFetchFn = async (url, proxyConfig, options) => {
    calls.push({ url, port: proxyConfig.port, host: proxyConfig.host, options });
    return handler(url, options, calls.length);
  };
  return { calls, proxyFetchFn };
}

test('FEWS NET requests go through the proxy, keep the User-Agent and follow redirects there', async () => {
  const payload = fixture('fews-sd.json');
  const { calls, proxyFetchFn } = recordingProxy((url, _options, n) => n === 1
    ? answer('', 302, { location: url.replace('marketpricefacts/', 'marketpricefacts/?page=1&') })
    : answer(payload));
  const result = await collectFoodSource('fewssd', { now, pause: async () => {}, fetchFn: directForbidden, proxyAuth: PROXY_AUTH, proxyFetchFn, firstProxyExit: 0 });
  assert.ok(result.observations.length);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, 'fdw.fews.net');
    assert.equal(call.host, 'gate.decodo.com');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers['User-Agent'], CHROME_UA);
  }
  assert.match(calls[1].url, /page=1/);
});

test('an exit the publisher refuses with 403 rotates to the next sticky exit', async () => {
  const payload = fixture('fews-ye.json');
  const { calls, proxyFetchFn } = recordingProxy((_url, _options, n) => n === 1 ? answer('Forbidden', 403) : answer(payload));
  const result = await collectFoodSource('fewsye', { now, pause: async () => {}, fetchFn: directForbidden, proxyAuth: PROXY_AUTH, proxyFetchFn, firstProxyExit: 0 });
  assert.ok(result.observations.length);
  assert.deepEqual(calls.map(call => call.port), [10001, 10002]);

  const refused = recordingProxy(() => answer('Forbidden', 403));
  await assert.rejects(collectFoodSource('fewsye', { now, pause: async () => {}, fetchFn: directForbidden, proxyAuth: PROXY_AUTH, proxyFetchFn: refused.proxyFetchFn, firstProxyExit: 0 }), /fewsye HTTP 403/);
  assert.deepEqual(refused.calls.map(call => call.port), [10001, 10002, 10003]);
});

test('MakStat GET and POST are sent through the proxy, which resolves the host remotely', async () => {
  const data = fixture('makstat.json');
  const { calls, proxyFetchFn } = recordingProxy((_url, options) => answer(options.method === 'POST'
    ? data : JSON.stringify({ variables: [{ code: 'Година', values: ['2015M01', '2026M09'] }] })));
  const result = await collectFoodSource('makstat', { now, pause: async () => {}, fetchFn: directForbidden, proxyAuth: PROXY_AUTH, proxyFetchFn, firstProxyExit: 0 });
  assert.equal(result.contexts[0].countryCode, 'MK');
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'POST']);
  assert.ok(calls.every(call => new URL(call.url).hostname === 'makstat.stat.gov.mk'));
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].options.body).query[0].selection, { filter: 'item', values: ['2026M09'] });
});

test('when no exit reaches the publisher the request falls back to direct; a gateway refusal does not', async () => {
  const tunnelDown = recordingProxy(() => { throw new Error('CONNECT tunnel timeout'); });
  const direct = [];
  const fetchFn = async url => { direct.push(url); throw Object.assign(new Error('getaddrinfo ENOTFOUND makstat.stat.gov.mk'), { code: 'ENOTFOUND' }); };
  await assert.rejects(collectFoodSource('makstat', { now, pause: async () => {}, fetchFn, proxyAuth: PROXY_AUTH, proxyFetchFn: tunnelDown.proxyFetchFn, firstProxyExit: 0 }), /ENOTFOUND/);
  assert.deepEqual(tunnelDown.calls.map(call => call.port), [10001, 10002, 10003]);
  assert.equal(direct.length, 1);

  const gateway = recordingProxy(() => { throw Object.assign(new Error('Proxy CONNECT: HTTP/1.1 407 Proxy Authentication Required'), { status: 407, proxyConnect: true }); });
  const error = await collectFoodSource('fewsht', { now, pause: async () => {}, fetchFn: directForbidden, proxyAuth: PROXY_AUTH, proxyFetchFn: gateway.proxyFetchFn, firstProxyExit: 0 }).catch(caught => caught);
  assert.match(error.message, /proxy refused: Proxy CONNECT: HTTP\/1.1 407/);
  assert.equal(gateway.calls.length, 1);
});

test('FEWS stays direct without PROXY_URL, and other food sources never use the proxy', async () => {
  const payload = fixture('fews-ss.json');
  const direct = [];
  const unused = recordingProxy(() => { throw new Error('proxy must not run'); });
  const result = await collectFoodSource('fewsss', { now, pause: async () => {}, fetchFn: async url => { direct.push(url); return new Response(payload); }, proxyFetchFn: unused.proxyFetchFn });
  assert.ok(result.observations.length);
  assert.equal(direct.length, 1);

  for (const id of ['csblv', 'statec', 'pihps', 'giews']) {
    await assert.rejects(collectFoodSource(id, { now, pause: async () => {}, proxyAuth: PROXY_AUTH, proxyFetchFn: unused.proxyFetchFn,
      fetchFn: async () => new Response('down', { status: 500 }) }), new RegExp(`${id} HTTP 500`));
  }
  assert.equal(unused.calls.length, 0);
});

test('a hung exit times out on its own and the next exit still runs within the source budget', async () => {
  const payload = fixture('fews-sd.json');
  const signals = [];
  const { calls, proxyFetchFn } = recordingProxy((_url, options, n) => {
    signals.push(options.signal);
    if (n > 1) return answer(payload);
    // A dead exit that never answers: settles only when its own signal fires.
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const started = Date.now();
  const result = await collectFoodSource('fewssd', { now, pause: async () => {}, fetchFn: directForbidden, proxyAuth: PROXY_AUTH, proxyFetchFn, firstProxyExit: 0, budgetMs: 3_000 });
  assert.ok(result.observations.length);
  assert.deepEqual(calls.map(call => call.port), [10001, 10002]);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false);
  assert.ok(Date.now() - started < 3_000);
});
