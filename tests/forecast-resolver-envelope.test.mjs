import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ENVELOPE_BUG_VOID_REASON, processResolutionCycle, processResolutionCycleWithJudges, voidEnvelopeBugResolutions } from '../scripts/seed-forecast-resolutions.mjs';
import { evaluateExtractionShadow } from '../scripts/_forecast-resolution.mjs';
import { RECEIPT_VOID_REASON_LABELS, buildPublicReceipts, computeScorecard } from '../scripts/_forecast-scorecard.mjs';
import { shapeResolutionFeeds } from '../scripts/_forecast-resolution-eval.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const CYBER_FEED = 'cyber:threats-bootstrap:v2';
const INFRA_FEED = 'infra:outages:v1';

function envelope(data, fetchedAt = T0) {
  return { _seed: { fetchedAt, recordCount: 1, sourceVersion: 'test', schemaVersion: 1, state: 'OK' }, data };
}

function forecast(id, domain, region, resolution) {
  return {
    id,
    domain,
    region,
    title: `${domain}: ${region}`,
    probability: 0.4,
    confidence: 0.5,
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    generatedAt: T0,
    resolution,
  };
}

const cyberRomania = forecast('fc-cyber-ro', 'cyber', 'Romania', {
  kind: 'hard',
  metricKey: `${CYBER_FEED}|count(country==Romania)`,
  operator: '>=',
  threshold: 2,
  window: 'within-horizon',
  deadline: T0 + 7 * DAY_MS,
  sourceFeed: CYBER_FEED,
});

const infraIraq = forecast('fc-infra-iq', 'infrastructure', 'Iraq', {
  kind: 'hard',
  metricKey: `${INFRA_FEED}|present(country==Iraq)`,
  operator: '>=',
  threshold: 1,
  window: 'within-horizon',
  deadline: T0 + 7 * DAY_MS,
  sourceFeed: INFRA_FEED,
});

const cyberThreats = {
  threats: [
    { id: 'c2:1', country: 'RO', firstSeenAt: T0 + DAY_MS },
    { id: 'c2:2', country: 'RO', firstSeenAt: T0 + 2 * DAY_MS },
    { id: 'c2:3', country: 'DE', firstSeenAt: T0 + 2 * DAY_MS },
  ],
};
const infraOutages = { outages: [{ id: 'cf-1', country: 'Iraq', detectedAt: T0 + DAY_MS }] };

function resolvedRow(ledger, id) {
  return Object.values(ledger).find((entry) => entry.id === id);
}

describe('resolver reads contract-mode seed envelopes (#5233)', () => {
  for (const [label, raw] of [['enveloped', envelope(cyberThreats)], ['bare', cyberThreats]]) {
    it(`counts cyber records in a ${label} feed`, () => {
      const feeds = shapeResolutionFeeds({ [CYBER_FEED]: raw });
      const { ledger } = processResolutionCycle({}, [{ generatedAt: T0, predictions: [cyberRomania] }], feeds, T0 + 8 * DAY_MS);
      const row = resolvedRow(ledger, 'fc-cyber-ro');
      assert.equal(row.status, 'resolved');
      assert.equal(row.evidence.metricValue, 2);
      assert.equal(row.outcome, 'YES');
    });
  }

  it('samples an enveloped outage feed as present and resolves YES', () => {
    const feeds = shapeResolutionFeeds({ [INFRA_FEED]: envelope(infraOutages) });
    const sampled = processResolutionCycle({}, [{ generatedAt: T0, predictions: [infraIraq] }], feeds, T0 + DAY_MS);
    const { ledger } = processResolutionCycle(sampled.ledger, [], feeds, T0 + 8 * DAY_MS);
    const row = resolvedRow(ledger, 'fc-infra-iq');
    assert.equal(row.samples.last.value, 1);
    assert.equal(row.evidence.metricValue, 1);
    assert.equal(row.outcome, 'YES');
  });

  it('the emission-time shadow sees the same unwrapped view', () => {
    const [verdict] = evaluateExtractionShadow([{ ...infraIraq, resolution: infraIraq.resolution }], { [INFRA_FEED]: envelope(infraOutages) });
    assert.equal(verdict.outcome, 'pass');
    assert.equal(verdict.value, 1);
  });
});

