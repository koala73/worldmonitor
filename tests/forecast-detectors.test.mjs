import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  forecastId,
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
  buildChangeItems,
  buildChangeSummary,
  annotateForecastChanges,
  buildCounterEvidence,
  buildCaseTriggers,
  buildForecastActors,
  buildForecastWorldState,
  buildForecastBranches,
  buildActorLenses,
  scoreForecastReadiness,
  computeAnalysisPriority,
  rankForecastsForAnalysis,
  filterPublishedForecasts,
  selectForecastsForEnrichment,
  buildFallbackScenario,
  buildFallbackBaseCase,
  buildFallbackEscalatoryCase,
  buildFallbackContrarianCase,
  buildFeedSummary,
  buildFallbackPerspectives,
  populateFallbackNarratives,
  loadCascadeRules,
  evaluateRuleConditions,
  SIGNAL_TO_SOURCE,
  PREDICATE_EVALUATORS,
  DEFAULT_CASCADE_RULES,
  PROJECTION_CURVES,
} from '../scripts/seed-forecasts.mjs';

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
      geopolitical: [{ title: 'Will Iran conflict escalate in MENA?', yesPrice: 30, source: 'polymarket' }],
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
      geopolitical: [{ title: 'Will EU inflation drop?', yesPrice: 50 }],
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
      geopolitical: [{ title: 'Iran MENA conflict?', yesPrice: 40 }],
    };
    calibrateWithMarkets([pred], markets);
    assert.equal(pred.calibration.drift, +(0.7 - 0.4).toFixed(3));
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

  it('can generate from unrest event counts even when CII unrest is weak', () => {
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
      unrestEvents: { events: [{ country: 'India' }, { country: 'India' }, { country: 'India' }] },
    };
    const result = detectPoliticalScenarios(inputs);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'political');
    assert.equal(result[0].region, 'India');
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

  it('buildFeedSummary stays compact and distinct from the deeper case output', () => {
    const pred = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    buildForecastCase(pred);
    pred.caseFile.baseCase = 'Iran CII 87 (critical) and 3 UCDP conflict events keep the base path elevated over the next 7d with persistent force pressure.';
    const summary = buildFeedSummary(pred);
    assert.ok(summary.length <= 180);
    assert.match(summary, /Iran CII 87/);
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
  it('anchors projection to timeHorizon', () => {
    const p = makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', []);
    computeProjections([p]);
    assert.ok(p.projections);
    // probability should equal the d7 projection (anchored to 7d)
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
