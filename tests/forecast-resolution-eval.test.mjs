import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ACLED_SETTLEMENT_LAG_MS,
  UCDP_SETTLEMENT_LAG_MS,
  countSettlementLagMs,
  parseMetricKey,
  resolveHardSpec,
  hardResolutionBoundMs,
  extractMetricObservation,
  extractMetricValue,
  shapeResolutionFeed,
} from '../scripts/_forecast-resolution-eval.mjs';
import { attachResolutionSpecs, buildHorizonResolutionSpecs } from '../scripts/_forecast-resolution.mjs';
import { MARITIME_REGIONS, detectGpsJammingScenarios, normalizeGpsJamming } from '../scripts/seed-forecasts.mjs';
import { GPS_RESOLUTION_RULE, GPS_RESOLUTION_RULE_VERSION, GPS_ZONE_MAX_UNCERTAIN_HEXES, GPS_ZONE_MIN_HEXES, GPS_ZONE_PERSISTENCE_PROBABILITY } from '../scripts/_gps-maritime-regions.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-07-07T00:00:00Z');

function entry(overrides = {}) {
  const generatedAt = overrides.generatedAt ?? START;
  const deadline = overrides.deadline ?? (generatedAt + 7 * DAY_MS);
  return {
    id: 'fc-default',
    domain: 'conflict',
    generationOrigin: 'detector',
    generatedAt,
    deadline,
    probability: 0.62,
    spec: {
      kind: 'hard',
      metricKey: 'conflict:ucdp-events:v1|count(country==Mali)',
      operator: '>=',
      threshold: 2,
      window: 'within-horizon',
      deadline,
      sourceFeed: 'conflict:ucdp-events:v1',
    },
    ...overrides,
  };
}

function assertNoNullFields(value, path = 'fixture') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(child, null, `${path}.${key} must omit inapplicable fields instead of using null`);
    assertNoNullFields(child, `${path}.${key}`);
  }
}

describe('parseMetricKey', () => {
  it('parses the emitted function forms with anchored delimiters', () => {
    assert.deepEqual(parseMetricKey('conflict:ucdp-events:v1|count(country==Mali)'), {
      feedKey: 'conflict:ucdp-events:v1',
      fn: 'count',
      field: 'country',
      value: 'Mali',
    });
    assert.deepEqual(parseMetricKey('conflict:acled:v1:all:0:0|count(country==Mali)'), {
      feedKey: 'conflict:acled:v1:all:0:0',
      fn: 'count',
      field: 'country',
      value: 'Mali',
    });
    assert.deepEqual(parseMetricKey('supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)'), {
      feedKey: 'supply_chain:chokepoints:v4',
      fn: 'riskScore',
      field: 'route',
      value: 'Strait of Hormuz',
    });
    assert.equal(parseMetricKey('infra:outages:v1|present(country==Cuba)').fn, 'present');
    assert.equal(parseMetricKey('prediction:markets-bootstrap:v1|yesPrice(market==Will the Fed cut rates in July 2026?)').value, 'Will the Fed cut rates in July 2026?');
    assert.equal(parseMetricKey('intelligence:gpsjam:v2|hexCount(region==Black Sea)').fn, 'hexCount');
    assert.equal(parseMetricKey('market:commodities-bootstrap:v1|price(symbol==CL=F)').value, 'CL=F');
    assert.equal(parseMetricKey('prediction:markets-bootstrap:v1|yesPrice(market==Will conflict in A)B resolve?)').value, 'Will conflict in A)B resolve?');
  });

  it('returns null for malformed keys', () => {
    for (const bad of ['', 'no-pipe', 'feed|fn(field=value)', 'feed|fn(field==value', 'feed|fn()']) {
      assert.equal(parseMetricKey(bad), null, bad);
    }
  });
});

describe('countSettlementLagMs', () => {
  it('uses the long UCDP lag only for legacy UCDP count feeds', () => {
    assert.equal(countSettlementLagMs('conflict:ucdp-events:v1'), UCDP_SETTLEMENT_LAG_MS);
    assert.equal(countSettlementLagMs('conflict:acled:v1:all:0:0'), ACLED_SETTLEMENT_LAG_MS);
    // Unrest is ACLED "Protests" dated by event_date — it must seal after the
    // same 2-day lag, not resolve live (a premature read scores a false NO).
    assert.equal(countSettlementLagMs('unrest:events:v1'), ACLED_SETTLEMENT_LAG_MS);
    // Cyber stays live: firstSeenAt is a near-real-time observation stamp.
    assert.equal(countSettlementLagMs('cyber:threats-bootstrap:v2'), 0);
  });
});

