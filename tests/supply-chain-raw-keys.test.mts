/**
 * #7274 — supply-chain preview readers must read Railway-owned canonical
 * keys with raw=true.
 *
 * The fuel-shortage, storage-facility, energy-disruption, and pipeline
 * registries are published by Railway seed scripts (scripts/_seed-utils.mjs
 * atomicPublish → plain `SET <canonicalKey>`), which know nothing about the
 * Vercel deployment key-prefix scheme. A preview deployment reading those
 * keys through the default prefixed path asks Upstash for
 * `preview:<sha>:energy:…` — a key nothing ever writes — so every preview
 * served empty "upstreamUnavailable" registries.
 *
 * These tests run the handlers under a preview environment (VERCEL_ENV +
 * VERCEL_GIT_COMMIT_SHA set, so getKeyPrefix() is non-empty) with a stubbed
 * Upstash fetch, and assert the EXACT unprefixed canonical key is requested.
 */
import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

process.env.VERCEL_ENV = 'preview';
process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafe4321';
process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
delete process.env.LOCAL_API_MODE;

// Imported AFTER the env above so redis.ts's module-cached prefix is
// computed under preview conditions.
const redis = await import('../server/_shared/redis');
const { listFuelShortages } = await import(
  '../server/worldmonitor/supply-chain/v1/list-fuel-shortages'
);
const { getFuelShortageDetail } = await import(
  '../server/worldmonitor/supply-chain/v1/get-fuel-shortage-detail'
);
const { listStorageFacilities } = await import(
  '../server/worldmonitor/supply-chain/v1/list-storage-facilities'
);
const { getStorageFacilityDetail } = await import(
  '../server/worldmonitor/supply-chain/v1/get-storage-facility-detail'
);
const { listEnergyDisruptions } = await import(
  '../server/worldmonitor/supply-chain/v1/list-energy-disruptions'
);
const { listPipelines } = await import(
  '../server/worldmonitor/supply-chain/v1/list-pipelines'
);
const { getPipelineDetail } = await import(
  '../server/worldmonitor/supply-chain/v1/get-pipeline-detail'
);

/** Keys requested from the stubbed Upstash, decoded, in call order. */
const requested: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://upstash.test/get/')) {
    requested.push(decodeURIComponent(url.slice('https://upstash.test/get/'.length)));
    return Response.json({ result: null });
  }
  throw new Error(`unexpected global fetch: ${url}`);
}) as typeof fetch;

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

beforeEach(() => {
  requested.length = 0;
});

type Req<F> = F extends (ctx: unknown, req: infer R) => unknown ? R : never;

describe('supply-chain preview readers use raw Railway-owned keys (#7274)', () => {
  it('sanity: this suite really runs under a non-empty deployment prefix', () => {
    assert.equal(redis.getKeyPrefix(), 'preview:deadbeef:');
  });

  it('listFuelShortages reads the exact canonical key', async () => {
    await listFuelShortages(null, {} as Req<typeof listFuelShortages>);
    assert.deepEqual(requested, ['energy:fuel-shortages:v1']);
  });

  it('getFuelShortageDetail reads the exact canonical key', async () => {
    await getFuelShortageDetail(null, {
      shortageId: 'x',
    } as Req<typeof getFuelShortageDetail>);
    assert.deepEqual(requested, ['energy:fuel-shortages:v1']);
  });

  it('listStorageFacilities reads the exact canonical key', async () => {
    await listStorageFacilities(null, {} as Req<typeof listStorageFacilities>);
    assert.deepEqual(requested, ['energy:storage-facilities:v1']);
  });

  it('getStorageFacilityDetail reads the exact canonical key', async () => {
    await getStorageFacilityDetail(null, {
      facilityId: 'x',
    } as Req<typeof getStorageFacilityDetail>);
    assert.deepEqual(requested, ['energy:storage-facilities:v1']);
  });

  it('listEnergyDisruptions reads the exact canonical key', async () => {
    await listEnergyDisruptions(null, {} as Req<typeof listEnergyDisruptions>);
    assert.deepEqual(requested, ['energy:disruptions:v1']);
  });

  it('listPipelines reads both exact canonical pipeline keys', async () => {
    await listPipelines(null, {} as Req<typeof listPipelines>);
    assert.deepEqual(
      [...requested].sort(),
      ['energy:pipelines:gas:v1', 'energy:pipelines:oil:v1'],
    );
  });

  it('getPipelineDetail reads both exact canonical pipeline keys', async () => {
    await getPipelineDetail(null, {
      pipelineId: 'x',
    } as Req<typeof getPipelineDetail>);
    assert.deepEqual(
      [...requested].sort(),
      ['energy:pipelines:gas:v1', 'energy:pipelines:oil:v1'],
    );
  });
});
