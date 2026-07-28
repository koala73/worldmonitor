import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAlertDigest,
  buildWeeklyTrends,
  SEVERITY_RANK,
} from '../shared/analysis-alert-digest.ts';

const NOW = Date.parse('2026-07-28T00:00:00.000Z');

const fullInputs = () => ({
  cii: [
    { code: 'SD', score: 82, level: 'critical' },
    { code: 'UA', score: 64, level: 'high' },
    { code: 'DE', score: 12, level: 'low' },
  ],
  militarySurges: [
    { theaterId: 'centcom', surgeType: 'fighter', surgeMultiple: 2.4, strikeCapable: true },
    { theaterId: 'eucom', surgeType: 'airlift', surgeMultiple: 2.1, strikeCapable: false },
  ],
  cables: [
    { name: 'SeaMeWe-6', status: 'CABLE_HEALTH_STATUS_FAULT' },
    { name: 'Curie', status: 'CABLE_HEALTH_STATUS_DEGRADED' },
    { name: 'Marea', status: 'CABLE_HEALTH_STATUS_OK' },
  ],
  outages: [
    { country: 'Sudan', severity: 'major', detectedAt: NOW - 3_600_000 },
    { country: 'Nepal', severity: 'minor', detectedAt: NOW - 90_000_000, endedAt: NOW - 86_400_000 },
  ],
  temporalAnomalies: [
    { type: 'news', region: 'Middle East', zScore: 3.4, severity: 'critical' },
  ],
  thermal: [
    { id: 'strait-of-hormuz', level: 'high', score: 71 },
    { id: 'baltic', level: 'low', score: 12 },
  ],
  shippingStress: { index: 61, level: 'high' },
});

describe('buildAlertDigest', () => {
  it('trips each domain on its own severity vocabulary', () => {
    const digest = buildAlertDigest(fullInputs(), NOW);
    const domains = new Set(digest.tripped.map((t) => t.domain));
    assert.deepEqual(
      [...domains].sort(),
      ['cable_health', 'cii', 'military_surge', 'outages', 'shipping_stress', 'temporal_anomaly', 'thermal'],
    );
    // CII: critical + high trip, low does not.
    const cii = digest.tripped.filter((t) => t.domain === 'cii');
    assert.deepEqual(cii.map((t) => t.id).sort(), ['SD', 'UA']);
    // Cables: fault + degraded trip, ok does not.
    const cables = digest.tripped.filter((t) => t.domain === 'cable_health');
    assert.deepEqual(cables.map((t) => t.id).sort(), ['Curie', 'SeaMeWe-6']);
    // Outages: the ended one must not trip.
    const outages = digest.tripped.filter((t) => t.domain === 'outages');
    assert.equal(outages.length, 1);
    assert.equal(outages[0].id, 'Sudan');
  });

  it('assigns severities from domain semantics and sorts by rank', () => {
    const digest = buildAlertDigest(fullInputs(), NOW);
    const bySev = Object.fromEntries(digest.tripped.map((t) => [`${t.domain}:${t.id}`, t.severity]));
    assert.equal(bySev['cii:SD'], 'critical');
    assert.equal(bySev['cii:UA'], 'high');
    assert.equal(bySev['military_surge:fighter-centcom'], 'critical'); // strikeCapable
    assert.equal(bySev['military_surge:airlift-eucom'], 'high');
    assert.equal(bySev['cable_health:SeaMeWe-6'], 'high'); // fault
    assert.equal(bySev['cable_health:Curie'], 'medium'); // degraded
    assert.equal(bySev['temporal_anomaly:news:Middle East'], 'critical');
    const ranks = digest.tripped.map((t) => SEVERITY_RANK[t.severity]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'sorted most-severe first');
  });

  it('separates quiet domains from unavailable domains', () => {
    const digest = buildAlertDigest(
      {
        cii: [{ code: 'DE', score: 8, level: 'low' }],
        militarySurges: [],
        cables: null,
        outages: undefined,
        temporalAnomalies: [],
        thermal: null,
        shippingStress: null,
      },
      NOW,
    );
    assert.equal(digest.tripped.length, 0);
    assert.deepEqual(digest.quiet.sort(), ['cii', 'military_surge', 'temporal_anomaly']);
    assert.deepEqual(digest.unavailable.sort(), ['cable_health', 'outages', 'shipping_stress', 'thermal']);
    assert.equal(digest.generatedAt, new Date(NOW).toISOString());
  });

  it('treats the producer endedAt=0 sentinel as an ongoing outage', () => {
    const digest = buildAlertDigest({
      cii: [],
      militarySurges: [],
      cables: [],
      outages: [{ country: 'Sudan', severity: 'critical', endedAt: 0 }],
      temporalAnomalies: [],
      thermal: [],
      shippingStress: { index: 0, level: 'low' },
    }, NOW);
    const outage = digest.tripped.find((alert) => alert.domain === 'outages');
    assert.ok(outage);
    assert.equal(outage.severity, 'critical');
  });

  it('does not trip shipping stress without an elevated level', () => {
    const inputs = { ...fullInputs(), shippingStress: { index: 30, level: 'normal' } };
    const digest = buildAlertDigest(inputs, NOW);
    assert.ok(!digest.tripped.some((t) => t.domain === 'shipping_stress'));
    assert.ok(digest.quiet.includes('shipping_stress'));
  });

  it('tolerates malformed entries without throwing', () => {
    const digest = buildAlertDigest(
      {
        cii: [{ code: null, score: 'x', level: 42 }, {}],
        militarySurges: [{}],
        cables: [{ status: 'BOGUS' }],
        outages: [{}],
        temporalAnomalies: [{ severity: 'nonsense' }],
        thermal: [{}],
        shippingStress: {},
      },
      NOW,
    );
    assert.ok(Array.isArray(digest.tripped));
  });
});

describe('buildWeeklyTrends', () => {
  const series = (values) => values.map((v, i) => ({ t: NOW - (values.length - 1 - i) * 86_400_000, value: v }));

  it('computes direction, volatility, and anomaly flags per domain', () => {
    const trends = buildWeeklyTrends(
      [
        { domain: 'cii', points: series([10, 10, 11, 10, 30, 45, 60]) },
        { domain: 'outages', points: series([5, 5, 5, 5, 5, 5, 5]) },
        { domain: 'news', points: series([60, 50, 40, 30, 20, 10, 5]) },
      ],
      NOW,
    );
    const byDomain = Object.fromEntries(trends.map((t) => [t.domain, t]));
    assert.equal(byDomain.cii.direction, 'rising');
    assert.equal(byDomain.outages.direction, 'flat');
    assert.equal(byDomain.news.direction, 'falling');
    assert.equal(byDomain.outages.volatility, 0);
    assert.ok(byDomain.cii.volatility > byDomain.outages.volatility);
    assert.equal(byDomain.cii.latest, 60);
    assert.ok(byDomain.cii.anomalous, 'latest 60 is > mean + 2σ of the early-week baseline');
    assert.ok(!byDomain.outages.anomalous);
  });

  it('skips domains with fewer than 3 points', () => {
    const trends = buildWeeklyTrends([{ domain: 'thin', points: series([1, 2]) }], NOW);
    assert.equal(trends.length, 0);
  });
});