describe('resolveHardSpec', () => {
  it('keeps count entries pending until the settlement lag, then counts dated records in the forecast window', () => {
    const e = entry();
    const feed = {
      events: [
        { country: 'Mali', date_start: '2026-07-06' },
        { country: 'Mali', date_start: '2026-07-07' },
        { country: 'Mali', date_start: '2026-07-10' },
        { country: 'Somalia', date_start: '2026-07-10' },
        { country: 'Mali', date_start: '2026-07-15' },
      ],
    };

    assert.deepEqual(
      resolveHardSpec(e, feed, {}, e.deadline + UCDP_SETTLEMENT_LAG_MS - 1),
      {
        status: 'pending',
        evidence: { reason: 'count_settlement_lag', deadline: e.deadline, sealAfter: e.deadline + UCDP_SETTLEMENT_LAG_MS },
      },
    );

    const resolved = resolveHardSpec(e, feed, {}, e.deadline + UCDP_SETTLEMENT_LAG_MS);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.outcome, 'YES');
    assert.equal(resolved.evidence.metricValue, 2);
    assert.equal(resolved.evidence.comparison, '2 >= 2');
  });

  it('uses the shorter ACLED lag for fresh conflict counts', () => {
    const deadline = START + 3 * DAY_MS;
    const e = entry({
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:acled:v1:all:0:0|count(country==Mali)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:acled:v1:all:0:0',
      },
    });
    const feed = {
      events: [
        // Production ACLED shape from seed-conflict-intel.mjs: numeric occurredAt.
        { country: 'Mali', occurredAt: START },
        { country: 'Mali', occurredAt: START + 2 * DAY_MS },
        { country: 'Mali', occurredAt: START + 4 * DAY_MS },
        // Raw ACLED date string still resolves via the event_date fallback.
        { country: 'Burkina Faso', event_date: '2026-07-09' },
      ],
    };

    assert.deepEqual(
      resolveHardSpec(e, feed, {}, deadline + ACLED_SETTLEMENT_LAG_MS - 1),
      {
        status: 'pending',
        evidence: { reason: 'count_settlement_lag', deadline, sealAfter: deadline + ACLED_SETTLEMENT_LAG_MS },
      },
    );

    const resolved = resolveHardSpec(e, feed, {}, deadline + ACLED_SETTLEMENT_LAG_MS);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.outcome, 'YES');
    assert.equal(resolved.evidence.metricValue, 2);
    assert.equal(resolved.evidence.comparison, '2 >= 2');
  });

  it('voids a 30d ACLED display feed whose retained window starts after forecast generation', () => {
    const generatedAt = START;
    const deadline = generatedAt + 30 * DAY_MS;
    const sealAt = deadline + ACLED_SETTLEMENT_LAG_MS;
    const e = entry({
      id: 'fc-display-window-pruned',
      generatedAt,
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:acled:v1:all:0:0|count(country==Mali)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:acled:v1:all:0:0',
      },
    });
    const feed = {
      events: [
        { country: 'Mali', occurredAt: generatedAt + 2 * DAY_MS },
        { country: 'Burkina Faso', occurredAt: deadline },
      ],
    };

    const result = resolveHardSpec(e, feed, {}, sealAt);

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'VOID');
    assert.equal(result.evidence.reason, 'count_source_window_not_retained');
    assert.equal(result.evidence.sourceMinTs, generatedAt + 2 * DAY_MS);
    assert.equal(result.evidence.partialMetricValue, 1);
  });

  it('resolves a below-threshold 30d ACLED count when the resolution feed retains pre-generation coverage', () => {
    const generatedAt = START;
    const deadline = generatedAt + 30 * DAY_MS;
    const sealAt = deadline + ACLED_SETTLEMENT_LAG_MS;
    const e = entry({
      id: 'fc-resolution-window-retained',
      generatedAt,
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:acled-resolution:v1:all:0:0|count(country==Mali)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:acled-resolution:v1:all:0:0',
      },
    });
    const feed = {
      events: [
        { country: 'Ghana', occurredAt: generatedAt - DAY_MS },
        { country: 'Mali', occurredAt: generatedAt + 2 * DAY_MS },
        { country: 'Burkina Faso', occurredAt: deadline },
      ],
    };

    const result = resolveHardSpec(e, feed, {}, sealAt);

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'NO');
    assert.equal(result.evidence.metricValue, 1);
    assert.equal(result.evidence.sourceCoverage.minTs, generatedAt - DAY_MS);
  });

  it('keeps due count specs pending until the UCDP source has reached the forecast deadline', () => {
    const generatedAt = Date.parse('2026-07-09T00:00:00Z');
    const deadline = Date.parse('2026-08-08T00:00:00Z');
    const e = entry({
      id: 'fc-ukraine',
      generatedAt,
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:ucdp-events:v1|count(country==Ukraine)',
        operator: '>=',
        threshold: 66,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:ucdp-events:v1',
      },
    });
    const feed = {
      events: [
        { country: 'Ukraine', dateStart: Date.parse('2025-11-20T00:00:00Z') },
        { country: 'Ukraine', dateStart: Date.parse('2025-12-18T00:00:00Z') },
        { country: 'Somalia', dateStart: Date.parse('2025-12-19T00:00:00Z') },
      ],
    };

    const result = resolveHardSpec(e, feed, {}, deadline + UCDP_SETTLEMENT_LAG_MS);

    assert.equal(result.status, 'pending');
    assert.equal(result.evidence.reason, 'count_source_lags_deadline');
    assert.equal(result.evidence.sourceMaxTs, Date.parse('2025-12-19T00:00:00Z'));
  });

  it('voids count specs when a capped feed can no longer establish a below-threshold count', () => {
    const generatedAt = Date.parse('2026-07-01T00:00:00Z');
    const deadline = Date.parse('2026-07-10T00:00:00Z');
    const e = entry({
      id: 'fc-pruned-window',
      generatedAt,
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:ucdp-events:v1|count(country==Mali)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:ucdp-events:v1',
      },
    });
    const feed = {
      events: [
        { country: 'Mali', dateStart: Date.parse('2026-07-09T00:00:00Z') },
        { country: 'Ghana', dateStart: Date.parse('2026-07-11T00:00:00Z') },
      ],
    };

    const result = resolveHardSpec(e, feed, {}, deadline + UCDP_SETTLEMENT_LAG_MS);

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'VOID');
    assert.equal(result.evidence.reason, 'count_source_window_not_retained');
    assert.equal(result.evidence.partialMetricValue, 1);
  });

  it('resolves truncated count specs when the partial count already establishes YES', () => {
    const generatedAt = Date.parse('2026-07-01T00:00:00Z');
    const deadline = Date.parse('2026-07-10T00:00:00Z');
    const e = entry({
      id: 'fc-pruned-yes',
      generatedAt,
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:ucdp-events:v1|count(country==Mali)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:ucdp-events:v1',
      },
    });
    const feed = {
      events: [
        { country: 'Mali', dateStart: Date.parse('2026-07-09T00:00:00Z') },
        { country: 'Mali', dateStart: Date.parse('2026-07-10T00:00:00Z') },
        { country: 'Ghana', dateStart: Date.parse('2026-07-11T00:00:00Z') },
      ],
    };

    const result = resolveHardSpec(e, feed, {}, deadline + UCDP_SETTLEMENT_LAG_MS);

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'YES');
    assert.equal(result.evidence.metricValue, 2);
    assert.equal(result.evidence.sourceCoverage.minTs, Date.parse('2026-07-09T00:00:00Z'));
  });

  it('matches country display names against ISO-2 country fields for cyber counts', () => {
    const deadline = START + DAY_MS;
    const e = entry({
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'cyber:threats-bootstrap:v2|count(country==Estonia)',
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'cyber:threats-bootstrap:v2',
      },
    });
    const feed = {
      threats: [
        { country: 'EE', firstSeenAt: START + 1_000 },
        { country: 'LV', firstSeenAt: START + 2_000 },
      ],
    };

    const resolved = resolveHardSpec(e, feed, {}, deadline);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.outcome, 'YES');
    assert.equal(resolved.evidence.metricValue, 1);
  });

  it('bridges a UCDP parenthetical region name to ACLED country naming for conflict counts', () => {
    // The conflict detector names the region from the UCDP feed (a former name
    // in parentheses), but the spec now resolves against the ACLED feed, whose
    // country field drops the article. Without canonical bridging these never
    // match and an active conflict zone scores a false NO.
    const deadline = START + 3 * DAY_MS;
    const e = entry({
      region: 'DR Congo (Zaire)',
      deadline,
      spec: {
        kind: 'hard',
        metricKey: 'conflict:acled:v1:all:0:0|count(country==DR Congo (Zaire))',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:acled:v1:all:0:0',
      },
    });
    // Real ACLED feed shape: ACLED country naming + numeric occurredAt (epoch ms).
    const feed = {
      events: [
        { country: 'Democratic Republic of Congo', occurredAt: START + DAY_MS },
        { country: 'Democratic Republic of Congo', occurredAt: START + 2 * DAY_MS },
        { country: 'Rwanda', occurredAt: deadline },
      ],
    };

    const resolved = resolveHardSpec(e, feed, {}, deadline + ACLED_SETTLEMENT_LAG_MS);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.outcome, 'YES');
    assert.equal(resolved.evidence.metricValue, 2);
  });

  it('resolves at-deadline point reads from the first sample at or after deadline', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)',
        operator: '>=',
        threshold: 60,
        window: 'at-deadline',
        deadline: START + DAY_MS,
        sourceFeed: 'supply_chain:chokepoints:v4',
      },
      deadline: START + DAY_MS,
    });

    const result = resolveHardSpec(e, { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 88 }] }, {
      recent: [
        { ts: START + DAY_MS - 1, value: 61 },
        { ts: START + DAY_MS + 10, value: 99 },
        { ts: START + DAY_MS + 20, value: 20 },
      ],
    }, START + DAY_MS + 10);

    assert.equal(result.outcome, 'YES');
    assert.equal(result.evidence.metricValue, 99);
    assert.equal(result.evidence.readTs, START + DAY_MS + 10);
  });

  it('resolves at-deadline point reads from live feed after deadline when no post-deadline sample exists', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)',
        operator: '>=',
        threshold: 60,
        window: 'at-deadline',
        deadline: START + DAY_MS,
        sourceFeed: 'supply_chain:chokepoints:v4',
      },
      deadline: START + DAY_MS,
    });

    const result = resolveHardSpec(e, { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 88 }] }, {
      recent: [{ ts: START + DAY_MS - 1, value: 12 }],
    }, START + DAY_MS + 10);

    assert.equal(result.outcome, 'YES');
    assert.equal(result.evidence.metricValue, 88);
    assert.equal(result.evidence.readTs, START + DAY_MS + 10);
  });

  it('reads the producer-shaped chokepoint record: name + disruptionScore, no riskScore', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)',
        operator: '>=',
        threshold: 60,
        window: 'at-deadline',
        deadline: START + DAY_MS,
        sourceFeed: 'supply_chain:chokepoints:v4',
      },
      deadline: START + DAY_MS,
    });
    // Shape of the live supply_chain:chokepoints:v4 value (get-chokepoint-status.ts).
    const feed = { chokepoints: [{ id: 'hormuz', name: 'Strait of Hormuz', disruptionScore: 72, status: 'red' }], fetchedAt: START };

    const result = resolveHardSpec(e, feed, { recent: [] }, START + DAY_MS + 10);

    assert.equal(result.outcome, 'YES');
    assert.equal(result.evidence.metricValue, 72);
  });

  it('keeps due count specs pending when the source feed is unavailable', () => {
    const e = entry();

    const result = resolveHardSpec(e, undefined, {}, e.deadline + UCDP_SETTLEMENT_LAG_MS);

    assert.equal(result.status, 'pending');
    assert.equal(result.evidence.reason, 'source_feed_unavailable');
  });

  it('resolves within-horizon presence when a record appears and then disappears inside samples', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'infra:outages:v1|present(country==Cuba)',
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline: START + 3 * DAY_MS,
        sourceFeed: 'infra:outages:v1',
      },
      deadline: START + 3 * DAY_MS,
    });

    const result = resolveHardSpec(e, { outages: [] }, {
      recent: [
        { ts: START + DAY_MS, value: 0 },
        { ts: START + 2 * DAY_MS, value: 1 },
        { ts: START + 3 * DAY_MS, value: 0 },
      ],
    }, START + 3 * DAY_MS);

    assert.equal(result.outcome, 'YES');
    assert.equal(result.evidence.metricValue, 1);
  });

  it('resolves within-horizon crosses using sampled crossed-and-reverted observations', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'market:commodities-bootstrap:v1|price(symbol==CL=F)',
        operator: 'crosses',
        threshold: 110,
        baselineValue: 100,
        window: 'within-horizon',
        deadline: START + 3 * DAY_MS,
        sourceFeed: 'market:commodities-bootstrap:v1',
      },
      deadline: START + 3 * DAY_MS,
    });

    const yes = resolveHardSpec(e, { quotes: [{ symbol: 'CL=F', price: 101 }] }, {
      recent: [
        { ts: START + DAY_MS, value: 102 },
        { ts: START + 2 * DAY_MS, value: 111 },
        { ts: START + 3 * DAY_MS, value: 99 },
      ],
    }, START + 3 * DAY_MS);
    assert.equal(yes.outcome, 'YES');

    const voided = resolveHardSpec(e, { quotes: [] }, { recent: [] }, START + 3 * DAY_MS);
    assert.equal(voided.outcome, 'VOID');
    assert.match(voided.evidence.reason, /no_establishable_metric/);
  });

  it('does not resolve within-horizon from a post-deadline current feed snapshot', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'market:commodities-bootstrap:v1|price(symbol==CL=F)',
        operator: '>=',
        threshold: 110,
        window: 'within-horizon',
        deadline: START + DAY_MS,
        sourceFeed: 'market:commodities-bootstrap:v1',
      },
      deadline: START + DAY_MS,
    });

    const result = resolveHardSpec(e, { quotes: [{ symbol: 'CL=F', price: 120 }] }, {
      recent: [
        { ts: START + DAY_MS - 1, value: 90 },
      ],
    }, START + DAY_MS + 60_000);

    assert.equal(result.outcome, 'NO');
    assert.equal(result.evidence.metricValue, 90);
  });

  it('keeps at-deadline pending on feed outage instead of voiding before the first post-deadline read', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'market:commodities-bootstrap:v1|price(symbol==CL=F)',
        operator: '>=',
        threshold: 110,
        window: 'at-deadline',
        deadline: START + DAY_MS,
        sourceFeed: 'market:commodities-bootstrap:v1',
      },
      deadline: START + DAY_MS,
    });

    const result = resolveHardSpec(e, undefined, { recent: [] }, START + 2 * DAY_MS);

    assert.equal(result.status, 'pending');
    assert.equal(result.evidence.reason, 'source_feed_unavailable');
  });

  it('resolves <= and downward crosses branches', () => {
    const base = entry({
      spec: {
        kind: 'hard',
        metricKey: 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)',
        operator: '<=',
        threshold: 30,
        window: 'at-deadline',
        deadline: START + DAY_MS,
        sourceFeed: 'supply_chain:chokepoints:v4',
      },
      deadline: START + DAY_MS,
    });
    const le = resolveHardSpec(base, { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 25 }] }, {}, START + DAY_MS);
    assert.equal(le.outcome, 'YES');
    assert.equal(le.evidence.comparison, '25 <= 30');

    const crossDown = resolveHardSpec({
      ...base,
      spec: {
        ...base.spec,
        operator: 'crosses',
        threshold: 30,
        baselineValue: 60,
        window: 'within-horizon',
      },
    }, { chokepoints: [] }, {
      recent: [
        { ts: START + 1_000, value: 55 },
        { ts: START + 2_000, value: 28 },
      ],
    }, START + DAY_MS);
    assert.equal(crossDown.outcome, 'YES');
    assert.equal(crossDown.evidence.comparison, '28 crosses 30 from 60');
  });

  it('never grades a bootstrap yesPrice read: the feed carries the crowd price, not the outcome (#5233)', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'prediction:markets-bootstrap:v1|yesPrice(market==Will the Fed cut rates in July 2026?)',
        operator: 'crosses',
        threshold: 50,
        baselineValue: 72,
        window: 'at-endDate',
        deadline: START + DAY_MS,
        sourceFeed: 'prediction:markets-bootstrap:v1',
      },
      deadline: START + DAY_MS,
    });
    for (const yesPrice of [98, 51, 49, 2]) {
      const result = resolveHardSpec(e, { markets: [{ market: 'Will the Fed cut rates in July 2026?', yesPrice }] }, {
        recent: [{ ts: START + DAY_MS - 5, value: yesPrice }],
      }, START + DAY_MS);
      assert.equal(result.outcome, 'VOID', `yesPrice ${yesPrice}`);
      assert.equal(result.evidence.reason, 'market_price_not_outcome');
    }
    assert.equal(resolveHardSpec(e, {}, {}, START + DAY_MS - 1).status, 'pending', 'still pending before endDate');
  });

  it('is deterministic and every VOID carries a reason', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'feed|unknown(field==value)',
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline: START + DAY_MS,
        sourceFeed: 'feed',
      },
      deadline: START + DAY_MS,
    });
    const a = resolveHardSpec(e, {}, {}, START + DAY_MS);
    const b = resolveHardSpec(e, {}, {}, START + DAY_MS);
    assert.deepEqual(a, b);
    assert.equal(a.outcome, 'VOID');
    assert.ok(a.evidence.reason);
  });

  it('fixtures stay omission-shaped', () => {
    assertNoNullFields(entry());
  });
});

