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

function formatProbabilityFixed(value) {
  return value.toFixed(2);
}

function formatSignedProbability(value) {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}`;
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
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
    const conflictBaseMax = parseNumericConst(seeder, 'CONFLICT_BASE_DETECTOR_PROB_MAX');
    const ucdpConflictZoneMax = parseNumericConst(seeder, 'UCDP_CONFLICT_ZONE_PROB_MAX');
    const velocitySpikeLift = parseNumericConst(seeder, 'VELOCITY_SPIKE_PROBABILITY_LIFT');
    const velocitySpikeMax = parseNumericConst(seeder, 'VELOCITY_SPIKE_PROBABILITY_MAX');
    const defensePressureLift = parseNumericConst(seeder, 'DEFENSE_DIRECT_CONFIRMATION_PRESSURE_LIFT');
    const defenseConfidenceLift = parseNumericConst(seeder, 'DEFENSE_DIRECT_CONFIRMATION_CONFIDENCE_LIFT');
    const defenseAbsentConfidencePenalty = parseNumericConst(seeder, 'DEFENSE_ABSENT_CONFIRMATION_CONFIDENCE_PENALTY');

    assert.doesNotMatch(docs, /probability-calibrated/);
    assert.match(docs, /deterministic, rule-based signal detectors/);
    assert.match(docs, /LLM calls do not set the numeric probability/);
    assert.match(docs, /Groq `llama-3\.1-8b-instant`/);
    assert.match(docs, /OpenRouter `google\/gemini-2\.5-flash`/);
    assert.match(docs, /market-calibrated only when/);
    assert.match(docs, /calibration: null/);
    assert.doesNotMatch(docs, /Conflict base detector probability ceiling \| 0\.90/);
    assert.ok(
      docs.includes(`| Conflict base detector probability ceiling (before velocity spike) | ${formatProbabilityFixed(conflictBaseMax)} |`),
      `forecast panel doc must disclose conflict base detector cap from CONFLICT_BASE_DETECTOR_PROB_MAX=${conflictBaseMax}`,
    );
    assert.ok(
      docs.includes(`| UCDP conflict-zone base probability ceiling (before velocity spike) | ${formatProbabilityFixed(ucdpConflictZoneMax)} |`),
      `forecast panel doc must disclose UCDP conflict-zone cap from UCDP_CONFLICT_ZONE_PROB_MAX=${ucdpConflictZoneMax}`,
    );
    assert.ok(
      docs.includes(`| Conflict velocity-spike override ceiling | ${formatProbabilityFixed(velocitySpikeMax)} |`),
      `forecast panel doc must disclose velocity-spike ceiling from VELOCITY_SPIKE_PROBABILITY_MAX=${velocitySpikeMax}`,
    );
    assert.ok(
      docs.includes(`adds a \`${formatSignedProbability(velocitySpikeLift)}\` probability override after the base cap`),
      `forecast panel doc must disclose velocity-spike lift from VELOCITY_SPIKE_PROBABILITY_LIFT=${velocitySpikeLift}`,
    );
    assert.match(docs, /Market probability ceiling \| 0\.85/);
    assert.match(docs, /Supply-chain \/ maritime probability ceiling \| 0\.85/);
    assert.match(docs, /GPS supply-chain detector probability ceiling \| 0\.60/);
    assert.match(docs, /Political probability ceiling \| 0\.80/);
    assert.match(docs, /Military probability ceiling \| 0\.90/);
    assert.match(docs, /Infrastructure probability ceiling \| 0\.85/);
    assert.match(seeder, /Math\.min\(CYBER_PROB_MAX,/);
    assert.match(seeder, /Math\.min\(CONFLICT_BASE_DETECTOR_PROB_MAX,/);
    assert.match(seeder, /Math\.min\(UCDP_CONFLICT_ZONE_PROB_MAX,/);
    assert.equal(
      countMatches(seeder, /Math\.min\(VELOCITY_SPIKE_PROBABILITY_MAX,\s*prob \+ VELOCITY_SPIKE_PROBABILITY_LIFT\)/g),
      2,
      'forecast seeder must apply the shared velocity-spike max/lift in both conflict detectors',
    );
    assert.match(docs, /Market-bucket scenario calibration is an editorial calibration layer/);
    assert.match(docs, /Defense.*0\.12/);
    assert.ok(
      docs.includes(`each unit of direct \`defense_repricing\` confirmation adds \`${formatSignedProbability(defensePressureLift)}\` pressure and \`${formatSignedProbability(defenseConfidenceLift)}\` confidence`),
      'forecast panel doc must disclose direct defense_repricing pressure and confidence lifts',
    );
    assert.ok(
      docs.includes(`confidence subtracts a separate \`${formatProbabilityFixed(defenseAbsentConfidencePenalty)}\` absence penalty`),
      'forecast panel doc must distinguish the extra confidence penalty from the table-driven pressure dampener',
    );
    assert.match(docs, /1% floor and 95% cap/);
    assert.match(seeder, /const PROJECTION_PROBABILITY_FLOOR = 0\.01;/);
    assert.match(seeder, /const PROJECTION_PROBABILITY_CAP = 0\.95;/);
    assert.ok(
      docs.includes(`| Cyber probability ceiling | ${formatProbability(cyberProbMax)} |`),
      `forecast panel doc must derive cyber ceiling from CYBER_PROB_MAX=${cyberProbMax}`,
    );
  });
});
