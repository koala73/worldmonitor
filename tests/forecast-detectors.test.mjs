import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  forecastId,
  forecastIdFromKey,
  buildStateDerivedForecast,
  normalize,
  makePrediction,
  resolveCascades,
  calibrateWithMarkets,
  computeTrends,
  detectConflictScenarios,
  detectMarketScenarios,
  detectSupplyChainScenarios,
  detectPoliticalScenarios,
  detectMilitaryScenarios,
  detectInfraScenarios,
  detectUcdpConflictZones,
  detectCyberScenarios,
  detectGpsJammingScenarios,
  detectFromPredictionMarkets,
  getFreshMilitaryForecastInputs,
  normalizeChokepoints,
  normalizeGpsJamming,
  loadEntityGraph,
  discoverGraphCascades,
  attachNewsContext,
  computeConfidence,
  computeHeadlineRelevance,
  computeMarketMatchScore,
  getSearchTermsForRegion,
  sanitizeForPrompt,
  parseLLMScenarios,
  validateScenarios,
  validatePerspectives,
  validateCaseNarratives,
  computeProjections,
  buildUserPrompt,
  buildForecastCase,
  buildForecastCases,
  buildPriorForecastSnapshot,
  buildPublishedForecastPayload,
  buildPublishedSeedPayload,
  buildChangeItems,
  buildChangeSummary,
  annotateForecastChanges,
  buildCounterEvidence,
  buildCaseTriggers,
  buildForecastActors,
  buildForecastWorldState,
  buildForecastRunWorldState,
  buildForecastBranches,
  buildActorLenses,
  scoreForecastReadiness,
  computeAnalysisPriority,
  rankForecastsForAnalysis,
  selectPublishedForecastPool,
  selectDeferredForecastForPublishBackfill,
  buildPublishedForecastArtifacts,
  filterPublishedForecasts,
  applySituationFamilyCaps,
  selectForecastsForEnrichment,
  parseForecastProviderOrder,
  getForecastLlmCallOptions,
  resolveForecastLlmProviders,
  __callForecastLlmForTests,
  buildFallbackScenario,
  buildFallbackBaseCase,
  buildFallbackEscalatoryCase,
  buildFallbackContrarianCase,
  buildFeedSummary,
  buildFallbackPerspectives,
  populateFallbackNarratives,
  refreshPublishedNarratives,
  extractImpactExpansionBundle,
  loadCascadeRules,
  evaluateRuleConditions,
  summarizePublishFiltering,
  SIGNAL_TO_SOURCE,
  PREDICATE_EVALUATORS,
  DEFAULT_CASCADE_RULES,
  PROJECTION_CURVES,
  __setForecastLlmCallOverrideForTests,
  __setForecastLlmTransportForTests,
  __setForecastLlmRunDeadlineForTests,
} from '../scripts/seed-forecasts.mjs';
import { CONFLICT_COUNT_SOURCE_FEED } from '../scripts/_forecast-resolution.mjs';

const originalForecastEnv = {
  FORECAST_LLM_PROVIDER_ORDER: process.env.FORECAST_LLM_PROVIDER_ORDER,
  FORECAST_LLM_COMBINED_PROVIDER_ORDER: process.env.FORECAST_LLM_COMBINED_PROVIDER_ORDER,
  FORECAST_LLM_MODEL_OPENROUTER: process.env.FORECAST_LLM_MODEL_OPENROUTER,
  FORECAST_LLM_COMBINED_MODEL_OPENROUTER: process.env.FORECAST_LLM_COMBINED_MODEL_OPENROUTER,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

afterEach(() => {
  __setForecastLlmCallOverrideForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
  for (const [key, value] of Object.entries(originalForecastEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('forecastId', () => {
  it('same inputs produce same ID', () => {
    const a = forecastId('conflict', 'Iran', 'Escalation risk');
    const b = forecastId('conflict', 'Iran', 'Escalation risk');
    assert.equal(a, b);
  });

  it('different inputs produce different IDs', () => {
    const a = forecastId('conflict', 'Iran', 'Escalation risk');
    const b = forecastId('market', 'Iran', 'Oil price shock');
    assert.notEqual(a, b);
  });

  it('ID format is fc-{domain}-{8char_hex}', () => {
    const id = forecastId('conflict', 'Middle East', 'Theater escalation');
    assert.match(id, /^fc-conflict-[0-9a-f]{8}$/);
  });

  it('domain is embedded in the ID', () => {
    const id = forecastId('market', 'Red Sea', 'Oil disruption');
    assert.ok(id.startsWith('fc-market-'));
  });
});

describe('normalize', () => {
  it('value at min returns 0', () => {
    assert.equal(normalize(50, 50, 100), 0);
  });

  it('value at max returns 1', () => {
    assert.equal(normalize(100, 50, 100), 1);
  });

  it('midpoint returns 0.5', () => {
    assert.equal(normalize(75, 50, 100), 0.5);
  });

  it('value below min clamps to 0', () => {
    assert.equal(normalize(10, 50, 100), 0);
  });

  it('value above max clamps to 1', () => {
    assert.equal(normalize(200, 50, 100), 1);
  });

  it('min === max returns 0', () => {
    assert.equal(normalize(50, 50, 50), 0);
  });

  it('min > max returns 0', () => {
    assert.equal(normalize(50, 100, 50), 0);
  });
});

describe('resolveCascades', () => {
  it('conflict near chokepoint creates supply_chain and market cascades', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.7, 0.6, '7d', [{ type: 'cii', value: 'Iran CII 85', weight: 0.4 }],
    );
    const predictions = [pred];
    resolveCascades(predictions, DEFAULT_CASCADE_RULES);
    const domains = pred.cascades.map(c => c.domain);
    assert.ok(domains.includes('supply_chain'), 'should have supply_chain cascade');
    assert.ok(domains.includes('market'), 'should have market cascade');
  });

  it('cascade probabilities capped at 0.8', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.99, 0.9, '7d', [{ type: 'cii', value: 'high', weight: 0.4 }],
    );
    resolveCascades([pred], DEFAULT_CASCADE_RULES);
    for (const c of pred.cascades) {
      assert.ok(c.probability <= 0.8, `cascade probability ${c.probability} should be <= 0.8`);
    }
  });

  it('deduplication within a single call: same rule does not fire twice for same source', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.7, 0.6, '7d', [{ type: 'cii', value: 'test', weight: 0.4 }],
    );
    resolveCascades([pred], DEFAULT_CASCADE_RULES);
    const keys = pred.cascades.map(c => `${c.domain}:${c.effect}`);
    const unique = new Set(keys);
    assert.equal(keys.length, unique.size, 'no duplicate cascade entries within one resolution');
  });

  it('no self-edges: cascade domain differs from source domain', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation',
      0.7, 0.6, '7d', [{ type: 'cii', value: 'test', weight: 0.4 }],
    );
    resolveCascades([pred], DEFAULT_CASCADE_RULES);
    for (const c of pred.cascades) {
      assert.notEqual(c.domain, pred.domain, `cascade domain ${c.domain} should differ from source ${pred.domain}`);
    }
  });

  it('political > 0.6 creates conflict cascade', () => {
    const pred = makePrediction(
      'political', 'Iran', 'Political instability',
      0.65, 0.5, '30d', [{ type: 'unrest', value: 'unrest', weight: 0.4 }],
    );
    resolveCascades([pred], DEFAULT_CASCADE_RULES);
    const domains = pred.cascades.map(c => c.domain);
    assert.ok(domains.includes('conflict'), 'political instability should cascade to conflict');
  });

  it('political <= 0.6 does not cascade to conflict', () => {
    const pred = makePrediction(
      'political', 'Iran', 'Political instability',
      0.5, 0.5, '30d', [{ type: 'unrest', value: 'unrest', weight: 0.4 }],
    );
    resolveCascades([pred], DEFAULT_CASCADE_RULES);
    assert.equal(pred.cascades.length, 0);
  });
});

describe('calibrateWithMarkets', () => {
  it('matching market adjusts probability with 40/60 blend', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation',
      0.7, 0.6, '7d', [],
    );
    pred.region = 'Middle East';
    const markets = {
      geopolitical: [{ title: 'Will Iran conflict escalate in MENA?', yesPrice: 30, source: 'polymarket', volume: 50000 }],
    };
    calibrateWithMarkets([pred], markets);
    const expected = +(0.4 * 0.3 + 0.6 * 0.7).toFixed(3);
    assert.equal(pred.probability, expected);
    assert.ok(pred.calibration !== null);
    assert.equal(pred.calibration.source, 'polymarket');
  });

  it('no match leaves probability unchanged', () => {
    const pred = makePrediction(
      'conflict', 'Korean Peninsula', 'Korea escalation',
      0.6, 0.5, '7d', [],
    );
    const originalProb = pred.probability;
    const markets = {
      geopolitical: [{ title: 'Will EU inflation drop?', yesPrice: 50, volume: 50000 }],
    };
    calibrateWithMarkets([pred], markets);
    assert.equal(pred.probability, originalProb);
    assert.equal(pred.calibration, null);
  });

  it('drift calculated correctly', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation',
      0.7, 0.6, '7d', [],
    );
    const markets = {
      geopolitical: [{ title: 'Iran MENA conflict?', yesPrice: 40, volume: 50000 }],
    };
    calibrateWithMarkets([pred], markets);
    assert.equal(pred.calibration.drift, +(0.7 - 0.4).toFixed(3));
  });

  it('does not calibrate escalation risk from a de-escalation YES market', () => {
    const pred = makePrediction(
      'conflict', 'Sudan', 'Escalation risk: Sudan',
      0.45, 0.6, '30d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will the Sudan conflict reach a ceasefire by Q3?', yesPrice: 85, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.45);
  });

  it('does not classify a temporal "end of" phrase as a failed ceasefire', () => {
    const pred = makePrediction(
      'conflict', 'Sudan', 'Escalation risk: Sudan',
      0.45, 0.6, '30d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will there be a ceasefire in Sudan by the end of 2026?', yesPrice: 85, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.45);
  });

  it('does not calibrate de-escalation risk from an adverse YES market', () => {
    const pred = makePrediction(
      'conflict', 'Sudan', 'Ceasefire holds in Sudan',
      0.6, 0.5, '7d', [{ type: 'ceasefire', value: 'ceasefire holds', weight: 0.4 }],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will the Sudan ceasefire fail by Q3?', yesPrice: 85, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.6);
  });

  it('calibrates an aligned de-escalation forecast with a de-escalation market', () => {
    const pred = makePrediction(
      'conflict', 'Sudan', 'Sudan de-escalation ceasefire forecast',
      0.55, 0.5, '7d', [{ type: 'de-escalation', value: 'Sudan de-escalate ceasefire diplomacy', weight: 0.4 }],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Sudan de-escalate into a ceasefire by 2026?', yesPrice: 80, source: 'polymarket', volume: 50000 }],
    });
    assert.ok(pred.calibration !== null);
    assert.equal(pred.probability, +(0.4 * 0.8 + 0.6 * 0.55).toFixed(3));
  });

  it('does not treat destabilize as a stabilizing outcome stem', () => {
    const pred = makePrediction(
      'conflict', 'Sudan', 'Escalation risk: Sudan',
      0.45, 0.6, '30d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Sudan destabilize further amid conflict?', yesPrice: 80, source: 'polymarket', volume: 50000 }],
    });
    assert.ok(pred.calibration !== null);
    assert.equal(pred.probability, +(0.4 * 0.8 + 0.6 * 0.45).toFixed(3));
  });

  it('does not calibrate de-escalation forecasts from adverse conjugations', () => {
    for (const title of [
      'Will Iran rejected nuclear deal terms by 2026?',
      'Will Iran nuclear deal violation occur by 2026?',
      'Will Iran nuclear deal breaches resume by 2026?',
    ]) {
      const pred = makePrediction(
        'conflict', 'Iran', 'Nuclear deal restored: Iran',
        0.55, 0.5, '7d', [{ type: 'agreement', value: 'nuclear deal restored', weight: 0.4 }],
      );
      calibrateWithMarkets([pred], {
        geopolitical: [{ title, yesPrice: 85, source: 'polymarket', volume: 50000 }],
      });
      assert.equal(pred.calibration, null, title);
      assert.equal(pred.probability, 0.55, title);
    }
  });

  it('treats an adverse condition ending as a de-escalatory YES outcome', () => {
    const pred = makePrediction(
      'conflict', 'Sudan', 'Escalation risk: Sudan',
      0.3, 0.6, '30d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will the Sudan war end in 2026?', yesPrice: 70, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.3);
  });

  it('does not calibrate from a low-liquidity market', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.5, 0.6, '7d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Iran conflict escalate in MENA?', yesPrice: 95, source: 'polymarket', volume: 20 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.5);
  });

  it('re-applies the domain cap after market calibration', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.85, 0.6, '7d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Iran conflict escalate in MENA?', yesPrice: 99, source: 'polymarket', volume: 50000 }],
    });
    assert.ok(pred.calibration !== null);
    assert.equal(pred.probability, 0.9);
  });

  it('does not record calibration metadata when a cap makes the blend a no-op', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.9, 0.6, '7d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Iran conflict escalate in MENA?', yesPrice: 96, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.9);
  });

  it('applies explicit post-blend caps to non-conflict domains', () => {
    const pred = makePrediction(
      'political', 'Iran', 'Political instability: Iran',
      0.78, 0.6, '7d', [],
    );
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Iran political unrest escalate in 2026?', yesPrice: 99, source: 'polymarket', volume: 50000 }],
    });
    assert.ok(pred.calibration !== null);
    assert.equal(pred.probability, 0.8);
  });

  it('null markets handled gracefully', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Test', 0.5, 0.5, '7d', []);
    calibrateWithMarkets([pred], null);
    assert.equal(pred.calibration, null);
  });

  it('empty markets handled gracefully', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Test', 0.5, 0.5, '7d', []);
    calibrateWithMarkets([pred], {});
    assert.equal(pred.calibration, null);
  });

  it('markets without geopolitical key handled gracefully', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Test', 0.5, 0.5, '7d', []);
    calibrateWithMarkets([pred], { crypto: [] });
    assert.equal(pred.calibration, null);
  });

  it('does not calibrate from unrelated same-region macro market', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.7, 0.6, '7d', [],
    );
    const markets = {
      geopolitical: [{ title: 'Will Netanyahu remain prime minister through 2026?', yesPrice: 20, source: 'polymarket', volume: 100000 }],
    };
    calibrateWithMarkets([pred], markets);
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.7);
  });

  it('does not calibrate commodity forecasts from loosely related regional conflict markets', () => {
    const pred = makePrediction(
      'market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption',
      0.668, 0.58, '30d', [],
    );
    const markets = {
      geopolitical: [{ title: 'Will Israel launch a major ground offensive in Lebanon by March 31?', yesPrice: 57, source: 'polymarket', volume: 100000 }],
    };
    calibrateWithMarkets([pred], markets);
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.668);
  });
});

describe('word-boundary term matching: no substring false positives (#4933)', () => {
  it('calibrateWithMarkets: Mali forecast is not calibrated by a Somalia market', () => {
    const pred = makePrediction('political', 'Mali', 'Political instability: Mali', 0.7, 0.6, '30d', []);
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: "Will Somalia's government collapse in 2026?", yesPrice: 30, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.7);
  });

  it('calibrateWithMarkets: Niger forecast is not calibrated by a Nigeria market', () => {
    const pred = makePrediction('political', 'Niger', 'Political instability: Niger', 0.7, 0.6, '30d', []);
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Nigeria hold peaceful elections in 2026?', yesPrice: 80, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.7);
  });

  it('detectInfraScenarios: Somalia cyber threat does not boost a Mali outage', () => {
    const preds = detectInfraScenarios({
      outages: [{ country: 'Mali', severity: 'major' }],
      cyberThreats: [{ country: 'Somalia', type: 'ddos' }],
      gpsJamming: [],
    });
    assert.equal(preds.length, 1);
    assert.equal(preds[0].probability, 0.4);
    assert.deepEqual(preds[0].signals.map(s => s.type), ['outage']);
  });

  it('detectInfraScenarios: same-country cyber threat still boosts (positive control)', () => {
    const preds = detectInfraScenarios({
      outages: [{ country: 'Mali', severity: 'major' }],
      cyberThreats: [{ country: 'Mali', type: 'ddos' }],
      gpsJamming: [],
    });
    assert.equal(preds[0].probability, 0.55);
    assert.ok(preds[0].signals.some(s => s.type === 'cyber'));
  });

  it('detectInfraScenarios: possessive form still matches across the boundary', () => {
    const preds = detectInfraScenarios({
      outages: [{ country: 'Mali', severity: 'major' }],
      cyberThreats: [{ target: "Mali's banking sector", type: 'ddos' }],
      gpsJamming: [],
    });
    assert.ok(preds[0].signals.some(s => s.type === 'cyber'));
  });

  it('detectPoliticalScenarios: Nigeria protest anomaly does not boost a Niger forecast', () => {
    const preds = detectPoliticalScenarios({
      ciiScores: [{ code: 'NE', name: 'Niger', score: 70, level: 'high', trend: 'rising', components: { unrest: 60 } }],
      unrestEvents: [],
      temporalAnomalies: [{ type: 'protest', country: 'Nigeria', zScore: 3.2 }],
    });
    assert.equal(preds.length, 1);
    assert.ok(!preds[0].signals.some(s => s.type === 'anomaly'));
  });

  it('detectPoliticalScenarios: same-country protest anomaly still boosts (positive control)', () => {
    const preds = detectPoliticalScenarios({
      ciiScores: [{ code: 'NE', name: 'Niger', score: 70, level: 'high', trend: 'rising', components: { unrest: 60 } }],
      unrestEvents: [],
      temporalAnomalies: [{ type: 'protest', country: 'Niger', zScore: 3.2 }],
    });
    assert.ok(preds[0].signals.some(s => s.type === 'anomaly'));
  });

  it('detectSupplyChainScenarios: route name nested in another word does not attach AIS signals', () => {
    const preds = detectSupplyChainScenarios({
      chokepoints: { routes: [{ route: 'Suez', riskScore: 80 }] },
      temporalAnomalies: [{ type: 'ais_gaps', region: 'Suezmax anchorage zone' }],
      gpsJamming: [],
    });
    assert.equal(preds.length, 1);
    assert.ok(!preds[0].signals.some(s => s.type === 'ais_gap'));
  });

  it('detectSupplyChainScenarios: route name as a standalone word still matches (positive control)', () => {
    const preds = detectSupplyChainScenarios({
      chokepoints: { routes: [{ route: 'Suez', riskScore: 80 }] },
      temporalAnomalies: [{ type: 'ais_gaps', region: 'Suez canal north entrance' }],
      gpsJamming: [],
    });
    assert.ok(preds[0].signals.some(s => s.type === 'ais_gap'));
  });

  it('detectMilitaryScenarios: theater name nested in another word does not attach flight anomalies', () => {
    const now = Date.now();
    const preds = detectMilitaryScenarios({
      militaryForecastInputs: {
        fetchedAt: now,
        theaters: [{ id: 'sahel-theater', name: 'Mali', postureLevel: 'elevated', assessedAt: now }],
        surges: [],
      },
      temporalAnomalies: [{ type: 'military_flights', region: 'Somalia border strip', zScore: 3.0 }],
    });
    assert.equal(preds.length, 1);
    assert.ok(!preds[0].signals.some(s => s.type === 'mil_flights'));
  });

  it('detectMilitaryScenarios: same-theater flight anomaly still attaches (positive control)', () => {
    const now = Date.now();
    const preds = detectMilitaryScenarios({
      militaryForecastInputs: {
        fetchedAt: now,
        theaters: [{ id: 'sahel-theater', name: 'Mali', postureLevel: 'elevated', assessedAt: now }],
        surges: [],
      },
      temporalAnomalies: [{ type: 'military_flights', region: 'Mali airspace', zScore: 3.0 }],
    });
    assert.ok(preds[0].signals.some(s => s.type === 'mil_flights'));
  });

  it('computeMarketMatchScore: "Iran" title token does not hit inside "Tirana"', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Escalation risk: Iran', 0.7, 0.6, '7d', []);
    const score = computeMarketMatchScore(pred, 'Will Tirana host the 2027 summit?', ['middle east']);
    assert.equal(score.titleHits, 0);
  });

  it('computeMarketMatchScore: exact "Iran" title token still hits (positive control)', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Escalation risk: Iran', 0.7, 0.6, '7d', []);
    const score = computeMarketMatchScore(pred, 'Will Iran strike back in 2026?', ['middle east']);
    assert.ok(score.titleHits >= 1);
  });

  it('computeMarketMatchScore: multi-word region term still matches across word boundaries', () => {
    const pred = makePrediction('market', 'Middle East', 'Oil disruption', 0.6, 0.5, '7d', []);
    const score = computeMarketMatchScore(pred, 'Will the Strait of Hormuz close in 2026?', ['strait of hormuz']);
    assert.ok(score.regionHits >= 1);
  });

  it('getSearchTermsForRegion: Somalia does not inherit Mali terms via reverse substring lookup', () => {
    const terms = getSearchTermsForRegion('Somalia').map(t => t.toLowerCase());
    assert.ok(!terms.includes('bamako'), `Somalia terms leaked Mali keywords: ${terms.join(', ')}`);
    assert.ok(!terms.some(t => t === 'mali'), `Somalia terms leaked Mali name: ${terms.join(', ')}`);
    assert.ok(terms.includes('mogadishu'), `Somalia lost its own keywords to the substring break: ${terms.join(', ')}`);
  });

  it('getSearchTermsForRegion: Nigeria does not inherit Niger terms via reverse substring lookup', () => {
    const terms = getSearchTermsForRegion('Nigeria').map(t => t.toLowerCase());
    assert.ok(!terms.includes('niamey'), `Nigeria terms leaked Niger keywords: ${terms.join(', ')}`);
    assert.ok(!terms.some(t => t === 'niger'), `Nigeria terms leaked Niger name: ${terms.join(', ')}`);
  });

  it('getSearchTermsForRegion: parenthetical suffix regions still resolve (positive control)', () => {
    const terms = getSearchTermsForRegion('Myanmar (Burma)').map(t => t.toLowerCase());
    assert.ok(terms.includes('myanmar'));
  });

  it('calibrateWithMarkets: Nigeria forecast is not calibrated by a Niger market (reverse-lookup poisoning)', () => {
    const pred = makePrediction('political', 'Nigeria', 'Political instability: Nigeria', 0.7, 0.6, '30d', []);
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: "Will Niger's junta lose power in 2026?", yesPrice: 30, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.7);
  });

  it('computeHeadlineRelevance: "war" hint does not hit inside "award", "iran" token not inside "Tirana"', () => {
    const score = computeHeadlineRelevance('Award season kicks off in Tirana', [], 'conflict', {
      titleTokens: ['iran'],
      requireSemantic: true,
    });
    assert.equal(score, 0);
  });

  it('computeHeadlineRelevance: exact domain hint and title token still score (positive control)', () => {
    const score = computeHeadlineRelevance('War fears grow as Iran mobilizes reservists', ['iran'], 'conflict', {
      titleTokens: ['iran'],
      requireSemantic: true,
    });
    assert.ok(score > 0);
  });

  it('computeHeadlineRelevance: plural form of a domain hint still scores (attacks vs attack)', () => {
    const score = computeHeadlineRelevance('Missile attacks intensify near border', [], 'conflict', {
      requireSemantic: true,
    });
    assert.ok(score > 0);
  });

  it('calibrateWithMarkets: plural domain hint still calibrates (elections vs election)', () => {
    const pred = makePrediction('political', 'Nigeria', 'Political instability: Nigeria', 0.7, 0.6, '30d', []);
    calibrateWithMarkets([pred], {
      // Keep this title adverse-aligned; a peaceful-election market is now rejected by the direction guard.
      geopolitical: [{ title: 'Will Nigeria elections trigger unrest in 2026?', yesPrice: 80, source: 'polymarket', volume: 50000 }],
    });
    assert.ok(pred.calibration !== null);
    assert.equal(pred.probability, +(0.4 * 0.8 + 0.6 * 0.7).toFixed(3));
  });

  it('getSearchTermsForRegion: DR Congo resolves to DR Congo, not Congo-Brazzaville', () => {
    const terms = getSearchTermsForRegion('DR Congo').map(t => t.toLowerCase());
    assert.ok(!terms.includes('brazzaville'), `DR Congo leaked Congo-Brazzaville terms: ${terms.join(', ')}`);
    assert.ok(terms.includes('kinshasa'), `DR Congo lost its own keywords: ${terms.join(', ')}`);
  });

  it('getSearchTermsForRegion: Guinea-Bissau does not inherit Guinea/Conakry terms', () => {
    const terms = getSearchTermsForRegion('Guinea-Bissau').map(t => t.toLowerCase());
    assert.ok(!terms.includes('conakry'), `Guinea-Bissau leaked Guinea terms: ${terms.join(', ')}`);
    assert.ok(terms.includes('guinea-bissau'));
  });

  it('getSearchTermsForRegion: Papua New Guinea does not inherit Guinea/Conakry terms', () => {
    const terms = getSearchTermsForRegion('Papua New Guinea').map(t => t.toLowerCase());
    assert.ok(!terms.includes('conakry'), `Papua New Guinea leaked Guinea terms: ${terms.join(', ')}`);
  });

  it('computeMarketMatchScore: "war" hint does not hit inside "wares" (es only after sibilants)', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Escalation risk: Iran', 0.7, 0.6, '7d', []);
    const score = computeMarketMatchScore(pred, 'Will Iran export more wares in 2026?', ['iran', 'middle east']);
    assert.equal(score.domainHits, 0);
  });

  it('calibrateWithMarkets: Iran conflict forecast not calibrated by an unrelated wares market', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Escalation risk: Iran', 0.7, 0.6, '7d', []);
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Iran export more wares in 2026?', yesPrice: 30, source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.7);
  });

  it('computeMarketMatchScore: sibilant plural still matches ("gas" hint vs "gases")', () => {
    const pred = makePrediction('market', 'Europe', 'Energy price shock: Europe', 0.6, 0.5, '7d', []);
    const score = computeMarketMatchScore(pred, 'Will greenhouse gases regulation raise Europe energy prices?', ['europe']);
    assert.ok(score.domainHits >= 1);
  });
});