// Shapes copied from production rows resolved before the fix.
function preFixRow(id, sourceFeed, metricKey, outcome, evidence) {
  return {
    id,
    key: `${id}@${T0 + 7 * DAY_MS}`,
    domain: sourceFeed.startsWith('cyber') ? 'cyber' : 'infrastructure',
    region: 'Romania',
    title: `Forecast ${id}`,
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    spec: { kind: 'hard', deadline: T0 + 7 * DAY_MS, metricKey, operator: '>=', threshold: 8, window: 'within-horizon', sourceFeed },
    probability: 0.174,
    generatedAt: T0,
    firstSeenAt: T0,
    deadline: T0 + 7 * DAY_MS,
    status: 'resolved',
    samples: { count: 0, recent: [] },
    outcome,
    resolvedAt: T0 + 8 * DAY_MS,
    sealedAt: T0 + 8 * DAY_MS,
    evidence: { metricKey, resolvedAt: T0 + 8 * DAY_MS, ...evidence },
    receiptArchivedAt: T0 + 8 * DAY_MS,
  };
}

// resolveDueEntries never stamps a horizon row, so a zero it reads after the
// fix carries no envelopeAware either.
function horizonRow() {
  const row = preFixRow('fc-infra-horizon', INFRA_FEED, `${INFRA_FEED}|present(country==Iraq)`, 'NO', { metricValue: 0 });
  row.key = `${row.id}@d7@${T0 + 7 * DAY_MS}`;
  row.spec = { ...row.spec, horizon: 'd7' };
  return row;
}

