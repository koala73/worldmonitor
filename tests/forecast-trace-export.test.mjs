import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  makePrediction,
  buildForecastCase,
  populateFallbackNarratives,
  buildForecastTraceArtifacts,
} from '../scripts/seed-forecasts.mjs';

import {
  resolveR2StorageConfig,
} from '../scripts/_r2-storage.mjs';

describe('forecast trace storage config', () => {
  it('resolves Cloudflare R2 trace env vars and derives the endpoint from account id', () => {
    const config = resolveR2StorageConfig({
      CLOUDFLARE_R2_ACCOUNT_ID: 'acct123',
      CLOUDFLARE_R2_TRACE_BUCKET: 'trace-bucket',
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'abc',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'def',
      CLOUDFLARE_R2_REGION: 'auto',
      CLOUDFLARE_R2_TRACE_PREFIX: 'custom-prefix',
      CLOUDFLARE_R2_FORCE_PATH_STYLE: 'true',
    });
    assert.equal(config.bucket, 'trace-bucket');
    assert.equal(config.endpoint, 'https://acct123.r2.cloudflarestorage.com');
    assert.equal(config.region, 'auto');
    assert.equal(config.basePrefix, 'custom-prefix');
    assert.equal(config.forcePathStyle, true);
  });

  it('falls back to a shared Cloudflare R2 bucket env var', () => {
    const config = resolveR2StorageConfig({
      CLOUDFLARE_R2_ACCOUNT_ID: 'acct123',
      CLOUDFLARE_R2_BUCKET: 'shared-bucket',
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'abc',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'def',
    });
    assert.equal(config.bucket, 'shared-bucket');
    assert.equal(config.endpoint, 'https://acct123.r2.cloudflarestorage.com');
  });
});

