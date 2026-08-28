import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const handlerSrc = readFileSync('server/worldmonitor/sanctions/v1/list-sanctions-pressure.ts', 'utf8');
const seedSrc = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');
const healthSrc = readFileSync('api/health.js', 'utf8');
const seedHealthSrc = readFileSync('api/seed-health.js', 'utf8');

const protoSrc = readFileSync('proto/worldmonitor/sanctions/v1/list_sanctions_pressure.proto', 'utf8');
const clientGenSrc = readFileSync('src/generated/client/worldmonitor/sanctions/v1/service_client.ts', 'utf8');
const serverGenSrc = readFileSync('src/generated/server/worldmonitor/sanctions/v1/service_server.ts', 'utf8');
const serviceSrc = readFileSync('src/services/sanctions-pressure.ts', 'utf8');
const serviceOpenApiJson = JSON.parse(readFileSync('docs/api/SanctionsService.openapi.json', 'utf8'));
const serviceOpenApiYaml = readFileSync('docs/api/SanctionsService.openapi.yaml', 'utf8');
const unifiedOpenApiYaml = readFileSync('docs/api/worldmonitor.openapi.yaml', 'utf8');

describe('sanctions pressure SEMA contract', () => {
  it('uses the previously-unassigned protobuf tags 12 and 13', () => {
    assert.match(protoSrc, /int32\s+sema_count\s*=\s*12;/);
    assert.match(protoSrc, /optional\s+string\s+sema_error\s*=\s*13;/);
  });

  it('generates typed SEMA fields for both client and server bindings', () => {
    for (const generated of [clientGenSrc, serverGenSrc]) {
      const response = generated.match(/export interface ListSanctionsPressureResponse \{[^}]*\}/)?.[0];
      assert.ok(response, 'generated sanctions response interface must exist');
      assert.match(response, /semaCount:\s*number;/);
      assert.match(response, /semaError\?:\s*string;/);
    }
  });

  it('exposes SEMA fields in service JSON/YAML and unified OpenAPI', () => {
    const schemas = serviceOpenApiJson.components?.schemas ?? {};
    const response = Object.entries(schemas)
      .find(([name]) => name.endsWith('ListSanctionsPressureResponse'))?.[1];
    assert.ok(response, 'service OpenAPI response schema must exist');
    assert.equal(response.properties?.semaCount?.type, 'integer');
    assert.equal(response.properties?.semaError?.type, 'string');
    assert.match(serviceOpenApiYaml, /semaCount:\s*\n\s*type:\s*integer/);
    assert.match(serviceOpenApiYaml, /semaError:\s*\n\s*type:\s*string/);
    assert.match(unifiedOpenApiYaml, /semaCount:\s*\n\s*type:\s*integer/);
    assert.match(unifiedOpenApiYaml, /semaError:\s*\n\s*type:\s*string/);
  });

  it('uses generated fields directly instead of response-extension casts', () => {
    assert.doesNotMatch(serviceSrc, /ListSanctionsPressureResponse\s*&\s*\{\s*sema(?:Count|Error)/);
  });
});

