import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

describe('forecast integrity and provenance surfaces', () => {
  it('labels simulation path confidence separately from event probability', () => {
    const src = read('src/components/ForecastPanel.ts');
    assert.match(src, /% confidence` : '—'/);
    assert.doesNotMatch(src, /p\.confidence \* 100\)}% probability/);
  });

  it('exposes degraded forecast backend state instead of empty success only', () => {
    const handler = read('server/worldmonitor/forecast/v1/get-forecasts.ts');
    const proto = read('proto/worldmonitor/forecast/v1/get_forecasts.proto');

    assert.match(proto, /bool degraded = 3;/);
    assert.match(proto, /bool stale = 4;/);
    assert.match(proto, /string error = 5;/);
    assert.match(handler, /getRawJson\(REDIS_KEY\)/);
    assert.match(handler, /degraded:\s*true/);
    assert.match(handler, /error:\s*'forecast_backend_unavailable'/);
  });

  it('documents market calibration limits and projection clamp heuristics', () => {
    const docs = read('docs/panels/forecast.mdx');
    const seeder = read('scripts/seed-forecasts.mjs');

    assert.doesNotMatch(docs, /probability-calibrated/);
    assert.match(docs, /market-calibrated only when/);
    assert.match(docs, /calibration: null/);
    assert.match(docs, /1% floor and 95% cap/);
    assert.match(seeder, /const PROJECTION_PROBABILITY_FLOOR = 0\.01;/);
    assert.match(seeder, /const PROJECTION_PROBABILITY_CAP = 0\.95;/);
  });
});