describe('forecast trace artifact builder', () => {
  it('builds manifest, summary, and per-forecast trace artifacts', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    a.calibration = { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.71, drift: 0.03, source: 'polymarket' };
    a.trend = 'rising';
    buildForecastCase(a);

    const b = makePrediction('supply_chain', 'Red Sea', 'Shipping disruption: Red Sea', 0.68, 0.59, '7d', [
      { type: 'chokepoint', value: 'Red Sea disruption detected', weight: 0.5 },
      { type: 'gps_jamming', value: 'GPS interference near Red Sea', weight: 0.2 },
    ]);
    b.newsContext = ['Freight rates react to Red Sea rerouting'];
    b.trend = 'rising';
    buildForecastCase(b);

    populateFallbackNarratives([a, b]);

    const artifacts = buildForecastTraceArtifacts(
      { generatedAt: Date.parse('2026-03-15T08:00:00Z'), predictions: [a, b] },
      { runId: 'run-123' },
      { basePrefix: 'forecast-runs', maxForecasts: 1 },
    );

    assert.equal(artifacts.manifest.runId, 'run-123');
    assert.equal(artifacts.manifest.forecastCount, 2);
    assert.equal(artifacts.manifest.tracedForecastCount, 1);
    assert.match(artifacts.manifestKey, /forecast-runs\/2026\/03\/15\/run-123\/manifest\.json/);
    assert.match(artifacts.summaryKey, /forecast-runs\/2026\/03\/15\/run-123\/summary\.json/);
    assert.equal(artifacts.forecasts.length, 1);
    assert.equal(artifacts.summary.topForecasts[0].id, a.id);
    assert.deepEqual(artifacts.summary.quality.fullRun.domainCounts, {
      conflict: 1,
      market: 0,
      supply_chain: 1,
      political: 0,
      military: 0,
      cyber: 0,
      infrastructure: 0,
    });
    assert.deepEqual(artifacts.summary.quality.fullRun.highlightedDomainCounts, {
      conflict: 1,
      market: 0,
      supply_chain: 1,
      political: 0,
      military: 0,
      cyber: 0,
      infrastructure: 0,
    });
    assert.deepEqual(artifacts.summary.quality.traced.domainCounts, {
      conflict: 1,
      market: 0,
      supply_chain: 0,
      political: 0,
      military: 0,
      cyber: 0,
      infrastructure: 0,
    });
    assert.equal(artifacts.summary.quality.traced.fallbackCount, 1);
    assert.equal(artifacts.summary.quality.traced.enrichedCount, 0);
    assert.equal(artifacts.summary.quality.traced.fallbackRate, 1);
    assert.equal(artifacts.summary.quality.traced.enrichedRate, 0);
    assert.ok(artifacts.summary.quality.fullRun.quietDomains.includes('military'));
    assert.equal(artifacts.summary.quality.traced.topPromotionSignals[0].type, 'cii');
    assert.ok(artifacts.forecasts[0].payload.caseFile.worldState.summary.includes('Iran'));
    assert.equal(artifacts.forecasts[0].payload.caseFile.branches.length, 3);
    assert.equal(artifacts.forecasts[0].payload.traceMeta.narrativeSource, 'fallback');
  });

  it('stores all forecasts by default when no explicit max is configured', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', []);
    const b = makePrediction('supply_chain', 'Red Sea', 'Shipping disruption: Red Sea', 0.68, 0.59, '7d', []);
    buildForecastCase(a);
    buildForecastCase(b);
    populateFallbackNarratives([a, b]);

    const artifacts = buildForecastTraceArtifacts(
      { generatedAt: Date.parse('2026-03-15T08:00:00Z'), predictions: [a, b] },
      { runId: 'run-all' },
      { basePrefix: 'forecast-runs' },
    );

    assert.equal(artifacts.manifest.forecastCount, 2);
    assert.equal(artifacts.manifest.tracedForecastCount, 2);
    assert.equal(artifacts.forecasts.length, 2);
  });

  it('summarizes fallback, enrichment, and domain quality across traced forecasts', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    a.trend = 'rising';
    buildForecastCase(a);
    populateFallbackNarratives([a]);
    a.traceMeta = { narrativeSource: 'llm_combined_cache', llmCached: true };

    const b = makePrediction('cyber', 'China', 'Cyber threat concentration: China', 0.6, 0.52, '7d', [
      { type: 'cyber', value: 'Malware-hosting concentration remains elevated', weight: 0.4 },
      { type: 'news_corroboration', value: 'Security researchers warn of renewed activity', weight: 0.2 },
    ]);
    b.trend = 'stable';
    buildForecastCase(b);
    populateFallbackNarratives([b]);

    const artifacts = buildForecastTraceArtifacts(
      {
        generatedAt: Date.parse('2026-03-17T08:00:00Z'),
        predictions: [a, b],
        enrichmentMeta: {
          selection: { candidateCount: 2, readinessEligibleCount: 2, selectedCombinedCount: 1, selectedScenarioCount: 1, reservedScenarioDomains: ['market'] },
          combined: { requested: 1, source: 'live', provider: 'openrouter', model: 'google/gemini-2.5-flash', scenarios: 1, perspectives: 1, cases: 1, succeeded: true },
          scenario: { requested: 1, source: 'cache', provider: 'cache', model: 'cache', scenarios: 0, cases: 0, succeeded: true },
        },
      },
      { runId: 'run-quality' },
      { basePrefix: 'forecast-runs' },
    );

    assert.equal(artifacts.summary.quality.traced.fallbackCount, 1);
    assert.equal(artifacts.summary.quality.traced.enrichedCount, 1);
    assert.equal(artifacts.summary.quality.traced.llmCombinedCount, 1);
    assert.equal(artifacts.summary.quality.traced.llmScenarioCount, 0);
    assert.equal(artifacts.summary.quality.fullRun.domainCounts.conflict, 1);
    assert.equal(artifacts.summary.quality.fullRun.domainCounts.cyber, 1);
    assert.ok(artifacts.summary.quality.traced.avgReadiness > 0);
    assert.ok(artifacts.summary.quality.traced.topSuppressionSignals.length >= 1);
    assert.equal(artifacts.summary.quality.enrichment.selection.selectedCombinedCount, 1);
    assert.equal(artifacts.summary.quality.enrichment.combined.provider, 'openrouter');
  });
});