describe('non-finite probability guards (#4933)', () => {
  it('makePrediction: NaN probability is coerced to a finite value, never serialized as null', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Test', NaN, 0.5, '7d', []);
    assert.ok(Number.isFinite(pred.probability), `probability is ${pred.probability}`);
    assert.equal(JSON.parse(JSON.stringify(pred)).probability, pred.probability);
  });

  it('makePrediction: undefined probability and NaN confidence are coerced to finite values', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Test', undefined, NaN, '7d', []);
    assert.ok(Number.isFinite(pred.probability));
    assert.ok(Number.isFinite(pred.confidence));
  });

  it('detectFromPredictionMarkets: non-numeric yesPrice row is skipped, not published with NaN', () => {
    const preds = detectFromPredictionMarkets({
      predictionMarkets: {
        geopolitical: [{ title: 'Will Iran attack escalate in 2026?', yesPrice: 'oops', source: 'polymarket' }],
      },
    });
    assert.equal(preds.length, 0);
  });

  it('detectFromPredictionMarkets: finite yesPrice in band still emits (positive control)', () => {
    const preds = detectFromPredictionMarkets({
      predictionMarkets: {
        geopolitical: [{ title: 'Will Iran attack escalate in 2026?', yesPrice: 75, source: 'polymarket' }],
      },
    });
    assert.equal(preds.length, 1);
    assert.equal(preds[0].probability, 0.75);
  });

  it('calibrateWithMarkets: matching market with a non-finite price is skipped, not anchored at 50%', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Escalation', 0.7, 0.6, '7d', []);
    calibrateWithMarkets([pred], {
      geopolitical: [{ title: 'Will Iran conflict escalate in MENA?', source: 'polymarket', volume: 50000 }],
    });
    assert.equal(pred.calibration, null);
    assert.equal(pred.probability, 0.7);
  });
});

describe('computeTrends', () => {
  it('no prior: all trends set to stable', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.6, 0.5, '7d', []);
    computeTrends([pred], null);
    assert.equal(pred.trend, 'stable');
    assert.equal(pred.priorProbability, pred.probability);
  });

  it('rising: delta > 0.05', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.7, 0.5, '7d', []);
    const prior = { predictions: [{ id: pred.id, probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'rising');
    assert.equal(pred.priorProbability, 0.5);
  });

  it('falling: delta < -0.05', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.3, 0.5, '7d', []);
    const prior = { predictions: [{ id: pred.id, probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'falling');
  });

  it('stable: delta within +/- 0.05', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.52, 0.5, '7d', []);
    const prior = { predictions: [{ id: pred.id, probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'stable');
  });

  it('new prediction (no prior match): stable', () => {
    const pred = makePrediction('conflict', 'Iran', 'Brand new', 0.6, 0.5, '7d', []);
    const prior = { predictions: [{ id: 'fc-conflict-00000000', probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'stable');
    assert.equal(pred.priorProbability, pred.probability);
  });

  it('prior with empty predictions array: all stable', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.6, 0.5, '7d', []);
    computeTrends([pred], { predictions: [] });
    assert.equal(pred.trend, 'stable');
  });

  it('just above +0.05 threshold: rising', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.56, 0.5, '7d', []);
    const prior = { predictions: [{ id: pred.id, probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'rising');
  });

  it('just below -0.05 threshold: falling', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.44, 0.5, '7d', []);
    const prior = { predictions: [{ id: pred.id, probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'falling');
  });

  it('delta exactly at boundary: uses strict comparison (> 0.05)', () => {
    const pred = makePrediction('conflict', 'Iran', 'Test', 0.549, 0.5, '7d', []);
    const prior = { predictions: [{ id: pred.id, probability: 0.5 }] };
    computeTrends([pred], prior);
    assert.equal(pred.trend, 'stable');
  });
});

describe('detector smoke tests: null/empty inputs', () => {
  it('detectConflictScenarios({}) returns []', () => {
    assert.deepEqual(detectConflictScenarios({}), []);
  });

  it('detectMarketScenarios({}) returns []', () => {
    assert.deepEqual(detectMarketScenarios({}), []);
  });

  it('detectSupplyChainScenarios({}) returns []', () => {
    assert.deepEqual(detectSupplyChainScenarios({}), []);
  });

  it('detectPoliticalScenarios({}) returns []', () => {
    assert.deepEqual(detectPoliticalScenarios({}), []);
  });

  it('detectMilitaryScenarios({}) returns []', () => {
    assert.deepEqual(detectMilitaryScenarios({}), []);
  });

  it('detectInfraScenarios({}) returns []', () => {
    assert.deepEqual(detectInfraScenarios({}), []);
  });

  it('detectors handle null arrays gracefully', () => {
    const inputs = {
      ciiScores: null,
      temporalAnomalies: null,
      theaterPosture: null,
      chokepoints: null,
      iranEvents: null,
      ucdpEvents: null,
      unrestEvents: null,
      outages: null,
      cyberThreats: null,
      gpsJamming: null,
    };
    assert.deepEqual(detectConflictScenarios(inputs), []);
    assert.deepEqual(detectMarketScenarios(inputs), []);
    assert.deepEqual(detectSupplyChainScenarios(inputs), []);
    assert.deepEqual(detectPoliticalScenarios(inputs), []);
    assert.deepEqual(detectMilitaryScenarios(inputs), []);
    assert.deepEqual(detectInfraScenarios(inputs), []);
  });
});

describe('detectConflictScenarios', () => {
  it('high CII rising score produces conflict prediction', () => {
    const inputs = {
      ciiScores: [{ code: 'IRN', name: 'Iran', score: 85, level: 'high', trend: 'rising' }],
      theaterPosture: { theaters: [] },
      iranEvents: [],
      ucdpEvents: [],
    };
    const result = detectConflictScenarios(inputs);
    assert.ok(result.length >= 1);
    assert.equal(result[0].domain, 'conflict');
    assert.ok(result[0].probability > 0);
    assert.ok(result[0].probability <= 0.9);
  });

  it('low CII score is ignored', () => {
    const inputs = {
      ciiScores: [{ code: 'CHE', name: 'Switzerland', score: 30, level: 'low', trend: 'stable' }],
      theaterPosture: { theaters: [] },
      iranEvents: [],
      ucdpEvents: [],
    };
    assert.deepEqual(detectConflictScenarios(inputs), []);
  });

  it('critical theater posture produces prediction', () => {
    const inputs = {
      ciiScores: [],
      theaterPosture: { theaters: [{ id: 'iran-theater', name: 'Iran Theater', postureLevel: 'critical' }] },
      iranEvents: [],
      ucdpEvents: [],
    };
    const result = detectConflictScenarios(inputs);
    assert.ok(result.length >= 1);
    assert.equal(result[0].region, 'Middle East');
  });

  it('accepts theater posture entries that use theater instead of id', () => {
    const inputs = {
      ciiScores: [],
      theaterPosture: { theaters: [{ theater: 'taiwan-theater', name: 'Taiwan Theater', postureLevel: 'elevated' }] },
      iranEvents: [],
      ucdpEvents: [],
    };
    const result = detectConflictScenarios(inputs);
    assert.ok(result.length >= 1);
    assert.equal(result[0].region, 'Western Pacific');
  });
});

describe('detectMarketScenarios', () => {
  it('high-risk chokepoint with known commodity produces market prediction', () => {
    const inputs = {
      chokepoints: { routes: [{ region: 'Middle East', riskLevel: 'critical', riskScore: 85 }] },
      ciiScores: [],
    };
    const result = detectMarketScenarios(inputs);
    assert.ok(result.length >= 1);
    assert.equal(result[0].domain, 'market');
    assert.ok(result[0].title.includes('Oil'));
  });

  it('maps live chokepoint names to market-sensitive regions', () => {
    const inputs = {
      chokepoints: { chokepoints: [{ name: 'Strait of Hormuz', region: 'Strait of Hormuz', riskLevel: 'critical', riskScore: 80 }] },
      ciiScores: [],
    };
    const result = detectMarketScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'market');
    assert.equal(result[0].region, 'Middle East');
    assert.match(result[0].title, /Hormuz/);
  });

  it('low-risk chokepoint is ignored', () => {
    const inputs = {
      chokepoints: { routes: [{ region: 'Middle East', riskLevel: 'low', riskScore: 30 }] },
      ciiScores: [],
    };
    assert.deepEqual(detectMarketScenarios(inputs), []);
  });
});

describe('detectInfraScenarios', () => {
  it('major outage produces infra prediction', () => {
    const inputs = {
      outages: [{ country: 'Syria', severity: 'major' }],
      cyberThreats: [],
      gpsJamming: [],
    };
    const result = detectInfraScenarios(inputs);
    assert.ok(result.length >= 1);
    assert.equal(result[0].domain, 'infrastructure');
    assert.ok(result[0].title.includes('Syria'));
  });

  it('minor outage is ignored', () => {
    const inputs = {
      outages: [{ country: 'Test', severity: 'minor' }],
      cyberThreats: [],
      gpsJamming: [],
    };
    assert.deepEqual(detectInfraScenarios(inputs), []);
  });

  it('cyber threats boost probability', () => {
    const base = {
      outages: [{ country: 'Syria', severity: 'total' }],
      cyberThreats: [],
      gpsJamming: [],
    };
    const withCyber = {
      outages: [{ country: 'Syria', severity: 'total' }],
      cyberThreats: [{ country: 'Syria', type: 'ddos' }],
      gpsJamming: [],
    };
    const baseResult = detectInfraScenarios(base);
    const cyberResult = detectInfraScenarios(withCyber);
    assert.ok(cyberResult[0].probability > baseResult[0].probability,
      'cyber threats should boost probability');
  });
});

describe('detectPoliticalScenarios', () => {
  it('uses geoConvergence when unrest-specific fields are absent or zero', () => {
    const inputs = {
      ciiScores: {
        ciiScores: [{
          region: 'IL',
          combinedScore: 69,
          trend: 'TREND_DIRECTION_STABLE',
          components: { ciiContribution: 0, geoConvergence: 63, militaryActivity: 35 },
        }],
      },
      temporalAnomalies: { anomalies: [] },
      unrestEvents: { events: [] },
    };
    const result = detectPoliticalScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'political');
    assert.equal(result[0].region, 'Israel');
  });

  it('can generate from ACLED unrest event counts even when CII unrest is weak', () => {
    const inputs = {
      ciiScores: {
        ciiScores: [{
          region: 'IN',
          combinedScore: 62,
          trend: 'TREND_DIRECTION_STABLE',
          components: { ciiContribution: 0, geoConvergence: 0 },
        }],
      },
      temporalAnomalies: { anomalies: [] },
      unrestEvents: {
        events: [
          { country: 'India', sourceType: 'UNREST_SOURCE_TYPE_ACLED' },
          { country: 'India', sourceType: 'UNREST_SOURCE_TYPE_ACLED' },
          { country: 'India', sourceType: 'UNREST_SOURCE_TYPE_ACLED' },
        ],
      },
    };
    const result = detectPoliticalScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'political');
    assert.equal(result[0].region, 'India');
  });

  it('does not derive hard-count unrest signals from GDELT-only events', () => {
    const inputs = {
      ciiScores: {
        ciiScores: [{
          region: 'IN',
          combinedScore: 62,
          trend: 'TREND_DIRECTION_STABLE',
          components: { ciiContribution: 0, geoConvergence: 63 },
        }],
      },
      temporalAnomalies: { anomalies: [] },
      unrestEvents: {
        events: [
          { country: 'India', sourceType: 'UNREST_SOURCE_TYPE_GDELT' },
          { country: 'India', sourceType: 'UNREST_SOURCE_TYPE_GDELT' },
          { country: 'India', sourceType: 'UNREST_SOURCE_TYPE_GDELT' },
        ],
      },
    };
    const result = detectPoliticalScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'political');
    assert.equal(result[0].region, 'India');
    assert.ok(!result[0].signals.some((signal) => signal.type === 'unrest_events'));
  });
});

describe('detectMilitaryScenarios', () => {
  it('accepts live theater entries that use theater instead of id', () => {
    const inputs = {
      militaryForecastInputs: { fetchedAt: Date.now(), theaters: [{ theater: 'baltic-theater', postureLevel: 'critical', activeFlights: 12 }] },
      temporalAnomalies: { anomalies: [] },
    };
    const result = detectMilitaryScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'military');
    assert.equal(result[0].region, 'Northern Europe');
  });

  it('creates a military forecast from theater surge data even before posture turns elevated', () => {
    const inputs = {
      temporalAnomalies: { anomalies: [] },
      militaryForecastInputs: {
        fetchedAt: Date.now(),
        theaters: [{ theater: 'taiwan-theater', postureLevel: 'normal', activeFlights: 5 }],
        surges: [{
          theaterId: 'taiwan-theater',
          surgeType: 'fighter',
          currentCount: 8,
          baselineCount: 2,
          surgeMultiple: 4,
          persistent: true,
          persistenceCount: 2,
          postureLevel: 'normal',
          strikeCapable: true,
          fighters: 8,
          tankers: 1,
          awacs: 1,
          dominantCountry: 'China',
          dominantCountryCount: 6,
          dominantOperator: 'plaaf',
        }],
      },
    };
    const result = detectMilitaryScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'China-linked fighter surge near Taiwan Strait');
    assert.ok(result[0].probability >= 0.7);
    assert.ok(result[0].signals.some((signal) => signal.type === 'mil_surge'));
    assert.ok(result[0].signals.some((signal) => signal.type === 'operator'));
    assert.ok(result[0].signals.some((signal) => signal.type === 'persistence'));
    assert.ok(result[0].signals.some((signal) => signal.type === 'theater_actor_fit'));
  });

  it('ignores stale military surge payloads', () => {
    const inputs = {
      temporalAnomalies: { anomalies: [] },
      militaryForecastInputs: {
        fetchedAt: Date.now() - (4 * 60 * 60 * 1000),
        theaters: [{ theater: 'taiwan-theater', postureLevel: 'normal', activeFlights: 5 }],
        surges: [{
          theaterId: 'taiwan-theater',
          surgeType: 'fighter',
          currentCount: 8,
          baselineCount: 2,
          surgeMultiple: 4,
          postureLevel: 'normal',
          strikeCapable: true,
          fighters: 8,
          tankers: 1,
          awacs: 1,
          dominantCountry: 'China',
          dominantCountryCount: 6,
        }],
      },
    };
    const result = detectMilitaryScenarios(inputs);
    assert.equal(result.length, 0);
  });

  it('rejects military bundles whose theater timestamps drift from fetchedAt', () => {
    const bundle = getFreshMilitaryForecastInputs({
      militaryForecastInputs: {
        fetchedAt: Date.now(),
        theaters: [{ theater: 'taiwan-theater', postureLevel: 'elevated', assessedAt: Date.now() - (6 * 60 * 1000) }],
        surges: [],
      },
    });
    assert.equal(bundle, null);
  });

  it('suppresses one-off generic air activity when it lacks persistence and theater-relevant actors', () => {
    const inputs = {
      temporalAnomalies: { anomalies: [] },
      militaryForecastInputs: {
        fetchedAt: Date.now(),
        theaters: [{ theater: 'iran-theater', postureLevel: 'normal', activeFlights: 6 }],
        surges: [{
          theaterId: 'iran-theater',
          surgeType: 'air_activity',
          currentCount: 6,
          baselineCount: 2.7,
          surgeMultiple: 2.22,
          persistent: false,
          persistenceCount: 0,
          postureLevel: 'normal',
          strikeCapable: false,
          fighters: 0,
          tankers: 0,
          awacs: 0,
          dominantCountry: 'Qatar',
          dominantCountryCount: 4,
          dominantOperator: 'other',
        }],
      },
    };
    const result = detectMilitaryScenarios(inputs);
    assert.equal(result.length, 0);
  });
});

// ── Phase 2 Tests ──────────────────────────────────────────

