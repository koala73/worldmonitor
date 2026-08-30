import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getRequiredTier, TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const ROUTE = '/api/resilience/v1/get-resilience-indicators';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('resilience indicator RPC contract', () => {
  it('registers a required ISO-2 GET RPC without changing the score proto', () => {
    const service = read('proto/worldmonitor/resilience/v1/service.proto');
    const indicators = read('proto/worldmonitor/resilience/v1/get_resilience_indicators.proto');

    assert.match(service, /import "worldmonitor\/resilience\/v1\/get_resilience_indicators\.proto";/);
    assert.match(service, /rpc GetResilienceIndicators\(GetResilienceIndicatorsRequest\) returns \(GetResilienceIndicatorsResponse\)/);
    assert.match(service, /path: "\/get-resilience-indicators", method: HTTP_METHOD_GET/);
    assert.match(indicators, /name: "countryCode", required: true/);
    assert.match(indicators, /repeated ResilienceIndicator indicators = 8;/);
    assert.equal(INDICATOR_REGISTRY.length, 72, 'response contract is defined for every registry row');
  });

  it('carries trace-aligned state, contribution, provenance and version metadata', () => {
    const proto = read('proto/worldmonitor/resilience/v1/get_resilience_indicators.proto');
    for (const field of [
      'included_in_dimension_score', 'state', 'reason', 'normalized_score_available',
      'nominal_weight', 'runtime_weight', 'scoring_weight_share', 'literal_contribution',
      'effective_contribution', 'imputation_class', 'source_year_available',
      'observation_age_available', 'observation_age_value', 'observation_age_unit',
      'observation_age_basis', 'retrieved_at_available', 'observed_at_available',
      'repeated ResilienceIndicatorSource sources', 'ResilienceIndicatorRawValue raw_value',
      'license_url', 'attribution_url',
      'pre_policy_score', 'policy_cap_name', 'policy_cap_factor',
      'reconciliation_available',
      'formula', 'data_version', 'schema_version', 'construct_versions',
    ]) {
      assert.ok(proto.includes(field), `missing resilience indicator contract field: ${field}`);
    }
    for (const state of [
      'observed', 'imputed', 'missing', 'fallback', 'source-failure',
      'inactive', 'retired', 'not-applicable',
    ]) {
      assert.ok(proto.includes(state), `state vocabulary must document ${state}`);
    }
  });

  it('keeps the existing get-resilience-score OpenAPI schema closure unchanged', () => {
    const spec = JSON.parse(read('docs/api/ResilienceService.openapi.json')) as {
      components: { schemas: Record<string, unknown> };
    };
    const names = [
      'GetResilienceScoreResponse',
      'ScoreInterval',
      'ResilienceDomain',
      'ResilienceDimension',
      'DimensionFreshness',
      'ResiliencePillar',
    ];
    const closure = Object.fromEntries(names.map((name) => [name, spec.components.schemas[name]]));
    const digest = createHash('sha256').update(canonicalJson(closure)).digest('hex');
    assert.equal(digest, '01fc1918c9f4b1138cea5d93b8453ca07056b964cd84ded7ef27e36db5c827c1');
  });

  it('registers matching legacy premium, modern tier-1 and slow-cache gates', () => {
    assert.ok(PREMIUM_RPC_PATHS.has(ROUTE));
    assert.ok(TIER_GATED_PATHS.has(ROUTE));
    assert.equal(getRequiredTier(ROUTE), 1);
    const gateway = read('server/gateway.ts');
    assert.match(gateway, /'\/api\/resilience\/v1\/get-resilience-indicators': 'slow'/);
  });

  it('exercises anonymous denial, validation, and success through the generated gateway route', async () => {
    const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
    const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const originalConvexUrl = process.env.CONVEX_SITE_URL;
    const originalConvexSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const originalFetch = globalThis.fetch;
    process.env.WORLDMONITOR_VALID_KEYS = 'issue-6507-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.CONVEX_SITE_URL = 'https://convex.example';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'issue-6507-shared-secret';
    const { fetchImpl } = createRedisFetch({});
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (requestUrl.endsWith('/api/internal-validate-api-key')) {
        return Response.json({ userId: 'issue-6507-free-user', keyId: 'free-key', name: 'Free key' });
      }
      if (requestUrl.endsWith('/api/internal-entitlements')) {
        return Response.json({
          planKey: 'free',
          validUntil: Date.now() + 86_400_000,
          features: {
            tier: 0,
            apiAccess: true,
            apiRateLimit: 60,
            maxDashboards: 3,
            prioritySupport: false,
            exportFormats: [],
            mcpAccess: false,
          },
        });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const [gatewayModule, generated, handlerModule] = await Promise.all([
        import('../server/gateway.ts'),
        import('../src/generated/server/worldmonitor/resilience/v1/service_server.ts'),
        import('../server/worldmonitor/resilience/v1/handler.ts'),
      ]);
      const routes = generated.createResilienceServiceRoutes({
        ...handlerModule.resilienceHandler,
        getResilienceIndicators: async (ctx, request) => request.countryCode === 'DEU'
          ? handlerModule.resilienceHandler.getResilienceIndicators(ctx, request)
          : {
              countryCode: request.countryCode,
              methodology: 'score-generation-trace-v1',
              formula: 'pc',
              dataVersion: '2026-08-30',
              schemaVersion: '2.0',
              constructVersions: { energy: 'legacy', education: 'active', financialSystemExposure: 'rollback' },
              dimensions: [],
              indicators: [],
            },
      }, gatewayModule.serverOptions);
      const gateway = gatewayModule.createDomainGateway(routes);
      const url = 'https://worldmonitor.app/api/resilience/v1/get-resilience-indicators?countryCode=DE';

      const anonymous = await gateway(new Request(url, { headers: { Origin: 'https://worldmonitor.app' } }));
      assert.equal(anonymous.status, 401);

      const free = await gateway(new Request(url, {
        headers: {
          Origin: 'https://worldmonitor.app',
          'X-WorldMonitor-Key': `wm_${'a'.repeat(40)}`,
        },
      }));
      assert.equal(free.status, 403);
      assert.deepEqual(await free.json(), {
        error: 'Upgrade required',
        requiredTier: 1,
        currentTier: 0,
        planKey: 'free',
      });

      const headers = { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'issue-6507-test-key' };
      const invalid = await gateway(new Request(url.replace('DE', 'DEU'), { headers }));
      assert.equal(invalid.status, 400);

      const success = await gateway(new Request(url, { headers }));
      assert.equal(success.status, 200);
      assert.equal((await success.json() as { countryCode?: string }).countryCode, 'DE');

      const projected = await gateway(new Request(
        `${url}&jmespath=indicators%5B%5D.rawValue`,
        { headers },
      ));
      assert.equal(projected.status, 400);
      assert.match(
        (await projected.json() as { violations?: Array<{ description?: string }> }).violations?.[0]?.description ?? '',
        /JMESPath.*attribution-bound/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
      if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
      if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
      if (originalConvexUrl == null) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalConvexUrl;
      if (originalConvexSecret == null) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalConvexSecret;
    }
  });
});
