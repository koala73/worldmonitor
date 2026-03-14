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
  attachNewsContext,
  computeConfidence,
  sanitizeForPrompt,
  parseLLMScenarios,
  validateScenarios,
  SIGNAL_TO_SOURCE,
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
    resolveCascades(predictions);
    const domains = pred.cascades.map(c => c.domain);
    assert.ok(domains.includes('supply_chain'), 'should have supply_chain cascade');
    assert.ok(domains.includes('market'), 'should have market cascade');
  });

  it('cascade probabilities capped at 0.8', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.99, 0.9, '7d', [{ type: 'cii', value: 'high', weight: 0.4 }],
    );
    resolveCascades([pred]);
    for (const c of pred.cascades) {
      assert.ok(c.probability <= 0.8, `cascade probability ${c.probability} should be <= 0.8`);
    }
  });

  it('deduplication within a single call: same rule does not fire twice for same source', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation risk: Iran',
      0.7, 0.6, '7d', [{ type: 'cii', value: 'test', weight: 0.4 }],
    );
    resolveCascades([pred]);
    const keys = pred.cascades.map(c => `${c.domain}:${c.effect}`);
    const unique = new Set(keys);
    assert.equal(keys.length, unique.size, 'no duplicate cascade entries within one resolution');
  });

  it('no self-edges: cascade domain differs from source domain', () => {
    const pred = makePrediction(
      'conflict', 'Middle East', 'Escalation',
      0.7, 0.6, '7d', [{ type: 'cii', value: 'test', weight: 0.4 }],
    );
    resolveCascades([pred]);
    for (const c of pred.cascades) {
      assert.notEqual(c.domain, pred.domain, `cascade domain ${c.domain} should differ from source ${pred.domain}`);
    }
  });

  it('political > 0.6 creates conflict cascade', () => {
    const pred = makePrediction(
      'political', 'Iran', 'Political instability',
      0.65, 0.5, '30d', [{ type: 'unrest', value: 'unrest', weight: 0.4 }],
    );
    resolveCascades([pred]);
    const domains = pred.cascades.map(c => c.domain);
    assert.ok(domains.includes('conflict'), 'political instability should cascade to conflict');
  });

  it('political <= 0.6 does not cascade to conflict', () => {
    const pred = makePrediction(
      'political', 'Iran', 'Political instability',
      0.5, 0.5, '30d', [{ type: 'unrest', value: 'unrest', weight: 0.4 }],
    );
    resolveCascades([pred]);
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

// ── Phase 2 Tests ──────────────────────────────────────────

describe('attachNewsContext', () => {
  it('attaches top-5 headlines to all predictions', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    const news = { topStories: [
      { primaryTitle: 'H1' }, { primaryTitle: 'H2' }, { primaryTitle: 'H3' },
      { primaryTitle: 'H4' }, { primaryTitle: 'H5' }, { primaryTitle: 'H6' },
    ]};
    attachNewsContext(preds, news);
    assert.equal(preds[0].newsContext.length, 5);
    assert.equal(preds[0].newsContext[0], 'H1');
  });

  it('handles null newsInsights', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    attachNewsContext(preds, null);
    assert.equal(preds[0].newsContext, undefined);
  });

  it('handles empty topStories', () => {
    const preds = [makePrediction('conflict', 'Iran', 'test', 0.5, 0.5, '7d', [])];
    attachNewsContext(preds, { topStories: [] });
    assert.equal(preds[0].newsContext, undefined);
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

  it('rejects scenario without signal reference', () => {
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