describe('attachNewsContext', () => {
  it('matches headlines mentioning prediction region and scenario context', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const news = { topStories: [
      { primaryTitle: 'Iran tensions escalate after military action' },
      { primaryTitle: 'Stock market rallies on tech earnings' },
      { primaryTitle: 'Iran nuclear deal negotiations resume' },
    ]};
    attachNewsContext(preds, news);
    assert.equal(preds[0].newsContext.length, 1);
    assert.ok(preds[0].newsContext[0].includes('Iran'));
  });

  it('adds news_corroboration signal when headlines match', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const news = { topStories: [{ primaryTitle: 'Iran military strikes reported' }] };
    attachNewsContext(preds, news);
    const corr = preds[0].signals.find(s => s.type === 'news_corroboration');
    assert.ok(corr, 'should have news_corroboration signal');
    assert.equal(corr.weight, 0.15);
  });

  it('does NOT add signal when no headlines match', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const news = { topStories: [{ primaryTitle: 'Local weather forecast sunny' }] };
    attachNewsContext(preds, news);
    const corr = preds[0].signals.find(s => s.type === 'news_corroboration');
    assert.equal(corr, undefined);
  });

  it('does not attach unrelated generic headlines when no match', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const news = { topStories: [
      { primaryTitle: 'Unrelated headline about sports' },
      { primaryTitle: 'Another unrelated story' },
      { primaryTitle: 'Third unrelated story' },
      { primaryTitle: 'Fourth unrelated story' },
    ]};
    attachNewsContext(preds, news);
    assert.deepEqual(preds[0].newsContext, []);
  });

  it('excludes commodity node names from matching (no false positives)', () => {
    // Iran links to "Oil" in entity graph, but "Oil" should NOT match headlines
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const news = { topStories: [{ primaryTitle: 'Oil prices rise on global demand' }] };
    attachNewsContext(preds, news);
    // "Oil" is a commodity node, not country/theater, so should NOT match
    const corr = preds[0].signals.find(s => s.type === 'news_corroboration');
    assert.equal(corr, undefined, 'commodity names should not trigger corroboration');
  });

  it('reads headlines from digest categories (primary path)', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const digest = { categories: {
      middleeast: { items: [{ title: 'Iran launches missile test' }, { title: 'Saudi oil output stable' }] },
      europe: { items: [{ title: 'EU summit concludes' }] },
    }};
    attachNewsContext(preds, null, digest);
    assert.ok(preds[0].newsContext.length >= 1);
    assert.ok(preds[0].newsContext[0].includes('Iran'));
    const corr = preds[0].signals.find(s => s.type === 'news_corroboration');
    assert.ok(corr, 'should have corroboration from digest headlines');
  });

  it('handles null newsInsights and null digest', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    attachNewsContext(preds, null, null);
    assert.equal(preds[0].newsContext, undefined);
  });

  it('handles empty topStories with no digest', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    attachNewsContext(preds, { topStories: [] }, null);
    assert.equal(preds[0].newsContext, undefined);
  });

  it('prefers region-relevant headlines over generic domain-only matches', () => {
    const preds = [makePrediction('supply_chain', 'Red Sea', 'Shipping disruption: Red Sea', 0.6, 0.4, '7d', [])];
    const news = { topStories: [
      { primaryTitle: 'Global shipping stocks rise despite broader market weakness' },
      { primaryTitle: 'Red Sea shipping disruption worsens after new attacks' },
      { primaryTitle: 'Freight rates react to Red Sea rerouting' },
    ]};
    attachNewsContext(preds, news);
    assert.ok(preds[0].newsContext[0].includes('Red Sea'));
    assert.ok(preds[0].newsContext.every(h => /Red Sea|rerouting/i.test(h)));
  });

  it('rejects domain-only headlines with no geographic grounding', () => {
    const preds = [makePrediction('military', 'Northern Europe', 'Military posture escalation: Northern Europe', 0.6, 0.4, '7d', [])];
    const news = { topStories: [
      { primaryTitle: 'Kenya minister flies to Russia to halt illegal army hiring' },
      { primaryTitle: 'Army reshuffle rattles coalition government in Nairobi' },
    ]};
    attachNewsContext(preds, news);
    assert.deepEqual(preds[0].newsContext, []);
  });
});

describe('headline and market relevance helpers', () => {
  it('scores region-specific headlines above generic domain headlines', () => {
    const terms = ['Red Sea', 'Yemen'];
    const specific = computeHeadlineRelevance('Red Sea shipping disruption worsens after new attacks', terms, 'supply_chain');
    const generic = computeHeadlineRelevance('Global shipping shares rise in New York trading', terms, 'supply_chain');
    assert.ok(specific > generic);
  });

  it('scores semantically aligned markets above broad regional ones', () => {
    const pred = makePrediction('conflict', 'Middle East', 'Escalation risk: Iran', 0.7, 0.5, '7d', []);
    const targeted = computeMarketMatchScore(pred, 'Will Iran conflict escalate before July?', ['Iran', 'Middle East']);
    const broad = computeMarketMatchScore(pred, 'Will Netanyahu remain prime minister through 2026?', ['Iran', 'Middle East']);
    assert.ok(targeted.score > broad.score);
  });

  it('penalizes mismatched regional headlines and markets', () => {
    const terms = ['Northern Europe', 'Baltic'];
    const headlineScore = computeHeadlineRelevance(
      'Kenya minister flies to Russia to halt illegal army hiring',
      terms,
      'military',
      { region: 'Northern Europe', requireRegion: true, requireSemantic: true },
    );
    assert.equal(headlineScore, 0);

    const pred = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.66, 0.5, '30d', []);
    const market = computeMarketMatchScore(
      pred,
      'Will Israel launch a major ground offensive in Lebanon by March 31?',
      ['Middle East', 'Strait of Hormuz', 'Iran'],
    );
    assert.ok(market.score < 7);
  });
});

describe('forecast case assembly', () => {
  it('buildForecastCase assembles evidence, triggers, and actors from current forecast data', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.42, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    pred.newsContext = ['Iran military drills intensify after border incident'];
    pred.calibration = { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.58, drift: 0.12, source: 'polymarket' };
    pred.cascades = [{ domain: 'market', effect: 'commodity price shock', probability: 0.41 }];
    pred.trend = 'falling';
    pred.priorProbability = 0.78;

    const caseFile = buildForecastCase(pred);
    assert.ok(caseFile.supportingEvidence.some(item => item.type === 'cii'));
    assert.ok(caseFile.supportingEvidence.some(item => item.type === 'headline'));
    assert.ok(caseFile.supportingEvidence.some(item => item.type === 'market_calibration'));
    assert.ok(caseFile.supportingEvidence.some(item => item.type === 'cascade'));
    assert.ok(caseFile.counterEvidence.length >= 1);
    assert.ok(caseFile.triggers.length >= 1);
    assert.ok(caseFile.actorLenses.length >= 1);
    assert.ok(caseFile.actors.length >= 1);
    assert.ok(caseFile.worldState.summary.includes('Iran'));
    assert.ok(caseFile.worldState.activePressures.length >= 1);
    assert.equal(caseFile.branches.length, 3);
  });

  it('buildForecastCases populates the case file for every forecast', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87', weight: 0.4 },
    ]);
    const b = makePrediction('market', 'Red Sea', 'Shipping price shock', 0.55, 0.5, '30d', [
      { type: 'chokepoint', value: 'Red Sea risk: high', weight: 0.5 },
    ]);
    buildForecastCases([a, b]);
    assert.ok(a.caseFile);
    assert.ok(b.caseFile);
  });

  it('helper functions return structured case ingredients', () => {
    const pred = makePrediction('supply_chain', 'Red Sea', 'Supply chain disruption: Red Sea', 0.64, 0.35, '7d', [
      { type: 'chokepoint', value: 'Red Sea disruption detected', weight: 0.5 },
      { type: 'gps_jamming', value: 'GPS interference near Red Sea', weight: 0.2 },
    ]);
    pred.trend = 'rising';
    pred.cascades = [{ domain: 'market', effect: 'supply shortage pricing', probability: 0.38 }];

    const counter = buildCounterEvidence(pred);
    const triggers = buildCaseTriggers(pred);
    const structuredActors = buildForecastActors(pred);
    const worldState = buildForecastWorldState(pred, structuredActors, triggers, counter);
    const branches = buildForecastBranches(pred, {
      actors: structuredActors,
      triggers,
      counterEvidence: counter,
      worldState,
    });
    const actorLenses = buildActorLenses(pred);
    assert.ok(Array.isArray(counter));
    assert.ok(triggers.length >= 1);
    assert.ok(structuredActors.length >= 1);
    assert.ok(worldState.summary.includes('Red Sea'));
    assert.ok(worldState.activePressures.length >= 1);
    assert.equal(branches.length, 3);
    assert.ok(branches[0].rounds.length >= 3);
    assert.ok(actorLenses.length >= 1);
  });
});

describe('forecast evaluation and ranking', () => {
  it('scores evidence-rich forecasts above thin forecasts', () => {
    const rich = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.62, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
      { type: 'theater', value: 'Middle East theater posture elevated', weight: 0.2 },
    ]);
    rich.newsContext = ['Iran military drills intensify after border incident'];
    rich.calibration = { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.58, drift: 0.04, source: 'polymarket' };
    rich.cascades = [{ domain: 'market', effect: 'commodity price shock', probability: 0.41 }];
    rich.trend = 'rising';
    buildForecastCase(rich);

    const thin = makePrediction('market', 'Europe', 'Energy stress: Europe', 0.7, 0.62, '7d', [
      { type: 'prediction_market', value: 'Broad market stress chatter', weight: 0.2 },
    ]);
    thin.trend = 'stable';
    buildForecastCase(thin);

    const richScore = scoreForecastReadiness(rich);
    const thinScore = scoreForecastReadiness(thin);
    assert.ok(richScore.overall > thinScore.overall);
    assert.ok(richScore.groundingScore > thinScore.groundingScore);
  });

  it('uses readiness to rank better-grounded forecasts ahead of thinner peers', () => {
    const rich = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.66, 0.58, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    rich.newsContext = ['Iran military drills intensify after border incident'];
    rich.calibration = { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.57, drift: 0.03, source: 'polymarket' };
    rich.trend = 'rising';
    buildForecastCase(rich);

    const thin = makePrediction('market', 'Europe', 'Energy stress: Europe', 0.69, 0.58, '7d', [
      { type: 'prediction_market', value: 'Broad market stress chatter', weight: 0.2 },
    ]);
    thin.trend = 'stable';
    buildForecastCase(thin);

    assert.ok(computeAnalysisPriority(rich) > computeAnalysisPriority(thin));

    const ranked = [thin, rich];
    rankForecastsForAnalysis(ranked);
    assert.equal(ranked[0].title, rich.title);
  });

  it('penalizes thin forecasts with weak grounding even at similar base probability', () => {
    const grounded = makePrediction('political', 'France', 'Political instability: France', 0.64, 0.57, '7d', [
      { type: 'unrest', value: 'France protest intensity remains elevated', weight: 0.3 },
      { type: 'cii', value: 'France institutional stress index 68', weight: 0.25 },
    ]);
    grounded.newsContext = ['French unions warn of a broader escalation in strikes'];
    grounded.trend = 'rising';
    buildForecastCase(grounded);

    const thin = makePrediction('conflict', 'Brazil', 'Active armed conflict: Brazil', 0.65, 0.57, '7d', [
      { type: 'conflict_events', value: 'Localized violence persists', weight: 0.15 },
    ]);
    thin.trend = 'stable';
    buildForecastCase(thin);

    assert.ok(computeAnalysisPriority(grounded) > computeAnalysisPriority(thin));
  });

  it('filters non-positive forecasts before publish while keeping positive probabilities', () => {
    const dropped = makePrediction('market', 'Red Sea', 'Shipping/Oil price impact from Suez Canal disruption', 0, 0.58, '30d', []);
    const kept = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.12, 0.58, '7d', []);
    const ranked = [dropped, kept];

    const published = filterPublishedForecasts(ranked);
    assert.equal(published.length, 1);
    assert.equal(published[0].id, kept.id);
  });

  it('selects enrichment targets from a broader, domain-balanced top slice', () => {
    const conflictA = makePrediction('conflict', 'Iran', 'Conflict A', 0.72, 0.61, '7d', [
      { type: 'cii', value: 'Iran CII 87', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    conflictA.newsContext = ['Iran military drills intensify after border incident'];
    conflictA.trend = 'rising';
    buildForecastCase(conflictA);

    const conflictB = makePrediction('conflict', 'Israel', 'Conflict B', 0.71, 0.6, '7d', [
      { type: 'ucdp', value: '4 UCDP conflict events', weight: 0.35 },
      { type: 'theater', value: 'Eastern Mediterranean posture elevated', weight: 0.25 },
    ]);
    conflictB.newsContext = ['Regional officials warn of retaliation risk'];
    conflictB.trend = 'rising';
    buildForecastCase(conflictB);

    const conflictC = makePrediction('conflict', 'Mexico', 'Conflict C', 0.7, 0.59, '7d', [
      { type: 'conflict_events', value: 'Violence persists across multiple states', weight: 0.2 },
    ]);
    conflictC.trend = 'stable';
    buildForecastCase(conflictC);

    const cyberA = makePrediction('cyber', 'China', 'Cyber A', 0.69, 0.58, '7d', [
      { type: 'cyber', value: 'Hostile malware hosting remains elevated', weight: 0.4 },
      { type: 'news_corroboration', value: 'Security firms warn of sustained activity', weight: 0.2 },
    ]);
    cyberA.newsContext = ['Security researchers warn of renewed malware coordination'];
    cyberA.trend = 'rising';
    buildForecastCase(cyberA);

    const cyberB = makePrediction('cyber', 'Russia', 'Cyber B', 0.67, 0.56, '7d', [
      { type: 'cyber', value: 'C2 server concentration remains high', weight: 0.35 },
      { type: 'news_corroboration', value: 'Government agencies issue new advisories', weight: 0.2 },
    ]);
    cyberB.newsContext = ['Authorities publish a fresh advisory on state-linked activity'];
    cyberB.trend = 'rising';
    buildForecastCase(cyberB);

    const supplyChain = makePrediction('supply_chain', 'Red Sea', 'Shipping disruption: Red Sea', 0.68, 0.59, '7d', [
      { type: 'chokepoint', value: 'Red Sea disruption detected', weight: 0.5 },
      { type: 'gps_jamming', value: 'GPS interference near Red Sea', weight: 0.2 },
    ]);
    supplyChain.newsContext = ['Freight rates react to Red Sea rerouting'];
    supplyChain.trend = 'rising';
    buildForecastCase(supplyChain);

    const market = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.73, 0.58, '30d', [
      { type: 'chokepoint', value: 'Hormuz transit risk rises', weight: 0.5 },
      { type: 'prediction_market', value: 'Oil breakout chatter increases', weight: 0.2 },
    ]);
    market.newsContext = ['Analysts warn of renewed stress in the Strait of Hormuz'];
    market.calibration = { marketTitle: 'Will oil close above $90?', marketPrice: 0.65, drift: 0.05, source: 'polymarket' };
    market.trend = 'rising';
    buildForecastCase(market);

    const selected = selectForecastsForEnrichment([
      conflictA,
      conflictB,
      conflictC,
      cyberA,
      cyberB,
      supplyChain,
      market,
    ]);

    const enriched = [...selected.combined, ...selected.scenarioOnly];
    assert.equal(enriched.length, 6);
    assert.ok(enriched.some(pred => pred.domain === 'supply_chain'));
    assert.ok(enriched.some(pred => pred.domain === 'market'));
    assert.ok(enriched.filter(pred => pred.domain === 'conflict').length <= 2);
    assert.ok(enriched.filter(pred => pred.domain === 'cyber').length <= 2);
  });
});

describe('forecast change tracking', () => {
  it('builds prior snapshots with enough context for evidence diffs', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
    ]);
    pred.newsContext = ['Iran military drills intensify after border incident'];
    pred.calibration = { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.58, drift: 0.04, source: 'polymarket' };
    const snapshot = buildPriorForecastSnapshot(pred);
    assert.equal(snapshot.id, pred.id);
    assert.deepEqual(snapshot.signals, ['Iran CII 87 (critical)']);
    assert.deepEqual(snapshot.newsContext, ['Iran military drills intensify after border incident']);
    assert.equal(snapshot.calibration.marketTitle, 'Will Iran conflict escalate before July?');
  });

  it('buildPublishedSeedPayload strips simulation-only forecast bulk from the canonical payload', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.72, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
    ]);
    buildForecastCase(pred);
    pred.caseFile.situationContext = { id: 'sit-1', label: 'Iran conflict situation', forecastCount: 3 };
    pred.caseFile.familyContext = { id: 'fam-1', label: 'War theater family', forecastCount: 6 };
    pred.caseFile.worldState = {
      ...pred.caseFile.worldState,
      situationId: 'sit-1',
      familyId: 'fam-1',
      familyLabel: 'War theater family',
      simulationSummary: 'Heavy simulation linkage that should stay out of the canonical Redis payload.',
      simulationPosture: 'escalatory',
      simulationPostureScore: 0.88,
    };
    pred.readiness = { overall: 0.82, explanation: 'heavy' };
    pred.analysisPriority = 42;
    pred.traceMeta = { narrativeSource: 'llm_combined', llmProvider: 'openrouter' };

    const slimForecast = buildPublishedForecastPayload(pred);
    assert.equal(slimForecast.caseFile.worldState.summary, pred.caseFile.worldState.summary);
    assert.equal(slimForecast.caseFile.worldState.situationId, undefined);
    assert.equal(slimForecast.caseFile.situationContext, undefined);
    assert.equal(slimForecast.caseFile.familyContext, undefined);
    assert.equal(slimForecast.readiness, undefined);
    assert.equal(slimForecast.analysisPriority, undefined);
    assert.equal(slimForecast.traceMeta, undefined);

    const payload = buildPublishedSeedPayload({ generatedAt: 123, predictions: [pred] });
    assert.equal(payload.generatedAt, 123);
    assert.equal(payload.predictions.length, 1);
    assert.equal(payload.predictions[0].caseFile.worldState.familyId, undefined);
  });

  it('keeps full canonical narrative fields and emits separate compact summary fields for publish payloads', () => {
    const pred = makePrediction('market', 'Strait of Hormuz', 'Energy repricing risk: Strait of Hormuz', 0.71, 0.64, '30d', [
      { type: 'shipping_cost_shock', value: 'Strait of Hormuz rerouting is keeping freight costs elevated.', weight: 0.38 },
    ]);
    buildForecastCase(pred);
    pred.scenario = 'Strait of Hormuz shipping disruption keeps freight and energy repricing active across the Gulf over the next 30d while LNG routes, tanker insurance costs, and importer hedging behavior continue to amplify the base path across multiple downstream markets and policy-sensitive sectors.';
    pred.feedSummary = 'Strait of Hormuz disruption is still anchoring the main market path through higher freight, wider energy premia, and persistent rerouting pressure across Gulf-linked trade flows, even as participants avoid assuming a full corridor closure.';

    const payload = buildPublishedForecastPayload(pred);

    assert.ok(payload.scenario.length > 220);
    assert.ok(payload.feedSummary.length > 220);
    assert.ok(payload.scenarioShort.length < payload.scenario.length);
    assert.ok(payload.feedSummaryShort.length < payload.feedSummary.length);
    assert.match(payload.scenarioShort, /\.\.\.$/);
    assert.match(payload.feedSummaryShort, /\.\.\.$/);
  });

  it('annotates what changed versus the prior run', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.72, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    pred.newsContext = [
      'Iran military drills intensify after border incident',
      'Regional officials warn of retaliation risk',
    ];
    pred.calibration = { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.64, drift: 0.04, source: 'polymarket' };
    buildForecastCase(pred);

    const prior = {
      predictions: [{
        id: pred.id,
        probability: 0.58,
        signals: ['Iran CII 87 (critical)'],
        newsContext: ['Iran military drills intensify after border incident'],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.53 },
      }],
    };

    annotateForecastChanges([pred], prior);
    assert.match(pred.caseFile.changeSummary, /Probability rose from 58% to 72%/);
    assert.ok(pred.caseFile.changeItems.some(item => item.includes('New signal: 3 UCDP conflict events')));
    assert.ok(pred.caseFile.changeItems.some(item => item.includes('New reporting: Regional officials warn of retaliation risk')));
    assert.ok(pred.caseFile.changeItems.some(item => item.includes('Market moved from 53% to 64%')));
  });

  it('marks newly surfaced forecasts clearly', () => {
    const pred = makePrediction('market', 'Europe', 'Energy stress: Europe', 0.55, 0.5, '30d', [
      { type: 'prediction_market', value: 'Broad market stress chatter', weight: 0.2 },
    ]);
    buildForecastCase(pred);
    const items = buildChangeItems(pred, null);
    const summary = buildChangeSummary(pred, null, items);
    assert.match(summary, /new in the current run/i);
    assert.ok(items[0].includes('New forecast surfaced'));
  });
});

