import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { MilitaryServiceClient } from '../src/generated/client/worldmonitor/military/v1/service_client.ts';
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
const MARITIME_OPTIONAL_BBOX_PATH = '/api/maritime/v1/get-vessel-snapshot';
const originalMaritimeRatePolicy = ENDPOINT_RATE_POLICIES[MARITIME_OPTIONAL_BBOX_PATH];

const OPTIONAL_BBOX_RPC_PATHS = [
  '/api/aviation/v1/track-aircraft',
  '/api/maritime/v1/get-vessel-snapshot',
  '/api/unrest/v1/list-unrest-events',
  '/api/wildfire/v1/list-fire-detections',
] as const;

afterEach(() => {
  if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;

  if (originalMaritimeRatePolicy == null) delete ENDPOINT_RATE_POLICIES[MARITIME_OPTIONAL_BBOX_PATH];
  else ENDPOINT_RATE_POLICIES[MARITIME_OPTIONAL_BBOX_PATH] = originalMaritimeRatePolicy;
});

function createGatewayForPaths(hits: Map<string, number>, paths: readonly string[]) {
  const routes: RouteDescriptor[] = paths.map((path) => ({
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

function createBboxGateway(hits: Map<string, number>) {
  return createGatewayForPaths(hits, REQUIRED_BBOX_RPC_PATHS);
}

// The live tanker endpoint fails closed when Upstash is absent; remove only
// this unit-test policy so the gateway header merge path is observable locally.
function bypassMaritimeRateLimitForLocalGatewayTest(pathAndQuery: string): void {
  if (!pathAndQuery.startsWith(MARITIME_OPTIONAL_BBOX_PATH)) return;
  delete ENDPOINT_RATE_POLICIES[MARITIME_OPTIONAL_BBOX_PATH];
}

function makeRequest(pathAndQuery: string): Request {
  bypassMaritimeRateLimitForLocalGatewayTest(pathAndQuery);
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  return new Request(
    'https://worldmonitor.app' + pathAndQuery,
    { headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY } },
  );
}

function makeJsonPostRequest(path: string, bodyObject: Record<string, unknown>): Request {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  const body = JSON.stringify(bodyObject);
  return new Request('https://worldmonitor.app' + path, {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      'X-WorldMonitor-Key': TEST_KEY,
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
}

async function getGeneratedMilitaryFlightsPathAndQuery(req: Parameters<MilitaryServiceClient['listMilitaryFlights']>[0]): Promise<string> {
  let requestedUrl = '';
  const client = new MilitaryServiceClient('https://worldmonitor.app', {
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ flights: [], clusters: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.listMilitaryFlights(req);
  const url = new URL(requestedUrl);
  return url.pathname + url.search;
}

function assertNoBboxDiagnostic(res: Response): void {
  assert.equal(res.headers.get('X-WorldMonitor-Bbox'), null);
  assert.equal(res.headers.get('X-WorldMonitor-Bbox-Missing'), null);
  assert.equal(res.headers.get('X-WorldMonitor-Bbox-Invalid'), null);
  assert.equal(res.headers.get('X-Military-Bbox'), null);
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
  it('tracks exactly the bbox-required military endpoints', () => {
    assert.deepEqual([...REQUIRED_BBOX_RPC_PATHS].sort(), [
      '/api/military/v1/list-military-bases',
      '/api/military/v1/list-military-flights',
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
      assertBboxDiagnostic(res, 'missing', { missing: REQUIRED_BBOX_QUERY, military: true });
    });
  }

  it('does not diagnose optional-bbox endpoints that support no-bbox/global modes', async () => {
    const hits = new Map<string, number>();
    const handler = createGatewayForPaths(hits, OPTIONAL_BBOX_RPC_PATHS);

    for (const path of OPTIONAL_BBOX_RPC_PATHS) {
      const res = await handler(makeRequest(path));
      const body = await res.json();

      assert.equal(res.status, 200, path);
      assert.deepEqual(body, { ok: true }, path);
      assert.equal(hits.get(path), 1, path);
      assertNoBboxDiagnostic(res);
    }
  });

  it('does not add bbox diagnostics to unrelated API endpoints', async () => {
    const hits = new Map<string, number>();
    const handler = createGatewayForPaths(hits, ['/api/market/v1/list-market-quotes']);

    const res = await handler(makeRequest('/api/market/v1/list-market-quotes?symbols=AAPL'));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(hits.get('/api/market/v1/list-market-quotes'), 1);
    assertNoBboxDiagnostic(res);
  });

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
      '/api/military/v1/list-military-flights?sw_lat=0&sw_lon=-1&ne_lat=abc&ne_lon=1',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assertBboxDiagnostic(res, 'invalid', { invalid: 'ne_lat', military: true });
  });

  it('reports invalid present fields without treating omitted zero corners as missing', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeRequest(
      '/api/military/v1/list-military-flights?ne_lat=abc&ne_lon=1',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assertBboxDiagnostic(res, 'invalid', { invalid: 'ne_lat', military: true });
  });

  it('does not flag the generated client shape for a zero-corner bbox', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);
    const pathAndQuery = await getGeneratedMilitaryFlightsPathAndQuery({
      pageSize: 100,
      cursor: '',
      neLat: 1,
      neLon: 1,
      swLat: 0,
      swLon: 0,
      operator: 'MILITARY_OPERATOR_UNSPECIFIED',
      aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED',
    });

    assert.equal(pathAndQuery, '/api/military/v1/list-military-flights?page_size=100&ne_lat=1&ne_lon=1');
    const res = await handler(makeRequest(pathAndQuery));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assertNoBboxDiagnostic(res);
  });

  it('reads the POST-to-GET converted request before deciding bbox diagnostics', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeJsonPostRequest('/api/military/v1/list-military-flights', {
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 1,
      ne_lon: 1,
      page_size: 100,
    }));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assertNoBboxDiagnostic(res);
  });

  it('does not flag a legitimate bbox that touches the equator or prime meridian', async () => {
    const hits = new Map<string, number>();
    const handler = createBboxGateway(hits);

    const res = await handler(makeRequest(
      '/api/military/v1/list-military-flights?sw_lat=0&sw_lon=0&ne_lat=1&ne_lon=1&page_size=100',
    ));

    assert.equal(res.status, 200);
    assert.equal(hits.get('/api/military/v1/list-military-flights'), 1);
    assertNoBboxDiagnostic(res);
  });
});
