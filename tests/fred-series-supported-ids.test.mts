import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';
import { getFredSeries } from '../server/worldmonitor/economic/v1/get-fred-series';
import { ALLOWED_FRED_SERIES } from '../server/worldmonitor/economic/v1/_fred-shared';
import { ValidationError } from '../src/generated/server/worldmonitor/economic/v1/service_server';

const SUPPORTED = [...ALLOWED_FRED_SERIES].sort();

test('an unsupported series ID is rejected with the supported IDs in the message', async () => {
  const request = new Request('https://api.worldmonitor.app/api/economic/v1/get-fred-series?series_id=DEXUSEU');
  await assert.rejects(
    getFredSeries({ request, pathParams: {}, headers: {} }, { seriesId: 'DEXUSEU', limit: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.violations[0]!.description, `Unsupported FRED series ID. Supported: ${SUPPORTED.join(', ')}`);
      return true;
    },
  );
});

test('published OpenAPI lists every supported FRED series ID', () => {
  const specs = {
    'EconomicService.openapi.json': JSON.parse,
    'EconomicService.openapi.yaml': loadYaml,
    'worldmonitor.openapi.yaml': loadYaml,
  };
  for (const [file, parse] of Object.entries(specs)) {
    const spec = parse(readFileSync(new URL(`../docs/api/${file}`, import.meta.url), 'utf8')) as {
      paths: Record<string, { get: { parameters: { name: string; schema: { enum?: string[] } }[] } }>;
    };
    const param = spec.paths['/api/economic/v1/get-fred-series']!.get.parameters.find(p => p.name === 'series_id');
    assert.deepEqual(param?.schema.enum, SUPPORTED, file);
  }
});