// ---------------------------------------------------------------------------
// Gold standard: handler must be Redis-read-only (no XML parsing, no live fetch)
// ---------------------------------------------------------------------------
describe('handler: gold standard compliance', () => {
  it('handler does not import XMLParser (no live OFAC fetch at edge)', () => {
    assert.ok(
      !handlerSrc.includes('XMLParser'),
      'handler must not import XMLParser: Vercel reads Redis only, Railway makes all external API calls',
    );
  });

  it('handler does not define OFAC_SOURCES (no direct OFAC HTTP from edge)', () => {
    assert.ok(
      !handlerSrc.includes('OFAC_SOURCES'),
      'handler must not define OFAC_SOURCES: all OFAC fetching belongs in the Railway seed script',
    );
  });

  it('handler uses getCachedJson for Redis read', () => {
    assert.match(
      handlerSrc,
      /getCachedJson\(REDIS_CACHE_KEY/,
      'handler must read from Redis via getCachedJson',
    );
  });
});

// ---------------------------------------------------------------------------
// _state must not leak to API clients
// ---------------------------------------------------------------------------
describe('handler: _state stripping', () => {
  it('handler destructures _state before spreading data', () => {
    assert.match(
      handlerSrc,
      /_state.*_discarded/s,
      'handler must destructure _state out to prevent leaking seed internals to API clients',
    );
  });

  it('seed stores _state under STATE_KEY (not canonical key)', () => {
    assert.match(
      seedSrc,
      /extraKeys.*STATE_KEY/s,
      'extraKeys must reference STATE_KEY to write _state separately from canonical payload',
    );
  });

  it('seed writes country counts only through afterPublish metadata path', () => {
    const extraKeysBlock = seedSrc.match(/extraKeys:\s*\[([\s\S]*?)\]/)?.[1];
    assert.ok(extraKeysBlock, 'seed must declare its extraKeys contract');
    assert.doesNotMatch(
      extraKeysBlock,
      /COUNTRY_COUNTS_KEY/,
      'COUNTRY_COUNTS_KEY must not be duplicated in extraKeys; afterPublish writes it with seed-meta for health',
    );
    assert.match(
      seedSrc,
      /writeExtraKeyWithMeta\(\s*COUNTRY_COUNTS_KEY/s,
      'afterPublish must keep writing COUNTRY_COUNTS_KEY with freshness metadata',
    );
  });

  it('preserves every afterPublish companion key and its seed metadata on failed runs', () => {
    const preserveBlock = seedSrc.match(/preserveKeys:\s*\[([\s\S]*?)\]/)?.[1];
    assert.ok(preserveBlock, 'seed must declare afterPublish companion keys for runSeed preservation');
    for (const key of [
      'ENTITY_INDEX_KEY',
      'ENTITY_INDEX_META_KEY',
      'COUNTRY_COUNTS_KEY',
      'COUNTRY_COUNTS_META_KEY',
    ]) {
      assert.match(preserveBlock, new RegExp(`\\b${key}\\b`),
        `${key} must retain last-good data or metadata when OFAC fetches fail`);
    }
  });
});

// ---------------------------------------------------------------------------
// Seed: sequential fetch to avoid OOM on Railway 512MB
// ---------------------------------------------------------------------------
describe('seed: memory safety', () => {
  it('seed fetches OFAC sources sequentially (not Promise.all)', () => {
    const fnStart = seedSrc.indexOf('async function fetchSanctionsPressure()');
    const fnEnd = seedSrc.indexOf('\nfunction validate(');
    const fnBody = seedSrc.slice(fnStart, fnEnd);
    assert.ok(
      !fnBody.includes('Promise.all(OFAC_SOURCES'),
      'seed must not fetch both OFAC XML files concurrently: combined parse can exceed 512MB heap limit',
    );
  });
});

// ---------------------------------------------------------------------------
// Seed: DEFAULT_RECENT_LIMIT must not exceed handler MAX_ITEMS_LIMIT
// ---------------------------------------------------------------------------
describe('sanctions seed: DEFAULT_RECENT_LIMIT vs MAX_ITEMS_LIMIT', () => {
  it('seed DEFAULT_RECENT_LIMIT does not exceed handler MAX_ITEMS_LIMIT (60)', () => {
    const match = seedSrc.match(/const DEFAULT_RECENT_LIMIT\s*=\s*(\d+)/);
    assert.ok(match, 'DEFAULT_RECENT_LIMIT must be defined in seed script');
    const seedLimit = Number(match[1]);
    const handlerMatch = handlerSrc.match(/const MAX_ITEMS_LIMIT\s*=\s*(\d+)/);
    assert.ok(handlerMatch, 'MAX_ITEMS_LIMIT must be defined in handler');
    const handlerLimit = Number(handlerMatch[1]);
    assert.ok(
      seedLimit <= handlerLimit,
      `DEFAULT_RECENT_LIMIT (${seedLimit}) must not exceed MAX_ITEMS_LIMIT (${handlerLimit}): entries above the handler limit are never served`,
    );
  });
});

describe('sanctions seed: production freshness contract', () => {
  function maxStaleMin(name) {
    const match = healthSrc.match(new RegExp(`${name}:\\s*\\{[^}]*maxStaleMin:\\s*(\\d+)`));
    assert.ok(match, `${name}.maxStaleMin must be declared`);
    return Number(match[1]);
  }

  it('co-produced pressure and entity keys alarm on the same two-missed-run boundary', () => {
    assert.equal(maxStaleMin('sanctionsPressure'), 720);
    assert.equal(maxStaleMin('sanctionsEntities'), 720);
    const seedHealthEntity = seedHealthSrc.match(/'sanctions:entities':\s*\{[^}]*intervalMin:\s*(\d+)/);
    assert.ok(seedHealthEntity, '/api/seed-health must register the sanctions entity companion');
    assert.equal(Number(seedHealthEntity[1]), 360,
      '/api/seed-health must use the same 6h producer cadence as sanctions pressure');
  });

  it('keeps data alive beyond both paired freshness alarms', () => {
    const ttlMatch = seedSrc.match(/const CACHE_TTL\s*=\s*(\d+)\s*\*\s*60\s*\*\s*60/);
    assert.ok(ttlMatch, 'sanctions CACHE_TTL must stay expressed in whole hours');
    const ttlMinutes = Number(ttlMatch[1]) * 60;

    assert.ok(ttlMinutes > maxStaleMin('sanctionsPressure'),
      'canonical pressure data must still exist when STALE_SEED first alarms');
    assert.ok(ttlMinutes > maxStaleMin('sanctionsEntities'),
      'entity data must still exist when STALE_SEED first alarms');
  });

  it('gives the serial recovery ladder a deadline above its two-source worst case', () => {
    function optionMs(name) {
      const match = seedSrc.match(new RegExp(`${name}:\\s*(\\d[\\d_]*)`));
      assert.ok(match, `${name} must be explicit for the OFAC recovery budget`);
      return Number(match[1].replaceAll('_', ''));
    }

    const fetchPhaseTimeoutMs = optionMs('fetchPhaseTimeoutMs');
    const lockTtlMs = optionMs('lockTtlMs');
    assert.ok(fetchPhaseTimeoutMs >= 7 * 60 * 1000,
      'the two serial OFAC source ladders need at least a seven-minute fetch budget');
    assert.ok(lockTtlMs > fetchPhaseTimeoutMs,
      'the lock must outlive the explicit fetch deadline during slow recovery');
  });
});

const REDIS_KEY = 'sanctions:pressure:v1';
const ENTERPRISE_KEY = 'wm-sanctions-contract-test';
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL_ENV',
  'WORLDMONITOR_VALID_KEYS',
].map((key) => [key, process.env[key]]));
const cacheStore = new Map();
let bootstrapPayload;
let listSanctionsPressure;

