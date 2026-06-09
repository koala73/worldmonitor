import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalVercelSha = process.env.VERCEL_GIT_COMMIT_SHA;
const originalSchemaV2 = process.env.RESILIENCE_SCHEMA_V2_ENABLED;
const originalPillarCombine = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
const originalEnergyV2 = process.env.RESILIENCE_ENERGY_V2_ENABLED;
const originalFinSysExposure = process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
const originalApiKey = process.env.WORLDMONITOR_API_KEY;

function restoreEnv(name: string, original: string | undefined): void {
  if (original == null) delete process.env[name];
  else process.env[name] = original;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restoreEnv('UPSTASH_REDIS_REST_URL', originalRedisUrl);
  restoreEnv('UPSTASH_REDIS_REST_TOKEN', originalRedisToken);
  restoreEnv('VERCEL_ENV', originalVercelEnv);
  restoreEnv('VERCEL_GIT_COMMIT_SHA', originalVercelSha);
  restoreEnv('RESILIENCE_SCHEMA_V2_ENABLED', originalSchemaV2);
  restoreEnv('RESILIENCE_PILLAR_COMBINE_ENABLED', originalPillarCombine);
  restoreEnv('RESILIENCE_ENERGY_V2_ENABLED', originalEnergyV2);
  restoreEnv('RESILIENCE_FIN_SYS_EXPOSURE_ENABLED', originalFinSysExposure);
  restoreEnv('WORLDMONITOR_VALID_KEYS', originalValidKeys);
  restoreEnv('WORLDMONITOR_API_KEY', originalApiKey);
  const { __resetKeyPrefixCacheForTests } = await import('../server/_shared/redis.ts');
  __resetKeyPrefixCacheForTests();
});

async function loadRuntimeManifestModules() {
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
  const [handler, shared, responseHeaders] = await Promise.all([
    import('../server/worldmonitor/resilience/v1/get-resilience-runtime-manifest.ts'),
    import('../server/worldmonitor/resilience/v1/_shared.ts'),
    import('../server/_shared/response-headers.ts'),
  ]);
  return { ...handler, ...shared, ...responseHeaders };
}