describe('extractMetricObservation present() semantics (#void-triage)', () => {
  const parsed = parseMetricKey('infra:outages:v1|present(country==Cuba)');

  it('observes 0 (not NaN) when the subject is absent, matching extractMetricValue', () => {
    const feed = { outages: [{ country: 'Iraq' }] }; // Cuba absent (no outage)
    assert.equal(extractMetricValue(parsed, feed), 0);
    const obs = extractMetricObservation(parsed, feed);
    assert.equal(obs.value, 0); // was NaN → error sample → false VOID
    assert.equal(obs.asOf, null);
  });

  it('observes 1 when the subject is present', () => {
    const feed = { outages: [{ country: 'Cuba', date: '2026-07-14' }] };
    const obs = extractMetricObservation(parsed, feed);
    assert.equal(obs.value, 1);
    assert.equal(obs.asOf, Date.parse('2026-07-14'));
  });

  it('lets a within-horizon present spec resolve NO on a sampled absence (not VOID)', () => {
    const now = Date.parse('2026-07-14T00:00:00Z');
    const spec = {
      kind: 'hard',
      metricKey: 'infra:outages:v1|present(country==Cuba)',
      operator: '>=',
      threshold: 1,
      window: 'within-horizon',
      deadline: now,
      sourceFeed: 'infra:outages:v1',
    };
    const entry = { spec, generatedAt: now - DAY_MS };
    // a sampled absence within the window (value 0) — must resolve NO, not VOID
    const samples = [{ ts: now - DAY_MS / 2, value: 0 }];
    const res = resolveHardSpec(entry, { outages: [{ country: 'Iraq' }] }, samples, now + 1);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'NO');
  });
});

