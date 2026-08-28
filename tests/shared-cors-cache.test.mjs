import assert from 'node:assert/strict';
import test from 'node:test';

// #7216: Cloudflare ignores Vary: Origin for the API domain. A response that
// is shared-cacheable must therefore use the public CORS posture rather than
// reflecting the caller's Origin into ACAO.

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const REDIS_URL = 'https://redis.example.test';
const ALLOWED_ORIGIN = 'https://worldmonitor.app';

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function json(value) {
  return Response.json(value);
}

function request(path, { origin = ALLOWED_ORIGIN, headers = {} } = {}) {
  return new Request(`https://api.worldmonitor.app${path}`, {
    headers: { Origin: origin, ...headers },
  });
}

function sharedCorsProblems(name, response, { expectSuccess = true } = {}) {
  const cacheControl = response.headers.get('cache-control') || '';
  const cdnCacheControl = response.headers.get('cdn-cache-control') || '';
  const cacheDirectives = `${cacheControl}, ${cdnCacheControl}`;
  const problems = [];

  if (expectSuccess && !response.ok) problems.push(`${name}: expected successful cacheable response, got ${response.status}`);
  if (!/\bpublic\b|\bs-maxage\s*=\s*[1-9]\d*/i.test(cacheDirectives)) {
    problems.push(`${name}: fixture must exercise a shared-cacheable response`);
  }
  if (response.headers.get('access-control-allow-origin') !== '*') {
    problems.push(`${name}: shared response must set Access-Control-Allow-Origin: *`);
  }
  if (response.headers.has('access-control-allow-credentials')) {
    problems.push(`${name}: shared response must not allow credentials`);
  }
  if (/\borigin\b/i.test(response.headers.get('vary') || '')) {
    problems.push(`${name}: shared response must not rely on Vary: Origin`);
  }

  return problems;
}

function privateCorsProblems(name, response, { expectSuccess = true } = {}) {
  const cacheControl = response.headers.get('cache-control') || '';
  const problems = [];

  if (expectSuccess && !response.ok) problems.push(`${name}: expected successful private response, got ${response.status}`);
  if (!/\bprivate\b|\bno-store\b/i.test(cacheControl)) {
    problems.push(`${name}: credential-gated response must be private or no-store`);
  }
  if (/\bpublic\b|\bs-maxage\s*=\s*[1-9]\d*/i.test(cacheControl)) {
    problems.push(`${name}: credential-gated response must not be shared-cacheable`);
  }
  if (response.headers.has('cdn-cache-control')) {
    problems.push(`${name}: credential-gated response must not set CDN-Cache-Control`);
  }
  if (response.headers.get('access-control-allow-origin') !== ALLOWED_ORIGIN) {
    problems.push(`${name}: credential-gated response must reflect the allowed Origin`);
  }
  if (response.headers.get('access-control-allow-credentials') !== 'true') {
    problems.push(`${name}: credential-gated response must allow credentials`);
  }
  if (!/\borigin\b/i.test(response.headers.get('vary') || '')) {
    problems.push(`${name}: credential-gated response must vary by Origin`);
  }

  return problems;
}

function moduleUrl(path, suffix) {
  return new URL(`${path}?shared-cors-cache=${suffix}`, import.meta.url).href;
}

test('shared responses use public CORS and RSS is the private exception (#7216)', async (t) => {
  t.after(restoreEnvironment);

  delete process.env.DODO_API_KEY;
  delete process.env.RELAY_SHARED_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.WORLDMONITOR_VALID_KEYS = 'shared-cors-test-key';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(`${REDIS_URL}/get/`)) {
      const key = decodeURIComponent(url.slice(`${REDIS_URL}/get/`.length));
      if (key === 'intelligence:gpsjam:v2') {
        return json({ result: JSON.stringify({
          fetchedAt: '2026-08-27T00:00:00.000Z',
          hexes: [{ h3: '8928308280fffff', lat: 37.77, lon: -122.42, level: 'high', pct: 20 }],
        }) });
      }
      if (key === 'geocode:37.700,-122.400') {
        return json({ result: JSON.stringify({
          country: 'United States',
          code: 'US',
          displayName: 'United States',
          error: '',
        }) });
      }
      throw new Error(`unexpected Redis key: ${key}`);
    }
    if (url === `${REDIS_URL}/pipeline`) {
      return json([{ result: [59, 60] }]);
    }
    if (url.startsWith('https://www.fwdstart.me/')) {
      return new Response('<a href="/p/test"></a><img alt="Shared CORS Test Post" /><span>Jan 12, 2026</span>');
    }
    if (url.startsWith('https://nominatim.openstreetmap.org/reverse?')) {
      return json({
        address: { country: 'United States', country_code: 'us' },
        display_name: 'United States',
      });
    }
    if (url === 'https://techcrunch.com/feed') {
      return new Response('<rss/>', { headers: { 'Content-Type': 'application/xml' } });
    }
    if (url === 'https://techcrunch.com/error-feed') {
      return new Response('upstream unavailable', { status: 502 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const suffix = `${Date.now()}-${Math.random()}`;

  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const { default: gpsJam } = await import(moduleUrl('../api/gpsjam.js', suffix));
  const gpsJamResponse = await gpsJam(request('/api/gpsjam'));

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const { default: fwdStart } = await import(moduleUrl('../api/fwdstart.js', suffix));
  const fwdStartResponse = await fwdStart(request('/api/fwdstart'));

  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const { default: reverseGeocode } = await import(moduleUrl('../api/reverse-geocode.js', suffix));
  const pendingWrites = [];
  const reverseGeocodeResponse = await reverseGeocode(
    request('/api/reverse-geocode?lat=37.7&lon=-122.4'),
    { waitUntil: (work) => pendingWrites.push(Promise.resolve(work)) },
  );
  await Promise.all(pendingWrites);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const { default: rssProxy } = await import(moduleUrl('../api/rss-proxy.js', suffix));
  const rssProxyResponse = await rssProxy(request('/api/rss-proxy?url=https%3A%2F%2Ftechcrunch.com%2Ffeed', {
    headers: { 'X-WorldMonitor-Key': 'shared-cors-test-key' },
  }));
  const rssProxyErrorResponse = await rssProxy(request('/api/rss-proxy?url=https%3A%2F%2Ftechcrunch.com%2Ferror-feed', {
    headers: { 'X-WorldMonitor-Key': 'shared-cors-test-key' },
  }));

  const { default: productCatalog } = await import(moduleUrl('../api/product-catalog.js', suffix));
  const productCatalogResponse = await productCatalog(request('/api/product-catalog'));
  const rejectedProductCatalogResponse = await productCatalog(request('/api/product-catalog', {
    origin: 'https://untrusted.example',
  }));

  const problems = [
    ...sharedCorsProblems('gpsjam', gpsJamResponse),
    ...sharedCorsProblems('fwdstart', fwdStartResponse),
    ...sharedCorsProblems('reverse-geocode', reverseGeocodeResponse),
    ...privateCorsProblems('rss-proxy', rssProxyResponse),
    ...privateCorsProblems('rss-proxy error response', rssProxyErrorResponse, { expectSuccess: false }),
    ...sharedCorsProblems('product-catalog', productCatalogResponse),
  ];
  if (rejectedProductCatalogResponse.status !== 403) {
    problems.push(`product-catalog: disallowed Origin must be rejected before the shared cacheable GET path (got ${rejectedProductCatalogResponse.status})`);
  }

  assert.deepEqual(problems, []);
});
