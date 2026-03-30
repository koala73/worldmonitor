import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBreakingAlertEvidencePack,
  buildClusterEvidencePack,
  buildSignalEvidencePack,
} from '../src/services/evidence-pack.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const NOW = new Date('2026-03-29T18:00:00.000Z');

function makeNewsItem(source, title, minutesAgo, tier) {
  return {
    source,
    title,
    link: `https://example.com/${source.toLowerCase().replace(/\W+/g, '-')}`,
    pubDate: new Date(NOW.getTime() - minutesAgo * 60_000),
    isAlert: true,
    tier,
  };
}

function makeClusteredEvent(overrides = {}) {
  return {
    id: 'cluster-1',
    primaryTitle: 'Bridge explosion reported near border crossing',
    primarySource: 'Reuters',
    primaryLink: 'https://example.com/reuters',
    sourceCount: 3,
    topSources: [
      { name: 'Reuters', tier: 1, url: 'https://example.com/reuters' },
      { name: 'AP News', tier: 1, url: 'https://example.com/ap' },
      { name: 'BBC World', tier: 2, url: 'https://example.com/bbc' },
    ],
    allItems: [
      makeNewsItem('Reuters', 'Bridge explosion reported near border crossing', 6, 1),
      makeNewsItem('AP News', 'Bridge explosion near border crossing reported', 5, 1),
      makeNewsItem('BBC World', 'Bridge crossing hit by explosion near border', 4, 2),
    ],
    firstSeen: new Date(NOW.getTime() - 10 * 60_000),
    lastUpdated: new Date(NOW.getTime() - 4 * 60_000),
    isAlert: true,
    ...overrides,
  };
}

function makeSupportingSource(
  name,
  tier,
  kind = 'news',
  type = 'other',
) {
  return {
    name,
    tier,
    url: `https://example.com/${name.toLowerCase().replace(/\W+/g, '-')}`,
    kind,
    type,
  };
}

test('buildClusterEvidencePack marks fresh trusted multi-source news as corroborated', () => {
  const evidence = buildClusterEvidencePack(makeClusteredEvent(), NOW);

  assert.equal(evidence.claim, 'Bridge explosion reported near border crossing');
  assert.equal(evidence.verdict, 'corroborated');
  assert.equal(evidence.actionThreshold, 'verify');
  assert.equal(evidence.freshness, 'fresh');
  assert.equal(evidence.corroborationCount, 3);
  assert.equal(evidence.trustedSourceCount, 3);
  assert.equal(evidence.supportingSources.length, 3);
  assert.equal(evidence.conflictingSources.length, 0);
});

test('buildSignalEvidencePack downgrades verdict when conflicting evidence is present', () => {
  const evidence = buildSignalEvidencePack({
    claim: 'Three source classes aligned on the same event',
    confidence: 0.92,
    timestamp: NOW,
    supportingSources: [
      makeSupportingSource('Reuters', 1, 'news', 'wire'),
      makeSupportingSource('White House', 1, 'news', 'gov'),
      makeSupportingSource('Bellingcat', 2, 'news', 'intel'),
    ],
    conflictingSources: [
      makeSupportingSource('Unknown Blog', 4, 'news', 'other'),
    ],
    confidenceReason: 'Wire, government, and intel coverage align, but one low-trust contradiction remains.',
  }, NOW);

  assert.equal(evidence.verdict, 'corroborated');
  assert.equal(evidence.actionThreshold, 'verify');
  assert.equal(evidence.supportingSources.length, 3);
  assert.equal(evidence.conflictingSources.length, 1);
});

test('buildBreakingAlertEvidencePack marks critical trusted alerts as actionable', () => {
  const evidence = buildBreakingAlertEvidencePack({
    headline: 'Major refinery fire reported',
    source: 'Reuters',
    threatLevel: 'critical',
    timestamp: NOW,
    origin: 'rss_alert',
  }, 1, 'wire', NOW);

  assert.equal(evidence.claim, 'Major refinery fire reported');
  assert.equal(evidence.verdict, 'actionable');
  assert.equal(evidence.actionThreshold, 'act');
  assert.equal(evidence.supportingSources[0]?.name, 'Reuters');
  assert.equal(evidence.supportingSources[0]?.tier, 1);
});

test('analysis-core wires cluster and signal evidence builders', () => {
  const source = readFileSync(
    resolve(root, 'src/services/analysis-core.ts'),
    'utf8',
  );

  assert.match(source, /buildClusterEvidencePack/);
  assert.match(source, /buildSignalEvidencePack/);
  assert.match(source, /evidence:\s*buildClusterEvidencePack\(clusteredEvent\)/);
  assert.match(source, /function createSignalWithEvidence/);
  assert.match(source, /evidence:\s*buildSignalEvidencePack\(/);
});

test('geo and breaking-alert integrations preserve the evidence contract', () => {
  const breakingAlertsSource = readFileSync(
    resolve(root, 'src/services/breaking-news-alerts.ts'),
    'utf8',
  );
  const geoConvergenceSource = readFileSync(
    resolve(root, 'src/services/geo-convergence.ts'),
    'utf8',
  );

  assert.match(breakingAlertsSource, /buildBreakingAlertEvidencePack/);
  assert.match(breakingAlertsSource, /function attachAlertEvidence/);
  assert.match(breakingAlertsSource, /tagBreakingAlertPlaces\(attachAlertEvidence\(alert\)\)/);
  assert.match(geoConvergenceSource, /buildSignalEvidencePack/);
  assert.match(geoConvergenceSource, /evidence:\s*buildSignalEvidencePack\(/);
});
