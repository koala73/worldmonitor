import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createDomainGateway,
  REQUIRED_BBOX_QUERY_PARAMS,
  REQUIRED_BBOX_RPC_PATHS,
} from '../server/gateway.ts';
import { ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit.ts';
import type { RouteDescriptor } from '../server/router.ts';

const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
const TEST_KEY = 'bbox-test-key';
const REQUIRED_BBOX_QUERY = REQUIRED_BBOX_QUERY_PARAMS.join(',');
const MARITIME_BBOX_PATH = '/api/maritime/v1/get-vessel-snapshot';
const originalMaritimeRatePolicy = ENDPOINT_RATE_POLICIES[MARITIME_BBOX_PATH];

afterEach(() => {
  if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
  ENDPOINT_RATE_POLICIES[MARITIME_BBOX_PATH] = originalMaritimeRatePolicy;
});

function createBboxGateway(hits: Map<string, number>) {
  const routes: RouteDescriptor[] = REQUIRED_BBOX_RPC_PATHS.map((path) => ({
    method: 'GET',
    path,
    handler: async () => {
      hits.set(path, (hits.get(path) ?? 0) + 1);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  }));
  return createDomainGateway(routes);
}

// The live tanker endpoint fails closed when Upstash is absent; remove only
// this unit-test policy so the gateway header merge path is observable locally.
function bypassMaritimeRateLimitForLocalGatewayTest(pathAndQuery: string): void {
  if (!pathAndQuery.startsWith(MARITIME_BBOX_PATH)) return;
  delete ENDPOINT_RATE_POLICIES[MARITIME_BBOX_PATH];
}

function makeRequest(pathAndQuery: string): Request {
  bypassMaritimeRateLimitForLocalGatewayTest(pathAndQuery);
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  return new Request(
    'https://worldmonitor.app' + pathAndQuery,
    { headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY } },
  );
}

function assertBboxDiagnostic(
  res: Response,
  status: 'missing' | 'invalid',
  options: { missing?: string; invalid?: string; military?: boolean } = {},
): void {
  assert.equal(res.headers.get('X-WorldMonitor-Bbox'), status);
  assert.equal(res.headers.get('X-WorldMonitor-Bbox-Missing'), options.missing ?? null);
  assert.equal(res.headers.get('X-WorldMonitor-Bbox-Invalid'), options.invalid ?? null);
  const exposedHeaders = res.headers.get('Access-Control-Expose-Headers') ?? '';
  assert.match(exposedHeaders, /X-WorldMonitor-Bbox/);
  assert.match(exposedHeaders, /X-WorldMonitor-Bbox-Missing/);
  assert.match(exposedHeaders, /X-WorldMonitor-Bbox-Invalid/);
  assert.match(exposedHeaders, /X-Military-Bbox/);
  if (options.military) assert.equal(res.headers.get('X-Military-Bbox'), status);
  else assert.equal(res.headers.get('X-Military-Bbox'), null);
}

describe('gateway required-bbox diagnostics', () => {
  it('tracks exactly the six issue-scoped bbox endpoints', () => {
    assert.deepEqual([...REQUIRED_BBOX_RPC_PATHS].sort(), [
      '/api/aviation/v1/track-aircraft',
      '/api/maritime/v1/get-vessel-snapshot',
      '/api/military/v1/list-military-bases',
      '/api/military/v1/list-military-flights',
      '/api/unrest/v1/list-unrest-events',
      '/api/wildfire/v1/list-fire-detections',
    ].sort());
  });

  for (const path of REQUIRED_BBOX_RPC_PATHS) {
    it(path + ' adds a missing-bbox diagnostic header without changing handler status', async () => {
      const hits = new Map<string, number>();
      const handler = createBboxGateway(hits);

      const res = await handler(makeRequest(path));
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.deepEqual(body, { ok: true });
      assert.equal(hits.get(path), 1, 'diagnostic mode must remain non-breaking and still call the handler');
      assertBboxDiagnostic(res, 'missing', {
        missing: REQUIRED_BBOX_QUERY,
        military: path.startsWith('/api/military/'),
      });
    });
  }

  it('treats wrong bbox parameter names as missing snake_case params', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeRequest(
      '/api/military/v1/list-military-flights?north=1&south=0&east=1&west=0&bbox=0,0,1,1',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assertBboxDiagnostic(res, 'missing', { missing: REQUIRED_BBOX_QUERY, military: true });
  });

  it('marks an explicit all-zero bbox as invalid instead of silently accepting the generated default shape', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeRequest(
      '/api/military/v1/list-military-bases?sw_lat=0&sw_lon=0&ne_lat=0&ne_lon=0',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-bases'), 1);
    assertBboxDiagnostic(res, 'invalid', { invalid: REQUIRED_BBOX_QUERY, military: true });
  });

  it('marks non-numeric bbox params as invalid', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeRequest(
      '/api/aviation/v1/track-aircraft?sw_lat=0&sw_lon=-1&ne_lat=abc&ne_lon=1',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/aviation/v1/track-aircraft'), 1);
    assertBboxDiagnostic(res, 'invalid', { invalid: 'ne_lat' });
  });

  it('does not flag a legitimate bbox that touches the equator or prime meridian', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeRequest(
      '/api/military/v1/list-military-flights?sw_lat=0&sw_lon=0&ne_lat=1&ne_lon=1&page_size=100',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assert.equal(res.headers.get('X-WorldMonitor-Bbox'), null);
    assert.equal(res.headers.get('X-WorldMonitor-Bbox-Missing'), null);
    assert.equal(res.headers.get('X-WorldMonitor-Bbox-Invalid'), null);
    assert.equal(res.headers.get('X-Military-Bbox'), null);
  });
});