describe('gpsjam hexCount measures what the GPS detector measured (#8990)', () => {
  const GPS_FEED = 'intelligence:gpsjam:v2';
  const hex = (lat, lon, level = 'high') => ({ h3: `84${lat}${lon}`, lat, lon, level, region: 'other', pct: level === 'high' ? 40 : 5 });
  // Live v2 shape: one daily snapshot of single medium/high res-4 hexes, slug
  // regions, no count field.
  const snapshot = (date, hexes) => ({ date, fetchedAt: `${date}T16:00:00.000Z`, source: 'gpsjam.org', hexes });
  const HEXES = [
    hex(34, 33), hex(36, 28, 'medium'), // Eastern Mediterranean, interior
    hex(33, 30), hex(37, 30, 'medium'), hex(35, 25), hex(34, 37, 'medium'), // Eastern Mediterranean, one on each box edge
    hex(26, 52), hex(27, 50, 'medium'), hex(30, 48), // Persian Gulf only
    hex(21, 50), // inside both the Red Sea and Persian Gulf boxes
    hex(0, 0), hex(55, 70), // outside every box
  ];
  const parsedFor = (region) => parseMetricKey(`${GPS_FEED}|hexCount(region==${region})`);

  it('buckets single hexes into the detector boxes, both interference levels, zero-count boxes included', () => {
    const shaped = shapeResolutionFeed(GPS_FEED, snapshot('2026-10-06', HEXES));
    const counts = Object.fromEntries(Object.keys(MARITIME_REGIONS).map((region) => [region, extractMetricValue(parsedFor(region), shaped)]));
    assert.deepEqual(counts, {
      'Eastern Mediterranean': 6,
      'Red Sea': 1,
      'Persian Gulf': 4,
      'Black Sea': 0,
      'Baltic Sea': 0,
    });
  });

  it('reads the same counts through a seed envelope', () => {
    const raw = snapshot('2026-10-06', HEXES);
    const enveloped = { _seed: { fetchedAt: Date.parse('2026-10-06T16:00:00Z') }, data: raw };
    assert.deepEqual(shapeResolutionFeed(GPS_FEED, enveloped), shapeResolutionFeed(GPS_FEED, raw));
  });

  it('stamps each region with the snapshot date as asOf', () => {
    const obs = extractMetricObservation(parsedFor('Eastern Mediterranean'), shapeResolutionFeed(GPS_FEED, snapshot('2026-10-06', HEXES)));
    assert.deepEqual(obs, { value: 6, asOf: Date.parse('2026-10-06') });
  });

  it('matches the detector count for every region the detector emits', () => {
    const raw = snapshot('2026-10-06', HEXES);
    const predictions = detectGpsJammingScenarios({ gpsJamming: normalizeGpsJamming(raw) });
    assert.deepEqual(predictions.map((p) => p.region).sort(), ['Eastern Mediterranean', 'Persian Gulf']);
    const shaped = shapeResolutionFeed(GPS_FEED, raw);
    for (const prediction of predictions) {
      const detected = Number(prediction.signals[0].value.split(' ')[0]);
      assert.equal(extractMetricValue(parsedFor(prediction.region), shaped), detected, prediction.region);
    }
  });

  it('the detector emits a zone at the shared floor and not below it', () => {
    const zone = (count) => ({ hexes: Array.from({ length: count }, () => hex(35, 30)) });
    const emitted = (count) => detectGpsJammingScenarios({ gpsJamming: normalizeGpsJamming(zone(count)) }).map((p) => p.region);
    assert.equal(GPS_ZONE_MIN_HEXES, 3);
    assert.deepEqual(emitted(GPS_ZONE_MIN_HEXES), ['Eastern Mediterranean']);
    assert.deepEqual(emitted(GPS_ZONE_MIN_HEXES - 1), []);
  });

  it('the detector skips a zone whose count is too high for the floor to be in doubt (#9012)', () => {
    const zone = (count) => ({ hexes: Array.from({ length: count }, () => hex(57, 20)) });
    const emitted = (count) => detectGpsJammingScenarios({ gpsJamming: normalizeGpsJamming(zone(count)) }).map((p) => p.region);
    assert.equal(GPS_ZONE_MAX_UNCERTAIN_HEXES, 9);
    assert.deepEqual(emitted(GPS_ZONE_MAX_UNCERTAIN_HEXES), ['Baltic Sea']);
    assert.deepEqual(emitted(GPS_ZONE_MAX_UNCERTAIN_HEXES + 1), []);
    assert.deepEqual(emitted(300), [], 'a Baltic-sized zone never falls to the floor within a week');
  });

  it('every emitted GPS forecast carries the measured persistence rate, whatever its count (#9012)', () => {
    const zone = (count) => ({ hexes: Array.from({ length: count }, () => hex(15, 40)) });
    for (let count = GPS_ZONE_MIN_HEXES; count <= GPS_ZONE_MAX_UNCERTAIN_HEXES; count++) {
      const [prediction] = detectGpsJammingScenarios({ gpsJamming: normalizeGpsJamming(zone(count)) });
      assert.equal(prediction.region, 'Red Sea', String(count));
      assert.equal(prediction.probability, GPS_ZONE_PERSISTENCE_PROBABILITY, String(count));
    }
    assert.equal(GPS_ZONE_PERSISTENCE_PROBABILITY, 0.58);
  });

  it('an emitted GPS forecast resolves on the detector floor: YES while the zone holds it, NO once it drops below', () => {
    const emittedAt = Date.parse('2026-10-06T18:00:00Z');
    const predictions = detectGpsJammingScenarios({ gpsJamming: normalizeGpsJamming(snapshot('2026-10-05', HEXES)) });
    const [forecast] = attachResolutionSpecs(predictions.filter((p) => p.region === 'Eastern Mediterranean'), {}, emittedAt);
    const spec = forecast.resolution;
    assert.equal(spec.metricKey, `${GPS_FEED}|hexCount(region==Eastern Mediterranean)`);
    assert.deepEqual([spec.operator, spec.threshold, spec.rule, spec.ruleVersion], ['>=', GPS_ZONE_MIN_HEXES, GPS_RESOLUTION_RULE, GPS_RESOLUTION_RULE_VERSION]);
    const ledgerEntry = { id: forecast.id, generatedAt: emittedAt, deadline: spec.deadline, spec };
    const atDeadline = spec.deadline + 30 * 60 * 1000;
    const deadlineDate = new Date(spec.deadline).toISOString().slice(0, 10);
    const withEasternMed = (count) => shapeResolutionFeed(GPS_FEED, snapshot(deadlineDate, Array.from({ length: count }, () => hex(35, 30))));

    const held = resolveHardSpec(ledgerEntry, withEasternMed(GPS_ZONE_MIN_HEXES), null, atDeadline);
    assert.equal(held.status, 'resolved');
    assert.equal(held.outcome, 'YES', 'fewer hexes than at emission still meets the floor');
    assert.equal(held.evidence.metricValue, GPS_ZONE_MIN_HEXES);

    const faded = resolveHardSpec(ledgerEntry, withEasternMed(GPS_ZONE_MIN_HEXES - 1), null, atDeadline);
    assert.equal(faded.outcome, 'NO');
    assert.equal(faded.evidence.metricValue, GPS_ZONE_MIN_HEXES - 1);
  });

  it('a GPS forecast\'s horizon windows carry the same rule, so the ledger never re-migrates them', () => {
    const [prediction] = detectGpsJammingScenarios({ gpsJamming: normalizeGpsJamming(snapshot('2026-10-05', HEXES)) });
    const horizons = buildHorizonResolutionSpecs(prediction, {}, Date.parse('2026-10-06T18:00:00Z'));
    const hard = Object.values(horizons).filter((spec) => spec.kind === 'hard');
    assert.ok(hard.length > 0);
    for (const spec of hard) assert.deepEqual([spec.threshold, spec.rule, spec.ruleVersion], [GPS_ZONE_MIN_HEXES, GPS_RESOLUTION_RULE, GPS_RESOLUTION_RULE_VERSION], spec.horizon);
  });

  it('waits for the snapshot covering the deadline day, and VOIDs if it never arrives', () => {
    const deadline = Date.parse('2026-10-13T12:00:00Z');
    const ledgerEntry = entry({
      generatedAt: deadline - 7 * DAY_MS,
      deadline,
      spec: { kind: 'hard', metricKey: `${GPS_FEED}|hexCount(region==Eastern Mediterranean)`, operator: '>=', threshold: 4, window: 'at-deadline', sourceFeed: GPS_FEED, deadline },
    });
    const stale = shapeResolutionFeed(GPS_FEED, snapshot('2026-10-12', HEXES));
    const pending = resolveHardSpec(ledgerEntry, stale, null, deadline + DAY_MS);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.evidence.reason, 'value_source_not_settled');
    const never = resolveHardSpec(ledgerEntry, stale, null, deadline + 11 * DAY_MS);
    assert.equal(never.outcome, 'VOID');
    assert.equal(never.evidence.reason, 'value_source_never_settled');
  });

  it('a feed without a hexes array still yields no metric rather than a fabricated 0', () => {
    assert.ok(Number.isNaN(extractMetricValue(parsedFor('Baltic Sea'), shapeResolutionFeed(GPS_FEED, { date: '2026-10-06' }))));
  });

  it('the detector and the resolver share one box definition', async () => {
    const shared = await import('../scripts/_gps-maritime-regions.mjs');
    assert.equal(MARITIME_REGIONS, shared.MARITIME_REGIONS);
  });
});