function entry(name = 'Kept OFAC designation') {
  return {
    id: 'SDN:9',
    name,
    entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
    countryCodes: ['CA'],
    countryNames: ['Canada'],
    programs: ['SDN'],
    sourceLists: ['SDN'],
    effectiveAt: '1700000000000',
    isNew: false,
    note: '',
  };
}

function cachedPayload(overrides = {}) {
  return {
    entries: [entry()],
    countries: [],
    programs: [],
    fetchedAt: '1700000000000',
    datasetDate: '1699000000000',
    totalCount: 1,
    sdnCount: 1,
    consolidatedCount: 0,
    semaCount: 3,
    newEntryCount: 0,
    vesselCount: 0,
    aircraftCount: 0,
    ...overrides,
  };
}

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;

  mock.method(globalThis, 'fetch', async (url, init) => {
    const urlString = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const redisGet = urlString.match(/\/get\/([^/?#]+)$/);
    if (redisGet) {
      const key = decodeURIComponent(redisGet[1]);
      return new Response(JSON.stringify({
        result: cacheStore.has(key) ? JSON.stringify(cacheStore.get(key)) : null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlString.includes('/api/bootstrap?keys=sanctionsPressure')) {
      return new Response(JSON.stringify({ data: { sanctionsPressure: bootstrapPayload } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(url, init);
  });

  ({ listSanctionsPressure } = await import('../server/worldmonitor/sanctions/v1/list-sanctions-pressure.ts'));
});

beforeEach(() => {
  cacheStore.clear();
  bootstrapPayload = undefined;
});

after(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis[FRONTEND_STATE_KEY];
});

function premiumContext() {
  const request = new Request('https://worldmonitor.test/api/sanctions/v1/list-sanctions-pressure', {
    headers: { 'X-WorldMonitor-Key': ENTERPRISE_KEY },
  });
  return { request, pathParams: {}, headers: {} };
}

describe('listSanctionsPressure typed SEMA behavior', () => {
  it('returns a healthy SEMA count without an error', async () => {
    cacheStore.set(REDIS_KEY, cachedPayload());
    const response = await listSanctionsPressure(premiumContext(), { maxItems: 25 });

    assert.equal(response.semaCount, 3);
    assert.equal(response.semaError, undefined);
    assert.equal(response.entries[0]?.name, 'Kept OFAC designation');
  });

  it('keeps OFAC visible and returns typed degradation when SEMA failed', async () => {
    cacheStore.set(REDIS_KEY, cachedPayload({ semaCount: 0, semaError: 'SEMA HTTP 503' }));
    const response = await listSanctionsPressure(premiumContext(), { maxItems: 25 });

    assert.equal(response.totalCount, 1);
    assert.equal(response.entries[0]?.sourceLists[0], 'SDN');
    assert.equal(response.semaCount, 0);
    assert.equal(response.semaError, 'SEMA HTTP 503');
  });

  it('normalizes an old cached payload to protobuf defaults', async () => {
    const oldPayload = cachedPayload();
    delete oldPayload.semaCount;
    cacheStore.set(REDIS_KEY, oldPayload);

    const response = await listSanctionsPressure(premiumContext(), { maxItems: 25 });
    assert.equal(response.semaCount, 0);
    assert.equal(response.semaError, undefined);
  });

  it('returns typed defaults for an empty cache and a premium denial', async () => {
    const empty = await listSanctionsPressure(premiumContext(), { maxItems: 25 });
    assert.equal(empty.semaCount, 0);
    assert.equal(empty.semaError, undefined);

    cacheStore.set(REDIS_KEY, cachedPayload({ semaError: 'must not leak' }));
    const deniedRequest = new Request('https://worldmonitor.test/api/sanctions/v1/list-sanctions-pressure');
    const denied = await listSanctionsPressure(
      { request: deniedRequest, pathParams: {}, headers: {} },
      { maxItems: 25 },
    );
    assert.equal(denied.semaCount, 0);
    assert.equal(denied.semaError, undefined);
    assert.deepEqual(denied.entries, []);
  });

  it('serializes both SEMA fields over the generated RPC route', async () => {
    cacheStore.set(REDIS_KEY, cachedPayload({ semaCount: 0, semaError: 'SEMA parse failed' }));
    const { createSanctionsServiceRoutes } = await import('../src/generated/server/worldmonitor/sanctions/v1/service_server.ts');
    const [route] = createSanctionsServiceRoutes({
      listSanctionsPressure,
      lookupSanctionEntity: async () => ({ results: [], total: 0, source: '' }),
    });
    const response = await route.handler(new Request(
      'https://worldmonitor.test/api/sanctions/v1/list-sanctions-pressure?max_items=25',
      { headers: { 'X-WorldMonitor-Key': ENTERPRISE_KEY } },
    ));
    const body = await response.json();

    assert.equal(body.semaCount, 0);
    assert.equal(body.semaError, 'SEMA parse failed');
    assert.equal(body.entries[0]?.sourceLists[0], 'SDN');
  });
});

const FRONTEND_STATE_KEY = '__wmSanctionsContractTestState';
let bundleSequence = 0;

async function loadSanctionsService(state) {
  globalThis[FRONTEND_STATE_KEY] = state;
  const stubs = new Map([
    ['utils-stub', `
      export function createCircuitBreaker() {
        return {
          async execute(fn, fallback) { try { return await fn(); } catch { return fallback; } },
          recordSuccess() {},
          clearCache() {},
        };
      }
    `],
    ['rpc-client-stub', `export function getRpcBaseUrl() { return 'https://worldmonitor.test'; }`],
    ['premium-fetch-stub', `export async function premiumFetch() { throw new Error('unused test stub'); }`],
    ['bootstrap-stub', `
      export function getHydratedData() {
        return structuredClone(globalThis.${FRONTEND_STATE_KEY}.hydrated);
      }
    `],
    ['panel-gating-stub', `
      export function hasPremiumAccess() { return globalThis.${FRONTEND_STATE_KEY}.premium; }
    `],
    ['runtime-stub', `export function toApiUrl(path) { return 'https://worldmonitor.test' + path; }`],
    ['generated-clients-stub', `
      export class SanctionsServiceClient {
        async listSanctionsPressure() {
          return structuredClone(globalThis.${FRONTEND_STATE_KEY}.rpcResponse);
        }
      }
    `],
  ]);
  const aliases = new Map([
    ['@/utils/circuit-breaker', 'utils-stub'],
    ['@/services/rpc-client', 'rpc-client-stub'],
    ['@/services/premium-fetch', 'premium-fetch-stub'],
    ['@/services/bootstrap', 'bootstrap-stub'],
    ['@/services/panel-gating', 'panel-gating-stub'],
    ['@/services/runtime', 'runtime-stub'],
    ['@/services/generated-rpc-clients', 'generated-clients-stub'],
  ]);
  const result = await build({
    entryPoints: [resolve(root, 'src/services/sanctions-pressure.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'sanctions-contract-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs.get(args.path),
          loader: 'ts',
        }));
      },
    }],
  });
  const source = `${result.outputFiles[0].text}\n// test bundle ${bundleSequence++}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

describe('sanctions frontend normalization parity', () => {
  it('normalizes old hydrated cache data to absent-error defaults', async () => {
    const oldPayload = cachedPayload();
    delete oldPayload.semaCount;
    const service = await loadSanctionsService({
      hydrated: oldPayload,
      premium: true,
      rpcResponse: undefined,
    });

    const result = await service.fetchSanctionsPressure();
    assert.equal(result.semaCount, 0);
    assert.equal(result.semaError, null);
    assert.equal(result.entries[0]?.name, 'Kept OFAC designation');
  });

  it('normalizes bootstrap and RPC SEMA failure payloads identically', async () => {
    const payload = cachedPayload({ semaCount: 0, semaError: 'SEMA unavailable' });
    bootstrapPayload = payload;
    const bootstrapService = await loadSanctionsService({
      hydrated: undefined,
      premium: false,
      rpcResponse: undefined,
    });
    const rpcService = await loadSanctionsService({
      hydrated: undefined,
      premium: true,
      rpcResponse: payload,
    });

    const bootstrapResult = await bootstrapService.fetchSanctionsPressure();
    const rpcResult = await rpcService.fetchSanctionsPressure();
    assert.deepEqual(bootstrapResult, rpcResult);
    assert.equal(rpcResult.semaCount, 0);
    assert.equal(rpcResult.semaError, 'SEMA unavailable');
    assert.equal(rpcResult.entries[0]?.sourceLists[0], 'SDN');
  });
});
