import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  renderChinaActivityNowcastView,
} from '../src/components/china-activity-nowcast-view';
import {
  CHINA_ACTIVITY_PROXY_REGISTRY,
  evaluateChinaActivityNowcast,
  type ChinaActivityOfficialObservation,
  type ChinaActivityProxyObservation,
} from '../shared/china-activity-nowcast';

const EVALUATED_AT = '2026-07-25T12:00:00.000Z';

const official: ChinaActivityOfficialObservation = {
  seriesId: 'nbs_industrial_value_added_yoy',
  label: '<script>unsafe official label</script>',
  vintageId: 'nbs_industrial_value_added_yoy:2026-06:r1',
  observationPeriod: '2026-06',
  periodEnd: '2026-06-30T23:59:59.000Z',
  releaseTime: '2026-07-17T02:00:00.000Z',
  retrievalTime: '2026-07-17T02:05:00.000Z',
  direction: 'strengthening',
  value: 6.8,
  unit: '%',
  available: true,
  stale: false,
  provenance: { signalId: 'signal:official' },
};

function proxy(seriesId: string, value: number): ChinaActivityProxyObservation {
  return {
    seriesId,
    observationId: `${seriesId}:current`,
    observedAt: '2026-07-25T10:00:00.000Z',
    releasedAt: '2026-07-25T10:30:00.000Z',
    retrievedAt: '2026-07-25T10:35:00.000Z',
    value,
    priorValue: null,
    available: true,
    stale: false,
    structuralBreak: false,
    provenance: { source: seriesId },
  };
}

function response() {
  return evaluateChinaActivityNowcast({
    evaluatedAt: EVALUATED_AT,
    officialObservations: [official],
    proxyObservations: [
      proxy(CHINA_ACTIVITY_PROXY_REGISTRY[0]!.id, 1),
      proxy(CHINA_ACTIVITY_PROXY_REGISTRY[1]!.id, 1),
      proxy(CHINA_ACTIVITY_PROXY_REGISTRY[2]!.id, 1),
      proxy(CHINA_ACTIVITY_PROXY_REGISTRY[4]!.id, 1),
    ],
  });
}

describe('China activity nowcast explanatory UI (#5579)', () => {
  it('renders the method, vintage, window, contributions, missingness, sensitivity, and limitations', () => {
    const html = renderChinaActivityNowcastView(response());

    assert.match(html, /Official and proxies agree/);
    assert.match(html, /nbs_industrial_value_added_yoy:2026-06:r1/);
    assert.match(html, /90-day comparison window/);
    assert.match(html, /4\/7 proxy families eligible/);
    assert.match(html, /Freight/);
    assert.match(html, /Maritime/);
    assert.match(html, /Aviation/);
    assert.match(html, /Energy/);
    assert.match(html, /Commodity/);
    assert.match(html, /Corridor/);
    assert.match(html, /Market/);
    assert.match(html, /No forward-fill · no interpolation/);
    assert.match(html, /Leave-one-family-out sensitivity/);
    assert.match(html, /Historical evaluation unavailable/);
    assert.match(html, /not a replacement GDP estimate/);
    assert.doesNotMatch(html, /aggregate score/i);
  });

  it('escapes all user- and source-controlled text', () => {
    const result = response();
    result.limitations[0] = '<img src=x onerror=alert(1)> unsafe limitation';
    result.contributions[0]!.registry = {
      ...result.contributions[0]!.registry,
      source: {
        ...result.contributions[0]!.registry.source,
        url: 'javascript:alert(1)',
      },
    };
    const html = renderChinaActivityNowcastView(result);

    assert.match(html, /&lt;script&gt;unsafe official label&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; unsafe limitation/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /javascript:/);
  });
});
