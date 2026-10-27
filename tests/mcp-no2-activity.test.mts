// get_no2_activity drives the real _execute through a mocked fetch to the
// get-no2-activity RPC, so the argument mapping, the compact projection and
// the budget fit are pinned here rather than by a source grep. The RPC body is
// produced by the real handler over the shared fixture, so the two surfaces
// cannot drift apart silently.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import jmespath from 'jmespath';

import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { TOOL_CATEGORY_BY_NAME } from '../api/mcp/domains.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { utf8ByteLength } from '../api/mcp/utils.ts';
import { NO2_ACTIVITY_KEY, NO2_REGIONS } from '../scripts/shared/no2-activity.mjs';
import { REST_ATTRIBUTION_EXPRESSIONS } from '../shared/attribution-rider.ts';
import { getNo2Activity } from '../server/worldmonitor/economic/v1/get-no2-activity.ts';
import { no2ActivityDataset } from './helpers/no2-activity-fixture.mjs';

const tool = TOOL_REGISTRY.find((t) => t.name === 'get_no2_activity');
assert.ok(tool, 'get_no2_activity must be registered');
if (tool._execute === undefined) throw new Error('get_no2_activity must be an _execute tool');
const execute = tool._execute;

const BASE = 'https://api.worldmonitor.app';
const CTX = { kind: 'env_key', apiKey: 'test' } as Parameters<typeof execute>[2];
const DAY_MS = 86_400_000;
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validateOutput = ajv.compile(tool.outputSchema as object);

const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function freshDataset(changes: Record<string, number | null | 'pending'> = {}) {
  const now = Date.now();
  return no2ActivityDataset({
    generatedAt: new Date(now - 3_600_000).toISOString(),
    windowEnd: new Date(now - 4 * DAY_MS).toISOString().slice(0, 10),
    changes,
  });
}

let requestedUrls: string[] = [];
let redisValue: unknown = null;

/** Routes RPC fetches through the real handler and Redis fetches to a fixture. */
function installTransport() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/')) {
      return Response.json({ result: redisValue === null ? null : JSON.stringify(redisValue) });
    }
    requestedUrls.push(url);
    const parsed = new URL(url);
    const response = await getNo2Activity({} as never, {
      countryCode: parsed.searchParams.get('country_code') ?? '',
      regionId: parsed.searchParams.get('region_id') ?? '',
      kind: (parsed.searchParams.get('kind') ?? 'NO2_REGION_KIND_UNSPECIFIED') as never,
    });
    return Response.json(response);
  }) as typeof fetch;
}

