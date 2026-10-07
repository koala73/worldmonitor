// #8967: the unscored 24h/7d/30d projections are no longer published. The v1
// proto keeps field 17 as deprecated for wire compatibility (buf breaking and
// docs/api-versioning.mdx forbid removing a v1 field). Horizon scoring (#8939)
// still reads the values from the seeder's history snapshot, which
// forecast-history.test.mjs covers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('forecast projections deprecated in the public contract (#8967)', () => {
  it('Forecast field 17 is deprecated, not reused', () => {
    const proto = read('proto/worldmonitor/forecast/v1/forecast.proto');
    assert.match(proto, /^\s*Projections projections = 17 \[deprecated = true\];$/m);
  });

  it('the OpenAPI Forecast schema marks projections deprecated', () => {
    const spec = JSON.parse(read('docs/api/ForecastService.openapi.json'));
    const projections = spec.components.schemas.Forecast?.properties?.projections;
    assert.ok(projections, 'Forecast.projections present for v1 compatibility');
    assert.equal(projections.deprecated, true);
  });

  it('the generated Forecast types mark projections deprecated', () => {
    for (const path of [
      'src/generated/server/worldmonitor/forecast/v1/service_server.ts',
      'src/generated/client/worldmonitor/forecast/v1/service_client.ts',
    ]) {
      assert.match(read(path), /\/\*\* @deprecated \*\/\n\s*projections\?: Projections;/, path);
    }
  });
});
