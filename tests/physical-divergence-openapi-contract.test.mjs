import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';

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
});
