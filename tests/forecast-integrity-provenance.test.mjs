import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

function parseNumericConst(source, name) {
  const match = source.match(new RegExp(`const ${name} = ([0-9.]+);`));
  assert.ok(match, `${name} declaration not found`);
  return Number(match[1]);
}

function formatProbability(value) {
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

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

  it('does not repeat backend-unavailable detail in degraded forecast notices', () => {
    const src = read('src/components/ForecastPanel.ts');

    assert.match(src, /const errorDetail = this\.sourceState\.degraded \? '' : this\.sourceState\.error\.replace/);
    assert.doesNotMatch(src, /this\.sourceState\.error \? this\.sourceState\.error\.replace/);
  });

  it('keeps client request failures distinct from backend degradation', () => {
    const dataLoader = read('src/app/data-loader.ts');
    const forecastService = read('src/services/forecast.ts');

    assert.match(dataLoader, /degraded:\s*false,\n\s*stale:\s*false,\n\s*error:\s*'forecast_request_failed'/);
    assert.match(forecastService, /export async function fetchForecastFeed/);
    assert.doesNotMatch(forecastService, /export async function fetchForecasts/);
  });

  it('documents market calibration limits and projection clamp heuristics', () => {
    const docs = read('docs/panels/forecast.mdx');
    const seeder = read('scripts/seed-forecasts.mjs');
    const cyberProbMax = parseNumericConst(seeder, 'CYBER_PROB_MAX');

    assert.doesNotMatch(docs, /probability-calibrated/);
    assert.match(docs, /deterministic, rule-based signal detectors/);
    assert.match(docs, /LLM calls do not set the numeric probability/);
    assert.match(docs, /Groq `llama-3\.1-8b-instant`/);
    assert.match(docs, /OpenRouter `google\/gemini-2\.5-flash`/);
    assert.match(docs, /market-calibrated only when/);
    assert.match(docs, /calibration: null/);
    assert.match(docs, /Conflict base detector probability ceiling \| 0\.90/);
    assert.match(docs, /Market probability ceiling \| 0\.85/);
    assert.match(docs, /Supply-chain \/ maritime probability ceiling \| 0\.85/);
    assert.match(docs, /GPS supply-chain detector probability ceiling \| 0\.60/);
    assert.match(docs, /Political probability ceiling \| 0\.80/);
    assert.match(docs, /Military probability ceiling \| 0\.90/);
    assert.match(docs, /Infrastructure probability ceiling \| 0\.85/);
    assert.match(seeder, /Math\.min\(CYBER_PROB_MAX,/);
    assert.match(docs, /Market-bucket scenario calibration is an editorial calibration layer/);
    assert.match(docs, /Defense.*0\.12/);
    assert.match(docs, /1% floor and 95% cap/);
    assert.match(seeder, /const PROJECTION_PROBABILITY_FLOOR = 0\.01;/);
    assert.match(seeder, /const PROJECTION_PROBABILITY_CAP = 0\.95;/);
    assert.ok(
      docs.includes(`| Cyber probability ceiling | ${formatProbability(cyberProbMax)} |`),
      `forecast panel doc must derive cyber ceiling from CYBER_PROB_MAX=${cyberProbMax}`,
    );
  });
});