describe('forecast llm overrides', () => {
  it('parses provider order safely', () => {
    assert.equal(parseForecastProviderOrder(''), null);
    assert.deepEqual(parseForecastProviderOrder('openrouter, groq, openrouter, invalid'), ['openrouter', 'groq']);
  });

  it('keeps default provider order when no override is set', () => {
    delete process.env.FORECAST_LLM_PROVIDER_ORDER;
    delete process.env.FORECAST_LLM_COMBINED_PROVIDER_ORDER;
    delete process.env.FORECAST_LLM_MODEL_OPENROUTER;
    delete process.env.FORECAST_LLM_COMBINED_MODEL_OPENROUTER;

    const options = getForecastLlmCallOptions('combined');
    const providers = resolveForecastLlmProviders(options);

    assert.deepEqual(options.providerOrder, ['openrouter', 'groq']);
    assert.equal(providers[0]?.name, 'openrouter');
    assert.equal(providers[0]?.model, 'deepseek/deepseek-v4-flash');
    assert.equal(providers[1]?.name, 'groq');
    assert.equal(providers[1]?.model, 'llama-3.3-70b-versatile');
  });

  it('pins critical_signals to the pre-#4944 chain (probability-coupled stage)', () => {
    delete process.env.FORECAST_LLM_PROVIDER_ORDER;
    delete process.env.FORECAST_LLM_CRITICAL_PROVIDER_ORDER;
    delete process.env.FORECAST_LLM_MODEL_OPENROUTER;
    delete process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER;

    // critical_signals feeds LLM strength/confidence into state-derived
    // forecast probabilities — the DeepSeek migration must not reach it
    // before the #4930 resolver baseline exists.
    const options = getForecastLlmCallOptions('critical_signals');
    const providers = resolveForecastLlmProviders(options);

    assert.deepEqual(options.providerOrder, ['groq', 'openrouter']);
    assert.equal(providers[0]?.name, 'groq');
    assert.equal(providers[0]?.model, 'llama-3.1-8b-instant');
    assert.equal(providers[1]?.name, 'openrouter');
    assert.equal(providers[1]?.model, 'google/gemini-2.5-flash');
    assert.equal(providers[1]?.extraBody, undefined, 'pinned openrouter entry must keep the legacy request body (no reasoning field)');
  });

  it('lets ONLY the stage-scoped env override unpin critical_signals', () => {
    process.env.FORECAST_LLM_CRITICAL_PROVIDER_ORDER = 'openrouter';
    process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER = 'deepseek/deepseek-v4-flash';

    const options = getForecastLlmCallOptions('critical_signals');
    const providers = resolveForecastLlmProviders(options);

    assert.deepEqual(options.providerOrder, ['openrouter']);
    assert.equal(providers[0]?.model, 'deepseek/deepseek-v4-flash');

    delete process.env.FORECAST_LLM_CRITICAL_PROVIDER_ORDER;
    delete process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER;
  });

  it('keeps critical_signals pinned even when a GLOBAL provider order is set', () => {
    // A global order flip must not move the probability-coupled stage as a
    // side effect (review finding on #4965) — only FORECAST_LLM_CRITICAL_*
    // unpins deliberately.
    process.env.FORECAST_LLM_PROVIDER_ORDER = 'openrouter';
    delete process.env.FORECAST_LLM_CRITICAL_PROVIDER_ORDER;

    const options = getForecastLlmCallOptions('critical_signals');
    const providers = resolveForecastLlmProviders(options);

    assert.deepEqual(options.providerOrder, ['groq', 'openrouter']);
    assert.equal(providers[0]?.model, 'llama-3.1-8b-instant');
    assert.equal(providers[1]?.model, 'google/gemini-2.5-flash');

    delete process.env.FORECAST_LLM_PROVIDER_ORDER;
  });

  it('keeps the pinned critical_signals fallback model against a GLOBAL model override', () => {
    // A global FORECAST_LLM_MODEL_OPENROUTER must not move the
    // probability-coupled stage's fallback either (review finding on
    // #4965) — only FORECAST_LLM_CRITICAL_MODEL_OPENROUTER may.
    process.env.FORECAST_LLM_MODEL_OPENROUTER = 'deepseek/deepseek-v4-flash';
    delete process.env.FORECAST_LLM_CRITICAL_PROVIDER_ORDER;
    delete process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER;

    const options = getForecastLlmCallOptions('critical_signals');
    const providers = resolveForecastLlmProviders(options);

    assert.equal(providers[0]?.model, 'llama-3.1-8b-instant');
    assert.equal(providers[1]?.model, 'google/gemini-2.5-flash');
    assert.equal(providers[1]?.extraBody, undefined);

    // The stage-scoped model env DOES reach the pinned fallback slot.
    process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER = 'google/gemini-2.5-pro';
    const scoped = resolveForecastLlmProviders(getForecastLlmCallOptions('critical_signals'));
    assert.equal(scoped[1]?.model, 'google/gemini-2.5-pro');

    delete process.env.FORECAST_LLM_MODEL_OPENROUTER;
    delete process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER;
  });

  it('supports a stronger combined-model override without changing scenario defaults', () => {
    process.env.FORECAST_LLM_COMBINED_PROVIDER_ORDER = 'openrouter';
    process.env.FORECAST_LLM_COMBINED_MODEL_OPENROUTER = 'google/gemini-2.5-pro';

    const combinedOptions = getForecastLlmCallOptions('combined');
    const combinedProviders = resolveForecastLlmProviders(combinedOptions);
    const scenarioOptions = getForecastLlmCallOptions('scenario');
    const scenarioProviders = resolveForecastLlmProviders(scenarioOptions);

    assert.deepEqual(combinedOptions.providerOrder, ['openrouter']);
    assert.equal(combinedProviders.length, 1);
    assert.equal(combinedProviders[0]?.name, 'openrouter');
    assert.equal(combinedProviders[0]?.model, 'google/gemini-2.5-pro');

    assert.deepEqual(scenarioOptions.providerOrder, ['openrouter', 'groq']);
    assert.equal(scenarioProviders[0]?.name, 'openrouter');
    assert.equal(scenarioProviders[0]?.model, 'deepseek/deepseek-v4-flash');
    assert.equal(scenarioProviders[1]?.model, 'llama-3.3-70b-versatile');
  });

  it('lets a global provider order and openrouter model apply to non-combined stages', () => {
    process.env.FORECAST_LLM_PROVIDER_ORDER = 'openrouter';
    process.env.FORECAST_LLM_MODEL_OPENROUTER = 'google/gemini-2.5-flash-lite-preview';

    const options = getForecastLlmCallOptions('scenario');
    const providers = resolveForecastLlmProviders(options);

    assert.deepEqual(options.providerOrder, ['openrouter']);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.name, 'openrouter');
    assert.equal(providers[0]?.model, 'google/gemini-2.5-flash-lite-preview');
  });

  it('retries a 429 Retry-After response on the same provider and returns groq', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalSetTimeout = globalThis.setTimeout;
    const calls = [];
    const waits = [];
    globalThis.setTimeout = (fn, ms, ...args) => {
      waits.push(ms);
      fn(...args);
      return 0;
    };

    try {
      __setForecastLlmTransportForTests({
        fetch: async (url) => {
          calls.push(String(url));
          if (calls.length <= 2) {
            return {
              ok: false,
              status: 429,
              headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
            };
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({
              model: 'deepseek/deepseek-v4-flash',
              choices: [{ message: { content: 'OpenRouter retry succeeded with enough narrative content.' } }],
            }),
          };
        },
      });

      const result = await __callForecastLlmForTests('system', 'user', { stage: 'scenario', retryDelayMs: 0 });

      assert.deepEqual(waits, [2000, 2000]);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((url) => url.includes('openrouter.ai')));
      assert.deepEqual(result, {
        text: 'OpenRouter retry succeeded with enough narrative content.',
        model: 'deepseek/deepseek-v4-flash',
        provider: 'openrouter',
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('caps oversized Retry-After hints before retrying a forecast LLM provider', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let calls = 0;
    globalThis.setTimeout = (fn, ms, ...args) => {
      waits.push(ms);
      fn(...args);
      return 0;
    };

    try {
      __setForecastLlmTransportForTests({
        fetch: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              ok: false,
              status: 429,
              headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
            };
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({
              model: 'deepseek/deepseek-v4-flash',
              choices: [{ message: { content: 'Capped retry succeeded with enough narrative content.' } }],
            }),
          };
        },
      });

      const result = await __callForecastLlmForTests('system', 'user', { stage: 'scenario', retryDelayMs: 0 });

      assert.deepEqual(waits, [10000]);
      assert.equal(calls, 2);
      assert.equal(result?.provider, 'openrouter');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('bounds Retry-After sleeps by the forecast LLM stage budget', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let now = 1_000;
    let calls = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => {
      waits.push(ms);
      now += ms;
      fn(...args);
      return 0;
    };

    try {
      __setForecastLlmTransportForTests({
        fetch: async (url) => {
          calls += 1;
          assert.ok(String(url).includes('api.groq.com'), 'budget exhaustion should not fall through to the next provider');
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
          };
        },
      });

      const result = await __callForecastLlmForTests('system', 'user', {
        stage: 'scenario',
        providerOrder: ['groq', 'openrouter'],
        retryDelayMs: 0,
        stageBudgetMs: 17_000,
      });

      assert.equal(result, null);
      assert.equal(calls, 2);
      assert.deepEqual(waits, [10000, 2000]);
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('caps cumulative LLM time by the run budget even when the stage budget is generous', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let now = 1_000;
    let calls = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => {
      waits.push(ms);
      now += ms;
      fn(...args);
      return 0;
    };

    try {
      // Run deadline 12s out; a single 7s usable window remains after the 5s
      // guard, so exactly one attempt fires and its Retry-After sleep is capped
      // to the remaining RUN budget — not the (generous) per-stage budget.
      __setForecastLlmRunDeadlineForTests(now + 12_000);
      __setForecastLlmTransportForTests({
        fetch: async (url) => {
          calls += 1;
          assert.ok(String(url).includes('api.groq.com'), 'run-budget stop should not fall through to the next provider');
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
          };
        },
      });

      const result = await __callForecastLlmForTests('system', 'user', {
        stage: 'scenario',
        providerOrder: ['groq', 'openrouter'],
        retryDelayMs: 0,
        stageBudgetMs: 120_000,
      });

      assert.equal(result, null);
      assert.equal(calls, 1);
      assert.deepEqual(waits, [7000]);
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('falls back to groq after exhausting openrouter retries and preserves provider/model', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const providers = [];

    __setForecastLlmTransportForTests({
      fetch: async (url) => {
        const href = String(url);
        providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
        if (href.includes('openrouter.ai')) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => null },
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: 'groq/llama-test',
            choices: [{ message: { content: 'Groq fallback succeeded with enough narrative content.' } }],
          }),
        };
      },
    });

    const result = await __callForecastLlmForTests('system', 'user', { stage: 'scenario', retryDelayMs: 0 });

    assert.deepEqual(providers, ['openrouter', 'openrouter', 'openrouter', 'openrouter', 'groq']);
    assert.deepEqual(result, {
      text: 'Groq fallback succeeded with enough narrative content.',
      model: 'groq/llama-test',
      provider: 'groq',
    });
  });

  it('does not retry non-retryable 402 before falling back', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const providers = [];

    __setForecastLlmTransportForTests({
      fetch: async (url) => {
        const href = String(url);
        providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
        if (href.includes('openrouter.ai')) {
          return {
            ok: false,
            status: 402,
            headers: { get: () => null },
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: 'groq/no-retry-test',
            choices: [{ message: { content: 'Groq fallback after non retryable status has enough content.' } }],
          }),
        };
      },
    });

    const result = await __callForecastLlmForTests('system', 'user', { stage: 'scenario', retryDelayMs: 0 });

    assert.deepEqual(providers, ['openrouter', 'groq']);
    assert.deepEqual(result, {
      text: 'Groq fallback after non retryable status has enough content.',
      model: 'groq/no-retry-test',
      provider: 'groq',
    });
  });

  it('recovers impact expansion output after an initial invalid parse', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/get/')) {
        return {
          ok: false,
          json: async () => ({}),
          text: async () => '',
        };
      }
      return {
        ok: true,
        json: async () => ({ result: null }),
        text: async () => '',
      };
    };

    const prediction = makePrediction('supply_chain', 'Strait of Hormuz', 'Shipping disruption: Strait of Hormuz', 0.68, 0.6, '7d', [
      { type: 'shipping_cost_shock', value: 'Shipping costs are rising around Strait of Hormuz rerouting.', weight: 0.5 },
      { type: 'energy_supply_shock', value: 'Energy transit pressure is building around Qatar LNG flows.', weight: 0.32 },
    ]);
    prediction.newsContext = ['Tanker rerouting is amplifying LNG and freight pressure around the Gulf.'];
    buildForecastCase(prediction);
    populateFallbackNarratives([prediction]);

    const baseState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-23T10:00:00Z'),
      predictions: [prediction],
    });
    const candidateStateId = baseState.stateUnits[0]?.id || 'state-0';

    __setForecastLlmCallOverrideForTests(async (_systemPrompt, _userPrompt, options = {}) => {
      if (options.stage === 'impact_expansion_single') {
        return {
          provider: 'test',
          model: 'impact-model',
          text: 'not valid json',
        };
      }
      if (options.stage === 'impact_expansion_recovery') {
        return {
          provider: 'test',
          model: 'impact-model',
          text: JSON.stringify({
            candidates: [
              {
                candidateIndex: 0,
                candidateStateId,
                directHypotheses: [
                  {
                    variableKey: 'route_disruption',
                    channel: 'shipping_cost_shock',
                    targetBucket: 'freight',
                    region: 'Strait of Hormuz',
                    macroRegion: 'EMEA',
                    countries: ['Qatar'],
                    assetsOrSectors: ['Shipping'],
                    commodity: 'lng',
                    dependsOnKey: '',
                    strength: 0.9,
                    confidence: 0.88,
                    analogTag: 'energy_corridor_blockage',
                    summary: 'Route disruption persists through the Strait of Hormuz corridor.',
                    evidenceRefs: ['E1', 'E2'],
                  },
                ],
                secondOrderHypotheses: [],
                thirdOrderHypotheses: [],
              },
            ],
          }),
        };
      }
      return null;
    });

    try {
      const bundle = await extractImpactExpansionBundle({
        stateUnits: baseState.stateUnits,
        worldSignals: baseState.worldSignals,
        marketTransmission: baseState.marketTransmission,
        marketState: baseState.marketState,
        marketInputCoverage: baseState.marketInputCoverage,
      });

      assert.equal(bundle.source, 'live');
      assert.equal(bundle.failureReason, '');
      assert.equal(bundle.extractedCandidateCount, 1);
      assert.equal(bundle.extractedHypothesisCount, 1);
      assert.equal(bundle.parseMode, 'per_candidate');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('forecast narrative fallbacks', () => {
  it('buildUserPrompt keeps headlines scoped to each prediction', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87', weight: 0.4 },
    ]);
    a.newsContext = ['Iran military drills intensify'];
    a.projections = { h24: 0.6, d7: 0.7, d30: 0.5 };
    buildForecastCase(a);

    const b = makePrediction('market', 'Europe', 'Gas price shock in Europe', 0.55, 0.5, '30d', [
      { type: 'market', value: 'EU gas futures spike', weight: 0.3 },
    ]);
    b.newsContext = ['European gas storage draw accelerates'];
    b.projections = { h24: 0.5, d7: 0.55, d30: 0.6 };
    buildForecastCase(b);

    const prompt = buildUserPrompt([a, b]);
    assert.match(prompt, /\[0\][\s\S]*Iran military drills intensify/);
    assert.match(prompt, /\[1\][\s\S]*European gas storage draw accelerates/);
    assert.ok(!prompt.includes('Current top headlines:'));
    assert.match(prompt, /\[SUPPORTING_EVIDENCE\]/);
    assert.match(prompt, /\[ACTORS\]/);
    assert.match(prompt, /\[WORLD_STATE\]/);
    assert.match(prompt, /\[SIMULATED_BRANCHES\]/);
  });

  it('populateFallbackNarratives fills missing scenario, perspectives, and case narratives', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    pred.trend = 'rising';
    populateFallbackNarratives([pred]);
    assert.match(pred.scenario, /Iran CII 87|central path/i);
    assert.ok(pred.perspectives?.strategic);
    assert.ok(pred.perspectives?.regional);
    assert.ok(pred.perspectives?.contrarian);
    assert.ok(pred.caseFile?.baseCase);
    assert.ok(pred.caseFile?.escalatoryCase);
    assert.ok(pred.caseFile?.contrarianCase);
    assert.equal(pred.caseFile?.branches?.length, 3);
    assert.ok(pred.feedSummary);
  });

  it('fallback perspective references calibration when present', () => {
    const pred = makePrediction('market', 'Middle East', 'Oil price impact', 0.65, 0.5, '30d', [
      { type: 'chokepoint', value: 'Hormuz disruption detected', weight: 0.5 },
    ]);
    pred.calibration = { marketTitle: 'Will oil close above $90?', marketPrice: 0.62, drift: 0.03, source: 'polymarket' };
    const perspectives = buildFallbackPerspectives(pred);
    assert.match(perspectives.contrarian, /Will oil close above \$90/);
  });

  it('fallback scenario stays concise and evidence-led', () => {
    const pred = makePrediction('infrastructure', 'France', 'Infrastructure cascade risk: France', 0.48, 0.4, '24h', [
      { type: 'outage', value: 'France major outage', weight: 0.4 },
    ]);
    const scenario = buildFallbackScenario(pred);
    assert.match(scenario, /France major outage/);
    assert.ok(scenario.length <= 500);
  });

  it('fallback case narratives stay evidence-led and concise', () => {
    const pred = makePrediction('infrastructure', 'France', 'Infrastructure cascade risk: France', 0.48, 0.4, '24h', [
      { type: 'outage', value: 'France major outage', weight: 0.4 },
    ]);
    buildForecastCase(pred);
    const baseCase = buildFallbackBaseCase(pred);
    const escalatoryCase = buildFallbackEscalatoryCase(pred);
    const contrarianCase = buildFallbackContrarianCase(pred);
    assert.match(baseCase, /France major outage/);
    assert.ok(escalatoryCase.length <= 500);
    assert.ok(contrarianCase.length <= 500);
  });

  it('fallback narratives keep situation context without broader-cluster filler', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.63, 0.48, '7d', [
      { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.5 },
    ]);
    buildForecastCase(pred);
    pred.caseFile.situationContext = {
      id: 'sit-1',
      label: 'Iran conflict pressure',
      forecastCount: 4,
      topSignals: [{ type: 'ucdp', count: 4 }],
    };
    pred.situationContext = pred.caseFile.situationContext;

    const scenario = buildFallbackScenario(pred);
    const baseCase = buildFallbackBaseCase(pred);
    const summary = buildFeedSummary(pred);

    assert.match(baseCase, /27 conflict events in Iran/i);
    assert.ok(!scenario.match(/broader|cluster/i));
    assert.ok(!summary.match(/broader|cluster/i));
  });

  it('buildFeedSummary preserves the full narrative without server-side clipping', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    buildForecastCase(pred);
    pred.caseFile.baseCase = 'Iran CII 87 (critical) and 3 UCDP conflict events keep the base path elevated over the next 7d with persistent force pressure and increasingly visible cross-border signaling, while regional actors still avoid a decisive break into a wider confrontation.';
    const summary = buildFeedSummary(pred);
    assert.ok(summary.length > 180);
    assert.ok(!summary.endsWith('...'));
    assert.match(summary, /Iran CII 87/);
  });

  it('refreshPublishedNarratives preserves validated llm narratives and only fills gaps', () => {
    const pred = makePrediction('market', 'Strait of Hormuz', 'Inflation and rates pressure from Strait of Hormuz maritime disruption state', 0.69, 0.64, '30d', [
      { type: 'shipping_cost_shock', value: 'Strait of Hormuz shipping costs remain elevated', weight: 0.42 },
    ]);
    buildForecastCase(pred);
    pred.traceMeta = { narrativeSource: 'llm_combined', llmProvider: 'openrouter' };
    pred.caseFile.baseCase = 'LLM base case keeps Hormuz freight and energy repricing tied to persistent shipping disruption over the next 30d.';
    pred.caseFile.escalatoryCase = 'LLM escalatory case sees a sharper repricing if maritime insurance and rerouting costs jump again.';
    pred.caseFile.contrarianCase = 'LLM contrarian case assumes corridor access stabilizes before the freight shock spreads further.';
    pred.scenario = 'LLM scenario keeps Hormuz inflation pressure elevated while the corridor remains contested.';
    pred.feedSummary = '';

    refreshPublishedNarratives([pred]);

    assert.equal(pred.caseFile.baseCase, 'LLM base case keeps Hormuz freight and energy repricing tied to persistent shipping disruption over the next 30d.');
    assert.equal(pred.caseFile.escalatoryCase, 'LLM escalatory case sees a sharper repricing if maritime insurance and rerouting costs jump again.');
    assert.equal(pred.caseFile.contrarianCase, 'LLM contrarian case assumes corridor access stabilizes before the freight shock spreads further.');
    assert.equal(pred.scenario, 'LLM scenario keeps Hormuz inflation pressure elevated while the corridor remains contested.');
    assert.equal(pred.feedSummary, 'LLM base case keeps Hormuz freight and energy repricing tied to persistent shipping disruption over the next 30d.');
  });

  it('rebuilds deterministic feed summaries from enriched scenarios instead of leaving fallback phrasing in place', () => {
    const pred = makePrediction('market', 'Strait of Hormuz', 'Energy repricing risk from Strait of Hormuz maritime disruption state', 0.68, 0.63, '30d', [
      { type: 'shipping_cost_shock', value: 'Hormuz freight costs remain elevated.', weight: 0.4 },
    ]);
    buildForecastCase(pred);
    pred.traceMeta = { narrativeSource: 'llm_scenario', llmProvider: 'openrouter' };
    pred.caseFile.baseCase = buildFallbackBaseCase(pred);
    pred.scenario = 'LLM scenario keeps Hormuz energy and freight stress elevated as the corridor stays contested and downstream importers continue to hedge against extended rerouting pressure.';
    pred.feedSummary = buildFallbackBaseCase(pred);

    refreshPublishedNarratives([pred]);

    assert.equal(pred.feedSummary, pred.scenario);
    assert.doesNotMatch(pred.feedSummary, /For now, the base case stays near/i);
  });
});

describe('validateCaseNarratives', () => {
  it('accepts valid case narratives', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87', weight: 0.4 },
    ]);
    const valid = validateCaseNarratives([{
      index: 0,
      baseCase: 'Iran CII 87 remains the main anchor for the base path in the next 7d.',
      escalatoryCase: 'A further rise in Iran CII 87 and added conflict-event reporting would move risk materially higher.',
      contrarianCase: 'If no new corroborating headlines appear, the current path would lose support and flatten out.',
    }], [pred]);
    assert.equal(valid.length, 1);
  });

  it('accepts partial case narratives when at least one branch is substantive', () => {
    const pred = makePrediction('market', 'India', 'FX stress from India cyber pressure state', 0.68, 0.61, '30d', [
      { type: 'fx_stress', value: 'India cyber pressure state is keeping FX stress active', weight: 0.42 },
    ]);
    const valid = validateCaseNarratives([{
      index: 0,
      baseCase: 'India cyber pressure state remains the clearest anchor for the current FX stress base case over the next 30d.',
    }], [pred]);
    assert.equal(valid.length, 1);
    assert.match(valid[0].baseCase, /India cyber pressure state/);
    assert.equal(valid[0].escalatoryCase, undefined);
  });
});

