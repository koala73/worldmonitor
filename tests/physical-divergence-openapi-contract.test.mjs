import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { PHYSICAL_DIVERGENCE_CONTRACT } from '../shared/physical-divergence-contract.js';

const specs = [
  ['service JSON', JSON.parse(readFileSync(new URL('../docs/api/MarketService.openapi.json', import.meta.url), 'utf8'))],
  ['service YAML', loadYaml(readFileSync(new URL('../docs/api/MarketService.openapi.yaml', import.meta.url), 'utf8'))],
  ['unified YAML', loadYaml(readFileSync(new URL('../docs/api/worldmonitor.openapi.yaml', import.meta.url), 'utf8'))],
];

function schema(spec, name) {
  return spec.components.schemas[name]
    ?? Object.entries(spec.components.schemas).find(([candidate]) => candidate.endsWith(`_${name}`))?.[1];
}

describe('physical divergence OpenAPI contract', () => {
  it('publishes the same metal constraints as generated request validation', () => {
    const expected = {
      items: { pattern: '^(?:gold|silver)$', type: 'string' },
      maxItems: 2,
      type: 'array',
      uniqueItems: true,
    };
    for (const [label, spec] of specs) {
      const request = schema(spec, 'GetPhysicalDivergenceIndexRequest');
      assert.deepEqual(
        request.properties.metals,
        { ...expected, description: 'Accepted values are "gold" and "silver". Empty returns both metals.' },
        label,
      );
      const operation = spec.paths['/api/market/v1/get-physical-divergence-index'].get;
      const parameter = operation.parameters.find((candidate) => candidate.name === 'metals');
      assert.deepEqual(parameter.schema, expected, label);
    }
  });

  it('publishes the shared reading and composite reason patterns', () => {
    for (const [label, spec] of specs) {
      assert.equal(
        schema(spec, 'PhysicalDivergenceReading').properties.reason.pattern,
        PHYSICAL_DIVERGENCE_CONTRACT.readingReasonPattern,
        label,
      );
      assert.equal(
        schema(spec, 'PhysicalStressComposite').properties.reason.pattern,
        PHYSICAL_DIVERGENCE_CONTRACT.compositeReasonPattern,
        label,
      );
    }
  });
});