// #7072: the scorecard stamps each hard window with hardResolutionBoundMs plus
// one resolver cycle. Drive the resolver hour by hour with the feed down, so a
// change to any grace here cannot drift from the stamped service level.
describe('hardResolutionBoundMs matches when resolveHardSpec first seals a window with its feed down', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const deadline = Date.parse('2026-08-10T12:00:00Z');
  const cases = [
    ['UCDP count', 'conflict:ucdp-events:v1|count(country==Syria)', 'within-horizon'],
    ['ACLED count', 'conflict:acled-resolution:v1:all:0:0|count(country==Syria)', 'within-horizon'],
    ['live count', 'cyber:threats-bootstrap:v2|count(country==US)', 'within-horizon'],
    ['live price', 'market:commodities-bootstrap:v1|price(symbol==CL)', 'at-deadline'],
    ['chokepoint', 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)', 'at-deadline'],
    ['EIA', 'energy:eia-petroleum:v1|value(series==WCRSTUS1)', 'at-deadline'],
    ['monthly FRED', 'economic:fred:v1:CPIAUCSL:0|value(series==CPIAUCSL)', 'at-deadline'],
    ['daily FRED', 'economic:fred:v1:DGS10:0|value(series==DGS10)', 'at-deadline'],
    ['GPS jamming', 'intelligence:gpsjam:v2|hexCount(region==Baltic Sea)', 'at-deadline'],
    ['market settlement', 'prediction:markets-resolution:v1|yesPrice(slug==x)', 'at-endDate'],
    ['within-horizon read', 'market:commodities-bootstrap:v1|price(symbol==CL)', 'within-horizon'],
    ['unsupported window', 'market:commodities-bootstrap:v1|price(symbol==CL)', 'rolling'],
  ];
  for (const [label, metricKey, window] of cases) {
    it(label, () => {
      const spec = { kind: 'hard', metricKey, window, operator: 'gt', threshold: 1, deadline, sourceFeed: metricKey.split('|')[0] };
      const entry = { key: 'k', id: 'k', spec, deadline, generatedAt: deadline - 7 * DAY, firstSeenAt: deadline - 7 * DAY };
      const bound = hardResolutionBoundMs(spec);
      let sealedAfter = null;
      for (let t = 0; t <= bound + 2 * DAY; t += HOUR) {
        if (resolveHardSpec(entry, null, [], deadline + t).status === 'resolved') { sealedAfter = t; break; }
      }
      assert.notEqual(sealedAfter, null, 'the window seals inside its bound');
      assert.ok(sealedAfter <= bound + HOUR, `sealed ${sealedAfter / HOUR}h after the deadline, bound ${bound / HOUR}h`);
      // GPS jamming counts its bound from the start of the deadline's UTC day,
      // so it may seal that many hours early, and no earlier.
      const lowerBound = label === 'GPS jamming' ? bound - (deadline - Math.floor(deadline / DAY) * DAY) : bound;
      assert.ok(sealedAfter >= lowerBound, `sealed ${sealedAfter / HOUR}h, before the ${lowerBound / HOUR}h lower bound`);
    });
  }
});