function preFixLedger() {
  const rows = [
    preFixRow('fc-cyber-zero', CYBER_FEED, `${CYBER_FEED}|count(country==Romania)`, 'NO', { metricValue: 0, comparison: '0 >= 8', sampleSpan: { count: 0 } }),
    preFixRow('fc-infra-zero', INFRA_FEED, `${INFRA_FEED}|present(country==Iraq)`, 'NO', { metricValue: 0, comparison: '0 >= 1', sampleSpan: { count: 3 } }),
    preFixRow('fc-infra-void', INFRA_FEED, `${INFRA_FEED}|present(country==Iraq)`, 'VOID', { reason: 'no_establishable_metric' }),
    preFixRow('fc-ucdp-zero', 'conflict:ucdp-events:v1', 'conflict:ucdp-events:v1|count(country==Mali)', 'NO', { metricValue: 0, comparison: '0 >= 8' }),
    preFixRow('fc-cyber-postfix', CYBER_FEED, `${CYBER_FEED}|count(country==Romania)`, 'NO', { metricValue: 0, comparison: '0 >= 8', envelopeAware: true }),
    preFixRow('fc-cyber-nonzero', CYBER_FEED, `${CYBER_FEED}|count(country==Romania)`, 'NO', { metricValue: 3, comparison: '3 >= 8' }),
    horizonRow(),
  ];
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

describe('voidEnvelopeBugResolutions (#5233)', () => {
  it('voids only zero reads of the enveloped feeds that the old reader resolved', () => {
    const before = preFixLedger();
    const ledger = structuredClone(before);
    const voidedAt = T0 + 10 * DAY_MS;
    assert.equal(voidEnvelopeBugResolutions(ledger, voidedAt), 2);
    const byId = Object.fromEntries(Object.values(ledger).map((row) => [row.id, row]));
    for (const id of ['fc-cyber-zero', 'fc-infra-zero']) {
      const original = Object.values(before).find((row) => row.id === id);
      assert.equal(byId[id].outcome, 'VOID', id);
      assert.deepEqual(byId[id].evidence, {
        reason: ENVELOPE_BUG_VOID_REASON,
        metricKey: original.spec.metricKey,
        resolvedAt: original.resolvedAt,
        supersededOutcome: 'NO',
        supersededEvidence: original.evidence,
        voidedAt,
      });
      assert.equal(byId[id].resolvedAt, original.resolvedAt, 'the row stays in the same rolling window');
    }
    for (const id of ['fc-infra-void', 'fc-ucdp-zero', 'fc-cyber-postfix', 'fc-cyber-nonzero', 'fc-infra-horizon']) {
      assert.deepEqual(byId[id], Object.values(before).find((row) => row.id === id), id);
    }
  });

  it('is idempotent', () => {
    const once = preFixLedger();
    voidEnvelopeBugResolutions(once, T0 + 10 * DAY_MS);
    const twice = structuredClone(once);
    assert.equal(voidEnvelopeBugResolutions(twice, T0 + 11 * DAY_MS), 0);
    assert.deepEqual(twice, once, 'a later run keeps the first voidedAt');
  });

  it('keeps a genuine zero the fixed reader resolves, across later cycles', () => {
    const feeds = shapeResolutionFeeds({ [CYBER_FEED]: envelope({ threats: [{ id: 'x', country: 'DE', firstSeenAt: T0 + DAY_MS }] }) });
    const first = processResolutionCycle({}, [{ generatedAt: T0, predictions: [cyberRomania] }], feeds, T0 + 8 * DAY_MS);
    const second = processResolutionCycle(first.ledger, [], feeds, T0 + 9 * DAY_MS);
    const row = resolvedRow(second.ledger, 'fc-cyber-ro');
    assert.equal(row.outcome, 'NO');
    assert.equal(row.evidence.metricValue, 0);
    assert.equal(row.evidence.envelopeAware, true);
  });

  it('runs inside the resolver cycle and drops the rows from the scored cohort', () => {
    const nowMs = T0 + 10 * DAY_MS;
    const before = computeScorecard(preFixLedger(), nowMs);
    const { ledger, scorecard } = processResolutionCycle(preFixLedger(), [], {}, nowMs);
    assert.equal(before.totals.scored - scorecard.totals.scored, 2);
    assert.equal(scorecard.totals.void - before.totals.void, 2);
    const receipt = buildPublicReceipts(ledger, nowMs).find((row) => row.voidReason === ENVELOPE_BUG_VOID_REASON);
    assert.ok(receipt, 'a voided row is published as a receipt with its reason');
    assert.equal(RECEIPT_VOID_REASON_LABELS[receipt.voidReason], 'Scored against a data feed we could not read correctly');
    assert.equal(Object.values(ledger).find((row) => row.id === 'fc-cyber-zero').evidence.voidedAt, nowMs);
  });

  it('runs inside the judged cycle that production calls', async () => {
    const nowMs = T0 + 10 * DAY_MS;
    const { ledger } = await processResolutionCycleWithJudges(preFixLedger(), [], {}, { items: [], available: false }, nowMs);
    const voided = Object.values(ledger).filter((row) => row.evidence?.reason === ENVELOPE_BUG_VOID_REASON).map((row) => row.id).sort();
    assert.deepEqual(voided, ['fc-cyber-zero', 'fc-infra-zero']);
  });

  it('explains the voids in the scorecard methodology only while the window holds them', () => {
    const nowMs = T0 + 10 * DAY_MS;
    const { scorecard } = processResolutionCycle(preFixLedger(), [], {}, nowMs);
    assert.match(scorecard.methodology, / 2 forecasts scored against a data feed we could not read correctly are voided and left out of every score \(issue #5233\)\.$/);
    assert.doesNotMatch(computeScorecard(preFixLedger(), nowMs).methodology, /could not read correctly/);
    const one = preFixLedger();
    delete one['fc-infra-zero@' + (T0 + 7 * DAY_MS)];
    assert.match(processResolutionCycle(one, [], {}, nowMs).scorecard.methodology, / 1 forecast scored against a data feed we could not read correctly is voided /);
  });
});
