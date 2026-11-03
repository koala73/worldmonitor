// #8950: the seeder sets kind and deadline on every ResolutionSpec it emits,
// so the public contract declares both required. Forecast.resolution stays
// optional, because a forecast without a spec omits it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('ResolutionSpec required fields in the public contract (#8950)', () => {
  const schemas = JSON.parse(read('docs/api/ForecastService.openapi.json')).components.schemas;

  it('requires kind and deadline on ResolutionSpec', () => {
    assert.deepEqual([...(schemas.ResolutionSpec.required ?? [])].sort(), ['deadline', 'kind']);
  });

  it('keeps Forecast.resolution optional', () => {
    assert.ok(schemas.Forecast.properties.resolution, 'Forecast.resolution is declared');
    assert.equal((schemas.Forecast.required ?? []).includes('resolution'), false);
  });

  it('carries the requirement into the unified bundle', () => {
    const bundle = read('docs/api/worldmonitor.openapi.yaml');
    const block = bundle.match(/\n {8}worldmonitor_forecast_v1_ResolutionSpec:\n([\s\S]*?)\n {8}\S/)?.[1];
    assert.ok(block, 'the bundle declares ResolutionSpec');
    assert.match(block, /\n {12}required:\n {16}- kind\n {16}- deadline\n/);
  });
});