beforeEach(() => {
  requestedUrls = [];
  redisValue = null;
  installTransport();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalEnv.url;
  if (originalEnv.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.token;
});

describe('get_no2_activity', () => {
  it('is registered with parity, coverage, category and access contracts', () => {
    assert.deepEqual(tool._apiPaths, ['GET /api/economic/v1/get-no2-activity']);
    assert.deepEqual(tool._coverageKeys, [NO2_ACTIVITY_KEY, 'seed-meta:economic:no2-activity']);
    assert.equal(TOOL_CATEGORY_BY_NAME.get_no2_activity, 'markets-economy');
    assert.equal(toolAccess(tool), 'subscription');
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['country_code', 'kind', 'region_id']);
  });

  it('serves every region unfiltered, validated by its own output schema and inside its budget', async () => {
    redisValue = freshDataset({ 'country-cn': 14.2, 'country-fr': 'pending', 'country-de': null });
    const result = await execute({}, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(requestedUrls, [`${BASE}/api/economic/v1/get-no2-activity`]);
    assert.ok(validateOutput(result), JSON.stringify(validateOutput.errors));
    const regions = result.regions as Array<Record<string, unknown>>;
    assert.equal(regions.length, NO2_REGIONS.length);
    assert.equal(result.unavailableReason, 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED');
    assert.equal(result.upstreamUnavailable, false);
    assert.equal(result.stale, false);
    assert.equal(result.attribution, 'Contains modified Copernicus Sentinel data 2023-2026');
    assert.deepEqual(result.method, {
      methodVersion: 'no2-activity/v1', windowDays: 56, windowEndLagDays: 3, baselineYears: 3,
      minBaselineYears: 2, minValidDays: 14, minValidFraction: 0.2, deadBandPercent: 10,
    });
    assert.ok(utf8ByteLength(JSON.stringify(result)) <= tool._outputBudgetBytes, 'unfiltered response must fit the output budget');

    const china = regions.find((region) => region.id === 'country-cn');
    assert.deepEqual(china, {
      id: 'country-cn',
      kind: 'country',
      label: 'China',
      countryCode: 'CN',
      bbox: [73.63, 18.29, 134.77, 53.55],
      windowStart: (redisValue as ReturnType<typeof freshDataset>).regions['country-cn'].current.windowStart,
      windowEnd: (redisValue as ReturnType<typeof freshDataset>).regions['country-cn'].current.windowEnd,
      validDays: 40,
      meanNo2MolM2: 1.1e-4 * 1.142,
      baselineYears: (redisValue as ReturnType<typeof freshDataset>).regions['country-cn'].baseline.years.map((year) => year.year),
      baselineMeanNo2MolM2: 1.1e-4,
      changePercent: 14.2,
      signalValue: 14.2,
      direction: 'strengthening',
      exclusion: null,
    });
    const inside = regions.find((region) => region.id === 'country-ae');
    assert.equal(inside?.changePercent, 2);
    assert.equal(inside?.signalValue, 0);
    assert.equal(inside?.direction, 'unchanged');

    const pending = regions.find((region) => region.id === 'country-fr');
    assert.deepEqual(pending && {
      direction: pending.direction, exclusion: pending.exclusion, changePercent: pending.changePercent,
      baselineYears: pending.baselineYears, baselineMeanNo2MolM2: pending.baselineMeanNo2MolM2,
    }, { direction: null, exclusion: 'baseline_backfill_pending', changePercent: null, baselineYears: [], baselineMeanNo2MolM2: null });

    const cloudy = regions.find((region) => region.id === 'country-de');
    assert.equal(cloudy?.exclusion, 'insufficient_valid_days');
    assert.equal(cloudy?.meanNo2MolM2, null);
    assert.equal(regions.find((region) => region.id === 'gulf-states')?.countryCode, null);
  });

  it('resolves country names and alpha-3 codes and maps kind to the RPC enum', async () => {
    redisValue = freshDataset();
    const byName = await execute({ country_code: 'Germany', kind: 'cluster' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.equal(requestedUrls.at(-1), `${BASE}/api/economic/v1/get-no2-activity?country_code=DE&kind=NO2_REGION_KIND_CLUSTER`);
    assert.deepEqual((byName.regions as Array<{ id: string }>).map((region) => region.id), ['ruhr-rhine']);

    await execute({ country_code: 'chn', kind: 'country' }, BASE, CTX, {});
    assert.equal(requestedUrls.at(-1), `${BASE}/api/economic/v1/get-no2-activity?country_code=CN&kind=NO2_REGION_KIND_COUNTRY`);

    const byRegion = await execute({ region_id: 'po-valley' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.equal(requestedUrls.at(-1), `${BASE}/api/economic/v1/get-no2-activity?region_id=po-valley`);
    assert.deepEqual((byRegion.regions as Array<{ countryCode: string }>).map((region) => region.countryCode), ['IT']);
  });

  it('rejects an unresolvable country or an unknown kind before any fetch, in _validateArgs too', async () => {
    redisValue = freshDataset();
    assert.throws(() => tool._validateArgs?.({ country_code: 'Atlantis' }), RpcValidationError);
    assert.throws(() => tool._validateArgs?.({ kind: 'constructor' }), RpcValidationError);
    await assert.rejects(execute({ country_code: 'Atlantis' }, BASE, CTX, {}), RpcValidationError);
    await assert.rejects(execute({ kind: 'city' }, BASE, CTX, {}), RpcValidationError);
    await assert.rejects(execute({ region_id: 'Po Valley' }, BASE, CTX, {}), RpcValidationError);
    assert.deepEqual(requestedUrls, []);
  });

  it('carries no signal and zeroed constants for a method version this server does not know', async () => {
    redisValue = freshDataset();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://redis.example.test/')) return Response.json({ result: JSON.stringify(redisValue) });
      const served = await getNo2Activity({} as never, { countryCode: 'CN', regionId: 'country-cn', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
      return Response.json({ ...served, methodVersion: 'no2-activity/v9' });
    }) as typeof fetch;
    const result = await execute({ region_id: 'country-cn' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.ok(validateOutput(result), JSON.stringify(validateOutput.errors));
    const region = (result.regions as Array<Record<string, unknown>>)[0];
    assert.equal(region?.changePercent, 2);
    assert.equal(region?.signalValue, null);
    assert.equal((result.method as Record<string, unknown>).methodVersion, 'no2-activity/v9');
    assert.equal((result.method as Record<string, unknown>).deadBandPercent, 0);
  });

  it('passes a fault through with its reason instead of inventing an empty reading', async () => {
    redisValue = null;
    const result = await execute({ country_code: 'CN' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.ok(validateOutput(result), JSON.stringify(validateOutput.errors));
    assert.equal(result.unavailableReason, 'NO2_ACTIVITY_UNAVAILABLE_REASON_SEED_MISSING');
    assert.equal(result.upstreamUnavailable, true);
    assert.deepEqual(result.regions, []);
    assert.equal(result.attribution, '');
  });

  it('rides the Copernicus credit with every projection, on MCP and REST alike', async () => {
    redisValue = freshDataset();
    const result = await execute({ country_code: 'IT' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.equal(tool._attribution, REST_ATTRIBUTION_EXPRESSIONS['/api/economic/v1/get-no2-activity']);
    assert.deepEqual(jmespath.search(result, tool._attribution as string), {
      attribution: 'Contains modified Copernicus Sentinel data 2023-2026',
      generatedAt: (redisValue as ReturnType<typeof freshDataset>).generatedAt,
    });
  });

  it('answers not_covered for a resolvable country outside the registry', async () => {
    redisValue = freshDataset();
    const result = await execute({ country_code: 'VA' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.equal(result.unavailableReason, 'NO2_ACTIVITY_UNAVAILABLE_REASON_NOT_COVERED');
    assert.equal(result.upstreamUnavailable, false);
    assert.deepEqual(result.regions, []);
  });
});
