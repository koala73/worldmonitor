import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

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
    const gateway = read('server/gateway.ts');
    assert.match(gateway, /'\/api\/resilience\/v1\/get-resilience-indicators': 'slow'/);
  });
});