describe('computeConfidence', () => {
  it('higher source diversity = higher confidence', () => {
    const p1 = makePrediction('conflict', 'Iran', 'a', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
    ]);
    const p2 = makePrediction('conflict', 'Iran', 'b', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
      { type: 'theater', value: 'test', weight: 0.3 },
      { type: 'ucdp', value: 'test', weight: 0.2 },
    ]);
    computeConfidence([p1, p2]);
    assert.ok(p2.confidence > p1.confidence);
  });

  it('cii and cii_delta count as one source', () => {
    const p = makePrediction('conflict', 'Iran', 'a', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
      { type: 'cii_delta', value: 'test', weight: 0.2 },
    ]);
    const pSingle = makePrediction('conflict', 'Iran', 'b', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
    ]);
    computeConfidence([p, pSingle]);
    assert.equal(p.confidence, pSingle.confidence);
  });

  it('low calibration drift = higher confidence than high drift', () => {
    const pLow = makePrediction('conflict', 'Iran', 'a', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
    ]);
    pLow.calibration = { marketTitle: 'test', marketPrice: 0.5, drift: 0.01, source: 'polymarket' };
    const pHigh = makePrediction('conflict', 'Iran', 'b', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
    ]);
    pHigh.calibration = { marketTitle: 'test', marketPrice: 0.5, drift: 0.4, source: 'polymarket' };
    computeConfidence([pLow, pHigh]);
    assert.ok(pLow.confidence > pHigh.confidence);
  });

  it('high calibration drift = lower confidence', () => {
    const p = makePrediction('conflict', 'Iran', 'a', 0.5, 0, '7d', [
      { type: 'cii', value: 'test', weight: 0.4 },
    ]);
    p.calibration = { marketTitle: 'test', marketPrice: 0.5, drift: 0.4, source: 'polymarket' };
    computeConfidence([p]);
    assert.ok(p.confidence <= 0.5);
  });

  it('floors at 0.2', () => {
    const p = makePrediction('conflict', 'Iran', 'a', 0.5, 0, '7d', []);
    p.calibration = { marketTitle: 'test', marketPrice: 0.5, drift: 0.5, source: 'polymarket' };
    computeConfidence([p]);
    assert.ok(p.confidence >= 0.2);
  });
});

describe('sanitizeForPrompt', () => {
  it('strips HTML tags', () => {
    assert.equal(sanitizeForPrompt('<script>alert("xss")</script>hello'), 'scriptalert("xss")/scripthello');
  });

  it('strips newlines', () => {
    assert.equal(sanitizeForPrompt('line1\nline2\rline3'), 'line1 line2 line3');
  });

  it('truncates to 200 chars', () => {
    const long = 'x'.repeat(300);
    assert.equal(sanitizeForPrompt(long).length, 200);
  });

  it('handles null/undefined', () => {
    assert.equal(sanitizeForPrompt(null), '');
    assert.equal(sanitizeForPrompt(undefined), '');
  });
});

describe('parseLLMScenarios', () => {
  it('parses valid JSON array', () => {
    const result = parseLLMScenarios('[{"index": 0, "scenario": "Test scenario"}]');
    assert.equal(result.length, 1);
    assert.equal(result[0].index, 0);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseLLMScenarios('not json at all'), null);
  });

  it('strips thinking tags before parsing', () => {
    const result = parseLLMScenarios('<think>reasoning here</think>[{"index": 0, "scenario": "Test"}]');
    assert.equal(result.length, 1);
  });

  it('repairs truncated JSON array', () => {
    const result = parseLLMScenarios('[{"index": 0, "scenario": "Test scenario"');
    assert.ok(result !== null);
    assert.equal(result[0].index, 0);
  });

  it('extracts JSON from surrounding text', () => {
    const result = parseLLMScenarios('Here is my analysis:\n[{"index": 0, "scenario": "Test"}]\nDone.');
    assert.equal(result.length, 1);
  });

  it('extracts scenarios from fenced object wrappers', () => {
    const result = parseLLMScenarios('```json\n{"scenarios":[{"index":0,"scenario":"Test scenario"}]}\n```');
    assert.equal(result.length, 1);
    assert.equal(result[0].index, 0);
  });
});

