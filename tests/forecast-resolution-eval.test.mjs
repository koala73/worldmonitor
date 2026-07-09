import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ACLED_SETTLEMENT_LAG_MS,
  UCDP_SETTLEMENT_LAG_MS,
  countSettlementLagMs,
  parseMetricKey,
  resolveHardSpec,
} from '../scripts/_forecast-resolution-eval.mjs';

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
    assert.equal(countSettlementLagMs('unrest:events:v1'), 0);
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

  it('uses the shorter ACLED lag and event_date for fresh conflict counts', () => {
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
        { country: 'Mali', event_date: '2026-07-07' },
        { country: 'Mali', event_date: '2026-07-09' },
        { country: 'Mali', event_date: '2026-07-11' },
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

  it('matches country display names against ISO-2 country fields for cyber counts', () => {
    const deadline = START + 1_000;
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

  it('resolves at-endDate yesPrice from production market baselines without inverting settlement', () => {
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

    const yes = resolveHardSpec(e, { markets: [{ market: 'Will the Fed cut rates in July 2026?', yesPrice: 98 }] }, {
      recent: [
        { ts: START, value: 72 },
        { ts: START + DAY_MS - 5, value: 3 },
      ],
    }, START + DAY_MS);

    assert.equal(yes.outcome, 'YES');
    assert.equal(yes.evidence.metricValue, 98);

    const no = resolveHardSpec(e, { markets: [{ market: 'Will the Fed cut rates in July 2026?', yesPrice: 2 }] }, {
      recent: [
        { ts: START, value: 72 },
        { ts: START + DAY_MS - 5, value: 98 },
      ],
    }, START + DAY_MS);

    assert.equal(no.outcome, 'NO');
    assert.equal(no.evidence.metricValue, 2);
  });

  it('keeps prediction-market yesPrice settlement flip-resistant around the 50 line', () => {
    const e = entry({
      spec: {
        kind: 'hard',
        metricKey: 'prediction:markets-bootstrap:v1|yesPrice(market==Will the Fed cut rates in July 2026?)',
        operator: 'crosses',
        threshold: 50,
        baselineValue: 90,
        window: 'at-endDate',
        deadline: START + DAY_MS,
        sourceFeed: 'prediction:markets-bootstrap:v1',
      },
      deadline: START + DAY_MS,
    });

    const yes = resolveHardSpec(e, { markets: [{ market: 'Will the Fed cut rates in July 2026?', yesPrice: 51 }] }, {}, START + DAY_MS);
    const no = resolveHardSpec(e, { markets: [{ market: 'Will the Fed cut rates in July 2026?', yesPrice: 49 }] }, {}, START + DAY_MS);

    assert.equal(yes.outcome, 'YES');
    assert.equal(no.outcome, 'NO');
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
