import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatResilienceChange30d,
  formatResilienceConfidence,
  getResilienceDomainLabel,
  getResilienceTrendArrow,
  getResilienceVisualLevel,
} from '../src/components/resilience-widget-utils';
import type { ResilienceScoreResponse } from '../src/services/resilience';

const baseResponse: ResilienceScoreResponse = {
  countryCode: 'US',
  overallScore: 73,
  level: 'high',
  domains: [],
  cronbachAlpha: 0.74,
  trend: 'rising',
  change30d: 2.4,
  lowConfidence: false,
};

test('getResilienceVisualLevel maps the score thresholds from the widget spec', () => {
  assert.equal(getResilienceVisualLevel(80), 'very_high');
  assert.equal(getResilienceVisualLevel(79), 'high');
  assert.equal(getResilienceVisualLevel(60), 'high');
  assert.equal(getResilienceVisualLevel(59), 'moderate');
  assert.equal(getResilienceVisualLevel(20), 'low');
  assert.equal(getResilienceVisualLevel(19), 'very_low');
  assert.equal(getResilienceVisualLevel(Number.NaN), 'unknown');
});

test('getResilienceTrendArrow renders the expected glyphs', () => {
  assert.equal(getResilienceTrendArrow('rising'), '↑');
  assert.equal(getResilienceTrendArrow('falling'), '↓');
  assert.equal(getResilienceTrendArrow('stable'), '→');
  assert.equal(getResilienceTrendArrow('unknown'), '→');
});

test('getResilienceDomainLabel keeps the deep-dive shorthand labels stable', () => {
  assert.equal(getResilienceDomainLabel('economic'), 'Economic');
  assert.equal(getResilienceDomainLabel('infrastructure'), 'Infra & Supply');
  assert.equal(getResilienceDomainLabel('social-governance'), 'Social & Gov');
  assert.equal(getResilienceDomainLabel('health-food'), 'Health & Food');
  assert.equal(getResilienceDomainLabel('custom-domain'), 'custom-domain');
});

test('formatResilienceConfidence shows sparse-data copy when low confidence is set', () => {
  assert.equal(formatResilienceConfidence(baseResponse), 'Confidence 0.74 ✓');
  assert.equal(
    formatResilienceConfidence({ ...baseResponse, lowConfidence: true, cronbachAlpha: 0.21 }),
    'Low confidence — sparse data',
  );
});

test('formatResilienceChange30d preserves explicit sign formatting', () => {
  assert.equal(formatResilienceChange30d(2.41), '30d +2.4');
  assert.equal(formatResilienceChange30d(-1.26), '30d -1.3');
  assert.equal(formatResilienceChange30d(0), '30d 0.0');
});