describe('validateScenarios', () => {
  const preds = [
    makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [
      { type: 'cii', value: 'Iran CII 87 critical', weight: 0.4 },
    ]),
  ];

  it('accepts scenario with signal reference', () => {
    const scenarios = [{ index: 0, scenario: 'The Iran CII score of 87 indicates critical instability in the region, driven by ongoing military activity.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 1);
  });

  it('accepts scenario with headline reference', () => {
    preds[0].newsContext = ['Iran military drills intensify after border incident'];
    const scenarios = [{ index: 0, scenario: 'Iran military drills intensify after border incident, keeping escalation pressure elevated over the next 7d.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 1);
    delete preds[0].newsContext;
  });

  it('accepts scenario with market cue and trigger reference', () => {
    preds[0].calibration = { marketTitle: 'Will oil close above $90?', marketPrice: 0.62, drift: 0.03, source: 'polymarket' };
    preds[0].caseFile = {
      supportingEvidence: [],
      counterEvidence: [],
      triggers: ['A market repricing of 8-10 points would be a meaningful confirmation or rejection signal.'],
      actorLenses: [],
      baseCase: '',
      escalatoryCase: '',
      contrarianCase: '',
    };
    const scenarios = [{ index: 0, scenario: 'Will oil close above $90? remains a live market cue, and a market repricing of 8-10 points would confirm the current path.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 1);
    delete preds[0].calibration;
    delete preds[0].caseFile;
  });

  it('accepts scenario with state-label evidence for state-derived forecasts', () => {
    preds[0].stateContext = {
      id: 'state-india-fx',
      label: 'India cyber pressure state',
      sampleTitles: ['FX stress from India cyber pressure state'],
    };
    const scenarios = [{ index: 0, scenario: 'India cyber pressure state remains the clearest anchor for the current FX stress path over the next 30d.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 1);
    delete preds[0].stateContext;
  });

  it('rejects scenario without any evidence reference', () => {
    const scenarios = [{ index: 0, scenario: 'Tensions continue to rise in the region due to various geopolitical factors and ongoing disputes.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 0);
  });

  it('rejects too-short scenario', () => {
    const scenarios = [{ index: 0, scenario: 'Short.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 0);
  });

  it('rejects out-of-bounds index', () => {
    const scenarios = [{ index: 5, scenario: 'Iran CII 87 indicates critical instability in the region.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 0);
  });

  it('strips HTML from scenario', () => {
    const scenarios = [{ index: 0, scenario: 'The Iran CII score of 87 <b>critical</b> indicates instability in the conflict zone region.' }];
    const valid = validateScenarios(scenarios, preds);
    assert.equal(valid.length, 1);
    assert.ok(!valid[0].scenario.includes('<b>'));
  });

  it('handles null/non-array input', () => {
    assert.deepEqual(validateScenarios(null, preds), []);
    assert.deepEqual(validateScenarios('not array', preds), []);
  });
});

// ── Phase 3 Tests ──────────────────────────────────────────

describe('computeProjections', () => {
  it('keeps peak-horizon projection equal to probability', () => {
    const p = makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', []);
    computeProjections([p]);
    assert.ok(p.projections);
    // Conflict's 7d multiplier is the domain peak, so it remains the stored probability.
    assert.equal(p.projections.d7, p.probability);
  });

  it('different domains produce different curves', () => {
    const conflict = makePrediction('conflict', 'A', 'a', 0.5, 0.5, '7d', []);
    const infra = makePrediction('infrastructure', 'B', 'b', 0.5, 0.5, '24h', []);
    computeProjections([conflict, infra]);
    assert.notEqual(conflict.projections.d30, infra.projections.d30);
  });

  it('caps at 0.95', () => {
    const p = makePrediction('conflict', 'Iran', 'test', 0.9, 0.5, '7d', []);
    computeProjections([p]);
    assert.ok(p.projections.h24 <= 0.95);
    assert.ok(p.projections.d7 <= 0.95);
    assert.ok(p.projections.d30 <= 0.95);
  });

  it('floors at 0.01', () => {
    const p = makePrediction('infrastructure', 'A', 'test', 0.02, 0.5, '24h', []);
    computeProjections([p]);
    assert.ok(p.projections.d30 >= 0.01);
  });

  it('unknown domain defaults to multiplier 1', () => {
    const p = makePrediction('unknown_domain', 'X', 'test', 0.5, 0.5, '7d', []);
    computeProjections([p]);
    assert.equal(p.projections.h24, 0.5);
    assert.equal(p.projections.d7, 0.5);
    assert.equal(p.projections.d30, 0.5);
  });

  it('de-anchors projections from non-peak emit horizons', () => {
    const p = makePrediction('market', 'Middle East', 'test', 0.5, 0.5, '30d', []);
    computeProjections([p]);
    assert.equal(p.projections.h24, p.probability);
    assert.equal(p.projections.d7, 0.29);
    assert.equal(p.projections.d30, 0.21);
  });

  it('preserves own-horizon projections for non-market 30d forecasts', () => {
    const p = makePrediction('conflict', 'Sudan', 'test', 0.35, 0.5, '30d', []);
    computeProjections([p]);
    assert.equal(p.projections.d30, p.probability);
    assert.equal(p.projections.h24, 0.408);
    assert.equal(p.projections.d7, 0.449);
  });
});

describe('validatePerspectives', () => {
  const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [
    { type: 'cii', value: 'Iran CII 87', weight: 0.4 },
  ])];

  it('accepts valid perspectives', () => {
    const items = [{
      index: 0,
      strategic: 'The CII data shows critical instability with a score of 87 in the conflict region.',
      regional: 'Regional actors face mounting pressure from the elevated CII threat level.',
      contrarian: 'Despite CII readings, diplomatic channels remain open and could defuse tensions.',
    }];
    const valid = validatePerspectives(items, preds);
    assert.equal(valid.length, 1);
  });

  it('rejects too-short perspectives', () => {
    const items = [{ index: 0, strategic: 'Short.', regional: 'Also short.', contrarian: 'Nope.' }];
    assert.equal(validatePerspectives(items, preds).length, 0);
  });

  it('strips HTML before length check', () => {
    const items = [{
      index: 0,
      strategic: '<b><i><span>x</span></i></b>',
      regional: 'Valid regional perspective with enough characters here.',
      contrarian: 'Valid contrarian perspective with enough characters here.',
    }];
    assert.equal(validatePerspectives(items, preds).length, 0);
  });

  it('handles null input', () => {
    assert.deepEqual(validatePerspectives(null, preds), []);
  });

  it('rejects out-of-bounds index', () => {
    const items = [{
      index: 5,
      strategic: 'Valid strategic perspective with sufficient length.',
      regional: 'Valid regional perspective with sufficient length too.',
      contrarian: 'Valid contrarian perspective with sufficient length too.',
    }];
    assert.equal(validatePerspectives(items, preds).length, 0);
  });
});

describe('loadCascadeRules', () => {
  it('loads rules from JSON file', () => {
    const rules = loadCascadeRules();
    assert.ok(Array.isArray(rules));
    assert.ok(rules.length >= 5);
  });

  it('each rule has required fields', () => {
    const rules = loadCascadeRules();
    for (const r of rules) {
      assert.ok(r.from, 'missing from');
      assert.ok(r.to, 'missing to');
      assert.ok(typeof r.coupling === 'number', 'coupling must be number');
      assert.ok(r.mechanism, 'missing mechanism');
    }
  });

  it('includes new Phase 3 rules', () => {
    const rules = loadCascadeRules();
    const infraToSupply = rules.find(r => r.from === 'infrastructure' && r.to === 'supply_chain');
    assert.ok(infraToSupply, 'infrastructure -> supply_chain rule missing');
    assert.equal(infraToSupply.requiresSeverity, 'total');
  });
});

describe('evaluateRuleConditions', () => {
  it('requiresChokepoint passes for chokepoint region', () => {
    const pred = makePrediction('conflict', 'Middle East', 'test', 0.5, 0.5, '7d', []);
    assert.ok(evaluateRuleConditions({ requiresChokepoint: true }, pred));
  });

  it('requiresChokepoint fails for non-chokepoint region', () => {
    const pred = makePrediction('conflict', 'Northern Europe', 'test', 0.5, 0.5, '7d', []);
    assert.ok(!evaluateRuleConditions({ requiresChokepoint: true }, pred));
  });

  it('minProbability passes when above threshold', () => {
    const pred = makePrediction('political', 'Iran', 'test', 0.7, 0.5, '7d', []);
    assert.ok(evaluateRuleConditions({ minProbability: 0.6 }, pred));
  });

  it('minProbability fails when below threshold', () => {
    const pred = makePrediction('political', 'Iran', 'test', 0.3, 0.5, '7d', []);
    assert.ok(!evaluateRuleConditions({ minProbability: 0.6 }, pred));
  });

  it('requiresSeverity checks outage signal value', () => {
    const pred = makePrediction('infrastructure', 'Iran', 'test', 0.5, 0.5, '24h', [
      { type: 'outage', value: 'Iran total outage', weight: 0.4 },
    ]);
    assert.ok(evaluateRuleConditions({ requiresSeverity: 'total' }, pred));
  });

  it('requiresSeverity fails for non-matching severity', () => {
    const pred = makePrediction('infrastructure', 'Iran', 'test', 0.5, 0.5, '24h', [
      { type: 'outage', value: 'Iran minor outage', weight: 0.4 },
    ]);
    assert.ok(!evaluateRuleConditions({ requiresSeverity: 'total' }, pred));
  });
});

// ── Phase 4 Tests ──────────────────────────────────────────

describe('normalizeChokepoints', () => {
  it('maps v4 shape to v2 fields', () => {
    const v4 = { chokepoints: [{ name: 'Suez Canal', disruptionScore: 75, status: 'yellow' }] };
    const result = normalizeChokepoints(v4);
    assert.equal(result.chokepoints[0].region, 'Suez Canal');
    assert.equal(result.chokepoints[0].riskScore, 75);
    assert.equal(result.chokepoints[0].riskLevel, 'high');
    assert.equal(result.chokepoints[0].disrupted, false);
  });

  it('maps red status to critical + disrupted', () => {
    const v4 = { chokepoints: [{ name: 'Hormuz', status: 'red' }] };
    const result = normalizeChokepoints(v4);
    assert.equal(result.chokepoints[0].riskLevel, 'critical');
    assert.equal(result.chokepoints[0].disrupted, true);
  });

  it('handles null', () => {
    assert.equal(normalizeChokepoints(null), null);
  });
});

describe('normalizeGpsJamming', () => {
  it('maps hexes to zones', () => {
    const raw = { hexes: [{ lat: 35, lon: 30 }] };
    const result = normalizeGpsJamming(raw);
    assert.ok(result.zones);
    assert.equal(result.zones[0].lat, 35);
  });

  it('preserves existing zones', () => {
    const raw = { zones: [{ lat: 10, lon: 20 }] };
    const result = normalizeGpsJamming(raw);
    assert.equal(result.zones[0].lat, 10);
  });

  it('handles null', () => {
    assert.equal(normalizeGpsJamming(null), null);
  });
});

describe('detectUcdpConflictZones', () => {
  it('generates prediction for 10+ events in one country', () => {
    const events = Array.from({ length: 15 }, () => ({ country: 'Syria' }));
    const result = detectUcdpConflictZones({ ucdpEvents: { events } });
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'conflict');
    assert.equal(result[0].region, 'Syria');
  });

  it('does not pin the 10-event gate to the old normalization floor', () => {
    const events = Array.from({ length: 10 }, () => ({ country: 'Sudan' }));
    const [pred] = detectUcdpConflictZones({ ucdpEvents: { events } });
    assert.ok(pred);
    assert.equal(pred.probability, 0.35);
  });

  it('ramps UCDP conflict probability above the 10-event gate', () => {
    const midGateEvents = Array.from({ length: 55 }, () => ({ country: 'Sudan' }));
    const [midGate] = detectUcdpConflictZones({ ucdpEvents: { events: midGateEvents } });
    assert.ok(midGate);
    assert.equal(midGate.probability, 0.6);

    const cappedEvents = Array.from({ length: 120 }, () => ({ country: 'Sudan' }));
    const [capped] = detectUcdpConflictZones({ ucdpEvents: { events: cappedEvents } });
    assert.ok(capped);
    assert.equal(capped.probability, 0.85);
  });

  it('skips countries with < 10 events', () => {
    const events = Array.from({ length: 5 }, () => ({ country: 'Jordan' }));
    assert.equal(detectUcdpConflictZones({ ucdpEvents: { events } }).length, 0);
  });

  it('handles empty input', () => {
    assert.equal(detectUcdpConflictZones({}).length, 0);
  });
});

describe('detectCyberScenarios', () => {
  it('generates prediction for 5+ threats in one country', () => {
    const threats = Array.from({ length: 8 }, () => ({ country: 'US', type: 'malware' }));
    const result = detectCyberScenarios({ cyberThreats: { threats } });
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'cyber');
  });

  it('skips countries with < 5 threats', () => {
    const threats = Array.from({ length: 3 }, () => ({ country: 'CH', type: 'phishing' }));
    assert.equal(detectCyberScenarios({ cyberThreats: { threats } }).length, 0);
  });

  it('handles empty input', () => {
    assert.equal(detectCyberScenarios({}).length, 0);
  });

  it('caps broad cyber output to the top-ranked countries', () => {
    const threats = [];
    for (let i = 0; i < 20; i++) {
      const country = `Country-${i}`;
      for (let j = 0; j < 5; j++) threats.push({ country, type: 'phishing' });
    }
    const result = detectCyberScenarios({ cyberThreats: { threats } });
    assert.equal(result.length, 12);
  });
});

describe('detectGpsJammingScenarios', () => {
  it('generates prediction for hexes in maritime region', () => {
    const zones = Array.from({ length: 5 }, () => ({ lat: 35, lon: 30 })); // Eastern Med
    const result = detectGpsJammingScenarios({ gpsJamming: { zones } });
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'supply_chain');
    assert.equal(result[0].region, 'Eastern Mediterranean');
  });

  it('skips hexes outside maritime regions', () => {
    const zones = [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
    assert.equal(detectGpsJammingScenarios({ gpsJamming: { zones } }).length, 0);
  });
});

describe('detectFromPredictionMarkets', () => {
  it('generates from 60-90% markets with region', () => {
    const markets = { geopolitical: [{ title: 'Will Iran strike Israel?', yesPrice: 70, source: 'polymarket' }] };
    const result = detectFromPredictionMarkets({ predictionMarkets: markets });
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'conflict');
    assert.equal(result[0].region, 'Middle East');
  });

  it('skips markets below 60%', () => {
    const markets = { geopolitical: [{ title: 'Will US enter recession?', yesPrice: 30 }] };
    assert.equal(detectFromPredictionMarkets({ predictionMarkets: markets }).length, 0);
  });

  it('caps at 5 predictions', () => {
    const markets = { geopolitical: Array.from({ length: 10 }, (_, i) => ({
      title: `Will Europe face crisis ${i}?`, yesPrice: 70,
    })) };
    assert.ok(detectFromPredictionMarkets({ predictionMarkets: markets }).length <= 5);
  });
});

describe('lowered CII conflict threshold', () => {
  it('CII score 67 (high level) now triggers conflict', () => {
    const result = detectConflictScenarios({
      ciiScores: { ciiScores: [{ region: 'IL', combinedScore: 67, trend: 'TREND_DIRECTION_STABLE', components: {} }] },
      theaterPosture: { theaters: [] },
      iranEvents: { events: [] },
      ucdpEvents: { events: [] },
    });
    assert.ok(result.length >= 1, 'should trigger at score 67');
  });

  it('CII score 62 (elevated level) does NOT trigger conflict', () => {
    const result = detectConflictScenarios({
      ciiScores: { ciiScores: [{ region: 'JO', combinedScore: 62, trend: 'TREND_DIRECTION_RISING', components: {} }] },
      theaterPosture: { theaters: [] },
      iranEvents: { events: [] },
      ucdpEvents: { events: [] },
    });
    assert.equal(result.length, 0, 'should NOT trigger at score 62 (elevated)');
  });
});

describe('loadEntityGraph', () => {
  it('loads graph from JSON', () => {
    const graph = loadEntityGraph();
    assert.ok(graph.nodes);
    assert.ok(graph.aliases);
    assert.ok(graph.edges);
    assert.ok(Object.keys(graph.nodes).length > 10);
  });

  it('aliases resolve country codes', () => {
    const graph = loadEntityGraph();
    assert.equal(graph.aliases['IR'], 'IR');
    assert.equal(graph.aliases['Iran'], 'IR');
    assert.equal(graph.aliases['Middle East'], 'middle-east');
  });
});

describe('discoverGraphCascades', () => {
  it('finds linked predictions via graph', () => {
    const graph = loadEntityGraph();
    const preds = [
      makePrediction('conflict', 'IR', 'Iran conflict', 0.6, 0.5, '7d', []),
      makePrediction('market', 'Middle East', 'Oil impact', 0.4, 0.5, '30d', []),
    ];
    discoverGraphCascades(preds, graph);
    // IR links to middle-east theater, which has Oil impact prediction
    const irCascades = preds[0].cascades.filter(c => c.effect.includes('graph:'));
    assert.ok(irCascades.length > 0 || preds[1].cascades.length > 0, 'should find graph cascade between Iran and Middle East');
  });

  it('skips same-domain predictions', () => {
    const graph = loadEntityGraph();
    const preds = [
      makePrediction('conflict', 'IR', 'a', 0.6, 0.5, '7d', []),
      makePrediction('conflict', 'Middle East', 'b', 0.5, 0.5, '7d', []),
    ];
    discoverGraphCascades(preds, graph);
    const graphCascades = preds[0].cascades.filter(c => c.effect.includes('graph:'));
    assert.equal(graphCascades.length, 0, 'same domain should not cascade');
  });
});

describe('forecast quality gating', () => {
  function attachPublishSelectionContext(pred, {
    stateId = `state-${pred.id}`,
    situationId = `sit-${pred.id}`,
    familyId = `fam-${pred.id}`,
    label = `${pred.region || pred.id} selection state`,
    dominantRegion = pred.region || pred.id,
    dominantDomain = pred.domain,
    stateKind = '',
    priority = 0.5,
    readiness = 0.7,
    forecastCount = 1,
    topSignals = [{ type: 'news_corroboration' }],
  } = {}) {
    const state = {
      id: stateId,
      label,
      dominantRegion,
      dominantDomain,
      stateKind,
      forecastCount,
      familyId,
      topSignals,
    };
    const situation = {
      id: situationId,
      label: `${label} situation`,
      forecastCount,
      topSignals: topSignals.map((signal) => ({ type: signal.type, count: signal.count || 1 })),
    };
    const family = {
      id: familyId,
      label: `${label} family`,
      forecastCount,
      situationCount: 1,
      situationIds: [situationId],
    };

    pred.traceMeta = { narrativeSource: 'fallback' };
    pred.readiness = { overall: readiness };
    pred.analysisPriority = priority;
    pred.stateContext = state;
    pred.situationContext = situation;
    pred.familyContext = family;
    pred.caseFile = pred.caseFile || {};
    pred.caseFile.situationContext = situation;
    pred.caseFile.familyContext = family;
    return pred;
  }

  it('reserves scenario enrichment slots for scarce market and military forecasts', () => {
    const predictions = [
      makePrediction('cyber', 'A', 'Cyber A', 0.7, 0.55, '7d', [{ type: 'cyber', value: '8 threats', weight: 0.5 }]),
      makePrediction('cyber', 'B', 'Cyber B', 0.68, 0.55, '7d', [{ type: 'cyber', value: '7 threats', weight: 0.5 }]),
      makePrediction('conflict', 'C', 'Conflict C', 0.66, 0.6, '7d', [{ type: 'ucdp', value: '12 events', weight: 0.5 }]),
      makePrediction('market', 'Middle East', 'Oil price impact', 0.4, 0.5, '30d', [{ type: 'news_corroboration', value: 'Oil traders react', weight: 0.3 }]),
      makePrediction('military', 'Korean Peninsula', 'Elevated military air activity', 0.34, 0.5, '7d', [{ type: 'mil_surge', value: 'fighter surge', weight: 0.4 }]),
    ];
    buildForecastCases(predictions);
    const selected = selectForecastsForEnrichment(predictions, { maxCombined: 2, maxScenario: 2, maxPerDomain: 2, minReadiness: 0 });
    assert.equal(selected.combined.length, 2);
    assert.equal(selected.scenarioOnly.length, 2);
    assert.ok(selected.scenarioOnly.some(item => item.domain === 'market'));
    assert.ok(selected.scenarioOnly.some(item => item.domain === 'military'));
    assert.deepEqual(selected.telemetry.reservedScenarioDomains.sort(), ['market', 'military']);
  });

  it('filters only the weakest fallback forecasts from publish output', () => {
    const weak = makePrediction('cyber', 'Thinland', 'Cyber threat concentration: Thinland', 0.11, 0.32, '7d', [
      { type: 'cyber', value: '5 threats (phishing)', weight: 0.5 },
    ]);
    buildForecastCases([weak]);
    weak.traceMeta = { narrativeSource: 'fallback' };
    weak.readiness = { overall: 0.28 };
    weak.analysisPriority = 0.05;

    const strong = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.22, 0.48, '7d', [
      { type: 'news_corroboration', value: 'Oil prices moved on shipping risk', weight: 0.4 },
    ]);
    buildForecastCases([strong]);
    strong.traceMeta = { narrativeSource: 'fallback' };
    strong.readiness = { overall: 0.52 };
    strong.analysisPriority = 0.11;

    const published = filterPublishedForecasts([weak, strong]);
    assert.equal(published.length, 1);
    assert.equal(published[0].id, strong.id);
  });

  it('suppresses weaker duplicate-like conflict forecasts while preserving distinct consequences', () => {
    const primary = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.64, 0.58, '7d', [
      { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.5 },
      { type: 'news_corroboration', value: 'Iran strike exchange intensifies', weight: 0.3 },
    ]);
    const duplicate = makePrediction('conflict', 'Iran', 'Active armed conflict: Iran', 0.52, 0.42, '7d', [
      { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.5 },
      { type: 'news_corroboration', value: 'Iran strike exchange intensifies', weight: 0.3 },
    ]);
    const consequence = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.41, 0.51, '30d', [
      { type: 'news_corroboration', value: 'Oil traders react to Hormuz risk', weight: 0.4 },
    ]);
    const distinctConflict = makePrediction('conflict', 'Gulf', 'Spillover conflict risk: Gulf shipping corridor', 0.47, 0.53, '14d', [
      { type: 'news_corroboration', value: 'Gulf states prepare for possible spillover', weight: 0.35 },
    ]);

    buildForecastCases([primary, duplicate, consequence, distinctConflict]);
    for (const pred of [primary, duplicate, consequence, distinctConflict]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
    }
    primary.caseFile.situationContext = { id: 'sit-1', label: 'Iran conflict pressure', forecastCount: 3, topSignals: [{ type: 'ucdp', count: 2 }] };
    duplicate.caseFile.situationContext = { id: 'sit-1', label: 'Iran conflict pressure', forecastCount: 3, topSignals: [{ type: 'ucdp', count: 2 }] };
    consequence.caseFile.situationContext = { id: 'sit-1', label: 'Iran conflict pressure', forecastCount: 3, topSignals: [{ type: 'ucdp', count: 2 }] };
    distinctConflict.caseFile.situationContext = { id: 'sit-2', label: 'Gulf spillover pressure', forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
    primary.situationContext = primary.caseFile.situationContext;
    duplicate.situationContext = duplicate.caseFile.situationContext;
    consequence.situationContext = consequence.caseFile.situationContext;
    distinctConflict.situationContext = distinctConflict.caseFile.situationContext;
    primary.readiness = { overall: 0.63 };
    duplicate.readiness = { overall: 0.44 };
    consequence.readiness = { overall: 0.54 };
    distinctConflict.readiness = { overall: 0.49 };
    primary.analysisPriority = 0.19;
    duplicate.analysisPriority = 0.09;
    consequence.analysisPriority = 0.12;
    distinctConflict.analysisPriority = 0.11;

    const published = filterPublishedForecasts([primary, duplicate, consequence, distinctConflict]);
    assert.equal(published.length, 3);
    assert.ok(published.some((item) => item.id === primary.id));
    assert.ok(!published.some((item) => item.id === duplicate.id));
    assert.ok(published.some((item) => item.id === consequence.id));
    assert.ok(published.some((item) => item.id === distinctConflict.id));

    const telemetry = summarizePublishFiltering([primary, duplicate, consequence, distinctConflict]);
    assert.equal(telemetry.suppressedSituationOverlap, 1);
  });

  it('caps dominant same-domain situation output while preserving cross-domain consequences', () => {
    const conflictA = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.66, 0.61, '7d', [
      { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.5 },
    ]);
    const conflictB = makePrediction('conflict', 'Gulf', 'Spillover conflict risk: Gulf shipping corridor', 0.61, 0.57, '7d', [
      { type: 'news_corroboration', value: 'Gulf states prepare for spillover', weight: 0.45 },
    ]);
    const conflictC = makePrediction('conflict', 'Israel', 'Retaliatory conflict risk: Israel', 0.58, 0.53, '14d', [
      { type: 'news_corroboration', value: 'Retaliatory pressure remains elevated around Israel', weight: 0.42 },
    ]);
    const consequence = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.49, 0.55, '30d', [
      { type: 'news_corroboration', value: 'Oil traders react to Hormuz risk', weight: 0.4 },
    ]);

    buildForecastCases([conflictA, conflictB, conflictC, consequence]);
    for (const pred of [conflictA, conflictB, conflictC, consequence]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.situationContext = {
        id: 'sit-iran',
        label: 'Iran conflict and market situation',
        forecastCount: 4,
        topSignals: [{ type: 'ucdp', count: 3 }],
      };
      pred.caseFile.situationContext = pred.situationContext;
    }
    conflictA.readiness = { overall: 0.64 };
    conflictB.readiness = { overall: 0.59 };
    conflictC.readiness = { overall: 0.51 };
    consequence.readiness = { overall: 0.56 };
    conflictA.analysisPriority = 0.22;
    conflictB.analysisPriority = 0.19;
    conflictC.analysisPriority = 0.15;
    consequence.analysisPriority = 0.17;

    const published = filterPublishedForecasts([conflictA, conflictB, conflictC, consequence]);
    assert.equal(published.length, 3);
    assert.ok(published.some((item) => item.id === consequence.id));
    assert.ok(!published.some((item) => item.id === conflictC.id));

    const telemetry = summarizePublishFiltering([conflictA, conflictB, conflictC, consequence]);
    assert.equal(telemetry.suppressedSituationDomainCap, 1);
    assert.equal(telemetry.cappedSituations, 0);
  });

  it('does not suppress same-domain forecasts as duplicates when they belong to different situation families', () => {
    const iranConflict = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.67, 0.61, '7d', [
      { type: 'ucdp', value: 'Iran conflict intensity remains elevated', weight: 0.45 },
    ]);
    const brazilConflict = makePrediction('conflict', 'Brazil', 'Escalation risk: Brazil', 0.62, 0.58, '7d', [
      { type: 'ucdp', value: 'Brazil conflict intensity remains elevated', weight: 0.42 },
    ]);

    buildForecastCases([iranConflict, brazilConflict]);
    for (const pred of [iranConflict, brazilConflict]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.58 };
      pred.analysisPriority = 0.16;
    }

    iranConflict.situationContext = { id: 'sit-iran', label: 'Iran conflict situation', forecastCount: 1, topSignals: [{ type: 'ucdp', count: 1 }] };
    brazilConflict.situationContext = { id: 'sit-brazil', label: 'Brazil conflict situation', forecastCount: 1, topSignals: [{ type: 'ucdp', count: 1 }] };
    iranConflict.caseFile.situationContext = iranConflict.situationContext;
    brazilConflict.caseFile.situationContext = brazilConflict.situationContext;
    iranConflict.familyContext = { id: 'fam-middle-east', label: 'Middle East conflict pressure family', situationCount: 1, forecastCount: 1 };
    brazilConflict.familyContext = { id: 'fam-brazil', label: 'Brazil conflict pressure family', situationCount: 1, forecastCount: 1 };
    iranConflict.caseFile.familyContext = iranConflict.familyContext;
    brazilConflict.caseFile.familyContext = brazilConflict.familyContext;

    const published = filterPublishedForecasts([iranConflict, brazilConflict]);
    assert.equal(published.length, 2);

    const telemetry = summarizePublishFiltering([iranConflict, brazilConflict]);
    assert.equal(telemetry.suppressedSituationOverlap, 0);
  });

  it('caps dominant family output while preserving family diversity', () => {
    const preds = [
      makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.69, 0.62, '7d', [{ type: 'ucdp', value: 'Iran events remain elevated', weight: 0.4 }]),
      makePrediction('political', 'Iran', 'Political instability: Iran', 0.56, 0.56, '14d', [{ type: 'news_corroboration', value: 'Emergency cabinet talks continue', weight: 0.35 }]),
      makePrediction('market', 'Middle East', 'Oil price impact: Middle East', 0.53, 0.55, '30d', [{ type: 'prediction_market', value: 'Oil repricing persists', weight: 0.3 }]),
      makePrediction('supply_chain', 'Persian Gulf', 'Shipping disruption: Persian Gulf', 0.51, 0.54, '14d', [{ type: 'chokepoint', value: 'Shipping reroutes persist', weight: 0.35 }]),
      makePrediction('infrastructure', 'Iran', 'Infrastructure strain: Iran', 0.49, 0.53, '14d', [{ type: 'news_corroboration', value: 'Grid strain and outages remain elevated', weight: 0.32 }]),
      makePrediction('conflict', 'Brazil', 'Escalation risk: Brazil', 0.63, 0.58, '7d', [{ type: 'ucdp', value: 'Brazil conflict remains active', weight: 0.42 }]),
    ];

    buildForecastCases(preds);
    for (const [index, pred] of preds.entries()) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.68 - (index * 0.03) };
      pred.analysisPriority = 0.24 - (index * 0.02);
    }

    const familyA = {
      id: 'fam-middle-east',
      label: 'Middle East pressure family',
      situationCount: 5,
      forecastCount: 5,
      situationIds: ['sit-iran-conflict', 'sit-iran-political', 'sit-middleeast-market', 'sit-gulf-shipping', 'sit-iran-infra'],
    };
    const familyB = {
      id: 'fam-brazil',
      label: 'Brazil pressure family',
      situationCount: 1,
      forecastCount: 1,
      situationIds: ['sit-brazil-conflict'],
    };
    preds[0].situationContext = { id: 'sit-iran-conflict', label: 'Iran conflict situation', forecastCount: 1, topSignals: [{ type: 'ucdp', count: 1 }] };
    preds[1].situationContext = { id: 'sit-iran-political', label: 'Iran political situation', forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
    preds[2].situationContext = { id: 'sit-middleeast-market', label: 'Middle East market situation', forecastCount: 1, topSignals: [{ type: 'prediction_market', count: 1 }] };
    preds[3].situationContext = { id: 'sit-gulf-shipping', label: 'Persian Gulf supply chain situation', forecastCount: 1, topSignals: [{ type: 'chokepoint', count: 1 }] };
    preds[4].situationContext = { id: 'sit-iran-infra', label: 'Iran infrastructure situation', forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
    preds[5].situationContext = { id: 'sit-brazil-conflict', label: 'Brazil conflict situation', forecastCount: 1, topSignals: [{ type: 'ucdp', count: 1 }] };
    for (const pred of preds.slice(0, 5)) {
      pred.familyContext = familyA;
      pred.caseFile.situationContext = pred.situationContext;
      pred.caseFile.familyContext = familyA;
    }
    preds[5].familyContext = familyB;
    preds[5].caseFile.situationContext = preds[5].situationContext;
    preds[5].caseFile.familyContext = familyB;

    const published = applySituationFamilyCaps(preds, [familyA, familyB]);
    assert.equal(published.length, 5);
    assert.ok(published.some((item) => item.id === preds[5].id));

    const telemetry = summarizePublishFiltering(preds);
    assert.equal(telemetry.suppressedSituationFamilyCap, 1);
    assert.equal(telemetry.cappedFamilies, 1);
  });

  it('preselects published forecasts across families before overlap suppression', () => {
    const preds = [
      makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.72, 0.65, '7d', [{ type: 'ucdp', value: 'Iran events elevated', weight: 0.4 }]),
      makePrediction('political', 'Iran', 'Political instability: Iran', 0.58, 0.59, '14d', [{ type: 'news_corroboration', value: 'Emergency meetings continue', weight: 0.35 }]),
      makePrediction('market', 'Middle East', 'Oil repricing risk: Gulf', 0.55, 0.57, '30d', [{ type: 'prediction_market', value: 'Oil reprices higher', weight: 0.3 }]),
      makePrediction('supply_chain', 'Persian Gulf', 'Shipping disruption: Persian Gulf', 0.53, 0.56, '14d', [{ type: 'chokepoint', value: 'Routing delays persist', weight: 0.35 }]),
      makePrediction('conflict', 'Ukraine', 'Escalation risk: Ukraine', 0.64, 0.61, '7d', [{ type: 'ucdp', value: 'Ukraine conflict remains active', weight: 0.42 }]),
      makePrediction('market', 'Black Sea', 'Grain pricing pressure: Black Sea', 0.5, 0.54, '30d', [{ type: 'prediction_market', value: 'Grain risk premium widens', weight: 0.28 }]),
    ];

    buildForecastCases(preds);
    for (const [index, pred] of preds.entries()) {
      pred.traceMeta = { narrativeSource: index < 2 ? 'llm_combined' : 'fallback' };
      pred.readiness = { overall: 0.7 - (index * 0.04) };
      pred.analysisPriority = 0.24 - (index * 0.02);
    }

    const familyA = { id: 'fam-middle-east', label: 'Middle East pressure family', forecastCount: 4, situationCount: 4, situationIds: ['sit-iran-conflict', 'sit-iran-political', 'sit-gulf-market', 'sit-gulf-shipping'] };
    const familyB = { id: 'fam-black-sea', label: 'Black Sea pressure family', forecastCount: 2, situationCount: 2, situationIds: ['sit-ukraine-conflict', 'sit-blacksea-market'] };
    const contexts = [
      ['sit-iran-conflict', 'Iran conflict situation', familyA],
      ['sit-iran-political', 'Iran political situation', familyA],
      ['sit-gulf-market', 'Gulf market situation', familyA],
      ['sit-gulf-shipping', 'Persian Gulf shipping situation', familyA],
      ['sit-ukraine-conflict', 'Ukraine conflict situation', familyB],
      ['sit-blacksea-market', 'Black Sea market situation', familyB],
    ];
    for (const [index, pred] of preds.entries()) {
      const [id, label, family] = contexts[index];
      pred.situationContext = { id, label, forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
      pred.caseFile.situationContext = pred.situationContext;
      pred.familyContext = family;
      pred.caseFile.familyContext = family;
    }

    const selected = selectPublishedForecastPool(preds);
    assert.ok(selected.some((pred) => pred.familyContext?.id === familyA.id));
    assert.ok(selected.some((pred) => pred.familyContext?.id === familyB.id));
    assert.ok(selected.some((pred) => pred.domain === 'market'));
    assert.ok((selected.deferredCandidates || []).length >= 1);
  });

  it('backfills deferred forecasts when filtering drops a preselected duplicate', () => {
    const primary = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.66, '7d', [{ type: 'ucdp', value: 'Iran events elevated', weight: 0.4 }]);
    const duplicate = makePrediction('conflict', 'Iran', 'Retaliatory conflict risk: Iran', 0.69, 0.58, '7d', [{ type: 'ucdp', value: 'Iran events elevated', weight: 0.36 }]);
    const political = makePrediction('political', 'Iran', 'Political instability: Iran', 0.59, 0.57, '14d', [{ type: 'news_corroboration', value: 'Emergency cabinet meetings continue', weight: 0.35 }]);
    const supply = makePrediction('supply_chain', 'Persian Gulf', 'Shipping disruption: Persian Gulf', 0.54, 0.56, '14d', [{ type: 'chokepoint', value: 'Routing delays persist', weight: 0.34 }]);

    buildForecastCases([primary, duplicate, political, supply]);
    const fullRunSituationClusters = [
      { id: 'sit-iran-conflict', label: 'Iran conflict situation', dominantRegion: 'Iran', dominantDomain: 'conflict', regions: ['Iran'], domains: ['conflict'], actors: ['Iran'], branchKinds: ['base'], forecastIds: [primary.id, duplicate.id], forecastCount: 2, avgProbability: 0.715, avgConfidence: 0.62, topSignals: [{ type: 'ucdp', count: 2 }], sampleTitles: [primary.title, duplicate.title] },
      { id: 'sit-iran-political', label: 'Iran political situation', dominantRegion: 'Iran', dominantDomain: 'political', regions: ['Iran'], domains: ['political'], actors: ['Iran'], branchKinds: ['base'], forecastIds: [political.id], forecastCount: 1, avgProbability: 0.59, avgConfidence: 0.57, topSignals: [{ type: 'news_corroboration', count: 1 }], sampleTitles: [political.title] },
      { id: 'sit-gulf-shipping', label: 'Persian Gulf shipping situation', dominantRegion: 'Persian Gulf', dominantDomain: 'supply_chain', regions: ['Persian Gulf'], domains: ['supply_chain'], actors: ['Shipping'], branchKinds: ['base'], forecastIds: [supply.id], forecastCount: 1, avgProbability: 0.54, avgConfidence: 0.56, topSignals: [{ type: 'chokepoint', count: 1 }], sampleTitles: [supply.title] },
    ];

    const familyA = { id: 'fam-middle-east', label: 'Middle East pressure family', forecastCount: 3, situationCount: 2, situationIds: ['sit-iran-conflict', 'sit-iran-political'] };
    const familyB = { id: 'fam-gulf', label: 'Persian Gulf pressure family', forecastCount: 1, situationCount: 1, situationIds: ['sit-gulf-shipping'] };
    for (const pred of [primary, duplicate, political, supply]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.7 };
    }
    primary.analysisPriority = 0.25;
    duplicate.analysisPriority = 0.2;
    political.analysisPriority = 0.18;
    supply.analysisPriority = 0.14;

    primary.situationContext = fullRunSituationClusters[0];
    duplicate.situationContext = fullRunSituationClusters[0];
    political.situationContext = fullRunSituationClusters[1];
    supply.situationContext = fullRunSituationClusters[2];
    primary.caseFile.situationContext = primary.situationContext;
    duplicate.caseFile.situationContext = duplicate.situationContext;
    political.caseFile.situationContext = political.situationContext;
    supply.caseFile.situationContext = supply.situationContext;
    primary.familyContext = familyA;
    duplicate.familyContext = familyA;
    political.familyContext = familyA;
    supply.familyContext = familyB;
    primary.caseFile.familyContext = familyA;
    duplicate.caseFile.familyContext = familyA;
    political.caseFile.familyContext = familyA;
    supply.caseFile.familyContext = familyB;

    const pool = selectPublishedForecastPool([primary, duplicate, political], { targetCount: 3 });
    assert.equal(pool.length, 3);
    assert.equal(pool.deferredCandidates.length, 0);

    const expandedPool = selectPublishedForecastPool([primary, duplicate, political, supply], { targetCount: 3 });
    const candidatePool = [...expandedPool];
    const deferred = [...expandedPool.deferredCandidates];
    let artifacts = buildPublishedForecastArtifacts(candidatePool, fullRunSituationClusters);
    while (artifacts.publishedPredictions.length < expandedPool.targetCount && deferred.length > 0) {
      candidatePool.push(deferred.shift());
      artifacts = buildPublishedForecastArtifacts(candidatePool, fullRunSituationClusters);
    }

    assert.equal(artifacts.publishedPredictions.length, 3);
    assert.ok(artifacts.publishedPredictions.some((pred) => pred.id === supply.id));
    assert.ok(!artifacts.publishedPredictions.some((pred) => pred.id === duplicate.id));
  });

  it('boosts memory-backed situations during publish selection', () => {
    const persistent = makePrediction('political', 'Iran', 'Political pressure: Iran', 0.53, 0.5, '14d', [{ type: 'news_corroboration', value: 'Iran unrest persists', weight: 0.34 }]);
    const fresh = makePrediction('political', 'India', 'Political pressure: India', 0.54, 0.5, '14d', [{ type: 'news_corroboration', value: 'India coalition talks continue', weight: 0.34 }]);

    buildForecastCases([persistent, fresh]);
    for (const pred of [persistent, fresh]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.55 };
      pred.analysisPriority = 0.12;
    }

    persistent.situationContext = { id: 'sit-iran-political', label: 'Iran political situation', forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
    fresh.situationContext = { id: 'sit-india-political', label: 'India political situation', forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
    persistent.caseFile.situationContext = persistent.situationContext;
    fresh.caseFile.situationContext = fresh.situationContext;
    persistent.familyContext = { id: 'fam-mena-political', label: 'MENA political family', forecastCount: 1, situationCount: 1, situationIds: ['sit-iran-political'] };
    fresh.familyContext = { id: 'fam-asia-political', label: 'Asia political family', forecastCount: 1, situationCount: 1, situationIds: ['sit-india-political'] };
    persistent.caseFile.familyContext = persistent.familyContext;
    fresh.caseFile.familyContext = fresh.familyContext;

    const pool = selectPublishedForecastPool([fresh, persistent], {
      targetCount: 1,
      memoryIndex: {
        bySituationLabel: new Map([['iran political situation', {
          situationId: 'sit-iran-political',
          label: 'Iran political situation',
          dominantRegion: 'Iran',
          dominantDomain: 'political',
          pressureMemory: 0.82,
          memoryDelta: 0.14,
        }]]),
        byRegionDomain: new Map(),
        edgeCounts: new Map([['sit-iran-political', 2]]),
      },
    });

    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, persistent.id);
    assert.equal(pool[0].publishSelectionMemory?.matchedBy, 'label');
  });

  it('boosts market-confirmed situations during publish selection', () => {
    const confirmed = makePrediction('market', 'Middle East', 'Oil repricing: Strait of Hormuz', 0.51, 0.48, '30d', [
      { type: 'prediction_market', value: 'Oil contracts reprice on Hormuz stress', weight: 0.3 },
    ]);
    const unconfirmed = makePrediction('political', 'India', 'Political pressure: India', 0.54, 0.49, '14d', [
      { type: 'news_corroboration', value: 'Coalition bargaining remains active', weight: 0.32 },
    ]);

    buildForecastCases([confirmed, unconfirmed]);
    for (const pred of [confirmed, unconfirmed]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.55 };
      pred.analysisPriority = 0.12;
      pred.situationContext = { id: `sit-${pred.region}`, label: `${pred.region} situation`, forecastCount: 1, topSignals: [{ type: 'news_corroboration', count: 1 }] };
      pred.familyContext = { id: `fam-${pred.region}`, label: `${pred.region} family`, forecastCount: 1, situationCount: 1, situationIds: [pred.situationContext.id] };
      pred.caseFile.situationContext = pred.situationContext;
      pred.caseFile.familyContext = pred.familyContext;
    }

    confirmed.marketSelectionContext = {
      confirmationScore: 0.74,
      contradictionScore: 0.04,
      topBucketId: 'energy',
      topBucketLabel: 'Energy',
      topBucketPressure: 0.66,
      transmissionEdgeCount: 2,
      topTransmissionStrength: 0.63,
      topTransmissionConfidence: 0.68,
      consequenceSummary: 'Hormuz risk is transmitting into Energy.',
    };
    unconfirmed.marketSelectionContext = {
      confirmationScore: 0.08,
      contradictionScore: 0.22,
      topBucketId: '',
      topBucketLabel: '',
      topBucketPressure: 0,
      transmissionEdgeCount: 0,
      topTransmissionStrength: 0,
      topTransmissionConfidence: 0,
      consequenceSummary: '',
    };

    const pool = selectPublishedForecastPool([unconfirmed, confirmed], { targetCount: 1 });
    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, confirmed.id);
    assert.ok((pool[0].publishSelectionMarket?.confirmationScore || 0) > 0.7);
  });

  it('boosts hard-resolvable forecasts during publish selection', () => {
    const judged = makePrediction('political', 'France', 'Political pressure: France', 0.82, 0.58, '14d', [
      { type: 'news_corroboration', value: 'France coalition pressure persists', weight: 0.35 },
    ]);
    const hard = makePrediction('conflict', 'Mali', 'Escalation risk: Mali', 0.5, 0.58, '14d', [
      { type: 'conflict_events', value: '4 cross-border events in Mali', weight: 0.35 },
    ]);

    buildForecastCases([judged, hard]);
    for (const pred of [judged, hard]) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.6 };
      pred.analysisPriority = 0.12;
    }

    const deadline = Date.parse('2026-08-01T00:00:00Z');
    judged.resolution = {
      kind: 'judged',
      deadline,
      question: 'Will French political pressure materially escalate?',
    };
    hard.resolution = {
      kind: 'hard',
      metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Mali)`,
      operator: '>=',
      threshold: 1,
      window: 'within-horizon',
      deadline,
      sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
    };

    const pool = selectPublishedForecastPool([judged, hard], { targetCount: 1 });
    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, hard.id);
    assert.ok(hard.publishSelectionScore > judged.publishSelectionScore);
  });

  it('rebalances the freshest selected snapshot to >=80% hard when hard supply exists', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const forecasts = [];

    for (let i = 0; i < 6; i++) {
      const judged = makePrediction('military', `Theater ${i}`, `Military posture: Theater ${i}`, 0.75, 0.7, '7d', [
        { type: 'theater', value: `Theater ${i} posture: elevated`, weight: 0.45 },
      ]);
      judged.id = `judged-${i}`;
      judged.traceMeta = { narrativeSource: 'fallback' };
      judged.readiness = { overall: 0.7 };
      judged.analysisPriority = 0.8;
      judged.resolution = {
        kind: 'judged',
        deadline,
        question: `Will Theater ${i} posture escalate?`,
      };
      forecasts.push(judged);
    }

    for (let i = 0; i < 10; i++) {
      const hard = makePrediction('conflict', `Country ${i}`, `Escalation risk: Country ${i}`, 0.5, 0.6, '7d', [
        { type: 'conflict_events', value: `4 cross-border events in Country ${i}`, weight: 0.35 },
      ]);
      hard.id = `hard-${i}`;
      hard.traceMeta = { narrativeSource: 'fallback' };
      hard.readiness = { overall: 0.65 };
      hard.analysisPriority = 0.5;
      hard.resolution = {
        kind: 'hard',
        metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Country ${i})`,
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline,
        sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
      };
      forecasts.push(hard);
    }

    const pool = selectPublishedForecastPool(forecasts, { targetCount: 10 });
    const hardCount = pool.filter((pred) => pred.resolution?.kind === 'hard').length;
    assert.equal(pool.length, 10);
    assert.ok(hardCount >= 8, `expected >=8 hard forecasts, got ${hardCount}`);
  });

  it('preserves sole guaranteed military and strategic supply-chain forecasts during hard rebalance', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const rankedJudged = Array.from({ length: 10 }, (_, index) => {
      const pred = makePrediction('market', `Ranked market ${index}`, `Market repricing: Ranked market ${index}`, 0.77 - (index * 0.01), 0.68, '7d', [
        { type: 'market_signal', value: `Ranked market ${index} remains elevated`, weight: 0.4 },
      ]);
      pred.id = `ranked-judged-${index}`;
      pred.resolution = { kind: 'judged', deadline, question: `Will ranked market ${index} reprice?` };
      attachPublishSelectionContext(pred, {
        stateId: `state-ranked-judged-${index}`,
        situationId: `sit-ranked-judged-${index}`,
        familyId: `fam-ranked-judged-${index}`,
        priority: 0.9 - (index * 0.015),
        readiness: 0.88 - (index * 0.01),
      });
      return pred;
    });

    const military = makePrediction('military', 'Baltic airspace', 'Military posture: Baltic airspace', 0.52, 0.54, '7d', [
      { type: 'theater', value: 'Baltic patrol activity remains elevated', weight: 0.35 },
    ]);
    military.id = 'guaranteed-military';
    military.resolution = { kind: 'judged', deadline, question: 'Will Baltic posture escalate?' };
    attachPublishSelectionContext(military, {
      stateId: 'state-guaranteed-military',
      situationId: 'sit-guaranteed-military',
      familyId: 'fam-guaranteed-military',
      priority: 0.02,
      readiness: 0.52,
    });

    const supply = makePrediction('supply_chain', 'Strait of Hormuz', 'Shipping disruption: Strait of Hormuz', 0.51, 0.53, '14d', [
      { type: 'shipping_cost_shock', value: 'Shipping reroutes persist through the Hormuz corridor.', weight: 0.35 },
    ]);
    supply.id = 'guaranteed-strategic-supply';
    supply.marketSelectionContext = {
      confirmationScore: 0.38,
      contradictionScore: 0.05,
      topBucketId: 'freight',
      topBucketLabel: 'Freight',
      topBucketPressure: 0.44,
      transmissionEdgeCount: 1,
      criticalSignalLift: 0.25,
      topChannel: 'shipping_cost_shock',
      linkedBucketIds: ['freight'],
    };
    supply.resolution = { kind: 'judged', deadline, question: 'Will Hormuz shipping disruption persist?' };
    attachPublishSelectionContext(supply, {
      stateId: 'state-guaranteed-supply',
      situationId: 'sit-guaranteed-supply',
      familyId: 'fam-guaranteed-supply',
      stateKind: 'maritime_disruption',
      priority: 0.03,
      readiness: 0.54,
      topSignals: [{ type: 'shipping_cost_shock' }],
    });

    const hardCandidates = Array.from({ length: 8 }, (_, index) => {
      const hard = makePrediction('conflict', `Hard country ${index}`, `Escalation risk: Hard country ${index}`, 0.51, 0.57, '7d', [
        { type: 'conflict_events', value: `4 conflict events in Hard country ${index}`, weight: 0.35 },
      ]);
      hard.id = `domain-guard-hard-${index}`;
      hard.resolution = {
        kind: 'hard',
        metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Hard country ${index})`,
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline,
        sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
      };
      attachPublishSelectionContext(hard, {
        stateId: `state-domain-guard-hard-${index}`,
        situationId: `sit-domain-guard-hard-${index}`,
        familyId: `fam-domain-guard-hard-${index}`,
        priority: 0.05,
        readiness: 0.55,
      });
      return hard;
    });

    const pool = selectPublishedForecastPool([...rankedJudged, military, supply, ...hardCandidates], { targetCount: 10 });
    const poolIds = pool.map((pred) => pred.id);
    const hardCount = pool.filter((pred) => pred.resolution?.kind === 'hard').length;
    assert.ok(poolIds.includes(military.id), poolIds.join(', '));
    assert.ok(poolIds.includes(supply.id), poolIds.join(', '));
    assert.equal(hardCount, 8, poolIds.join(', '));
  });

  it('tops out hard rebalance at constrained hard supply', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const judged = Array.from({ length: 10 }, (_, index) => {
      const pred = makePrediction('market', `Constrained market ${index}`, `Market repricing: Constrained market ${index}`, 0.76 - (index * 0.01), 0.68, '7d', [
        { type: 'market_signal', value: `Constrained market ${index} remains elevated`, weight: 0.4 },
      ]);
      pred.id = `constrained-judged-${index}`;
      pred.resolution = { kind: 'judged', deadline, question: `Will constrained market ${index} reprice?` };
      attachPublishSelectionContext(pred, {
        stateId: `state-constrained-judged-${index}`,
        situationId: `sit-constrained-judged-${index}`,
        familyId: `fam-constrained-judged-${index}`,
        priority: 0.84 - (index * 0.015),
        readiness: 0.84,
      });
      return pred;
    });
    const hardCandidates = Array.from({ length: 2 }, (_, index) => {
      const hard = makePrediction('conflict', `Constrained hard ${index}`, `Escalation risk: Constrained hard ${index}`, 0.51, 0.56, '7d', [
        { type: 'conflict_events', value: `4 conflict events in Constrained hard ${index}`, weight: 0.35 },
      ]);
      hard.id = `constrained-hard-${index}`;
      hard.resolution = {
        kind: 'hard',
        metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Constrained hard ${index})`,
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline,
        sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
      };
      attachPublishSelectionContext(hard, {
        stateId: `state-constrained-hard-${index}`,
        situationId: `sit-constrained-hard-${index}`,
        familyId: `fam-constrained-hard-${index}`,
        priority: 0.04,
        readiness: 0.54,
      });
      return hard;
    });

    const pool = selectPublishedForecastPool([...judged, ...hardCandidates], { targetCount: 10 });
    const hardCount = pool.filter((pred) => pred.resolution?.kind === 'hard').length;
    assert.equal(pool.length, 10);
    assert.equal(hardCount, 2, pool.map((pred) => pred.id).join(', '));
  });

  it('leaves selection unchanged when every hard rebalance candidate is cap-blocked', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const judged = Array.from({ length: 8 }, (_, index) => {
      const pred = makePrediction('market', `Blocked market ${index}`, `Market repricing: Blocked market ${index}`, 0.74 - (index * 0.01), 0.66, '7d', [
        { type: 'market_signal', value: `Blocked market ${index} remains elevated`, weight: 0.4 },
      ]);
      pred.id = `cap-blocked-judged-${index}`;
      pred.resolution = { kind: 'judged', deadline, question: `Will blocked market ${index} reprice?` };
      attachPublishSelectionContext(pred, {
        stateId: `state-cap-blocked-judged-${index}`,
        situationId: `sit-cap-blocked-judged-${index}`,
        familyId: `fam-cap-blocked-judged-${index}`,
        priority: 0.72 - (index * 0.02),
        readiness: 0.78,
      });
      return pred;
    });
    const hardCandidates = Array.from({ length: 3 }, (_, index) => {
      const hard = makePrediction('conflict', `Blocked hard ${index}`, `Escalation risk: Blocked hard ${index}`, 0.55, 0.58, '7d', [
        { type: 'conflict_events', value: `4 conflict events in Blocked hard ${index}`, weight: 0.35 },
      ]);
      hard.id = `cap-blocked-hard-${index}`;
      hard.resolution = {
        kind: 'hard',
        metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Blocked hard ${index})`,
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline,
        sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
      };
      attachPublishSelectionContext(hard, {
        stateId: `state-cap-blocked-hard-${index}`,
        situationId: `sit-cap-blocked-hard-${index}`,
        familyId: 'fam-cap-blocked-hard',
        priority: index < 2 ? 0.94 - (index * 0.01) : 0.01,
        readiness: index < 2 ? 0.86 : 0.5,
      });
      return hard;
    });

    const pool = selectPublishedForecastPool([...judged, ...hardCandidates], { targetCount: 10 });
    const poolIds = new Set(pool.map((pred) => pred.id));
    assert.equal(pool.length, 10);
    assert.ok(poolIds.has(hardCandidates[0].id));
    assert.ok(poolIds.has(hardCandidates[1].id));
    assert.ok(!poolIds.has(hardCandidates[2].id));
    for (const pred of judged) assert.ok(poolIds.has(pred.id), [...poolIds].join(', '));
  });

  it('keeps the hard situation cap while rebalancing for resolution coverage', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const hormuzState = {
      id: 'state-hormuz-cap',
      label: 'Hormuz maritime disruption state',
      dominantRegion: 'Strait of Hormuz',
      dominantDomain: 'market',
      forecastCount: 3,
      familyId: 'fam-hormuz-cap',
      topSignals: [{ type: 'shipping_cost_shock' }, { type: 'energy_supply_shock' }],
    };
    const hormuzSituation = {
      id: 'sit-hormuz-cap',
      label: 'Hormuz maritime disruption situation',
      forecastCount: 3,
      topSignals: [{ type: 'shipping_cost_shock', count: 1 }],
    };
    const hormuzFamily = {
      id: 'fam-hormuz-cap',
      label: 'Hormuz maritime pressure family',
      forecastCount: 3,
      situationCount: 1,
      situationIds: [hormuzSituation.id],
    };

    function attachSelectionContext(pred, state, family, priority, readiness = 0.74) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: readiness };
      pred.analysisPriority = priority;
      pred.stateContext = state;
      pred.situationContext = state === hormuzState ? hormuzSituation : {
        id: `sit-${state.id}`,
        label: `${state.label} situation`,
        forecastCount: 1,
        topSignals: [{ type: 'news_corroboration', count: 1 }],
      };
      pred.familyContext = family;
      pred.caseFile = pred.caseFile || {};
      pred.caseFile.situationContext = pred.situationContext;
      pred.caseFile.familyContext = family;
    }

    const market = makePrediction('market', 'Gulf benchmark', 'Energy repricing risk: Gulf benchmark', 0.76, 0.68, '14d', [
      { type: 'energy_supply_shock', value: 'Energy repricing persists around Hormuz risk.', weight: 0.36 },
    ]);
    market.id = 'hormuz-market-judged';
    market.marketSelectionContext = {
      confirmationScore: 0.66,
      contradictionScore: 0.04,
      topBucketId: 'energy',
      topBucketLabel: 'Energy',
      topBucketPressure: 0.71,
      transmissionEdgeCount: 3,
      criticalSignalLift: 0.6,
      topChannel: 'energy_supply_shock',
      linkedBucketIds: ['energy', 'freight'],
    };
    market.resolution = { kind: 'judged', deadline, question: 'Will Hormuz energy repricing escalate?' };
    attachSelectionContext(market, hormuzState, hormuzFamily, 0.9, 0.86);

    const supply = makePrediction('supply_chain', 'Strait of Hormuz', 'Shipping disruption: Strait of Hormuz', 0.74, 0.66, '14d', [
      { type: 'shipping_cost_shock', value: 'Shipping reroutes persist through the Hormuz corridor.', weight: 0.35 },
    ]);
    supply.id = 'hormuz-supply-judged';
    supply.marketSelectionContext = {
      confirmationScore: 0.62,
      contradictionScore: 0.04,
      topBucketId: 'freight',
      topBucketLabel: 'Freight',
      topBucketPressure: 0.67,
      transmissionEdgeCount: 3,
      criticalSignalLift: 0.58,
      topChannel: 'shipping_cost_shock',
      linkedBucketIds: ['freight', 'energy'],
    };
    supply.resolution = { kind: 'judged', deadline, question: 'Will Hormuz shipping disruption escalate?' };
    attachSelectionContext(supply, hormuzState, hormuzFamily, 0.88, 0.84);

    const hardSameState = makePrediction('market', 'Gulf benchmark', 'Hard benchmark trigger: Gulf benchmark', 0.55, 0.6, '14d', [
      { type: 'energy_supply_shock', value: 'Energy benchmark pressure remains visible around Hormuz.', weight: 0.3 },
    ]);
    hardSameState.id = 'hormuz-hard-same-state';
    hardSameState.marketSelectionContext = {
      confirmationScore: 0.4,
      contradictionScore: 0.05,
      topBucketId: 'energy',
      topBucketLabel: 'Energy',
      topBucketPressure: 0.45,
      transmissionEdgeCount: 1,
      criticalSignalLift: 0.25,
      topChannel: 'energy_supply_shock',
      linkedBucketIds: ['energy'],
    };
    hardSameState.resolution = {
      kind: 'hard',
      metricKey: 'market|hormuz_energy_benchmark',
      operator: '>=',
      threshold: 1,
      window: 'within-horizon',
      deadline,
      sourceFeed: 'market',
    };
    attachSelectionContext(hardSameState, hormuzState, hormuzFamily, 0.08, 0.58);

    const otherJudged = Array.from({ length: 3 }, (_, index) => {
      const pred = makePrediction('military', `Theater ${index}`, `Military posture: Theater ${index}`, 0.73 - (index * 0.01), 0.66, '7d', [
        { type: 'theater', value: `Theater ${index} posture: elevated`, weight: 0.45 },
      ]);
      pred.id = `other-judged-${index}`;
      pred.resolution = { kind: 'judged', deadline, question: `Will Theater ${index} posture escalate?` };
      const state = {
        id: `state-other-${index}`,
        label: `Other theater ${index}`,
        dominantRegion: `Theater ${index}`,
        dominantDomain: 'military',
        forecastCount: 1,
        familyId: `fam-other-${index}`,
        topSignals: [{ type: 'theater' }],
      };
      const family = {
        id: `fam-other-${index}`,
        label: `Other theater family ${index}`,
        forecastCount: 1,
        situationCount: 1,
        situationIds: [`sit-state-other-${index}`],
      };
      attachSelectionContext(pred, state, family, 0.7 - (index * 0.04), 0.76);
      return pred;
    });

    const pool = selectPublishedForecastPool([market, supply, hardSameState, ...otherJudged], { targetCount: 5 });
    const hormuzCount = pool.filter((pred) => pred.stateContext?.id === hormuzState.id).length;
    assert.equal(pool.length, 5);
    const poolIds = pool.map((pred) => pred.id).join(', ');
    const scoreSummary = [market, supply, hardSameState, ...otherJudged]
      .map((pred) => `${pred.id}:${pred.publishSelectionScore}`)
      .join(', ');
    assert.ok(pool.some((pred) => pred.id === hardSameState.id), `${poolIds} / ${scoreSummary}`);
    assert.equal(hormuzCount, 2, `${poolIds} / ${scoreSummary}`);
  });

  it('does not add a non-follow-on same-situation hard forecast while rebalancing', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const sharedState = {
      id: 'state-shared-soft-guard',
      label: 'Shared market pressure state',
      dominantRegion: 'Shared corridor',
      dominantDomain: 'market',
      forecastCount: 2,
      familyId: 'fam-shared-soft-guard',
      topSignals: [{ type: 'energy_supply_shock' }],
    };
    const sharedSituation = {
      id: 'sit-shared-soft-guard',
      label: 'Shared market pressure situation',
      forecastCount: 2,
      topSignals: [{ type: 'energy_supply_shock', count: 1 }],
    };
    const sharedFamily = {
      id: 'fam-shared-soft-guard',
      label: 'Shared market pressure family',
      forecastCount: 2,
      situationCount: 1,
      situationIds: [sharedSituation.id],
    };

    function attachSelectionContext(pred, state, family, priority, readiness = 0.74) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: readiness };
      pred.analysisPriority = priority;
      pred.stateContext = state;
      pred.situationContext = state === sharedState ? sharedSituation : {
        id: `sit-${state.id}`,
        label: `${state.label} situation`,
        forecastCount: 1,
        topSignals: [{ type: 'news_corroboration', count: 1 }],
      };
      pred.familyContext = family;
      pred.caseFile = pred.caseFile || {};
      pred.caseFile.situationContext = pred.situationContext;
      pred.caseFile.familyContext = family;
    }

    const judgedShared = makePrediction('market', 'Shared corridor', 'Energy repricing risk: Shared corridor', 0.78, 0.7, '14d', [
      { type: 'energy_supply_shock', value: 'Energy repricing remains active in the shared corridor.', weight: 0.36 },
    ]);
    judgedShared.id = 'shared-market-judged';
    judgedShared.marketSelectionContext = {
      confirmationScore: 0.68,
      contradictionScore: 0.03,
      topBucketId: 'energy',
      topBucketLabel: 'Energy',
      topBucketPressure: 0.72,
      transmissionEdgeCount: 3,
      criticalSignalLift: 0.61,
      topChannel: 'energy_supply_shock',
      linkedBucketIds: ['energy'],
    };
    judgedShared.resolution = { kind: 'judged', deadline, question: 'Will shared corridor repricing escalate?' };
    attachSelectionContext(judgedShared, sharedState, sharedFamily, 0.92, 0.88);

    const hardSameState = makePrediction('market', 'Shared corridor', 'Hard market trigger: Shared corridor', 0.52, 0.56, '14d', [
      { type: 'energy_supply_shock', value: 'A hard threshold remains observable for shared corridor pricing.', weight: 0.3 },
    ]);
    hardSameState.id = 'shared-hard-same-state';
    hardSameState.marketSelectionContext = {
      confirmationScore: 0.38,
      contradictionScore: 0.05,
      topBucketId: 'energy',
      topBucketLabel: 'Energy',
      topBucketPressure: 0.41,
      transmissionEdgeCount: 1,
      criticalSignalLift: 0.2,
      topChannel: 'energy_supply_shock',
      linkedBucketIds: ['energy'],
    };
    hardSameState.resolution = {
      kind: 'hard',
      metricKey: 'market|shared_corridor_trigger',
      operator: '>=',
      threshold: 1,
      window: 'within-horizon',
      deadline,
      sourceFeed: 'market',
    };
    attachSelectionContext(hardSameState, sharedState, sharedFamily, 0.02, 0.52);

    const otherJudged = Array.from({ length: 4 }, (_, index) => {
      const pred = makePrediction('military', `Other theater ${index}`, `Military posture: Other theater ${index}`, 0.72 - (index * 0.01), 0.66, '7d', [
        { type: 'theater', value: `Other theater ${index} posture: elevated`, weight: 0.45 },
      ]);
      pred.id = `soft-guard-other-${index}`;
      pred.resolution = { kind: 'judged', deadline, question: `Will other theater ${index} posture escalate?` };
      const state = {
        id: `state-soft-guard-other-${index}`,
        label: `Soft guard other theater ${index}`,
        dominantRegion: `Other theater ${index}`,
        dominantDomain: 'military',
        forecastCount: 1,
        familyId: `fam-soft-guard-other-${index}`,
        topSignals: [{ type: 'theater' }],
      };
      const family = {
        id: `fam-soft-guard-other-${index}`,
        label: `Soft guard other family ${index}`,
        forecastCount: 1,
        situationCount: 1,
        situationIds: [`sit-state-soft-guard-other-${index}`],
      };
      attachSelectionContext(pred, state, family, 0.68 - (index * 0.04), 0.76);
      return pred;
    });

    const pool = selectPublishedForecastPool([judgedShared, hardSameState, ...otherJudged], { targetCount: 5 });
    const sameStatePool = pool.filter((pred) => pred.stateContext?.id === sharedState.id);
    const poolIds = pool.map((pred) => pred.id).join(', ');
    assert.equal(pool.length, 5);
    assert.deepEqual(sameStatePool.map((pred) => pred.id), [hardSameState.id], poolIds);
  });

  it('prefers deferred hard forecasts while backfilling a below-target published set', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const judged = makePrediction('military', 'Theater', 'Military posture: Theater', 0.7, 0.7, '7d', [
      { type: 'theater', value: 'Theater posture: elevated', weight: 0.45 },
    ]);
    judged.id = 'deferred-judged';
    judged.resolution = {
      kind: 'judged',
      deadline,
      question: 'Will theater posture escalate?',
    };

    const hard = makePrediction('conflict', 'Mali', 'Escalation risk: Mali', 0.5, 0.6, '7d', [
      { type: 'conflict_events', value: '4 cross-border events in Mali', weight: 0.35 },
    ]);
    hard.id = 'deferred-hard';
    hard.resolution = {
      kind: 'hard',
      metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Mali)`,
      operator: '>=',
      threshold: 1,
      window: 'within-horizon',
      deadline,
      sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
    };

    const published = Array.from({ length: 7 }, (_, index) => {
      const item = makePrediction('market', `Market ${index}`, `Market repricing: ${index}`, 0.6, 0.6, '7d', []);
      item.id = `published-judged-${index}`;
      item.resolution = { kind: 'judged', deadline, question: `Will market ${index} reprice?` };
      return item;
    });

    const deferred = [judged, hard];
    const next = selectDeferredForecastForPublishBackfill(deferred, published, 10);
    assert.equal(next.id, hard.id);
    assert.deepEqual(deferred.map((pred) => pred.id), [judged.id]);
  });

  it('preserves FIFO deferred backfill when hard coverage does not require a hard candidate', () => {
    const deadline = Date.parse('2026-08-01T00:00:00Z');
    const first = makePrediction('market', 'Market A', 'Market repricing: A', 0.65, 0.6, '7d', []);
    first.id = 'deferred-fifo-first';
    first.resolution = { kind: 'judged', deadline, question: 'Will market A reprice?' };
    const second = makePrediction('market', 'Market B', 'Market repricing: B', 0.63, 0.6, '7d', []);
    second.id = 'deferred-fifo-second';
    second.resolution = { kind: 'judged', deadline, question: 'Will market B reprice?' };

    const deferred = [first, second];
    const next = selectDeferredForecastForPublishBackfill(deferred, [], 2);
    assert.equal(next.id, first.id);
    assert.deepEqual(deferred.map((pred) => pred.id), [second.id]);
  });

  it('reports hard-resolution coverage telemetry for candidate, selected, and published pools', () => {
    const hard = { id: 'telemetry-hard', domain: 'conflict', resolution: { kind: 'hard' } };
    const judgedA = { id: 'telemetry-judged-a', domain: 'market', resolution: { kind: 'judged' } };
    const judgedB = { id: 'telemetry-judged-b', domain: 'military', resolution: { kind: 'judged' } };

    const telemetry = summarizePublishFiltering([hard, judgedA, judgedB], [hard, judgedA], [hard]);
    assert.deepEqual(telemetry.candidateResolutionCoverage, {
      total: 3,
      hard: 1,
      judged: 2,
      hardRatio: 0.333333,
    });
    assert.deepEqual(telemetry.selectedResolutionCoverage, {
      total: 2,
      hard: 1,
      judged: 1,
      hardRatio: 0.5,
    });
    assert.deepEqual(telemetry.publishedResolutionCoverage, {
      total: 1,
      hard: 1,
      judged: 0,
      hardRatio: 1,
    });

    const emptyTelemetry = summarizePublishFiltering([], [], []);
    assert.deepEqual(emptyTelemetry.candidateResolutionCoverage, {
      total: 0,
      hard: 0,
      judged: 0,
      hardRatio: 0,
    });
    assert.deepEqual(emptyTelemetry.selectedResolutionCoverage, emptyTelemetry.candidateResolutionCoverage);
    assert.deepEqual(emptyTelemetry.publishedResolutionCoverage, emptyTelemetry.candidateResolutionCoverage);
  });

  it('keeps strategic supply-chain forecasts alive alongside same-state market repricing and reports survival telemetry', () => {
    const market = makePrediction('market', 'Strait of Hormuz', 'Energy repricing risk: Strait of Hormuz', 0.66, 0.61, '30d', [
      { type: 'energy_supply_shock', value: 'Energy repricing persists around Hormuz shipping stress.', weight: 0.36 },
    ]);
    const supply = makePrediction('supply_chain', 'Strait of Hormuz', 'Shipping disruption: Strait of Hormuz', 0.59, 0.57, '14d', [
      { type: 'shipping_cost_shock', value: 'Shipping reroutes persist through the Hormuz corridor.', weight: 0.35 },
    ]);
    const conflict = makePrediction('conflict', 'Brazil', 'Escalation risk: Brazil', 0.67, 0.62, '7d', [
      { type: 'ucdp', value: 'Brazil conflict pressure remains active.', weight: 0.4 },
    ]);

    buildForecastCases([market, supply, conflict]);
    for (const [index, pred] of [market, supply, conflict].entries()) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.readiness = { overall: 0.7 - (index * 0.04) };
      pred.analysisPriority = 0.26 - (index * 0.02);
    }

    const hormuzSituation = {
      id: 'sit-hormuz',
      label: 'Hormuz maritime disruption situation',
      dominantRegion: 'Strait of Hormuz',
      dominantDomain: 'market',
      regions: ['Strait of Hormuz'],
      domains: ['market', 'supply_chain'],
      actors: ['Shipping operator'],
      branchKinds: ['base'],
      forecastIds: [market.id, supply.id],
      forecastCount: 2,
      avgProbability: 0.625,
      avgConfidence: 0.59,
      topSignals: [{ type: 'shipping_cost_shock', count: 1 }, { type: 'energy_supply_shock', count: 1 }],
      sampleTitles: [market.title, supply.title],
    };
    const brazilSituation = {
      id: 'sit-brazil',
      label: 'Brazil escalation situation',
      dominantRegion: 'Brazil',
      dominantDomain: 'conflict',
      regions: ['Brazil'],
      domains: ['conflict'],
      actors: ['Regional forces'],
      branchKinds: ['base'],
      forecastIds: [conflict.id],
      forecastCount: 1,
      avgProbability: 0.67,
      avgConfidence: 0.62,
      topSignals: [{ type: 'ucdp', count: 1 }],
      sampleTitles: [conflict.title],
    };
    const hormuzState = {
      id: 'state-hormuz',
      label: 'Strait of Hormuz maritime disruption state',
      dominantRegion: 'Strait of Hormuz',
      dominantDomain: 'market',
      forecastCount: 2,
      familyId: 'fam-hormuz',
      topSignals: [{ type: 'shipping_cost_shock' }, { type: 'energy_supply_shock' }],
    };
    const hormuzFamily = { id: 'fam-hormuz', label: 'Hormuz maritime pressure family', forecastCount: 2, situationCount: 1, situationIds: ['sit-hormuz'] };
    const brazilFamily = { id: 'fam-brazil', label: 'Brazil escalation family', forecastCount: 1, situationCount: 1, situationIds: ['sit-brazil'] };

    market.stateContext = hormuzState;
    supply.stateContext = { ...hormuzState, dominantDomain: 'supply_chain' };
    conflict.stateContext = {
      id: 'state-brazil',
      label: 'Brazil security escalation state',
      dominantRegion: 'Brazil',
      dominantDomain: 'conflict',
      forecastCount: 1,
      familyId: 'fam-brazil',
      topSignals: [{ type: 'ucdp' }],
    };
    market.situationContext = hormuzSituation;
    supply.situationContext = hormuzSituation;
    conflict.situationContext = brazilSituation;
    market.familyContext = hormuzFamily;
    supply.familyContext = hormuzFamily;
    conflict.familyContext = brazilFamily;
    market.caseFile.situationContext = market.situationContext;
    supply.caseFile.situationContext = supply.situationContext;
    conflict.caseFile.situationContext = conflict.situationContext;
    market.caseFile.familyContext = hormuzFamily;
    supply.caseFile.familyContext = hormuzFamily;
    conflict.caseFile.familyContext = brazilFamily;

    market.marketSelectionContext = {
      confirmationScore: 0.66,
      contradictionScore: 0.04,
      topBucketId: 'energy',
      topBucketLabel: 'Energy',
      topBucketPressure: 0.71,
      transmissionEdgeCount: 3,
      criticalSignalLift: 0.6,
      topChannel: 'energy_supply_shock',
      linkedBucketIds: ['energy', 'freight'],
    };
    supply.marketSelectionContext = {
      confirmationScore: 0.62,
      contradictionScore: 0.04,
      topBucketId: 'freight',
      topBucketLabel: 'Freight',
      topBucketPressure: 0.67,
      transmissionEdgeCount: 3,
      criticalSignalLift: 0.58,
      topChannel: 'shipping_cost_shock',
      linkedBucketIds: ['freight', 'energy'],
    };
    conflict.marketSelectionContext = {
      confirmationScore: 0.28,
      contradictionScore: 0.1,
      topBucketId: 'sovereign_risk',
      topBucketLabel: 'Sovereign Risk',
      topBucketPressure: 0.39,
      transmissionEdgeCount: 1,
      criticalSignalLift: 0.18,
      topChannel: 'security_spillover',
      linkedBucketIds: ['sovereign_risk'],
    };

    const selected = selectPublishedForecastPool([market, supply, conflict], { targetCount: 2 });

    assert.ok(selected.some((pred) => pred.id === market.id));
    assert.ok(selected.some((pred) => pred.id === supply.id));

    const telemetry = summarizePublishFiltering([market, supply, conflict], selected, selected);
    assert.equal(telemetry.candidateSupplyChainCount, 1);
    assert.equal(telemetry.selectedSupplyChainCount, 1);
    assert.equal(telemetry.publishedSupplyChainCount, 1);
  });

  it('does not report capped situations when a situation only reaches the cap without dropping anything', () => {
    const preds = [
      makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.66, 0.6, '7d', [
        { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.5 },
      ]),
      makePrediction('political', 'Iran', 'Political instability: Iran', 0.55, 0.54, '14d', [
        { type: 'news_corroboration', value: 'Emergency cabinet meetings continue', weight: 0.35 },
      ]),
      makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.48, 0.52, '30d', [
        { type: 'news_corroboration', value: 'Oil traders react to Hormuz risk', weight: 0.4 },
      ]),
    ];

    buildForecastCases(preds);
    for (const [index, pred] of preds.entries()) {
      pred.traceMeta = { narrativeSource: 'fallback' };
      pred.situationContext = {
        id: 'sit-iran-gulf',
        label: 'Iran Gulf pressure',
        forecastCount: 3,
        topSignals: [{ type: 'news_corroboration', count: 2 }],
      };
      pred.caseFile.situationContext = pred.situationContext;
      pred.readiness = { overall: 0.65 - (index * 0.05) };
      pred.analysisPriority = 0.22 - (index * 0.03);
    }

    const published = filterPublishedForecasts(preds);
    assert.equal(published.length, 3);

    const telemetry = summarizePublishFiltering(preds);
    assert.equal(telemetry.suppressedSituationCap, 0);
    assert.equal(telemetry.cappedSituations, 0);
  });

  it('keeps unrelated forecasts in separate situations instead of token-only over-merging', () => {
    const conflict = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.65, 0.58, '7d', [
      { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.5 },
    ]);
    const cyber = makePrediction('cyber', 'Estonia', 'Cyber disruption risk: Estonia', 0.43, 0.52, '7d', [
      { type: 'news_corroboration', value: 'Estonia reports sustained cyber probing', weight: 0.35 },
    ]);

    buildForecastCases([conflict, cyber]);
    const worldState = buildForecastRunWorldState({ predictions: [conflict, cyber] });

    assert.equal(worldState.situationClusters.length, 2);
    assert.ok(worldState.situationClusters.every((cluster) => cluster.label.endsWith('situation')));
    assert.ok(worldState.situationClusters.every((cluster) => !/fc-[a-z]+-[0-9a-f]{8}/.test(cluster.label)));
  });

});

