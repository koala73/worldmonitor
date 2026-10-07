// #8967: the unscored 24h/7d/30d projections are no longer part of the public
// forecast contract. Horizon scoring (#8939) still reads them from the
// seeder's history snapshot, which forecast-history.test.mjs covers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('forecast projections removed from the public contract (#8967)', () => {
  const proto = read('proto/worldmonitor/forecast/v1/forecast.proto');
  const forecastMessage = proto.slice(proto.indexOf('message Forecast {'));
  const forecastBody = forecastMessage.slice(0, forecastMessage.indexOf('\n}'));

  it('Forecast reserves field 17 and the projections name', () => {
    assert.match(forecastBody, /^\s*reserved 17;$/m);
    assert.match(forecastBody, /^\s*reserved "projections";$/m);
    assert.doesNotMatch(forecastBody, /\bprojections\s*=/);
  });

  it('the Projections message is gone', () => {
    assert.doesNotMatch(proto, /message Projections\b/);
  });

  it('the OpenAPI Forecast schema has no projections property', () => {
    const spec = JSON.parse(read('docs/api/ForecastService.openapi.json'));
    const forecast = spec.components.schemas.Forecast;
    assert.ok(forecast?.properties, 'Forecast schema present');
    assert.ok(!('projections' in forecast.properties));
    assert.ok(!('Projections' in spec.components.schemas));
  });

  it('the generated Forecast types have no projections field', () => {
    for (const path of [
      'src/generated/server/worldmonitor/forecast/v1/service_server.ts',
      'src/generated/client/worldmonitor/forecast/v1/service_client.ts',
    ]) {
      assert.doesNotMatch(read(path), /projections\??:|interface Projections\b/, path);
    }
  });
});
