import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HORIZON_MS,
  CONFLICT_COUNT_SOURCE_FEED,
  UNREST_COUNT_SOURCE_FEED,
  CYBER_COUNT_SOURCE_FEED,
  RESOLUTION_FEED_KEYS,
  SIGNAL_TO_HARD_FAMILY,
  JUDGED_DOMAINS,
  DOMAIN_TO_HARD_FAMILIES,
  COMMODITY_LABEL_TO_SYMBOL,
  MARKET_PRICE_MOVE_RATIO,
  CONFLICT_ESCALATION_RATIO,
  deriveDeadline,
  buildResolutionSpec,
  attachResolutionSpecs,
} from '../scripts/_forecast-resolution.mjs';

// Emission-time commodities feed shape (inputs.commodityQuotes) — mirrors the
// LIVE market:commodities-bootstrap:v1 snapshot: quotes keyed by future ticker.
const COMMODITY_INPUTS = {
  commodityQuotes: {
    quotes: [
      { symbol: 'CL=F', name: 'WTI Crude', price: 68.92 },
      { symbol: 'TTF=F', name: 'Dutch TTF Gas', price: 44.25 },
      { symbol: 'ZW=F', name: 'Wheat', price: 5.42 },
    ],
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const seederSource = readFileSync(resolve(here, '../scripts/seed-forecasts.mjs'), 'utf8');

const GENERATED_AT = 1_700_000_000_000;

function pred(overrides = {}) {
  return {
    id: 'fc-test-00000000',
    domain: 'conflict',
    region: 'Mali',
    title: 'Escalation risk: Mali',
    probability: 0.6,
    confidence: 0.5,
    timeHorizon: '30d',
    signals: [],
    generationOrigin: 'legacy_detector',
    calibration: null,
    ...overrides,
  };
}

describe('HORIZON_MS / deriveDeadline', () => {
  it('maps every allowlisted horizon to the correct millisecond offset', () => {
    assert.equal(deriveDeadline(1000, '24h'), 1000 + 24 * 60 * 60 * 1000);
    assert.equal(deriveDeadline(1000, '7d'), 1000 + 7 * 86_400_000);
    assert.equal(deriveDeadline(1000, '14d'), 1000 + 14 * 86_400_000);
    assert.equal(deriveDeadline(1000, '30d'), 1000 + 30 * 86_400_000);
  });

  it('throws on an unrecognized horizon rather than silently coercing', () => {
    assert.throws(() => deriveDeadline(1000, '90d'));
  });

  it('throws rather than returning null/NaN for a missing horizon', () => {
    assert.throws(() => deriveDeadline(1000, undefined));
    assert.throws(() => deriveDeadline(1000, ''));
  });

  it('HORIZON_MS is a complete allowlist of the four documented horizons', () => {
    assert.deepEqual(Object.keys(HORIZON_MS).sort(), ['14d', '24h', '30d', '7d']);
  });
});

describe('horizon drift guard', () => {
  it('every horizon literal passed to makePrediction() in seed-forecasts.mjs is a key of HORIZON_MS', () => {
    // Text-extraction scan (no import — seed-forecasts.mjs has top-level
    // side effects): find every makePrediction(...) call site and pull the
    // 6th positional arg (timeHorizon) when it's a quoted string literal,
    // plus the state-derived domain ternary's two literal branches.
    const literalHorizons = new Set();

    // makePrediction(domain, region, title, probability, confidence, timeHorizon, signals)
    // Horizon args appear as quoted literals like '24h', '7d', '30d' directly
    // as one of the call's arguments; scan every quoted horizon-shaped token
    // that appears as a bare argument (preceded by a comma or newline+ws and
    // followed by a comma) anywhere makePrediction is invoked.
    const callSites = [...seederSource.matchAll(/makePrediction\(([\s\S]*?)\)/g)];
    assert.ok(callSites.length > 0, 'expected at least one makePrediction(...) call site');

    const horizonLiteralPattern = /'(\d+[a-z]+)'/g;
    for (const call of callSites) {
      const body = call[1];
      for (const m of body.matchAll(horizonLiteralPattern)) {
        literalHorizons.add(m[1]);
      }
    }

    // Also the state-derived ternary: domain === 'supply_chain' ? '7d' : '30d'
    const ternaryMatch = seederSource.match(/domain === 'supply_chain' \? '(\w+)' : '(\w+)'/);
    assert.ok(ternaryMatch, 'expected the state-derived supply_chain/else horizon ternary');
    literalHorizons.add(ternaryMatch[1]);
    literalHorizons.add(ternaryMatch[2]);

    assert.ok(literalHorizons.size > 0, 'expected to find at least one horizon literal');
    for (const horizon of literalHorizons) {
      assert.ok(
        Object.hasOwn(HORIZON_MS, horizon),
        `horizon literal '${horizon}' found in seed-forecasts.mjs is missing from HORIZON_MS`,
      );
    }
  });
});

describe('buildResolutionSpec — conflict is judged (#5136)', () => {
  it('a conflict forecast with a ucdp signal yields a JUDGED spec (was hard) — the conflict count feed needs ACLED creds it lacks', () => {
    const forecast = pred({
      domain: 'conflict',
      region: 'Sudan',
      signals: [{ type: 'ucdp', value: '14 UCDP conflict events', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    // judged specs carry a question + derived deadline, and NO hard-metric fields
    assert.equal(spec.metricKey, null);
    assert.equal(spec.sourceFeed, null);
    assert.equal(spec.operator, null);
    assert.equal(spec.threshold, null);
    assert.ok(Number.isFinite(spec.deadline), 'judged spec still carries a derived deadline');
    assert.ok(typeof spec.question === 'string' && spec.question.length > 0);
  });

  it('conflict judged specs use an escalation-framed, region-anchored question', () => {
    const spec = buildResolutionSpec(
      pred({ domain: 'conflict', region: 'Sudan', timeHorizon: '30d', signals: [{ type: 'ucdp', value: '9 UCDP conflict events', weight: 0.5 }] }),
      {},
      GENERATED_AT,
    );
    assert.match(spec.question, /Sudan/);
    assert.match(spec.question, /escalat/i);
    assert.match(spec.question, /30d/);
  });

  it('unrest is also judged by default (#5091 — same empty-feed root cause as conflict)', () => {
    const spec = buildResolutionSpec(
      pred({ domain: 'political', region: 'Kenya', timeHorizon: '7d', signals: [{ type: 'unrest_events', value: '20 unrest events', weight: 0.5 }] }),
      {},
      GENERATED_AT,
    );
    assert.equal(spec.kind, 'judged');
    assert.match(spec.question, /Kenya/);
    assert.match(spec.question, /unrest|instability/i);
    assert.match(spec.question, /7d/); // horizon embedded in the question template
  });

  it('unrest with the feed forced available but no finite count signal still falls back to judged (tally-null guard)', () => {
    const spec = buildResolutionSpec(
      pred({ domain: 'political', region: 'Kenya', timeHorizon: '7d', signals: [{ type: 'unrest_events', value: 'unrest reported (no count)', weight: 0.5 }] }),
      {},
      GENERATED_AT,
      { unrestCountFeedAvailable: true },
    );
    assert.equal(spec.kind, 'judged');
  });

  it('the reclassification is scoped — cyber (populated feed) still emits a hard spec', () => {
    const spec = buildResolutionSpec(
      pred({ domain: 'cyber', region: 'Estonia', timeHorizon: '7d', signals: [{ type: 'cyber', value: '10 threats (malware)', weight: 0.5 }] }),
      {},
      GENERATED_AT,
    );
    assert.equal(spec.kind, 'hard');
    assert.ok(RESOLUTION_FEED_KEYS.has(spec.sourceFeed));
    assert.ok(Number.isFinite(spec.threshold));
  });
});

describe('buildResolutionSpec — market family regression', () => {
  it('a production-shaped market forecast (chokepoint + commodity signals) resolves hard on the commodities feed via a ticker', () => {
    // Real detectMarketScenarios shape (seed-forecasts.mjs:1108-1114): a
    // chokepoint→commodity forecast carries `chokepoint` + `commodity`
    // signals, NOT market_transmission (that's state-derived only). The hard
    // path resolves the commodity LABEL ("Oil") to a future TICKER ("CL=F")
    // and reads the emission price from the live commodities feed.
    const forecast = pred({
      domain: 'market',
      region: 'Middle East',
      title: 'Oil price impact from Strait of Hormuz disruption',
      signals: [
        { type: 'chokepoint', value: 'Strait of Hormuz risk: critical', weight: 0.5 },
        { type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 },
      ],
    });
    const spec = buildResolutionSpec(forecast, COMMODITY_INPUTS, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, 'market:commodities-bootstrap:v1');
    assert.notEqual(spec.sourceFeed, 'supply_chain:chokepoints:v4');
    // metricKey encodes the resolvable ticker, not the display label.
    assert.ok(spec.metricKey.includes('CL=F'), `expected ticker in metricKey, got ${spec.metricKey}`);
    assert.ok(!spec.metricKey.includes('Oil'), 'metricKey must not carry the display label');
    // "price impact" = a MOVE: crosses + baselineValue = emission price.
    assert.equal(spec.operator, 'crosses');
    assert.equal(spec.baselineValue, 68.92);
    assert.ok(Number.isFinite(spec.threshold) && spec.threshold > spec.baselineValue);
  });

  it('a commodity label with no ticker mapping (Semiconductors) falls back to judged', () => {
    // CHOKEPOINT_COMMODITIES maps Western Pacific → Semiconductors, which has
    // no commodity-future ticker → no finite threshold → judged (R3 fallback,
    // confirmed load-bearing on real production regions by the R12 walkthrough).
    const forecast = pred({
      domain: 'market',
      region: 'Western Pacific',
      title: 'Semiconductors price impact from Taiwan Strait disruption',
      signals: [
        { type: 'chokepoint', value: 'Taiwan Strait risk: high', weight: 0.5 },
        { type: 'commodity', value: 'Semiconductors sensitivity: 0.9', weight: 0.3 },
      ],
    });
    const spec = buildResolutionSpec(forecast, COMMODITY_INPUTS, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.sourceFeed, null);
    assert.notEqual(spec.sourceFeed, 'supply_chain:chokepoints:v4');
  });

  it('a chokepoint-only market forecast (no commodity signal, no calibration) never mis-references supply_chain', () => {
    const forecast = pred({
      domain: 'market',
      signals: [{ type: 'chokepoint', value: 'Strait of Hormuz risk: critical', weight: 0.5 }],
      calibration: null,
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.sourceFeed, null);
  });

  it('COMMODITY_LABEL_TO_SYMBOL maps the walkthrough-validated labels and omits the unmapped ones', () => {
    assert.equal(COMMODITY_LABEL_TO_SYMBOL.Oil, 'CL=F');
    assert.equal(COMMODITY_LABEL_TO_SYMBOL.Gas, 'TTF=F');
    assert.equal(COMMODITY_LABEL_TO_SYMBOL['Grain/Energy'], 'ZW=F');
    assert.equal(COMMODITY_LABEL_TO_SYMBOL.Semiconductors, undefined);
    assert.equal(COMMODITY_LABEL_TO_SYMBOL['Trade goods'], undefined);
  });
});

describe('buildResolutionSpec — feed mapping per family', () => {
  it('a supply_chain forecast resolves to supply_chain:chokepoints:v4', () => {
    const forecast = pred({
      domain: 'supply_chain',
      timeHorizon: '7d',
      signals: [{ type: 'chokepoint', value: 'Suez Canal disruption detected', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, 'supply_chain:chokepoints:v4');
  });

  it('a GPS forecast resolves to intelligence:gpsjam:v2', () => {
    const forecast = pred({
      domain: 'supply_chain',
      timeHorizon: '7d',
      signals: [{ type: 'gps_jamming', value: '12 jamming hexes in Persian Gulf', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, 'intelligence:gpsjam:v2');
  });

  it('a UCDP-zone forecast resolves to the fresh ACLED count feed (when the feed is available)', () => {
    const forecast = pred({
      domain: 'conflict',
      signals: [{ type: 'ucdp', value: '25 UCDP conflict events', weight: 0.5 }],
    });
    // conflict/ucdp_zone are judged by default (#5136); force the hard path to
    // assert the feed mapping still points at the ACLED-resolution feed.
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT, { conflictCountFeedAvailable: true });
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    assert.equal(CONFLICT_COUNT_SOURCE_FEED, 'conflict:acled-resolution:v1:all:0:0');
    assert.notEqual(spec.sourceFeed, 'conflict:acled:v1:all:0:0');
  });

  it('a political unrest-events forecast resolves to the unrest count feed (when the feed is available)', () => {
    const forecast = pred({
      domain: 'political',
      region: 'Venezuela',
      title: 'Political instability: Venezuela',
      signals: [
        { type: 'unrest', value: 'Venezuela unrest component: 62', weight: 0.4 },
        { type: 'unrest_events', value: '4 unrest events in Venezuela', weight: 0.3 },
      ],
    });
    // unrest is judged by default (#5091); force the hard path to assert the feed mapping.
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT, { unrestCountFeedAvailable: true });
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, UNREST_COUNT_SOURCE_FEED);
    assert.equal(UNREST_COUNT_SOURCE_FEED, 'unrest:events-resolution:v1');
    assert.notEqual(spec.sourceFeed, 'unrest:events:v1');
    assert.equal(spec.metricKey, `${UNREST_COUNT_SOURCE_FEED}|count(country==Venezuela)`);
  });

  it('a cyber volume forecast resolves to the cyber threat count feed', () => {
    const forecast = pred({
      domain: 'cyber',
      region: 'Estonia',
      title: 'Cyber disruption risk: Estonia',
      signals: [{ type: 'cyber', value: '10 threats (malware)', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, CYBER_COUNT_SOURCE_FEED);
    assert.equal(spec.metricKey, `${CYBER_COUNT_SOURCE_FEED}|count(country==Estonia)`);
  });

  it('an infrastructure forecast resolves to infra:outages:v1', () => {
    const forecast = pred({
      domain: 'infrastructure',
      timeHorizon: '24h',
      signals: [{ type: 'outage', value: '3 active outages', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, 'infra:outages:v1');
  });

  it('a prediction_market forecast resolves to prediction:markets-bootstrap:v1', () => {
    const forecast = pred({
      domain: 'market',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 62%', weight: 0.8 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, 'prediction:markets-bootstrap:v1');
    assert.equal(spec.operator, 'crosses');
  });
});

describe('buildResolutionSpec — prediction_market exempt from JUDGED_DOMAINS gate', () => {
  it('a political-domain forecast WITH a prediction_market signal yields a hard prediction_market spec', () => {
    // detectFromPredictionMarkets assigns domain political/conflict/market by
    // title keyword (seed-forecasts.mjs:2234-2236), but the forecast's CLAIM
    // is the market question, so the market's own resolution is ground truth
    // regardless of domain — the exemption runs before the JUDGED_DOMAINS gate.
    const forecast = pred({
      domain: 'political',
      region: 'Iran',
      title: 'Will the U.S. invade Iran before 2027?',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 62%', weight: 0.8 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, 'prediction:markets-bootstrap:v1');
    assert.equal(spec.operator, 'crosses');
  });
});

describe('buildResolutionSpec — prediction_market deadline is the market endDate (R5 amended)', () => {
  it('deadline equals the fixture market endDate, not generatedAt + horizon', () => {
    const endDateMs = Date.parse('2026-12-31');
    const forecast = pred({
      domain: 'political',
      region: 'Iran',
      title: 'Will the U.S. invade Iran before 2027?',
      timeHorizon: '30d',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 62%', weight: 0.8 }],
    });
    const inputs = {
      predictionMarkets: {
        geopolitical: [
          { title: 'Will the U.S. invade Iran before 2027?', yesPrice: 62, endDate: '2026-12-31' },
        ],
      },
    };
    const spec = buildResolutionSpec(forecast, inputs, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.deadline, endDateMs);
    assert.notEqual(spec.deadline, GENERATED_AT + HORIZON_MS['30d']);
  });

  it('falls back to the horizon deadline when the market endDate is missing (still non-null)', () => {
    const forecast = pred({
      domain: 'political',
      region: 'Iran',
      title: 'Will the U.S. invade Iran before 2027?',
      timeHorizon: '30d',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 62%', weight: 0.8 }],
    });
    // No matching market / no endDate in inputs.
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.deadline, GENERATED_AT + HORIZON_MS['30d']);
    assert.ok(Number.isFinite(spec.deadline));
  });
});

describe('buildResolutionSpec — crosses operator carries a baseline', () => {
  it('operator "crosses" always has a finite baselineValue', () => {
    const forecast = pred({
      domain: 'market',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 62%', weight: 0.8 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.operator, 'crosses');
    assert.ok(Number.isFinite(spec.baselineValue));
  });
});

describe('buildResolutionSpec — origin precedence (production shape)', () => {
  it('state_derived origin with domain market AND a market_transmission signal still yields judged', () => {
    // Production-shaped fixture: buildStateDerivedForecast attaches a
    // market_transmission signal (weight 0.24) to EVERY state-derived
    // forecast, so this fixture must include one to prove origin wins
    // over a family-first dispatch that would otherwise classify it hard/market.
    const forecast = pred({
      domain: 'market',
      generationOrigin: 'state_derived',
      timeHorizon: '30d',
      signals: [
        { type: 'derived_transmission', value: 'lead signal', weight: 0.42 },
        { type: 'state_unit', value: 'combines 3 situations', weight: 0.26 },
        { type: 'market_transmission', value: 'strongest transmission path via energy', weight: 0.24 },
      ],
      calibration: { marketTitle: 'Oil > $100', marketPrice: 0.5, drift: 0, source: 'polymarket' },
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.ok(spec.question && spec.question.length > 0);
    assert.equal(spec.threshold, null);
  });
});

describe('buildResolutionSpec — threshold fallback', () => {
  it('a hard-family forecast whose signals yield no finite threshold falls back to judged', () => {
    const forecast = pred({
      domain: 'conflict',
      signals: [{ type: 'ucdp', value: 'no numeric count present', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.threshold, null);
    assert.ok(spec.question && spec.question.length > 0);
  });

  it('a market family with no calibration and no direct market signal falls back to judged', () => {
    const forecast = pred({
      domain: 'market',
      signals: [],
      calibration: null,
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
  });
});

describe('buildResolutionSpec — domain-specific hard and judged families', () => {
  it('a political forecast with no unrest event count yields judged with a non-empty question and no threshold', () => {
    const forecast = pred({
      domain: 'political',
      region: 'Venezuela',
      title: 'Political instability: Venezuela',
      signals: [{ type: 'unrest', value: 'Venezuela unrest component: elevated', weight: 0.4 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(typeof spec.question, 'string');
    assert.ok(spec.question.length > 0);
    assert.equal(spec.threshold, null);
  });

  it('a military forecast yields judged', () => {
    const forecast = pred({ domain: 'military', signals: [{ type: 'theater', value: 'elevated posture', weight: 0.4 }] });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
  });
});

describe('buildResolutionSpec — domain constraints win over hard-mapped signals (R3 by-domain)', () => {
  it('JUDGED_DOMAINS only retains domains without a stable hard metric identity', () => {
    assert.deepEqual([...JUDGED_DOMAINS].sort(), ['military']);
  });

  it('a political-domain forecast carrying a cii signal yields judged, never a hard conflict spec', () => {
    // 'cii' maps to the conflict hard family in SIGNAL_TO_HARD_FAMILY, but
    // political claims only permit the unrest hard family. This must not
    // resolve against a conflict event-count metric.
    const forecast = pred({
      domain: 'political',
      region: 'Venezuela',
      title: 'Political instability: Venezuela',
      signals: [{ type: 'cii', value: 'Venezuela CII 78 (high)', weight: 0.4 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.threshold, null);
    assert.equal(spec.sourceFeed, null);
    assert.ok(spec.question && spec.question.length > 0);
  });

  it('a military-domain forecast carrying a ucdp signal yields judged, never a hard ucdp-zone spec', () => {
    // 'ucdp' maps to the ucdp_zone hard family; the domain gate must intercept
    // it so a military-posture claim is not resolved against a UCDP event count.
    const forecast = pred({
      domain: 'military',
      region: 'Taiwan Strait',
      title: 'Military posture escalation: Taiwan Strait',
      signals: [{ type: 'ucdp', value: '20 UCDP conflict events', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.threshold, null);
    assert.equal(spec.sourceFeed, null);
    assert.ok(spec.question && spec.question.length > 0);
  });
});

describe('deadline is always present', () => {
  it('both a hard and a judged spec carry a finite numeric deadline', () => {
    const hardForecast = pred({
      domain: 'conflict',
      signals: [{ type: 'ucdp', value: '14 UCDP conflict events', weight: 0.5 }],
    });
    const judgedForecast = pred({ domain: 'political', signals: [] });

    // conflict is judged by default (#5136); force the hard path to exercise the deadline invariant on a hard spec.
    const hardSpec = buildResolutionSpec(hardForecast, {}, GENERATED_AT, { conflictCountFeedAvailable: true });
    const judgedSpec = buildResolutionSpec(judgedForecast, {}, GENERATED_AT);

    assert.equal(hardSpec.kind, 'hard');
    assert.equal(judgedSpec.kind, 'judged');
    assert.ok(Number.isFinite(hardSpec.deadline));
    assert.ok(Number.isFinite(judgedSpec.deadline));
  });

  it('attachResolutionSpecs never leaves a null/undefined deadline across a mixed batch', () => {
    const batch = [
      pred({ id: 'a', domain: 'conflict', signals: [{ type: 'ucdp', value: '20 UCDP conflict events', weight: 0.5 }] }),
      pred({ id: 'b', domain: 'political', signals: [] }),
      pred({ id: 'c', domain: 'market', generationOrigin: 'state_derived', signals: [{ type: 'market_transmission', value: 'x', weight: 0.24 }] }),
      pred({ id: 'd', domain: 'supply_chain', timeHorizon: '7d', signals: [{ type: 'chokepoint', value: 'disruption', weight: 0.5 }] }),
    ];
    attachResolutionSpecs(batch, {}, GENERATED_AT);
    for (const p of batch) {
      assert.ok(p.resolution, `forecast ${p.id} missing resolution`);
      assert.ok(Number.isFinite(p.resolution.deadline), `forecast ${p.id} has non-finite deadline`);
    }
  });
});

describe('R4 — sourceFeed membership over every hard fixture', () => {
  const fixtures = [
    pred({ id: 'conflict', domain: 'conflict', signals: [{ type: 'ucdp', value: '14 UCDP conflict events', weight: 0.5 }] }),
    pred({ id: 'political', domain: 'political', region: 'Venezuela', signals: [{ type: 'unrest_events', value: '4 unrest events', weight: 0.3 }] }),
    pred({ id: 'cyber', domain: 'cyber', region: 'Estonia', signals: [{ type: 'cyber', value: '10 threats', weight: 0.5 }] }),
    pred({ id: 'supply_chain', domain: 'supply_chain', timeHorizon: '7d', signals: [{ type: 'chokepoint', value: 'disruption', weight: 0.5 }] }),
    pred({ id: 'gps', domain: 'supply_chain', timeHorizon: '7d', signals: [{ type: 'gps_jamming', value: '5 jamming hexes', weight: 0.5 }] }),
    pred({ id: 'infra', domain: 'infrastructure', timeHorizon: '24h', signals: [{ type: 'outage', value: '2 outages', weight: 0.5 }] }),
    pred({ id: 'pm', domain: 'market', signals: [{ type: 'prediction_market', value: 'Polymarket: 40%', weight: 0.8 }] }),
    pred({
      id: 'market',
      domain: 'market',
      region: 'Middle East',
      title: 'Oil price impact from Strait of Hormuz disruption',
      signals: [
        { type: 'chokepoint', value: 'Strait of Hormuz risk: critical', weight: 0.5 },
        { type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 },
      ],
    }),
  ];

  it('every hard-family fixture yields a sourceFeed that is a RESOLUTION_FEED_KEYS member', () => {
    for (const forecast of fixtures) {
      // COMMODITY_INPUTS supplies the commodities feed the market fixture
      // needs; a harmless superset for the other families (they don't read it).
      // conflict (#5136) and unrest (#5091) are judged by default — force both
      // hard so their fixtures still exercise the sourceFeed-membership invariant.
      const spec = buildResolutionSpec(forecast, COMMODITY_INPUTS, GENERATED_AT, { conflictCountFeedAvailable: true, unrestCountFeedAvailable: true });
      assert.equal(spec.kind, 'hard', `expected fixture ${forecast.id} to resolve hard`);
      assert.ok(
        RESOLUTION_FEED_KEYS.has(spec.sourceFeed),
        `fixture ${forecast.id}: sourceFeed '${spec.sourceFeed}' is not in RESOLUTION_FEED_KEYS`,
      );
    }
  });

  it('a deliberately wrong sourceFeed fails the membership assertion (sanity-check the test itself)', () => {
    assert.equal(RESOLUTION_FEED_KEYS.has('not:a:real:feed:key'), false);
  });
});

describe('camelCase only (D6)', () => {
  it('the emitted spec object has metricKey/sourceFeed and never metric_key/source_feed', () => {
    const forecast = pred({
      domain: 'conflict',
      signals: [{ type: 'ucdp', value: '14 UCDP conflict events', weight: 0.5 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    const keys = Object.keys(spec);
    assert.ok(keys.includes('metricKey'));
    assert.ok(keys.includes('sourceFeed'));
    assert.ok(keys.includes('baselineValue'));
    for (const key of keys) {
      assert.ok(!key.includes('_'), `spec key '${key}' should be camelCase, not snake_case`);
    }
  });
});

describe('determinism', () => {
  it('two calls with identical (pred, inputs, generatedAt) produce a deep-equal spec', () => {
    const forecast = pred({
      domain: 'conflict',
      signals: [{ type: 'ucdp', value: '14 UCDP conflict events', weight: 0.5 }],
    });
    const specA = buildResolutionSpec(forecast, {}, GENERATED_AT);
    const specB = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.deepEqual(specA, specB);
  });

  it('holds for a judged spec too', () => {
    const forecast = pred({ domain: 'political', signals: [] });
    const specA = buildResolutionSpec(forecast, {}, GENERATED_AT);
    const specB = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.deepEqual(specA, specB);
  });
});

describe('edge cases', () => {
  it('an unrecognized domain/signal set falls back to judged rather than throwing', () => {
    const forecast = pred({ domain: 'some_future_domain', signals: [{ type: 'unknown_signal_type', value: 'x', weight: 0.1 }] });
    assert.doesNotThrow(() => buildResolutionSpec(forecast, {}, GENERATED_AT));
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
  });

  it('SIGNAL_TO_HARD_FAMILY maps the documented tokens', () => {
    assert.equal(SIGNAL_TO_HARD_FAMILY.market_transmission, 'market');
    assert.equal(SIGNAL_TO_HARD_FAMILY.market_divergence, 'market');
    assert.equal(SIGNAL_TO_HARD_FAMILY.market_calibration, 'market');
    assert.equal(SIGNAL_TO_HARD_FAMILY.commodity, 'market');
    assert.equal(SIGNAL_TO_HARD_FAMILY.prediction_market, 'prediction_market');
    assert.equal(SIGNAL_TO_HARD_FAMILY.ucdp, 'ucdp_zone');
    assert.equal(SIGNAL_TO_HARD_FAMILY.unrest, 'unrest');
    assert.equal(SIGNAL_TO_HARD_FAMILY.unrest_events, 'unrest');
    assert.equal(SIGNAL_TO_HARD_FAMILY.cyber, 'cyber');
    assert.equal(SIGNAL_TO_HARD_FAMILY.gps_jamming, 'gps');
    assert.equal(SIGNAL_TO_HARD_FAMILY.outage, 'infrastructure');
    assert.equal(SIGNAL_TO_HARD_FAMILY.conflict_events, 'conflict');
    assert.equal(SIGNAL_TO_HARD_FAMILY.cii, 'conflict');
  });
});

describe('FIX 1 — domain constrains the hard family (DOMAIN_TO_HARD_FAMILIES)', () => {
  it('exposes the documented table', () => {
    assert.deepEqual(DOMAIN_TO_HARD_FAMILIES, {
      conflict: ['conflict', 'ucdp_zone'],
      market: ['market', 'prediction_market'],
      supply_chain: ['supply_chain', 'gps'],
      infrastructure: ['infrastructure'],
      political: ['unrest'],
      cyber: ['cyber'],
    });
  });

  it('a market-domain forecast with [cii, commodity] never produces a conflict-feed hard spec', () => {
    // Real detectMarketScenarios CII-instability path (seed-forecasts.mjs
    // :1152-1157): domain 'market', signals [cii, commodity]. 'cii' maps to
    // the conflict family, but conflict is not allowed for domain 'market' —
    // so the claim must resolve via 'commodity' (market family), never against
    // event counts on the conflict count feed.
    const forecast = pred({
      domain: 'market',
      region: 'Middle East',
      title: 'Oil volatility from Iran instability',
      signals: [
        { type: 'cii', value: 'Iran CII 82', weight: 0.4 },
        { type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 },
      ],
    });
    const spec = buildResolutionSpec(forecast, COMMODITY_INPUTS, GENERATED_AT);
    // Never a conflict-feed hard spec.
    assert.notEqual(spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    if (spec.kind === 'hard') {
      assert.equal(spec.sourceFeed, 'market:commodities-bootstrap:v1');
      assert.ok(!spec.metricKey.includes(CONFLICT_COUNT_SOURCE_FEED));
    } else {
      assert.equal(spec.kind, 'judged');
    }
  });

  it('the same [cii, commodity] market fixture with an UNMAPPED commodity still never hits the conflict feed (judged)', () => {
    const forecast = pred({
      domain: 'market',
      region: 'Western Pacific',
      title: 'Semiconductors volatility from Taiwan instability',
      signals: [
        { type: 'cii', value: 'Taiwan CII 80', weight: 0.4 },
        { type: 'commodity', value: 'Semiconductors sensitivity: 0.9', weight: 0.3 },
      ],
    });
    const spec = buildResolutionSpec(forecast, COMMODITY_INPUTS, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.sourceFeed, null);
    assert.notEqual(spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
  });

  // FIX A: 'cii' is a 0-100 composite index, NOT an event count, so it no
  // longer drives the conflict/ucdp count threshold. A conflict forecast with
  // only cii signals has no clean count metric -> judged.
  it('a conflict-domain forecast with ONLY cii signals is judged (cii is not an event count)', () => {
    const forecast = pred({
      domain: 'conflict',
      region: 'Pakistan',
      signals: [{ type: 'cii', value: 'Pakistan CII 71', weight: 0.4 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.threshold, null);
    assert.equal(spec.sourceFeed, null);
  });

  it('a conflict forecast with cii + conflict_events derives a horizon-scoped threshold from the COUNT signal', () => {
    const forecast = pred({
      domain: 'conflict',
      region: 'Sudan',
      // cii emitted first (would shadow the count if it were accepted) — the
      // count base must come from the conflict_events tally (3), not 71.
      signals: [
        { type: 'cii', value: 'Sudan CII 71', weight: 0.4 },
        { type: 'conflict_events', value: '3 cross-border events', weight: 0.35 },
      ],
    });
    // conflict is judged by default (#5136); force the hard path to lock the
    // preserved #5010 horizon-commensurable threshold derivation.
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT, { conflictCountFeedAvailable: true });
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    // #5010 horizon-commensurable threshold: the 365d-trailing tally (3) is
    // scaled to the 30d horizon and escalated —
    // max(1, round(3 × 30d/365d × CONFLICT_ESCALATION_RATIO)) = 1.
    // Three wrong answers excluded: 71 (the cii index), 3 (the raw 365d
    // tally — would systematically resolve NO over a 30d window), and 0
    // (the floor guarantees a confirmable bar).
    assert.equal(spec.threshold, Math.max(1, Math.round(3 * (HORIZON_MS['30d'] / (365 * 24 * 60 * 60 * 1000)) * CONFLICT_ESCALATION_RATIO)));
    assert.equal(spec.threshold, 1);
  });
});

describe('FIX 2 — metricKey embeds real values with unified "==" grammar', () => {
  it('conflict metricKey substitutes the real region and uses ==', () => {
    const forecast = pred({
      domain: 'conflict',
      region: 'Pakistan',
      signals: [{ type: 'ucdp', value: '175 UCDP conflict events', weight: 0.5 }],
    });
    // conflict is judged by default (#5136); force the hard path to lock the metricKey grammar.
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT, { conflictCountFeedAvailable: true });
    assert.equal(spec.metricKey, `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Pakistan)`);
    assert.ok(!spec.metricKey.includes('<region>'));
  });

  it('supply_chain, infrastructure, gps, and prediction_market metricKeys are all real-value == form', () => {
    const sc = buildResolutionSpec(pred({
      domain: 'supply_chain', region: 'Strait of Hormuz', timeHorizon: '7d',
      signals: [{ type: 'chokepoint', value: 'disruption', weight: 0.5 }],
    }), {}, GENERATED_AT);
    assert.equal(sc.metricKey, 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)');

    const infra = buildResolutionSpec(pred({
      domain: 'infrastructure', region: 'Cuba', timeHorizon: '24h',
      signals: [{ type: 'outage', value: '3 outages', weight: 0.5 }],
    }), {}, GENERATED_AT);
    assert.equal(infra.metricKey, 'infra:outages:v1|present(country==Cuba)');

    const gps = buildResolutionSpec(pred({
      domain: 'supply_chain', region: 'Black Sea', timeHorizon: '7d',
      signals: [{ type: 'gps_jamming', value: '12 jamming hexes in Black Sea', weight: 0.5 }],
    }), {}, GENERATED_AT);
    assert.equal(gps.metricKey, 'intelligence:gpsjam:v2|hexCount(region==Black Sea)');

    const pm = buildResolutionSpec(pred({
      domain: 'market', title: 'Will the Fed cut rates in July 2026?',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 62%', weight: 0.8 }],
    }), {}, GENERATED_AT);
    assert.equal(pm.metricKey, 'prediction:markets-bootstrap:v1|yesPrice(market==Will the Fed cut rates in July 2026?)');

    for (const spec of [sc, infra, gps, pm]) {
      assert.ok(!/[^=]=[^=]/.test(spec.metricKey.split('|')[1]), `metricKey must use ==: ${spec.metricKey}`);
    }
  });
});

describe('FIX 3 — zero/garbage-value guards', () => {
  it('a commodity price of 0 (missing upstream) falls back to judged, not a baseline-0 hard spec', () => {
    const zeroInputs = { commodityQuotes: { quotes: [{ symbol: 'CL=F', name: 'WTI', price: 0 }] } };
    const forecast = pred({
      domain: 'market', region: 'Middle East', title: 'Oil price impact',
      signals: [{ type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 }],
    });
    const spec = buildResolutionSpec(forecast, zeroInputs, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.baselineValue, null);
  });

  // FIX B: there is NO calibration.marketPrice hard path — a market forecast
  // with only a calibration anchor (no mapped commodity signal) is judged,
  // regardless of the marketPrice value. A stocks feed cannot resolve a
  // prediction-market title, and the old spec was a vacuous
  // threshold===baselineValue 'crosses'.
  it('a market forecast with only a valid in-range calibration anchor is judged (no calibration hard path)', () => {
    const forecast = pred({
      domain: 'market', title: 'Some market', signals: [],
      calibration: { marketTitle: 'X', marketPrice: 0.6, drift: 0, source: 'polymarket' },
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
    assert.equal(spec.metricKey, null);
    assert.equal(spec.sourceFeed, null);
  });

  it('a market forecast with an already-scaled calibration value is still judged (never double-scaled)', () => {
    const forecast = pred({
      domain: 'market', title: 'Some market', signals: [],
      calibration: { marketTitle: 'X', marketPrice: 62, drift: 0, source: 'polymarket' },
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'judged');
  });
});

describe('FIX 4 — MARKET_PRICE_MOVE_RATIO is the named threshold knob', () => {
  it('the commodity threshold equals baseline × MARKET_PRICE_MOVE_RATIO', () => {
    assert.equal(MARKET_PRICE_MOVE_RATIO, 1.1);
    const forecast = pred({
      domain: 'market', region: 'Middle East', title: 'Oil price impact',
      signals: [{ type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 }],
    });
    const spec = buildResolutionSpec(forecast, COMMODITY_INPUTS, GENERATED_AT);
    assert.equal(spec.baselineValue, 68.92);
    assert.equal(spec.threshold, +(68.92 * MARKET_PRICE_MOVE_RATIO).toFixed(2));
  });
});

describe('#5010 amendment — resolvable windows + horizon-commensurable count', () => {
  it('supply_chain and gps specs emit window at-deadline — sustained-48h is gone', () => {
    const supply = buildResolutionSpec(pred({
      domain: 'supply_chain', region: 'Strait of Hormuz',
      signals: [{ type: 'chokepoint', value: 'Strait of Hormuz disruption detected', weight: 0.5 }],
    }), {}, GENERATED_AT);
    assert.equal(supply.kind, 'hard');
    assert.equal(supply.window, 'at-deadline');

    const gps = buildResolutionSpec(pred({
      domain: 'supply_chain', region: 'Black Sea',
      signals: [{ type: 'gps_jamming', value: '41 jamming hexes in Black Sea', weight: 0.5 }],
    }), {}, GENERATED_AT);
    assert.equal(gps.kind, 'hard');
    assert.equal(gps.window, 'at-deadline');
  });

  it('no emitted hard spec carries a sustained-48h window (unestablishable from snapshot feeds)', () => {
    // The module source must not emit the token at all — a resolver cannot
    // establish a sustained condition from current-snapshot feeds without
    // sampling, so the old value forced permanent VOID.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/_forecast-resolution.mjs'), 'utf8');
    const emitted = src.match(/'(sustained-[^']+)'/g) || [];
    assert.deepEqual(emitted, [], `sustained windows must not be emitted, found ${emitted}`);
  });

  it('within-horizon and at-endDate families are unchanged (only supply/gps windows moved)', () => {
    // Cherry-picked from the racing PR #5011 — the amendment must not drift
    // the families the issue confirmed fine.
    const conflict = buildResolutionSpec(pred({
      domain: 'conflict', region: 'Mali',
      signals: [{ type: 'conflict_events', value: '12 cross-border events', weight: 0.4 }],
    }), {}, GENERATED_AT, { conflictCountFeedAvailable: true }); // judged by default (#5136); force hard to assert the window
    assert.equal(conflict.window, 'within-horizon');

    const infra = buildResolutionSpec(pred({
      domain: 'infrastructure', region: 'Cuba',
      signals: [{ type: 'outage', value: 'Cuba major outage', weight: 0.4 }],
    }), {}, GENERATED_AT);
    assert.equal(infra.window, 'within-horizon');

    const market = buildResolutionSpec(pred({
      domain: 'market', region: 'Middle East', title: 'Oil price impact',
      signals: [{ type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 }],
    }), COMMODITY_INPUTS, GENERATED_AT);
    assert.equal(market.window, 'within-horizon');
  });

  it('the conflict count threshold scales with the horizon (24h vs 30d from the same tally)', () => {
    // conflict is judged by default (#5136); force the hard path to lock the preserved #5010 horizon scaling.
    const mk = (horizon) => buildResolutionSpec(pred({
      domain: 'conflict', region: 'Pakistan', timeHorizon: horizon,
      signals: [{ type: 'ucdp', value: '175 UCDP conflict events', weight: 0.5 }],
    }), {}, GENERATED_AT, { conflictCountFeedAvailable: true });
    const day = mk('24h');
    const month = mk('30d');
    // 175 events/365d: 24h → max(1, round(175 × 1/365 × 1.5)) = 1;
    // 30d → max(1, round(175 × 30/365 × 1.5)) = 22. Never the raw tally.
    assert.equal(day.threshold, 1);
    assert.equal(month.threshold, 22);
    assert.notEqual(month.threshold, 175);
    assert.equal(CONFLICT_ESCALATION_RATIO, 1.5);
  });

  it('the unrest count threshold scales with the horizon when the feed is available', () => {
    const mk = (horizon) => buildResolutionSpec(pred({
      domain: 'political', region: 'Venezuela', timeHorizon: horizon,
      signals: [{ type: 'unrest_events', value: '20 unrest events', weight: 0.5 }],
    }), {}, GENERATED_AT, { unrestCountFeedAvailable: true });
    const day = mk('24h');
    const month = mk('30d');
    // 20 events/30d: 24h -> max(1, round(20 x 1/30 x 0.75)) = 1;
    // 30d -> max(1, round(20 x 30/30 x 0.75)) = 15. Never the raw tally.
    assert.equal(day.threshold, 1);
    assert.equal(month.threshold, 15);
    assert.notEqual(month.threshold, 20);
  });
});

describe('FIX 6 — prediction_market baseline is percent-anchored', () => {
  it('a digit-bearing source label does not skew the baseline', () => {
    // "Metaculus2: 62%" — the generic first-number regex would grab 2.
    const forecast = pred({
      domain: 'market', title: 'Will X happen?',
      signals: [{ type: 'prediction_market', value: 'Metaculus2: 62%', weight: 0.8 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.kind, 'hard');
    assert.equal(spec.baselineValue, 62);
  });

  it('still reads a plain percent value', () => {
    const forecast = pred({
      domain: 'market', title: 'Will Y happen?',
      signals: [{ type: 'prediction_market', value: 'Polymarket: 74%', weight: 0.8 }],
    });
    const spec = buildResolutionSpec(forecast, {}, GENERATED_AT);
    assert.equal(spec.baselineValue, 74);
  });
});

describe('FIX 8 — signal-vocab drift guard', () => {
  it('every SIGNAL_TO_HARD_FAMILY key appears as a signal type literal in seed-forecasts.mjs', () => {
    // Text-scan the seeder source (no import — top-level side effects). A key
    // that no detector emits anymore is a stale mapping; catch it here before
    // it silently rots.
    const emittedTypes = new Set();
    for (const m of seederSource.matchAll(/type:\s*'([a-z0-9_]+)'/g)) {
      emittedTypes.add(m[1]);
    }
    assert.ok(emittedTypes.size > 0, 'expected to find signal type literals in the seeder');
    for (const key of Object.keys(SIGNAL_TO_HARD_FAMILY)) {
      assert.ok(
        emittedTypes.has(key),
        `SIGNAL_TO_HARD_FAMILY key '${key}' is not emitted as a type: literal in seed-forecasts.mjs (stale mapping?)`,
      );
    }
  });
});