describe('stable forecast ids: semantic slots, not volatile titles (#4933)', () => {
  const now = Date.now();
  const milInputs = (country, type) => ({
    militaryForecastInputs: {
      fetchedAt: now,
      theaters: [{ id: 'iran-theater', postureLevel: 'elevated', assessedAt: now }],
      surges: [{
        theaterId: 'iran-theater', surgeType: type, dominantCountry: country,
        fighters: 5, strikeCapable: true, persistent: true, surgeMultiple: 4, assessedAt: now,
      }],
    },
    temporalAnomalies: [],
  });

  it('military id is stable across surge-type and country changes in the same theater', () => {
    const a = detectMilitaryScenarios(milInputs('US', 'fighter'));
    const b = detectMilitaryScenarios(milInputs('Israel', 'airlift'));
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.notEqual(a[0].title, b[0].title);
    assert.equal(a[0].id, b[0].id);
  });

  it('military ids differ across theaters', () => {
    const preds = detectMilitaryScenarios({
      militaryForecastInputs: {
        fetchedAt: now,
        theaters: [
          { id: 'iran-theater', postureLevel: 'elevated', assessedAt: now },
          { id: 'taiwan-theater', postureLevel: 'elevated', assessedAt: now },
        ],
        surges: [],
      },
      temporalAnomalies: [],
    });
    assert.equal(preds.length, 2);
    assert.notEqual(preds[0].id, preds[1].id);
  });

  it('trend continuity survives a military title change', () => {
    const a = detectMilitaryScenarios(milInputs('US', 'fighter'));
    const b = detectMilitaryScenarios(milInputs('Israel', 'airlift'));
    const priorSnap = buildPriorForecastSnapshot({ ...a[0], probability: 0.1 });
    computeTrends(b, { predictions: [priorSnap] });
    assert.equal(b[0].trend, 'rising');
    assert.equal(b[0].priorProbability, 0.1);
  });

  it('state-derived id keys on the stable state-unit identity, not the volatile cluster label', () => {
    const mkUnit = (label) => ({
      id: 'state-abc123', label, stateKind: 'market_stress',
      dominantRegion: 'Middle East', regions: ['Middle East'],
      avgProbability: 0.5, avgConfidence: 0.5,
      situationCount: 2, forecastCount: 3,
    });
    const bucket = { id: 'energy', label: 'Energy', pressureScore: 0.6, confidence: 0.5 };
    const candidate = { score: 0.6, criticalLift: 0, primarySignalType: 'energy_supply_shock', primaryChannel: 'energy' };
    const a = buildStateDerivedForecast(mkUnit('Hormuz pressure complex'), 'market', bucket, candidate, null);
    const b = buildStateDerivedForecast(mkUnit('Gulf energy stress cluster'), 'market', bucket, candidate, null);
    assert.notEqual(a.title, b.title);
    assert.equal(a.id, b.id);
  });

  it('caps state-derived market and supply-chain forecasts like first-party detectors', () => {
    const stateUnit = {
      id: 'state-cap-test', label: 'High pressure state', stateKind: 'market_stress',
      dominantRegion: 'Middle East', regions: ['Middle East'],
      avgProbability: 1, avgConfidence: 0.8,
      situationCount: 3, forecastCount: 4,
    };
    const bucket = { id: 'energy', label: 'Energy', pressureScore: 1, confidence: 0.8 };
    const candidate = { score: 1, criticalLift: 0.2, primarySignalType: 'energy_supply_shock', primaryChannel: 'energy' };

    const market = buildStateDerivedForecast(stateUnit, 'market', bucket, candidate, null);
    const supplyChain = buildStateDerivedForecast(stateUnit, 'supply_chain', bucket, candidate, null);

    assert.equal(market.probability, 0.85);
    assert.equal(supplyChain.probability, 0.85);
  });

  it('two DISTINCT state units in the same region+bucket keep distinct ids (no slot collapse)', () => {
    const mkUnit = (id, label) => ({
      id, label, stateKind: 'market_stress',
      dominantRegion: 'Middle East', regions: ['Middle East'],
      avgProbability: 0.5, avgConfidence: 0.5,
      situationCount: 2, forecastCount: 3,
    });
    const bucket = { id: 'energy', label: 'Energy', pressureScore: 0.6, confidence: 0.5 };
    const candidate = { score: 0.6, criticalLift: 0, primarySignalType: 'energy_supply_shock', primaryChannel: 'energy' };
    const a = buildStateDerivedForecast(mkUnit('state-hormuz1', 'Hormuz pressure complex'), 'market', bucket, candidate, null);
    const b = buildStateDerivedForecast(mkUnit('state-redsea2', 'Red Sea freight stress'), 'market', bucket, candidate, null);
    assert.notEqual(a.id, b.id);
  });

  it('forecastIdFromKey is deterministic, domain-scoped, and keeps the fc-<domain>-<8hex> format', () => {
    assert.equal(forecastIdFromKey('military', 'theater:iran-theater'), forecastIdFromKey('military', 'theater:iran-theater'));
    assert.notEqual(forecastIdFromKey('military', 'theater:iran-theater'), forecastIdFromKey('conflict', 'theater:iran-theater'));
    assert.match(forecastIdFromKey('military', 'theater:iran-theater'), /^fc-military-[0-9a-f]{8}$/);
  });
});