describe('resilience runtime manifest', () => {
  it('returns public formula, dataVersion, and ranking metadata without deploy internals', async () => {
    const modules = await loadRuntimeManifestModules();
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
    process.env.RESILIENCE_ENERGY_V2_ENABLED = 'false';
    process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'true';
    process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
    process.env.VERCEL_ENV = 'production';

    installRedis({
      [modules.RESILIENCE_STATIC_META_KEY]: { fetchedAt: Date.parse('2026-05-28T15:41:37.635Z') },
      [modules.RESILIENCE_RANKING_META_KEY]: {
        fetchedAt: Date.parse('2026-05-29T12:00:00.000Z'),
        count: 196,
        scored: 171,
        total: 196,
      },
      [modules.RESILIENCE_INTERVALS_META_KEY]: {
        fetchedAt: Date.parse('2026-05-29T11:45:00.000Z'),
      },
      'resilience:intervals:v9:US': {
        p05: 65.2,
        p95: 72.8,
        _formula: 'pc',
        computedAt: '2026-05-29T12:15:00.000Z',
        methodology: 'weight-perturbation-sensitivity-v3',
      },
    }, { keepVercelEnv: true });

    const request = new Request('https://worldmonitor.app/api/resilience/v1/get-runtime-manifest');
    const response = await modules.getResilienceRuntimeManifest({ request } as never);

    assert.equal(response.manifestVersion, 4);
    assert.match(response.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(response.deployedCommitSha, '');
    assert.equal(response.vercelEnv, '');
    assert.equal(response.formulaTag, 'pc');
    assert.equal(response.dataVersion, '2026-05-28');
    assert.deepEqual(response.constructVersions, { energy: 'legacy' });
    assert.deepEqual(response.flags, []);
    assert.deepEqual(response.cache, {
      scorePrefix: '',
      rankingKey: '',
      historyPrefix: '',
      intervalPrefix: '',
      intervalMethodology: '',
    });
    assert.deepEqual(response.rankingCache, {
      fetchedAt: '2026-05-29T12:00:00.000Z',
      count: 196,
      scored: 171,
      total: 196,
    });
    assert.deepEqual(response.intervals, {
      available: true,
      methodology: 'weight-perturbation-sensitivity-v3',
      sampleCountry: 'US',
      lastObservedAt: '2026-05-29T12:15:00.000Z',
    });
    assert.deepEqual(modules.drainResponseHeaders(request), { 'X-No-Cache': '1' });
  });

  it('returns safe empty/zero metadata when Redis keys are absent', async () => {
    const modules = await loadRuntimeManifestModules();
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_ENV;
    installRedis({}, { keepVercelEnv: true });

    const response = await modules.getResilienceRuntimeManifest({
      request: new Request('https://worldmonitor.app/api/resilience/v1/get-runtime-manifest'),
    } as never);

    assert.equal(response.deployedCommitSha, '');
    assert.equal(response.vercelEnv, '');
    assert.equal(response.formulaTag, 'd6');
    assert.equal(response.dataVersion, '');
    assert.deepEqual(response.constructVersions, { energy: 'legacy' });
    assert.deepEqual(response.rankingCache, { fetchedAt: '', count: 0, scored: 0, total: 0 });
    assert.deepEqual(response.intervals, {
      available: false,
      methodology: 'weight-perturbation-sensitivity-v3',
      sampleCountry: 'US',
      lastObservedAt: '',
    });
  });

  it('reports interval metadata unavailable without throwing when the sample is missing or stale', async () => {
    const modules = await loadRuntimeManifestModules();
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
    installRedis({
      [modules.RESILIENCE_INTERVALS_META_KEY]: {
        fetchedAt: Date.parse('2026-05-30T10:00:00.000Z'),
      },
      'resilience:intervals:v9:US': {
        p05: 65.2,
        p95: 72.8,
        _formula: 'd6',
        computedAt: '2026-05-30T11:00:00.000Z',
        methodology: 'weight-perturbation-sensitivity-v3',
      },
    }, { keepVercelEnv: true });

    const response = await modules.getResilienceRuntimeManifest({
      request: new Request('https://worldmonitor.app/api/resilience/v1/get-runtime-manifest'),
    } as never);

    assert.deepEqual(response.intervals, {
      available: false,
      methodology: 'weight-perturbation-sensitivity-v3',
      sampleCountry: 'US',
      lastObservedAt: '2026-05-30T11:00:00.000Z',
    });
  });

  it('reports interval metadata unavailable when the sample methodology is stale', async () => {
    const modules = await loadRuntimeManifestModules();
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
    installRedis({
      [modules.RESILIENCE_INTERVALS_META_KEY]: {
        fetchedAt: Date.parse('2026-05-30T10:00:00.000Z'),
      },
      'resilience:intervals:v9:US': {
        p05: 65.2,
        p95: 72.8,
        _formula: 'pc',
        computedAt: '2026-05-30T11:00:00.000Z',
        methodology: 'legacy-weight-perturbation-v2',
      },
    }, { keepVercelEnv: true });

    const response = await modules.getResilienceRuntimeManifest({
      request: new Request('https://worldmonitor.app/api/resilience/v1/get-runtime-manifest'),
    } as never);

    assert.deepEqual(response.intervals, {
      available: false,
      methodology: 'weight-perturbation-sensitivity-v3',
      sampleCountry: 'US',
      lastObservedAt: '2026-05-30T11:00:00.000Z',
    });
  });

  it('exposes derived construct state without raw env names, cache keys, or secrets', async () => {
    const modules = await loadRuntimeManifestModules();
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
    process.env.RESILIENCE_ENERGY_V2_ENABLED = 'true';
    process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'true';
    process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
    process.env.VERCEL_ENV = 'production';
    process.env.WORLDMONITOR_VALID_KEYS = 'operator-secret-key';
    process.env.WORLDMONITOR_API_KEY = 'legacy-secret-key';
    installRedis({}, { keepVercelEnv: true });
    process.env.UPSTASH_REDIS_REST_TOKEN = 'super-secret-upstash-token';

    const response = await modules.getResilienceRuntimeManifest({
      request: new Request('https://worldmonitor.app/api/resilience/v1/get-runtime-manifest'),
    } as never);
    const serialized = JSON.stringify(response);

    assert.deepEqual(response.constructVersions, { energy: 'v2' });
    assert.deepEqual(response.intervals, {
      available: false,
      methodology: 'weight-perturbation-sensitivity-v3',
      sampleCountry: 'US',
      lastObservedAt: '',
    });
    assert.equal(serialized.includes('super-secret-upstash-token'), false);
    assert.equal(serialized.includes('operator-secret-key'), false);
    assert.equal(serialized.includes('legacy-secret-key'), false);
    assert.equal(serialized.includes('UPSTASH_REDIS_REST_TOKEN'), false);
    assert.equal(serialized.includes('WORLDMONITOR_VALID_KEYS'), false);
    assert.equal(serialized.includes('WORLDMONITOR_API_KEY'), false);
    assert.equal(serialized.includes('0123456789abcdef0123456789abcdef01234567'), false);
    assert.equal(serialized.includes('production'), false);
    assert.equal(serialized.includes('RESILIENCE_ENERGY_V2_ENABLED'), false);
    assert.equal(serialized.includes('RESILIENCE_FIN_SYS_EXPOSURE_ENABLED'), false);
    assert.equal(serialized.includes('RESILIENCE_INTERVAL_METHODOLOGY'), false);
    assert.equal(serialized.includes('RESILIENCE_INTERVAL_KEY_PREFIX'), false);
    assert.equal(serialized.includes(modules.RESILIENCE_RANKING_CACHE_KEY), false);
    assert.equal(serialized.includes(modules.RESILIENCE_INTERVAL_KEY_PREFIX), false);
    assert.equal(serialized.includes(`${modules.RESILIENCE_INTERVAL_KEY_PREFIX}US`), false);
    assert.equal(serialized.includes(modules.RESILIENCE_INTERVALS_META_KEY), false);
    assert.equal(serialized.includes('resilience:fossil-electricity-share:v1'), false);
    assert.equal(serialized.includes('resilience:low-carbon-generation:v1'), false);
    assert.equal(serialized.includes('resilience:power-losses:v1'), false);
  });
});

describe('resilience runtime manifest gateway auth', () => {
  it('allows no-key manifest access while score and ranking remain premium gated', async () => {
    const [{ createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS, serverOptions }, generated, { resilienceHandler }, { PREMIUM_RPC_PATHS }] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/resilience/v1/service_server.ts'),
      import('../server/worldmonitor/resilience/v1/handler.ts'),
      import('../src/shared/premium-paths.ts'),
    ]);
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.WORLDMONITOR_VALID_KEYS;
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';

    assert.deepEqual([...PUBLIC_NO_AUTH_RPC_PATHS], ['/api/resilience/v1/get-runtime-manifest']);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/resilience/v1/get-runtime-manifest'), false);

    const gateway = createDomainGateway(generated.createResilienceServiceRoutes(resilienceHandler, serverOptions));

    const manifest = await gateway(new Request('https://worldmonitor.app/api/resilience/v1/get-runtime-manifest?_debug=1'));
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('Cache-Control'), 'no-store');
    assert.equal(manifest.headers.get('X-Cache-Tier'), 'no-store');
    const body = await manifest.json() as {
      manifestVersion: number;
      formulaTag: string;
      constructVersions?: { energy?: string };
      intervals?: { available?: boolean; methodology?: string; sampleCountry?: string; lastObservedAt?: string };
    };
    assert.equal(body.manifestVersion, 4);
    assert.equal(body.formulaTag, 'pc');
    assert.equal(body.constructVersions?.energy, 'legacy');
    assert.deepEqual(body.intervals, {
      available: false,
      methodology: 'weight-perturbation-sensitivity-v3',
      sampleCountry: 'US',
      lastObservedAt: '',
    });

    const score = await gateway(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US'));
    assert.equal(score.status, 401);

    const ranking = await gateway(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking'));
    assert.equal(ranking.status, 401);
  });
});
