import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { processResolutionCycle } from '../scripts/seed-forecast-resolutions.mjs';
import { evaluateExtractionShadow } from '../scripts/_forecast-resolution.mjs';
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
