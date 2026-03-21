import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  makePrediction,
  buildForecastCase,
  populateFallbackNarratives,
  buildForecastTraceArtifacts,
  buildForecastRunWorldState,
  buildCrossSituationEffects,
  buildReportableInteractionLedger,
  buildInteractionWatchlist,
  isCrossTheaterPair,
  getMacroRegion,
  attachSituationContext,
  projectSituationClusters,
  refreshPublishedNarratives,
  selectPublishedForecastPool,
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

    const c = makePrediction('cyber', 'China', 'Cyber pressure: China', 0.59, 0.55, '7d', [
      { type: 'cyber', value: 'Malware-hosting concentration remains elevated', weight: 0.4 },
    ]);
    c.trend = 'stable';
    buildForecastCase(c);

    populateFallbackNarratives([a, b, c]);

    const artifacts = buildForecastTraceArtifacts(
      {
        generatedAt: Date.parse('2026-03-15T08:00:00Z'),
        predictions: [a, b],
        fullRunPredictions: [a, b, c],
        publishTelemetry: {
          suppressedFamilySelection: 2,
          suppressedWeakFallback: 1,
          suppressedSituationOverlap: 2,
          suppressedSituationCap: 1,
          suppressedSituationDomainCap: 1,
          suppressedTotal: 5,
          reasonCounts: { weak_fallback: 1, situation_overlap: 2, situation_cap: 1, situation_domain_cap: 1 },
          situationClusterCount: 2,
          maxForecastsPerSituation: 2,
          multiForecastSituations: 1,
          cappedSituations: 1,
        },
        triggerContext: {
          triggerSource: 'military_chain',
          triggerService: 'seed-forecasts',
          deployRevision: 'abc123',
          triggerRequest: {
            requestedAt: Date.parse('2026-03-15T07:59:00Z'),
            requestedAtIso: '2026-03-15T07:59:00.000Z',
            requester: 'seed-military-flights',
            requesterRunId: 'mil-run-1',
            sourceVersion: 'wingbits',
          },
        },
      },
      { runId: 'run-123' },
      { basePrefix: 'forecast-runs', maxForecasts: 1 },
    );

    assert.equal(artifacts.manifest.runId, 'run-123');
    assert.equal(artifacts.manifest.forecastCount, 2);
    assert.equal(artifacts.manifest.tracedForecastCount, 1);
    assert.equal(artifacts.manifest.triggerContext.triggerSource, 'military_chain');
    assert.match(artifacts.manifestKey, /forecast-runs\/2026\/03\/15\/run-123\/manifest\.json/);
    assert.match(artifacts.summaryKey, /forecast-runs\/2026\/03\/15\/run-123\/summary\.json/);
    assert.match(artifacts.worldStateKey, /forecast-runs\/2026\/03\/15\/run-123\/world-state\.json/);
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
    assert.equal(artifacts.summary.quality.publish.suppressedSituationOverlap, 2);
    assert.equal(artifacts.summary.quality.publish.suppressedFamilySelection, 2);
    assert.equal(artifacts.summary.quality.publish.suppressedSituationCap, 1);
    assert.equal(artifacts.summary.quality.publish.suppressedSituationDomainCap, 1);
    assert.equal(artifacts.summary.quality.publish.cappedSituations, 1);
    assert.equal(artifacts.summary.quality.candidateRun.domainCounts.cyber, 1);
    assert.ok(artifacts.summary.quality.fullRun.quietDomains.includes('military'));
    assert.equal(artifacts.summary.quality.traced.topPromotionSignals[0].type, 'cii');
    assert.equal(artifacts.summary.worldStateSummary.scope, 'published');
    assert.ok(artifacts.summary.worldStateSummary.summary.includes('active forecasts'));
    assert.ok(artifacts.summary.worldStateSummary.reportSummary.includes('leading domains'));
    assert.ok(typeof artifacts.summary.worldStateSummary.reportContinuitySummary === 'string');
    assert.equal(artifacts.summary.worldStateSummary.domainCount, 2);
    assert.equal(artifacts.summary.worldStateSummary.regionCount, 2);
    assert.ok(typeof artifacts.summary.worldStateSummary.situationCount === 'number');
    assert.ok(artifacts.summary.worldStateSummary.situationCount >= 1);
    assert.ok(typeof artifacts.summary.worldStateSummary.familyCount === 'number');
    assert.ok(artifacts.summary.worldStateSummary.familyCount >= 1);
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationSituationCount === 'number');
    assert.equal(artifacts.summary.worldStateSummary.simulationRoundCount, 3);
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationSummary === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.marketSummary === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationInputSummary === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.worldSignalCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.marketBucketCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.transmissionEdgeCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.marketConsequenceCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.topMarketBucket === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationEnvironmentSummary === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.memoryMutationSummary === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.causalReplaySummary === 'string');
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationActionCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationInteractionCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationEffectCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.simulationEnvironmentCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.memoryMutationCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.causalReplayCount === 'number');
    assert.ok(typeof artifacts.summary.worldStateSummary.historyRuns === 'number');
    assert.equal(artifacts.summary.worldStateSummary.candidateStateSummary.forecastCount, 3);
    assert.ok(artifacts.summary.worldStateSummary.candidateStateSummary.situationCount >= artifacts.summary.worldStateSummary.situationCount);
    assert.ok(Array.isArray(artifacts.worldState.actorRegistry));
    assert.ok(artifacts.worldState.actorRegistry.every(actor => actor.name && actor.id));
    assert.equal(artifacts.summary.worldStateSummary.persistentActorCount, 0);
    assert.ok(typeof artifacts.summary.worldStateSummary.newlyActiveActors === 'number');
    assert.equal(artifacts.summary.worldStateSummary.branchCount, 6);
    assert.equal(artifacts.summary.worldStateSummary.newBranches, 6);
    assert.equal(artifacts.summary.triggerContext.triggerRequest.requester, 'seed-military-flights');
    assert.ok(Array.isArray(artifacts.worldState.situationClusters));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.situationSimulations));
    assert.equal(artifacts.worldState.simulationState?.roundTransitions?.length, 3);
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.actionLedger));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.interactionLedger));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.replayTimeline));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.environmentSpec?.situations));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.memoryMutations?.situations));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.causalGraph?.edges));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.causalReplay?.chains));
    assert.ok(Array.isArray(artifacts.worldState.report.situationWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.actorWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.branchWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.marketWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.transmissionWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.marketConsequenceWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.simulationWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.interactionWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.replayWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.environmentWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.memoryWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.causalReplayWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.causalEdgeWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.simulationOutcomeSummaries));
    assert.ok(Array.isArray(artifacts.worldState.report.crossSituationEffects));
    assert.ok(Array.isArray(artifacts.worldState.report.causalReplayChains));
    assert.ok(Array.isArray(artifacts.worldState.report.replayTimeline));
    assert.ok(Array.isArray(artifacts.worldState.worldSignals?.signals));
    assert.ok(Array.isArray(artifacts.worldState.marketState?.buckets));
    assert.ok(Array.isArray(artifacts.worldState.marketTransmission?.edges));
    assert.ok(Array.isArray(artifacts.worldState.simulationState?.marketConsequences?.items));
    assert.ok(typeof artifacts.summary.worldStateSummary.marketInputCoverage?.loadedSourceCount === 'number');
    assert.ok(artifacts.forecasts[0].payload.caseFile.worldState.summary.includes('Iran'));
    assert.equal(artifacts.forecasts[0].payload.caseFile.branches.length, 3);
    assert.equal(artifacts.forecasts[0].payload.traceMeta.narrativeSource, 'fallback');
    // simulation linkage: per-forecast worldState must carry simulation fields from the global simulation state
    const forecastWorldState = artifacts.forecasts[0].payload.caseFile.worldState;
    const simulations = artifacts.worldState.simulationState?.situationSimulations || [];
    if (simulations.length > 0) {
      assert.ok(typeof forecastWorldState.situationId === 'string' && forecastWorldState.situationId.length > 0, 'worldState.situationId should be set from simulation');
      assert.ok(typeof forecastWorldState.simulationSummary === 'string' && forecastWorldState.simulationSummary.length > 0, 'worldState.simulationSummary should be set from simulation');
      assert.ok(['escalatory', 'contested', 'constrained'].includes(forecastWorldState.simulationPosture), 'worldState.simulationPosture should be a valid posture');
      assert.ok(typeof forecastWorldState.simulationPostureScore === 'number', 'worldState.simulationPostureScore should be a number');
    }
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
          combined: { requested: 1, source: 'live', provider: 'openrouter', model: 'google/gemini-2.5-flash', scenarios: 1, perspectives: 1, cases: 1, rawItemCount: 2, failureReason: '', succeeded: true },
          scenario: { requested: 1, source: 'cache', provider: 'cache', model: 'cache', scenarios: 0, cases: 0, rawItemCount: 1, failureReason: '', succeeded: true },
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
    assert.equal(artifacts.summary.quality.enrichment.combined.rawItemCount, 2);
    assert.equal(artifacts.summary.quality.enrichment.scenario.rawItemCount, 1);
    assert.equal(artifacts.summary.quality.enrichment.combined.failureReason, '');
  });

  it('projects published situations from the original full-run clusters without re-clustering ranked subsets', () => {
    const a = makePrediction('market', 'Red Sea', 'Freight shock: Red Sea', 0.74, 0.61, '7d', [
      { type: 'chokepoint', value: 'Red Sea disruption detected', weight: 0.4 },
    ]);
    const b = makePrediction('supply_chain', 'Hormuz', 'Shipping disruption: Hormuz', 0.71, 0.6, '7d', [
      { type: 'chokepoint', value: 'Hormuz disruption risk rising', weight: 0.4 },
    ]);
    const c = makePrediction('market', 'Hormuz', 'Oil pricing pressure: Hormuz', 0.69, 0.58, '7d', [
      { type: 'commodity_price', value: 'Energy prices are moving higher', weight: 0.3 },
    ]);
    const d = makePrediction('supply_chain', 'Red Sea', 'Container rerouting risk: Red Sea', 0.68, 0.57, '7d', [
      { type: 'shipping_delay', value: 'Freight rerouting remains elevated', weight: 0.3 },
    ]);

    buildForecastCase(a);
    buildForecastCase(b);
    buildForecastCase(c);
    buildForecastCase(d);
    populateFallbackNarratives([a, b, c, d]);

    const fullRunSituationClusters = attachSituationContext([a, b, c, d]);
    const publishedPredictions = [a, c, d];
    const projectedClusters = projectSituationClusters(fullRunSituationClusters, publishedPredictions);
    attachSituationContext(publishedPredictions, projectedClusters);
    refreshPublishedNarratives(publishedPredictions);

    const projectedIds = new Set(projectedClusters.map((cluster) => cluster.id));
    assert.equal(projectedClusters.reduce((sum, cluster) => sum + cluster.forecastCount, 0), publishedPredictions.length);
    assert.ok(projectedIds.has(a.situationContext.id));
    assert.ok(projectedIds.has(c.situationContext.id));
    assert.ok(projectedIds.has(d.situationContext.id));
  });

  it('refreshes published narratives after shrinking a broader situation cluster', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    const b = makePrediction('conflict', 'Iran', 'Retaliation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'news_corroboration', value: 'Officials warn of retaliation risk', weight: 0.3 },
    ]);

    buildForecastCase(a);
    buildForecastCase(b);
    const fullRunSituationClusters = attachSituationContext([a, b]);
    populateFallbackNarratives([a, b]);

    const publishedPredictions = [a];
    const projectedClusters = projectSituationClusters(fullRunSituationClusters, publishedPredictions);
    attachSituationContext(publishedPredictions, projectedClusters);
    refreshPublishedNarratives(publishedPredictions);

    assert.equal(a.caseFile.situationContext.forecastCount, 1);
    assert.ok(!a.scenario.includes('broader cluster'));
    assert.ok(!a.feedSummary.includes('broader'));
  });
});

describe('market transmission macro state', () => {
  it('uses live-shaped macro and market payloads to form energy-aware world signals and keep market consequences selective', () => {
    const fredSeries = (seriesId, observations) => ({
      seriesId,
      title: seriesId,
      observations: observations.map(([date, value]) => ({ date, value })),
    });

    const conflict = makePrediction('conflict', 'Middle East', 'Hormuz escalation risk', 0.73, 0.64, '7d', [
      { type: 'cii', value: 'Regional posture elevated', weight: 0.4 },
      { type: 'news', value: 'Hormuz pressure rising', weight: 0.25 },
    ]);
    buildForecastCase(conflict);

    const supply = makePrediction('supply_chain', 'Red Sea', 'Red Sea freight disruption', 0.69, 0.61, '7d', [
      { type: 'chokepoint', value: 'Red Sea disruption detected', weight: 0.45 },
      { type: 'shipping', value: 'Freight costs rising', weight: 0.25 },
    ]);
    buildForecastCase(supply);

    const political = makePrediction('political', 'United States', 'US sovereign risk repricing', 0.58, 0.56, '30d', [
      { type: 'macro', value: 'Rates and volatility remain elevated', weight: 0.3 },
    ]);
    buildForecastCase(political);

    populateFallbackNarratives([conflict, supply, political]);

    const worldState = buildForecastRunWorldState({
      predictions: [conflict, supply, political],
      inputs: {
        shippingRates: {
          indices: [
            { indexId: 'wci-red-sea', name: 'Red Sea Freight Index', changePct: 11.4, spikeAlert: true },
          ],
        },
        commodityQuotes: {
          quotes: [
            { symbol: 'CL=F', name: 'WTI Crude Oil', price: 87.4, change: 3.1 },
            { symbol: 'BZ=F', name: 'Brent Crude Oil', price: 92.8, change: 3.4 },
            { symbol: 'NG=F', name: 'Natural Gas', price: 3.9, change: 4.6 },
            { symbol: 'GC=F', name: 'Gold', price: 2450, change: 1.5 },
          ],
        },
        bisExchangeRates: {
          exchange: {
            rates: [
              { countryCode: 'TRY', countryName: 'Turkey', realChange: 3.2 },
            ],
          },
        },
        bisPolicyRates: {
          policy: {
            rates: [
              { countryCode: 'BR', countryName: 'Brazil', rate: 11.25, previousRate: 10.75 },
            ],
          },
          exchange: {
            rates: [
              { countryCode: 'MX', countryName: 'Mexico', realChange: 2.7 },
            ],
          },
        },
        correlationCards: {
          military: [
            { domain: 'military', title: 'Carrier posture and sanctions correlation' },
          ],
          markets: [
            { domain: 'market', title: 'Economic sanctions and commodity correlation' },
          ],
        },
        fredSeries: {
          VIXCLS: fredSeries('VIXCLS', [['2026-02-01', 18.2], ['2026-03-01', 23.4]]),
          FEDFUNDS: fredSeries('FEDFUNDS', [['2026-02-01', 4.25], ['2026-03-01', 4.50]]),
          T10Y2Y: fredSeries('T10Y2Y', [['2025-12-01', 0.55], ['2026-03-01', 0.08]]),
          CPIAUCSL: fredSeries('CPIAUCSL', [
            ['2025-03-01', 312.0],
            ['2025-04-01', 312.6],
            ['2025-05-01', 313.1],
            ['2025-06-01', 313.8],
            ['2025-07-01', 314.4],
            ['2025-08-01', 315.1],
            ['2025-09-01', 315.8],
            ['2025-10-01', 316.2],
            ['2025-11-01', 317.0],
            ['2025-12-01', 318.2],
            ['2026-01-01', 319.3],
            ['2026-02-01', 320.6],
            ['2026-03-01', 321.8],
          ]),
          UNRATE: fredSeries('UNRATE', [['2025-12-01', 3.9], ['2026-03-01', 4.2]]),
          DGS10: fredSeries('DGS10', [['2026-02-01', 4.02], ['2026-03-01', 4.21]]),
          WALCL: fredSeries('WALCL', [['2025-12-01', 6950], ['2026-03-01', 6760]]),
          M2SL: fredSeries('M2SL', [['2025-09-01', 21400], ['2026-03-01', 21880]]),
          GDP: fredSeries('GDP', [['2025-10-01', 28900], ['2026-01-01', 28940]]),
          DCOILWTICO: fredSeries('DCOILWTICO', [['2026-01-20', 74.8], ['2026-03-01', 86.6]]),
        },
      },
    });

    const signalTypes = new Set((worldState.worldSignals?.signals || []).map((item) => item.type));
    assert.ok(signalTypes.has('volatility_shock'));
    assert.ok(signalTypes.has('yield_curve_stress'));
    assert.ok(signalTypes.has('inflation_impulse'));
    assert.ok(signalTypes.has('oil_macro_shock'));
    assert.ok(signalTypes.has('global_crude_spread_stress'));
    assert.ok(signalTypes.has('gas_supply_stress'));
    assert.ok(signalTypes.has('safe_haven_bid'));
    assert.ok(signalTypes.has('fx_stress'));

    const buckets = new Map((worldState.marketState?.buckets || []).map((bucket) => [bucket.id, bucket]));
    assert.ok((buckets.get('energy')?.pressureScore || 0) > 0.4);
    assert.ok((buckets.get('freight')?.pressureScore || 0) > 0.35);
    assert.ok((buckets.get('sovereign_risk')?.pressureScore || 0) > 0.25);
    assert.ok((buckets.get('rates_inflation')?.macroConfirmation || 0) > 0);
    assert.ok((buckets.get('fx_stress')?.macroConfirmation || 0) > 0);
    assert.ok((buckets.get('energy')?.pressureScore || 0) >= (buckets.get('defense')?.pressureScore || 0));

    const marketConsequences = worldState.simulationState?.marketConsequences;
    assert.ok((marketConsequences?.internalCount || 0) >= (marketConsequences?.items?.length || 0));
    assert.ok((marketConsequences?.items?.length || 0) <= 6);
    assert.ok((marketConsequences?.blockedCount || 0) >= 1);
  });
});

describe('forecast run world state', () => {
  it('builds a canonical run-level world state artifact', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
      { type: 'news_corroboration', value: 'Regional officials warn of retaliation risk', weight: 0.3 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    a.trend = 'rising';
    a.priorProbability = 0.61;
    buildForecastCase(a);

    const b = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.52, 0.55, '30d', [
      { type: 'chokepoint', value: 'Strait of Hormuz remains disrupted', weight: 0.5 },
    ]);
    b.trend = 'stable';
    buildForecastCase(b);

    populateFallbackNarratives([a, b]);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T12:00:00Z'),
      predictions: [a, b],
      priorWorldState: {
        actorRegistry: [
          {
            id: 'Regional command authority:state',
            name: 'Regional command authority',
            category: 'state',
            influenceScore: 0.3,
            domains: ['conflict'],
            regions: ['Iran'],
          },
          {
            id: 'legacy:state',
            name: 'Legacy Actor',
            category: 'state',
            influenceScore: 0.2,
            domains: ['market'],
            regions: ['Middle East'],
          },
        ],
        branchStates: [
          {
            id: `${a.id}:base`,
            forecastId: a.id,
            kind: 'base',
            title: 'Base Branch',
            projectedProbability: 0.62,
            actorIds: ['Regional command authority:state'],
            triggerSample: ['Old trigger'],
          },
          {
            id: `${a.id}:contrarian`,
            forecastId: a.id,
            kind: 'contrarian',
            title: 'Contrarian Branch',
            projectedProbability: 0.55,
            actorIds: ['Regional command authority:state'],
            triggerSample: [],
          },
        ],
      },
    });

    assert.equal(worldState.version, 1);
    assert.equal(worldState.domainStates.length, 2);
    assert.ok(worldState.actorRegistry.length > 0);
    assert.equal(worldState.branchStates.length, 6);
    assert.equal(worldState.continuity.risingForecasts, 1);
    assert.ok(worldState.summary.includes('2 active forecasts'));
    assert.ok(worldState.evidenceLedger.supporting.length > 0);
    assert.ok(worldState.actorContinuity.persistentCount >= 1);
    assert.ok(worldState.actorContinuity.newlyActiveCount >= 1);
    assert.ok(worldState.actorContinuity.newlyActivePreview.length >= 1);
    assert.ok(worldState.actorContinuity.noLongerActivePreview.some(actor => actor.id === 'legacy:state'));
    assert.ok(worldState.branchContinuity.persistentBranchCount >= 2);
    assert.ok(worldState.branchContinuity.newBranchCount >= 1);
    assert.ok(worldState.branchContinuity.strengthenedBranchCount >= 1);
    assert.ok(worldState.branchContinuity.resolvedBranchCount >= 0);
    assert.ok(worldState.situationClusters.length >= 1);
    assert.ok(worldState.situationSummary.summary.includes('clustered situations'));
    assert.ok(typeof worldState.situationContinuity.newSituationCount === 'number');
    assert.ok(worldState.simulationState.summary.includes('deterministic rounds'));
    assert.equal(worldState.simulationState.roundTransitions.length, 3);
    assert.ok(worldState.simulationState.situationSimulations.length >= 1);
    assert.ok(worldState.simulationState.situationSimulations.every((unit) => unit.rounds.length === 3));
    assert.ok(worldState.report.summary.includes('leading domains'));
    assert.ok(worldState.report.continuitySummary.includes('Actors:'));
    assert.ok(worldState.report.simulationSummary.includes('deterministic rounds'));
    assert.ok(worldState.report.simulationInputSummary.includes('simulation report inputs'));
    assert.ok(worldState.report.regionalHotspots.length >= 1);
    assert.ok(worldState.report.branchWatchlist.length >= 1);
    assert.ok(Array.isArray(worldState.report.situationWatchlist));
    assert.ok(Array.isArray(worldState.report.simulationWatchlist));
    assert.ok(Array.isArray(worldState.report.simulationOutcomeSummaries));
    assert.ok(Array.isArray(worldState.report.crossSituationEffects));
  });

  it('reports full actor continuity counts even when previews are capped', () => {
    const predictions = [
      makePrediction('conflict', 'Region A', 'Escalation risk: Region A', 0.6, 0.6, '7d', [
        { type: 'cii', value: 'Conflict signal', weight: 0.4 },
      ]),
      makePrediction('market', 'Region B', 'Oil price impact: Region B', 0.6, 0.6, '7d', [
        { type: 'prediction_market', value: 'Market stress', weight: 0.4 },
      ]),
      makePrediction('cyber', 'Region C', 'Cyber threat concentration: Region C', 0.6, 0.6, '7d', [
        { type: 'cyber', value: 'Cyber signal', weight: 0.4 },
      ]),
    ];
    for (const pred of predictions) buildForecastCase(pred);

    const priorWorldState = {
      actorRegistry: [],
    };

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T12:00:00Z'),
      predictions,
      priorWorldState,
    });

    assert.ok(worldState.actorContinuity.newlyActiveCount > 8);
    assert.equal(worldState.actorContinuity.newlyActivePreview.length, 8);
  });

  it('tracks situation continuity across runs', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.72, 0.63, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
      { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    a.trend = 'rising';
    buildForecastCase(a);

    const b = makePrediction('market', 'Middle East', 'Oil price impact from Strait of Hormuz disruption', 0.55, 0.57, '30d', [
      { type: 'prediction_market', value: 'Oil contracts reprice on Strait of Hormuz risk', weight: 0.4 },
      { type: 'chokepoint', value: 'Strait of Hormuz remains disrupted', weight: 0.3 },
    ]);
    b.trend = 'rising';
    buildForecastCase(b);

    const currentWorldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T14:00:00Z'),
      predictions: [a, b],
      priorWorldState: {
        situationClusters: [
          {
            id: 'sit-legacy',
            label: 'Legacy: resolved pressure',
            forecastCount: 1,
            avgProbability: 0.22,
            regions: ['Elsewhere'],
            domains: ['political'],
            actors: ['legacy:actor'],
          },
        ],
      },
    });

    const priorWorldState = {
      situationClusters: currentWorldState.situationClusters.map((cluster) => ({
        ...cluster,
        avgProbability: +(cluster.avgProbability - 0.12).toFixed(3),
        forecastCount: Math.max(1, cluster.forecastCount - 1),
      })),
    };

    const nextWorldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T15:00:00Z'),
      predictions: [a, b],
      priorWorldState,
      priorWorldStates: [priorWorldState],
    });

    assert.ok(nextWorldState.situationContinuity.persistentSituationCount >= 1);
    assert.ok(nextWorldState.situationContinuity.strengthenedSituationCount >= 1);
    assert.ok(nextWorldState.report.continuitySummary.includes('Situations:'));
    assert.ok(nextWorldState.report.situationWatchlist.length >= 1);
    assert.ok(nextWorldState.reportContinuity.summary.includes('last'));
  });
  it('keeps situation continuity stable when a cluster expands with a new earlier-sorting actor', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.72, 0.63, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    a.trend = 'rising';
    buildForecastCase(a);

    const priorWorldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T14:00:00Z'),
      predictions: [a],
    });

    const currentPrediction = structuredClone(a);
    currentPrediction.caseFile = structuredClone(a.caseFile);
    currentPrediction.caseFile.actors = [
      {
        id: 'aaa-new-actor:state',
        name: 'AAA New Actor',
        category: 'state',
        influenceScore: 0.7,
        domains: ['conflict'],
        regions: ['Iran'],
        role: 'AAA New Actor is a primary state actor.',
        objectives: ['Shape the conflict path.'],
        constraints: ['Public escalation is costly.'],
        likelyActions: ['Increase visible coordination.'],
      },
      ...(currentPrediction.caseFile.actors || []),
    ];

    const nextWorldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T15:00:00Z'),
      predictions: [currentPrediction],
      priorWorldState,
      priorWorldStates: [priorWorldState],
    });

    assert.equal(nextWorldState.situationContinuity.newSituationCount, 0);
    assert.ok(nextWorldState.situationContinuity.persistentSituationCount >= 1);
  });

  it('summarizes report continuity across recent world-state history', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    buildForecastCase(a);

    const baseState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T10:00:00Z'),
      predictions: [a],
    });

    const strongerState = {
      ...baseState,
      generatedAt: Date.parse('2026-03-17T11:00:00Z'),
      generatedAtIso: '2026-03-17T11:00:00.000Z',
      situationClusters: baseState.situationClusters.map((cluster) => ({
        ...cluster,
        avgProbability: +(cluster.avgProbability - 0.08).toFixed(3),
        forecastCount: Math.max(1, cluster.forecastCount - 1),
      })),
    };

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T12:00:00Z'),
      predictions: [a],
      priorWorldState: strongerState,
      priorWorldStates: [strongerState, baseState],
    });

    assert.ok(worldState.reportContinuity.history.length >= 2);
    assert.ok(worldState.reportContinuity.persistentPressureCount >= 1);
    assert.equal(worldState.reportContinuity.repeatedStrengtheningCount, 0);
    assert.ok(Array.isArray(worldState.report.continuityWatchlist));
  });

  it('matches report continuity when historical situation ids drift from cluster expansion', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    a.newsContext = ['Regional officials warn of retaliation risk'];
    buildForecastCase(a);

    const priorState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T10:00:00Z'),
      predictions: [a],
    });

    const expandedPrediction = structuredClone(a);
    expandedPrediction.caseFile = structuredClone(a.caseFile);
    expandedPrediction.caseFile.actors = [
      {
        id: 'aaa-new-actor:state',
        name: 'AAA New Actor',
        category: 'state',
        influenceScore: 0.7,
        domains: ['conflict'],
        regions: ['Iran'],
        role: 'AAA New Actor is a primary state actor.',
        objectives: ['Shape the conflict path.'],
        constraints: ['Public escalation is costly.'],
        likelyActions: ['Increase visible coordination.'],
      },
      ...(expandedPrediction.caseFile.actors || []),
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T11:00:00Z'),
      predictions: [expandedPrediction],
      priorWorldState: priorState,
      priorWorldStates: [priorState],
    });

    assert.equal(worldState.reportContinuity.emergingPressureCount, 0);
    assert.equal(worldState.reportContinuity.fadingPressureCount, 0);
    assert.ok(worldState.reportContinuity.persistentPressureCount >= 1);
  });

  it('marks fading pressures for situations present in prior state but absent from current run', () => {
    const a = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    buildForecastCase(a);

    const baseState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T10:00:00Z'),
      predictions: [a],
    });

    // Inject a synthetic cluster into the prior state that will not be present in the current run
    const priorState = {
      ...baseState,
      generatedAt: Date.parse('2026-03-17T10:00:00Z'),
      situationClusters: [
        ...baseState.situationClusters,
        {
          id: 'sit-redseafade-test',
          label: 'Red Sea: Shipping disruption fading',
          domain: 'supply_chain',
          regionIds: ['red_sea'],
          actorIds: [],
          forecastIds: ['fc-supply_chain-redseafade'],
          avgProbability: 0.55,
          forecastCount: 1,
        },
      ],
    };

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-17T11:00:00Z'),
      predictions: [a],
      priorWorldState: priorState,
      priorWorldStates: [priorState],
    });

    assert.ok(worldState.reportContinuity.fadingPressureCount >= 1);
    assert.ok(worldState.reportContinuity.fadingPressurePreview.length >= 1);
    assert.ok(worldState.reportContinuity.fadingPressurePreview.every(
      (s) => typeof s.avgProbability === 'number' && typeof s.forecastCount === 'number',
    ));
    assert.ok(worldState.reportContinuity.persistentPressureCount >= 1);
  });

  it('does not collapse unrelated cross-country conflict and political forecasts into one giant situation', () => {
    const conflictIran = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'ucdp', value: '27 conflict events in Iran', weight: 0.4 },
    ]);
    conflictIran.newsContext = ['Regional officials warn of retaliation risk'];
    buildForecastCase(conflictIran);

    const conflictBrazil = makePrediction('conflict', 'Brazil', 'Active armed conflict: Brazil', 0.68, 0.44, '7d', [
      { type: 'ucdp', value: '18 conflict events in Brazil', weight: 0.35 },
    ]);
    conflictBrazil.newsContext = ['Security operations intensify in Brazil'];
    buildForecastCase(conflictBrazil);

    const politicalTurkey = makePrediction('political', 'Turkey', 'Political instability: Turkey', 0.43, 0.52, '14d', [
      { type: 'news_corroboration', value: 'Cabinet tensions intensify in Turkey', weight: 0.3 },
    ]);
    politicalTurkey.newsContext = ['Opposition parties escalate criticism in Turkey'];
    buildForecastCase(politicalTurkey);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-18T22:00:00Z'),
      predictions: [conflictIran, conflictBrazil, politicalTurkey],
    });

    assert.ok(worldState.situationClusters.length >= 2);
    assert.ok(worldState.situationClusters.every((cluster) => cluster.forecastCount <= 2));
    assert.ok(worldState.situationClusters.every((cluster) => cluster.label.endsWith('situation')));
  });

  it('does not describe a lower-probability situation as strengthened just because it expanded', () => {
    const prediction = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
    ]);
    prediction.newsContext = ['Regional officials warn of retaliation risk'];
    buildForecastCase(prediction);

    const priorWorldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-18T10:00:00Z'),
      predictions: [prediction],
    });

    const currentPrediction = structuredClone(prediction);
    currentPrediction.caseFile = structuredClone(prediction.caseFile);
    currentPrediction.probability = 0.62;
    currentPrediction.caseFile.actors = [
      {
        id: 'new-actor:state',
        name: 'New Actor',
        category: 'state',
        influenceScore: 0.7,
        role: 'New Actor is newly engaged.',
        objectives: ['Shape the path.'],
        constraints: ['Public escalation is costly.'],
        likelyActions: ['Increase visible coordination.'],
      },
      ...(currentPrediction.caseFile.actors || []),
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-18T11:00:00Z'),
      predictions: [currentPrediction],
      priorWorldState,
      priorWorldStates: [priorWorldState],
    });

    assert.equal(worldState.situationContinuity.strengthenedSituationCount, 0);
    assert.ok(worldState.report.situationWatchlist.every((item) => item.type !== 'strengthened_situation'));
  });

  it('builds deterministic simulation units and round transitions from clustered situations', () => {
    const conflict = makePrediction('conflict', 'Israel', 'Active armed conflict: Israel', 0.76, 0.66, '7d', [
      { type: 'ucdp', value: 'Israeli theater remains active', weight: 0.4 },
      { type: 'news_corroboration', value: 'Regional actors prepare responses', weight: 0.2 },
    ]);
    conflict.newsContext = ['Regional actors prepare responses'];
    buildForecastCase(conflict);

    const supply = makePrediction('supply_chain', 'Eastern Mediterranean', 'Shipping disruption: Eastern Mediterranean', 0.59, 0.55, '14d', [
      { type: 'chokepoint', value: 'Shipping reroutes through the Eastern Mediterranean', weight: 0.4 },
    ]);
    buildForecastCase(supply);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T08:00:00Z'),
      predictions: [conflict, supply],
    });

    assert.ok(worldState.simulationState.totalSituationSimulations >= 2);
    assert.equal(worldState.simulationState.totalRounds, 3);
    assert.ok(worldState.simulationState.roundTransitions.every((round) => round.situationCount >= 1));
    assert.ok(Array.isArray(worldState.simulationState.actionLedger));
    assert.ok(worldState.simulationState.actionLedger.length >= 2);
    assert.ok(Array.isArray(worldState.simulationState.replayTimeline));
    assert.equal(worldState.simulationState.replayTimeline.length, 3);
    assert.ok(worldState.simulationState.situationSimulations.every((unit) => ['escalatory', 'contested', 'constrained'].includes(unit.posture)));
    assert.ok(worldState.simulationState.situationSimulations.every((unit) => unit.rounds.every((round) => typeof round.netPressure === 'number')));
    assert.ok(worldState.simulationState.situationSimulations.every((unit) => Array.isArray(unit.actionPlan) && unit.actionPlan.length === 3));
    assert.ok(worldState.simulationState.situationSimulations.every((unit) => unit.actionPlan.every((round) => Array.isArray(round.actions))));
  });

  it('derives differentiated simulation postures from actor actions, branches, and counter-evidence', () => {
    const escalatory = makePrediction('conflict', 'Israel', 'Active armed conflict: Israel', 0.88, 0.71, '7d', [
      { type: 'ucdp', value: 'Israeli theater remains highly active', weight: 0.45 },
      { type: 'news_corroboration', value: 'Regional actors prepare responses', weight: 0.3 },
    ]);
    buildForecastCase(escalatory);

    const constrained = makePrediction('infrastructure', 'Cuba', 'Infrastructure cascade risk: Cuba', 0.28, 0.44, '14d', [
      { type: 'outage', value: 'Localized outages remain contained', weight: 0.2 },
    ]);
    buildForecastCase(constrained);
    constrained.caseFile.counterEvidence = [
      { type: 'confidence', summary: 'Confidence remains limited and the pattern is not yet broad.', weight: 0.3 },
      { type: 'coverage_gap', summary: 'Cross-system corroboration is still thin.', weight: 0.25 },
      { type: 'trend', summary: 'Momentum is already easing.', weight: 0.25 },
    ];
    constrained.caseFile.actors = (constrained.caseFile.actors || []).map((actor) => ({
      ...actor,
      likelyActions: ['Maintain continuity around exposed nodes.'],
      constraints: ['Containment remains the priority and escalation is costly.'],
    }));

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T13:00:00Z'),
      predictions: [escalatory, constrained],
    });

    const escalatoryUnit = worldState.simulationState.situationSimulations.find((unit) => unit.label.includes('Israel'));
    const constrainedUnit = worldState.simulationState.situationSimulations.find((unit) => unit.label.includes('Cuba'));
    assert.equal(escalatoryUnit?.posture, 'escalatory');
    assert.equal(constrainedUnit?.posture, 'constrained');
    assert.ok(escalatoryUnit?.rounds.some((round) => (round.actionMix?.pressure || 0) > (round.actionMix?.stabilizing || 0)));
    assert.ok(constrainedUnit?.rounds.some((round) => (round.actionMix?.stabilizing || 0) >= (round.actionMix?.pressure || 0)));
  });

  it('keeps moderate market and supply-chain situations contested unless pressure compounds strongly', () => {
    const market = makePrediction('market', 'Japan', 'Oil price impact: Japan', 0.58, 0.56, '30d', [
      { type: 'prediction_market', value: 'Oil contracts reprice on Japan energy risk', weight: 0.3 },
      { type: 'commodity_price', value: 'Energy prices are drifting higher', weight: 0.2 },
    ]);
    buildForecastCase(market);

    const supply = makePrediction('supply_chain', 'Red Sea', 'Shipping disruption: Red Sea', 0.55, 0.54, '14d', [
      { type: 'chokepoint', value: 'Shipping reroutes remain elevated', weight: 0.3 },
    ]);
    buildForecastCase(supply);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T13:30:00Z'),
      predictions: [market, supply],
    });

    const marketUnit = worldState.simulationState.situationSimulations.find((unit) => unit.label.includes('Japan'));
    const supplyUnit = worldState.simulationState.situationSimulations.find((unit) => unit.label.includes('Red Sea'));
    assert.equal(marketUnit?.posture, 'contested');
    assert.equal(supplyUnit?.posture, 'contested');
    assert.ok((marketUnit?.postureScore || 0) < 0.77);
    assert.ok((supplyUnit?.postureScore || 0) < 0.77);
    assert.ok((marketUnit?.marketContext?.confirmationScore || 0) > 0);
    assert.ok((supplyUnit?.marketContext?.linkedBucketIds || []).length >= 1);
    assert.ok((worldState.simulationState.marketConsequences?.items || []).length >= 1);
    assert.ok((worldState.report.marketConsequenceWatchlist || []).length >= 1);
  });

  it('builds report outputs from simulation outcomes and cross-situation effects', () => {
    const conflict = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.79, 0.67, '7d', [
      { type: 'ucdp', value: 'Conflict intensity remains elevated in Iran', weight: 0.4 },
      { type: 'news_corroboration', value: 'Regional actors prepare for reprisals', weight: 0.3 },
    ]);
    conflict.newsContext = ['Regional actors prepare for reprisals'];
    buildForecastCase(conflict);
    conflict.caseFile.actors = [
      {
        id: 'shared-energy-actor',
        name: 'Shared Energy Actor',
        category: 'market_participant',
        influenceScore: 0.7,
        domains: ['conflict', 'market'],
        regions: ['Iran', 'Japan'],
        objectives: ['Preserve energy flows'],
        constraints: ['Cannot absorb prolonged disruption'],
        likelyActions: ['Reprice energy exposure'],
      },
      ...(conflict.caseFile.actors || []),
    ];

    const market = makePrediction('market', 'Japan', 'Oil price impact: Japan', 0.61, 0.57, '30d', [
      { type: 'prediction_market', value: 'Oil contracts reprice on Japan energy risk', weight: 0.4 },
      { type: 'chokepoint', value: 'Strait of Hormuz remains exposed', weight: 0.2 },
    ]);
    market.newsContext = ['Oil traders price escalation risk across Japan'];
    buildForecastCase(market);
    market.caseFile.actors = [
      {
        id: 'shared-energy-actor',
        name: 'Shared Energy Actor',
        category: 'market_participant',
        influenceScore: 0.7,
        domains: ['conflict', 'market'],
        regions: ['Iran', 'Japan'],
        objectives: ['Preserve energy flows'],
        constraints: ['Cannot absorb prolonged disruption'],
        likelyActions: ['Reprice energy exposure'],
      },
      ...(market.caseFile.actors || []),
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T10:00:00Z'),
      predictions: [conflict, market],
    });

    assert.ok(worldState.report.simulationOutcomeSummaries.length >= 2);
    assert.ok(worldState.report.simulationOutcomeSummaries.every((item) => item.rounds.length === 3));
    assert.ok(worldState.report.simulationOutcomeSummaries.every((item) => ['escalatory', 'contested', 'constrained'].includes(item.posture)));
    assert.ok(worldState.simulationState.interactionLedger.length >= 1);
    assert.ok(worldState.simulationState.replayTimeline.some((item) => item.interactionCount >= 1));
    assert.ok(worldState.report.crossSituationEffects.length >= 1);
    assert.ok(worldState.report.crossSituationEffects.some((item) => item.summary.includes('Japan')));
    assert.ok(worldState.report.crossSituationEffects.every((item) => item.channel));
    assert.ok(worldState.report.interactionWatchlist.length >= 1);
    assert.ok(worldState.report.replayWatchlist.length === 3);
    assert.ok(worldState.simulationState.situationSimulations.every((item) => item.familyId));
  });

  it('does not synthesize cross-situation effects for unrelated theaters with no overlap', () => {
    const brazilConflict = makePrediction('conflict', 'Brazil', 'Active armed conflict: Brazil', 0.77, 0.65, '7d', [
      { type: 'ucdp', value: 'Brazil conflict intensity remains elevated', weight: 0.4 },
    ]);
    buildForecastCase(brazilConflict);

    const japanMarket = makePrediction('market', 'Japan', 'Market repricing: Japan', 0.58, 0.54, '30d', [
      { type: 'prediction_market', value: 'Japanese markets price regional risk', weight: 0.4 },
    ]);
    buildForecastCase(japanMarket);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T11:00:00Z'),
      predictions: [brazilConflict, japanMarket],
    });

    assert.equal(worldState.report.crossSituationEffects.length, 0);
  });

  it('uses the true dominant domain when deriving simulation report inputs and effects', () => {
    const supplyA = makePrediction('supply_chain', 'Middle East', 'Shipping disruption: Middle East', 0.66, 0.57, '14d', [
      { type: 'chokepoint', value: 'Regional shipping remains disrupted', weight: 0.4 },
    ]);
    supplyA.newsContext = ['Middle East shipping disruption expands'];
    buildForecastCase(supplyA);

    const supplyB = makePrediction('supply_chain', 'Middle East', 'Logistics delay: Middle East', 0.62, 0.55, '14d', [
      { type: 'chokepoint', value: 'Logistics routes remain congested', weight: 0.35 },
    ]);
    supplyB.newsContext = ['Middle East shipping disruption expands'];
    buildForecastCase(supplyB);

    const market = makePrediction('market', 'Middle East', 'Oil price impact: Middle East', 0.57, 0.53, '30d', [
      { type: 'prediction_market', value: 'Oil contracts reprice on logistics risk', weight: 0.3 },
    ]);
    market.newsContext = ['Middle East shipping disruption expands'];
    buildForecastCase(market);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T12:00:00Z'),
      predictions: [supplyA, supplyB, market],
    });

    const dominantInput = worldState.report.simulationOutcomeSummaries.find((item) => item.label.includes('Middle East'));
    const dominantSimulation = worldState.simulationState.situationSimulations.find((item) => item.label.includes('Middle East'));
    assert.equal(dominantSimulation?.dominantDomain, 'supply_chain');
    assert.ok(dominantInput);
  });

  it('builds broader situation families above individual situations', () => {
    const conflict = makePrediction('conflict', 'Israel', 'Active armed conflict: Israel', 0.76, 0.66, '7d', [
      { type: 'ucdp', value: 'Israeli theater remains active', weight: 0.4 },
    ]);
    conflict.newsContext = ['Regional actors prepare responses'];
    buildForecastCase(conflict);

    const market = makePrediction('market', 'Middle East', 'Oil price impact: Middle East', 0.59, 0.56, '30d', [
      { type: 'prediction_market', value: 'Energy traders reprice risk', weight: 0.35 },
    ]);
    market.newsContext = ['Regional actors prepare responses'];
    buildForecastCase(market);

    const supply = makePrediction('supply_chain', 'Eastern Mediterranean', 'Shipping disruption: Eastern Mediterranean', 0.57, 0.54, '14d', [
      { type: 'chokepoint', value: 'Shipping reroutes continue', weight: 0.35 },
    ]);
    supply.newsContext = ['Regional actors prepare responses'];
    buildForecastCase(supply);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T12:30:00Z'),
      predictions: [conflict, market, supply],
    });

    assert.ok(worldState.situationClusters.length >= 2);
    assert.ok(worldState.situationFamilies.length >= 1);
    assert.ok(worldState.situationFamilies.length <= worldState.situationClusters.length);
    assert.ok(worldState.report.familyWatchlist.length >= 1);
  });

  it('does not synthesize cross-situation effects from family membership alone', () => {
    const source = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.74, 0.64, '7d', [
      { type: 'ucdp', value: 'Iran theater remains active', weight: 0.4 },
    ]);
    source.newsContext = ['Regional actors prepare responses'];
    buildForecastCase(source);

    const target = makePrediction('market', 'Japan', 'Market repricing: Japan', 0.58, 0.55, '30d', [
      { type: 'prediction_market', value: 'Japan markets price energy risk', weight: 0.35 },
    ]);
    target.newsContext = ['Regional actors prepare responses'];
    buildForecastCase(target);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T12:45:00Z'),
      predictions: [source, target],
    });

    const patchedSimulationState = structuredClone(worldState.simulationState);
    for (const unit of patchedSimulationState.situationSimulations || []) {
      unit.familyId = 'fam-shared-test';
      unit.familyLabel = 'Shared test family';
    }

    const effects = buildCrossSituationEffects(patchedSimulationState);
    assert.equal(effects.length, 0);
  });

  it('does not emit cross-situation effects from constrained low-energy infrastructure situations', () => {
    const cuba = makePrediction('infrastructure', 'Cuba', 'Infrastructure degradation: Cuba', 0.29, 0.45, '14d', [
      { type: 'outage', value: 'Localized infrastructure outages remain contained in Cuba', weight: 0.25 },
    ]);
    buildForecastCase(cuba);
    cuba.caseFile.actors = [
      {
        id: 'shared-grid-operator',
        name: 'Shared Grid Operator',
        category: 'infrastructure_operator',
        influenceScore: 0.45,
        domains: ['infrastructure'],
        regions: ['Cuba', 'Iran'],
        objectives: ['Maintain continuity'],
        constraints: ['Containment remains the priority.'],
        likelyActions: ['Maintain service continuity around exposed nodes.'],
      },
    ];

    const iran = makePrediction('infrastructure', 'Iran', 'Infrastructure degradation: Iran', 0.31, 0.46, '14d', [
      { type: 'outage', value: 'Localized infrastructure outages remain contained in Iran', weight: 0.25 },
    ]);
    buildForecastCase(iran);
    iran.caseFile.actors = [
      {
        id: 'shared-grid-operator',
        name: 'Shared Grid Operator',
        category: 'infrastructure_operator',
        influenceScore: 0.45,
        domains: ['infrastructure'],
        regions: ['Cuba', 'Iran'],
        objectives: ['Maintain continuity'],
        constraints: ['Containment remains the priority.'],
        likelyActions: ['Maintain service continuity around exposed nodes.'],
      },
    ];
    iran.caseFile.counterEvidence = [
      { type: 'containment', summary: 'Containment actions are limiting broader spread.', weight: 0.35 },
    ];
    cuba.caseFile.counterEvidence = [
      { type: 'containment', summary: 'Containment actions are limiting broader spread.', weight: 0.35 },
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T13:20:00Z'),
      predictions: [cuba, iran],
    });

    assert.ok((worldState.simulationState.situationSimulations || []).every((item) => item.posture === 'constrained'));
    assert.equal(worldState.report.crossSituationEffects.length, 0);
  });

  it('allows cyber sources above the domain constrained threshold to emit direct effects', () => {
    const cyber = makePrediction('cyber', 'Poland', 'Cyber disruption risk: Poland', 0.46, 0.54, '14d', [
      { type: 'cyber', value: 'Cyber disruption pressure remains elevated across Poland', weight: 0.35 },
    ]);
    buildForecastCase(cyber);
    cyber.caseFile.actors = [
      {
        id: 'shared-cyber-actor',
        name: 'Shared Cyber Actor',
        category: 'state_actor',
        influenceScore: 0.6,
        domains: ['cyber', 'infrastructure'],
        regions: ['Poland', 'Baltic States'],
        objectives: ['Sustain pressure against exposed systems'],
        constraints: ['Avoid overt escalation'],
        likelyActions: ['Coordinate cyber pressure against exposed infrastructure.'],
      },
    ];

    const infrastructure = makePrediction('infrastructure', 'Baltic States', 'Infrastructure disruption risk: Baltic States', 0.41, 0.52, '14d', [
      { type: 'outage', value: 'Infrastructure resilience is under pressure in the Baltic States', weight: 0.3 },
    ]);
    buildForecastCase(infrastructure);
    infrastructure.caseFile.actors = [
      {
        id: 'shared-cyber-actor',
        name: 'Shared Cyber Actor',
        category: 'state_actor',
        influenceScore: 0.6,
        domains: ['cyber', 'infrastructure'],
        regions: ['Poland', 'Baltic States'],
        objectives: ['Sustain pressure against exposed systems'],
        constraints: ['Avoid overt escalation'],
        likelyActions: ['Coordinate cyber pressure against exposed infrastructure.'],
      },
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T13:25:00Z'),
      predictions: [cyber, infrastructure],
    });

    const patchedSimulationState = structuredClone(worldState.simulationState);
    const cyberUnit = patchedSimulationState.situationSimulations.find((item) => item.label.includes('Poland'));
    assert.ok(cyberUnit);
    cyberUnit.posture = 'contested';
    cyberUnit.postureScore = 0.394;
    cyberUnit.totalPressure = 0.62;
    cyberUnit.totalStabilization = 0.31;
    cyberUnit.effectChannels = [{ type: 'cyber_disruption', count: 2 }];

    const effects = buildCrossSituationEffects(patchedSimulationState);
    assert.ok(effects.some((item) => item.channel === 'cyber_disruption'));
  });

  it('keeps direct regional spillovers when a source only contributes one matching channel but has direct overlap', () => {
    const cyber = makePrediction('cyber', 'Estonia', 'Cyber pressure: Estonia', 0.47, 0.53, '14d', [
      { type: 'cyber', value: 'Regional cyber pressure remains elevated around Estonia', weight: 0.32 },
    ]);
    buildForecastCase(cyber);
    cyber.caseFile.actors = [
      {
        id: 'shared-regional-actor',
        name: 'Shared Regional Actor',
        category: 'state_actor',
        influenceScore: 0.58,
        domains: ['cyber', 'political'],
        regions: ['Estonia', 'Latvia'],
        objectives: ['Shape regional posture'],
        constraints: ['Avoid direct confrontation'],
        likelyActions: ['Manage broader regional effects from Estonia.'],
      },
    ];

    const political = makePrediction('political', 'Latvia', 'Political pressure: Latvia', 0.44, 0.52, '14d', [
      { type: 'policy_change', value: 'Political pressure is building in Latvia', weight: 0.3 },
    ]);
    buildForecastCase(political);
    political.caseFile.actors = [
      {
        id: 'shared-regional-actor',
        name: 'Shared Regional Actor',
        category: 'state_actor',
        influenceScore: 0.58,
        domains: ['cyber', 'political'],
        regions: ['Estonia', 'Latvia'],
        objectives: ['Shape regional posture'],
        constraints: ['Avoid direct confrontation'],
        likelyActions: ['Manage broader regional effects from Estonia.'],
      },
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T13:30:00Z'),
      predictions: [cyber, political],
    });

    const patchedSimulationState = structuredClone(worldState.simulationState);
    const cyberUnit = patchedSimulationState.situationSimulations.find((item) => item.label.includes('Estonia'));
    assert.ok(cyberUnit);
    cyberUnit.posture = 'contested';
    cyberUnit.postureScore = 0.422;
    cyberUnit.totalPressure = 0.59;
    cyberUnit.totalStabilization = 0.28;
    cyberUnit.effectChannels = [{ type: 'regional_spillover', count: 1 }];

    const effects = buildCrossSituationEffects(patchedSimulationState);
    assert.ok(effects.some((item) => item.channel === 'regional_spillover' && item.relation === 'regional pressure transfer'));
  });

  it('emits reverse-direction effects when only the later-listed situation can drive the target', () => {
    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T14:05:00Z'),
      predictions: [
        makePrediction('infrastructure', 'Romania', 'Infrastructure pressure: Romania', 0.34, 0.48, '14d', [
          { type: 'outage', value: 'Romania infrastructure remains contained', weight: 0.24 },
        ]),
        makePrediction('market', 'Black Sea', 'Market repricing: Black Sea', 0.57, 0.56, '14d', [
          { type: 'prediction_market', value: 'Black Sea pricing reacts to service disruption risk', weight: 0.36 },
        ]),
      ],
    });

    const patchedSimulationState = structuredClone(worldState.simulationState);
    const infraUnit = patchedSimulationState.situationSimulations.find((item) => item.dominantDomain === 'infrastructure');
    const marketUnit = patchedSimulationState.situationSimulations.find((item) => item.dominantDomain === 'market');
    assert.ok(infraUnit);
    assert.ok(marketUnit);

    infraUnit.posture = 'constrained';
    infraUnit.postureScore = 0.19;
    infraUnit.effectChannels = [{ type: 'service_disruption', count: 1 }];

    marketUnit.posture = 'contested';
    marketUnit.postureScore = 0.49;
    marketUnit.totalPressure = 0.67;
    marketUnit.totalStabilization = 0.24;
    marketUnit.effectChannels = [{ type: 'service_disruption', count: 2 }];

    patchedSimulationState.interactionLedger = [
      {
        id: 'reverse-only',
        stage: 'round_2',
        sourceSituationId: infraUnit.situationId,
        targetSituationId: marketUnit.situationId,
        strongestChannel: 'service_disruption',
        score: 5,
        sourceActorName: 'Port Operator',
        targetActorName: 'Market Desk',
        interactionType: 'spillover',
      },
      {
        id: 'reverse-emitter',
        stage: 'round_2',
        sourceSituationId: marketUnit.situationId,
        targetSituationId: infraUnit.situationId,
        strongestChannel: 'service_disruption',
        score: 5,
        sourceActorName: 'Market Desk',
        targetActorName: 'Port Operator',
        interactionType: 'spillover',
      },
    ];
    patchedSimulationState.reportableInteractionLedger = [...patchedSimulationState.interactionLedger];

    const effects = buildCrossSituationEffects(patchedSimulationState);
    assert.ok(effects.some((item) => item.sourceSituationId === marketUnit.situationId && item.targetSituationId === infraUnit.situationId));
  });

  it('prefers a usable shared channel over the alphabetically first shared channel', () => {
    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T14:10:00Z'),
      predictions: [
        makePrediction('market', 'Black Sea', 'Market repricing: Black Sea', 0.56, 0.55, '14d', [
          { type: 'prediction_market', value: 'Black Sea pricing reflects service disruption risk', weight: 0.36 },
        ]),
        makePrediction('infrastructure', 'Romania', 'Infrastructure pressure: Romania', 0.45, 0.52, '14d', [
          { type: 'outage', value: 'Romania infrastructure remains exposed to service disruption', weight: 0.3 },
        ]),
      ],
    });

    const patchedSimulationState = structuredClone(worldState.simulationState);
    const marketUnit = patchedSimulationState.situationSimulations.find((item) => item.dominantDomain === 'market');
    const infraUnit = patchedSimulationState.situationSimulations.find((item) => item.dominantDomain === 'infrastructure');
    assert.ok(marketUnit);
    assert.ok(infraUnit);

    marketUnit.posture = 'contested';
    marketUnit.postureScore = 0.5;
    marketUnit.totalPressure = 0.65;
    marketUnit.totalStabilization = 0.25;
    marketUnit.effectChannels = [
      { type: 'containment', count: 3 },
      { type: 'service_disruption', count: 2 },
    ];

    patchedSimulationState.interactionLedger = [
      {
        id: 'shared-channel-choice',
        stage: 'round_2',
        sourceSituationId: marketUnit.situationId,
        targetSituationId: infraUnit.situationId,
        strongestChannel: 'service_disruption',
        score: 5.5,
        sourceActorName: 'Shipping Desk',
        targetActorName: 'Port Operator',
        interactionType: 'spillover',
      },
    ];
    patchedSimulationState.reportableInteractionLedger = [...patchedSimulationState.interactionLedger];

    const effects = buildCrossSituationEffects(patchedSimulationState);
    assert.ok(effects.some((item) => item.channel === 'service_disruption'));
  });

  it('uses a cross-regional family label when no single region clearly dominates a family', () => {
    const iranPolitical = makePrediction('political', 'Iran', 'Political pressure: Iran', 0.62, 0.56, '14d', [
      { type: 'policy_change', value: 'Political posture hardens in Iran', weight: 0.35 },
    ]);
    buildForecastCase(iranPolitical);
    iranPolitical.caseFile.actors = [
      {
        id: 'shared-diplomatic-actor',
        name: 'Shared Diplomatic Actor',
        category: 'state_actor',
        influenceScore: 0.6,
        domains: ['political'],
        regions: ['Iran', 'Germany'],
        objectives: ['Shape political messaging'],
        constraints: ['Avoid direct confrontation'],
        likelyActions: ['Shift political posture across both theaters.'],
      },
    ];

    const germanyPolitical = makePrediction('political', 'Germany', 'Political pressure: Germany', 0.6, 0.55, '14d', [
      { type: 'policy_change', value: 'Political posture hardens in Germany', weight: 0.35 },
    ]);
    buildForecastCase(germanyPolitical);
    germanyPolitical.caseFile.actors = [
      {
        id: 'shared-diplomatic-actor',
        name: 'Shared Diplomatic Actor',
        category: 'state_actor',
        influenceScore: 0.6,
        domains: ['political'],
        regions: ['Iran', 'Germany'],
        objectives: ['Shape political messaging'],
        constraints: ['Avoid direct confrontation'],
        likelyActions: ['Shift political posture across both theaters.'],
      },
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T13:40:00Z'),
      predictions: [iranPolitical, germanyPolitical],
    });

    assert.ok(worldState.situationFamilies.length >= 1);
    assert.ok(worldState.situationFamilies.some((family) => family.label.startsWith('Cross-regional ')));
  });

  it('assigns archetype-aware family labels for maritime supply situations', () => {
    const supplyA = makePrediction('supply_chain', 'Red Sea', 'Shipping disruption: Red Sea', 0.68, 0.58, '14d', [
      { type: 'chokepoint', value: 'Shipping disruption persists in the Red Sea corridor', weight: 0.4 },
    ]);
    buildForecastCase(supplyA);

    const supplyB = makePrediction('supply_chain', 'Bab el-Mandeb', 'Freight rerouting: Bab el-Mandeb', 0.64, 0.56, '14d', [
      { type: 'gps_jamming', value: 'Maritime routing disruption persists near Bab el-Mandeb', weight: 0.32 },
    ]);
    buildForecastCase(supplyB);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T15:00:00Z'),
      predictions: [supplyA, supplyB],
    });

    assert.ok(worldState.situationFamilies.some((family) => family.archetype === 'maritime_supply'));
    assert.ok(worldState.situationFamilies.some((family) => family.label.includes('maritime supply')));
  });

  it('does not infer maritime families from generic port labor talk tokens', () => {
    const portTalks = makePrediction('political', 'Spain', 'Port labor talks: Spain', 0.58, 0.55, '14d', [
      { type: 'policy_change', value: 'Port labor talks continue in Spain', weight: 0.28 },
    ]);
    buildForecastCase(portTalks);

    const dockStrikePolitics = makePrediction('political', 'Portugal', 'Port labor pressure: Portugal', 0.56, 0.53, '14d', [
      { type: 'policy_change', value: 'Dockworker negotiations are shaping coalition pressure in Portugal', weight: 0.26 },
    ]);
    buildForecastCase(dockStrikePolitics);

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T15:30:00Z'),
      predictions: [portTalks, dockStrikePolitics],
    });

    assert.ok(worldState.situationFamilies.length >= 1);
    assert.ok(worldState.situationFamilies.every((family) => family.archetype !== 'maritime_supply'));
    assert.ok(worldState.situationFamilies.every((family) => !family.label.includes('maritime supply')));
  });

  it('keeps weak generic interactions out of the reportable interaction surface', () => {
    const source = makePrediction('political', 'Brazil', 'Political pressure: Brazil', 0.56, 0.53, '14d', [
      { type: 'policy_change', value: 'Political pressure is building in Brazil', weight: 0.32 },
    ]);
    buildForecastCase(source);
    source.caseFile.actors = [
      {
        id: 'regional-command-generic',
        name: 'Regional command authority',
        category: 'state',
        influenceScore: 0.58,
        domains: ['political'],
        regions: ['Brazil', 'Israel'],
        objectives: ['Shape regional posture'],
        constraints: ['Avoid direct confrontation'],
        likelyActions: ['Shift messaging and posture as new evidence arrives.'],
      },
    ];

    const target = makePrediction('political', 'Israel', 'Political pressure: Israel', 0.58, 0.54, '14d', [
      { type: 'policy_change', value: 'Political pressure is building in Israel', weight: 0.33 },
    ]);
    buildForecastCase(target);
    target.caseFile.actors = [
      {
        id: 'regional-command-generic',
        name: 'Regional command authority',
        category: 'state',
        influenceScore: 0.58,
        domains: ['political'],
        regions: ['Brazil', 'Israel'],
        objectives: ['Shape regional posture'],
        constraints: ['Avoid direct confrontation'],
        likelyActions: ['Shift messaging and posture as new evidence arrives.'],
      },
    ];

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T15:10:00Z'),
      predictions: [source, target],
    });

    assert.ok(Array.isArray(worldState.simulationState.reportableInteractionLedger));
    assert.equal(worldState.simulationState.reportableInteractionLedger.length, 0);
    assert.equal(worldState.report.interactionWatchlist.length, 0);
  });

  it('aggregates cross-situation effects across reportable interaction ledgers larger than 32 rows', () => {
    const source = {
      situationId: 'sit-source',
      label: 'Baltic Sea supply chain situation',
      dominantDomain: 'supply_chain',
      familyId: 'fam-a',
      familyLabel: 'Baltic maritime supply pressure family',
      regions: ['Baltic Sea'],
      actorIds: ['actor-shipping'],
      effectChannels: [{ type: 'logistics_disruption', count: 3 }],
      posture: 'escalatory',
      postureScore: 0.63,
      totalPressure: 0.68,
      totalStabilization: 0.24,
    };
    const target = {
      situationId: 'sit-target',
      label: 'Black Sea market situation',
      dominantDomain: 'market',
      familyId: 'fam-b',
      familyLabel: 'Black Sea market repricing family',
      regions: ['Black Sea'],
      actorIds: ['actor-markets'],
      effectChannels: [],
      posture: 'contested',
      postureScore: 0.44,
      totalPressure: 0.42,
      totalStabilization: 0.36,
    };

    const filler = Array.from({ length: 32 }, (_, index) => ({
      sourceSituationId: `noise-source-${index}`,
      targetSituationId: `noise-target-${index}`,
      sourceLabel: `Noise source ${index}`,
      targetLabel: `Noise target ${index}`,
      sourceActorName: `Actor ${index}`,
      targetActorName: `Counterparty ${index}`,
      interactionType: 'direct_overlap',
      strongestChannel: 'political_pressure',
      score: 6,
      confidence: 0.9,
      actorSpecificity: 0.85,
      stage: 'round_1',
    }));

    const paired = [
      {
        sourceSituationId: source.situationId,
        targetSituationId: target.situationId,
        sourceLabel: source.label,
        targetLabel: target.label,
        sourceActorName: 'Shipping operator',
        targetActorName: 'Commodity desk',
        interactionType: 'regional_spillover',
        strongestChannel: 'logistics_disruption',
        score: 2.4,
        confidence: 0.74,
        actorSpecificity: 0.82,
        stage: 'round_2',
      },
      {
        sourceSituationId: source.situationId,
        targetSituationId: target.situationId,
        sourceLabel: source.label,
        targetLabel: target.label,
        sourceActorName: 'Shipping operator',
        targetActorName: 'Commodity desk',
        interactionType: 'regional_spillover',
        strongestChannel: 'logistics_disruption',
        score: 2.3,
        confidence: 0.72,
        actorSpecificity: 0.82,
        stage: 'round_3',
      },
    ];

    const effects = buildCrossSituationEffects({
      situationSimulations: [
        source,
        target,
        ...filler.flatMap((item) => ([
          {
            situationId: item.sourceSituationId,
            label: item.sourceLabel,
            dominantDomain: 'political',
            familyId: `family-${item.sourceSituationId}`,
            familyLabel: 'Noise family',
            regions: [`Region ${item.sourceSituationId}`],
            actorIds: [`actor-${item.sourceSituationId}`],
            effectChannels: [{ type: 'political_pressure', count: 3 }],
            posture: 'escalatory',
            postureScore: 0.7,
            totalPressure: 0.75,
            totalStabilization: 0.2,
          },
          {
            situationId: item.targetSituationId,
            label: item.targetLabel,
            dominantDomain: 'political',
            familyId: `family-${item.targetSituationId}`,
            familyLabel: 'Noise family',
            regions: [`Region ${item.targetSituationId}`],
            actorIds: [`actor-${item.targetSituationId}`],
            effectChannels: [],
            posture: 'contested',
            postureScore: 0.45,
            totalPressure: 0.4,
            totalStabilization: 0.35,
          },
        ])),
      ],
      reportableInteractionLedger: [...filler, ...paired],
    });

    assert.ok(effects.some((item) => (
      item.sourceSituationId === source.situationId
      && item.targetSituationId === target.situationId
      && item.channel === 'logistics_disruption'
    )));
  });

  it('dedupes the interaction watchlist by source target and channel before report surfacing', () => {
    const watchlist = buildInteractionWatchlist([
      {
        sourceSituationId: 'sit-a',
        targetSituationId: 'sit-b',
        sourceLabel: 'Brazil cyber situation',
        targetLabel: 'United States cyber and political situation',
        strongestChannel: 'cyber_disruption',
        interactionType: 'spillover',
        stage: 'round_1',
        score: 4.2,
        confidence: 0.71,
        sourceActorName: 'Cyber unit',
        targetActorName: 'Agency',
      },
      {
        sourceSituationId: 'sit-a',
        targetSituationId: 'sit-b',
        sourceLabel: 'Brazil cyber situation',
        targetLabel: 'United States cyber and political situation',
        strongestChannel: 'cyber_disruption',
        interactionType: 'spillover',
        stage: 'round_2',
        score: 4.4,
        confidence: 0.74,
        sourceActorName: 'Cyber unit',
        targetActorName: 'Agency',
      },
    ]);

    assert.equal(watchlist.length, 1);
    assert.equal(watchlist[0].label, 'Brazil cyber situation -> United States cyber and political situation');
    assert.ok(watchlist[0].summary.includes('2 round(s)'));
  });

  it('blocks weak cross-theater political effects without strong actor continuity', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        {
          situationId: 'sit-politics-eu',
          label: 'Germany political situation',
          dominantDomain: 'political',
          familyId: 'fam-politics',
          familyLabel: 'Cross-regional political instability family',
          regions: ['Germany'],
          actorIds: ['actor-germany'],
          effectChannels: [{ type: 'political_pressure', count: 3 }],
          posture: 'contested',
          postureScore: 0.54,
          totalPressure: 0.62,
          totalStabilization: 0.39,
        },
        {
          situationId: 'sit-conflict-me',
          label: 'Israel conflict and political situation',
          dominantDomain: 'conflict',
          familyId: 'fam-conflict',
          familyLabel: 'Cross-regional war theater family',
          regions: ['Israel'],
          actorIds: ['actor-israel'],
          effectChannels: [],
          posture: 'escalatory',
          postureScore: 0.91,
          totalPressure: 0.95,
          totalStabilization: 0.18,
        },
      ],
      reportableInteractionLedger: [
        {
          sourceSituationId: 'sit-politics-eu',
          targetSituationId: 'sit-conflict-me',
          sourceLabel: 'Germany political situation',
          targetLabel: 'Israel conflict and political situation',
          strongestChannel: 'political_pressure',
          interactionType: 'spillover',
          stage: 'round_1',
          score: 4.9,
          confidence: 0.73,
          actorSpecificity: 0.78,
          directLinkCount: 1,
          sharedActor: true,
          regionLink: false,
          sourceActorName: 'Coalition bloc',
          targetActorName: 'Cabinet office',
        },
      ],
    });

    assert.equal(effects.length, 0);
  });

  it('keeps structural situation-level actor overlap in political reportable filtering', () => {
    const source = {
      situationId: 'sit-politics-a',
      label: 'Germany political situation',
      dominantDomain: 'political',
      regions: ['Germany'],
      actorIds: ['shared-actor', 'actor-germany'],
    };
    const target = {
      situationId: 'sit-politics-b',
      label: 'Israel political situation',
      dominantDomain: 'political',
      regions: ['Israel'],
      actorIds: ['shared-actor', 'actor-israel'],
    };

    const reportable = buildReportableInteractionLedger([
      {
        sourceSituationId: source.situationId,
        targetSituationId: target.situationId,
        sourceLabel: source.label,
        targetLabel: target.label,
        strongestChannel: 'political_pressure',
        interactionType: 'spillover',
        score: 5.5,
        confidence: 0.72,
        actorSpecificity: 0.84,
        sharedActor: false,
        regionLink: false,
      },
    ], [source, target]);

    assert.equal(reportable.length, 1);
  });

  it('blocks cross-theater political reportable interactions without market or regional support', () => {
    const source = {
      situationId: 'sit-politics-a',
      label: 'India political situation',
      dominantDomain: 'political',
      regions: ['India'],
      actorIds: ['shared-actor', 'actor-india'],
      marketContext: {
        confirmationScore: 0.34,
        linkedBucketIds: ['sovereign_risk'],
      },
    };
    const target = {
      situationId: 'sit-politics-b',
      label: 'Israel conflict and political situation',
      dominantDomain: 'conflict',
      regions: ['Israel'],
      actorIds: ['shared-actor', 'actor-israel'],
      marketContext: {
        confirmationScore: 0.31,
        linkedBucketIds: ['energy'],
      },
    };

    const reportable = buildReportableInteractionLedger([
      {
        sourceSituationId: source.situationId,
        targetSituationId: target.situationId,
        sourceLabel: source.label,
        targetLabel: target.label,
        strongestChannel: 'political_pressure',
        interactionType: 'spillover',
        score: 5.8,
        confidence: 0.75,
        actorSpecificity: 0.91,
        sharedActor: false,
        regionLink: false,
      },
    ], [source, target]);

    assert.equal(reportable.length, 0);
  });

  it('blocks cross-theater political effects even with shared-actor when actorSpec below 0.90', () => {
    // US (AMERICAS) → Japan (EAST_ASIA) via political_pressure with actorSpec 0.87 is cross-theater.
    // The gate requires actorSpec >= 0.90 for non-exempt channels across theater boundaries.
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        {
          situationId: 'sit-cyber',
          label: 'United States cyber and political situation',
          dominantDomain: 'cyber',
          familyId: 'fam-cyber',
          familyLabel: 'United States cyber pressure family',
          regions: ['United States'],
          actorIds: ['shared-actor', 'actor-us'],
          effectChannels: [{ type: 'political_pressure', count: 3 }],
          posture: 'contested',
          postureScore: 0.58,
          totalPressure: 0.67,
          totalStabilization: 0.29,
        },
        {
          situationId: 'sit-market',
          label: 'Japan market situation',
          dominantDomain: 'market',
          familyId: 'fam-market',
          familyLabel: 'Japan market repricing family',
          regions: ['Japan'],
          actorIds: ['shared-actor', 'actor-japan'],
          effectChannels: [],
          posture: 'contested',
          postureScore: 0.43,
          totalPressure: 0.48,
          totalStabilization: 0.31,
        },
      ],
      reportableInteractionLedger: [
        {
          sourceSituationId: 'sit-cyber',
          targetSituationId: 'sit-market',
          sourceLabel: 'United States cyber and political situation',
          targetLabel: 'Japan market situation',
          strongestChannel: 'political_pressure',
          interactionType: 'actor_carryover',
          stage: 'round_1',
          score: 5.6,
          confidence: 0.76,
          actorSpecificity: 0.87,
          directLinkCount: 1,
          sharedActor: false,
          regionLink: false,
          sourceActorName: 'Shared policy actor',
          targetActorName: 'Shared policy actor',
        },
        {
          sourceSituationId: 'sit-cyber',
          targetSituationId: 'sit-market',
          sourceLabel: 'United States cyber and political situation',
          targetLabel: 'Japan market situation',
          strongestChannel: 'political_pressure',
          interactionType: 'actor_carryover',
          stage: 'round_2',
          score: 5.5,
          confidence: 0.75,
          actorSpecificity: 0.87,
          directLinkCount: 1,
          sharedActor: false,
          regionLink: false,
          sourceActorName: 'Shared policy actor',
          targetActorName: 'Shared policy actor',
        },
      ],
    });

    assert.equal(effects.length, 0, 'US → Japan cross-theater political_pressure at actorSpec 0.87 should be blocked');
  });

  it('allows logistics effects with strong confidence while filtering weaker political ones', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        {
          situationId: 'sit-baltic',
          label: 'Baltic Sea supply chain situation',
          dominantDomain: 'supply_chain',
          familyId: 'fam-supply',
          familyLabel: 'Baltic maritime supply pressure family',
          regions: ['Baltic Sea', 'Black Sea'],
          actorIds: ['actor-shipping'],
          effectChannels: [{ type: 'logistics_disruption', count: 3 }],
          posture: 'contested',
          postureScore: 0.47,
          totalPressure: 0.58,
          totalStabilization: 0.33,
        },
        {
          situationId: 'sit-blacksea-market',
          label: 'Black Sea market situation',
          dominantDomain: 'market',
          familyId: 'fam-market',
          familyLabel: 'Black Sea market repricing family',
          regions: ['Black Sea'],
          actorIds: ['actor-market'],
          effectChannels: [],
          posture: 'contested',
          postureScore: 0.42,
          totalPressure: 0.45,
          totalStabilization: 0.32,
        },
        {
          situationId: 'sit-brazil-politics',
          label: 'Brazil political situation',
          dominantDomain: 'political',
          familyId: 'fam-politics-a',
          familyLabel: 'Cross-regional political instability family',
          regions: ['Brazil'],
          actorIds: ['actor-brazil'],
          effectChannels: [{ type: 'political_pressure', count: 3 }],
          posture: 'contested',
          postureScore: 0.55,
          totalPressure: 0.61,
          totalStabilization: 0.35,
        },
        {
          situationId: 'sit-uk-politics',
          label: 'United Kingdom political situation',
          dominantDomain: 'political',
          familyId: 'fam-politics-b',
          familyLabel: 'Cross-regional political instability family',
          regions: ['United Kingdom'],
          actorIds: ['actor-uk'],
          effectChannels: [],
          posture: 'contested',
          postureScore: 0.48,
          totalPressure: 0.5,
          totalStabilization: 0.33,
        },
      ],
      reportableInteractionLedger: [
        {
          sourceSituationId: 'sit-baltic',
          targetSituationId: 'sit-blacksea-market',
          sourceLabel: 'Baltic Sea supply chain situation',
          targetLabel: 'Black Sea market situation',
          strongestChannel: 'logistics_disruption',
          interactionType: 'regional_spillover',
          stage: 'round_1',
          score: 2.5,
          confidence: 0.76,
          actorSpecificity: 0.84,
          directLinkCount: 2,
          sharedActor: false,
          regionLink: true,
          sourceActorName: 'Shipping operator',
          targetActorName: 'Commodity desk',
        },
        {
          sourceSituationId: 'sit-baltic',
          targetSituationId: 'sit-blacksea-market',
          sourceLabel: 'Baltic Sea supply chain situation',
          targetLabel: 'Black Sea market situation',
          strongestChannel: 'logistics_disruption',
          interactionType: 'regional_spillover',
          stage: 'round_2',
          score: 2.4,
          confidence: 0.78,
          actorSpecificity: 0.84,
          directLinkCount: 2,
          sharedActor: false,
          regionLink: true,
          sourceActorName: 'Shipping operator',
          targetActorName: 'Commodity desk',
        },
        {
          sourceSituationId: 'sit-brazil-politics',
          targetSituationId: 'sit-uk-politics',
          sourceLabel: 'Brazil political situation',
          targetLabel: 'United Kingdom political situation',
          strongestChannel: 'political_pressure',
          interactionType: 'spillover',
          stage: 'round_1',
          score: 5.2,
          confidence: 0.75,
          actorSpecificity: 0.79,
          directLinkCount: 1,
          sharedActor: true,
          regionLink: false,
          sourceActorName: 'Coalition bloc',
          targetActorName: 'Policy team',
        },
        {
          sourceSituationId: 'sit-brazil-politics',
          targetSituationId: 'sit-uk-politics',
          sourceLabel: 'Brazil political situation',
          targetLabel: 'United Kingdom political situation',
          strongestChannel: 'political_pressure',
          interactionType: 'spillover',
          stage: 'round_2',
          score: 5.1,
          confidence: 0.74,
          actorSpecificity: 0.79,
          directLinkCount: 1,
          sharedActor: true,
          regionLink: false,
          sourceActorName: 'Coalition bloc',
          targetActorName: 'Policy team',
        },
      ],
    });

    assert.equal(effects.length, 1);
    assert.equal(effects[0].channel, 'logistics_disruption');
    assert.ok(effects[0].confidence >= 0.5);
  });

  it('ignores incompatible prior simulation momentum when the simulation version changes', () => {
    const conflict = makePrediction('conflict', 'Israel', 'Active armed conflict: Israel', 0.76, 0.66, '7d', [
      { type: 'ucdp', value: 'Israeli theater remains active', weight: 0.4 },
    ]);
    buildForecastCase(conflict);

    const priorWorldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T08:00:00Z'),
      predictions: [conflict],
    });
    priorWorldState.simulationState = {
      ...priorWorldState.simulationState,
      version: 1,
      situationSimulations: (priorWorldState.simulationState?.situationSimulations || []).map((item) => ({
        ...item,
        postureScore: 0.99,
        rounds: (item.rounds || []).map((round) => ({
          ...round,
          pressureDelta: 0.99,
          stabilizationDelta: 0,
        })),
      })),
    };

    const worldState = buildForecastRunWorldState({
      generatedAt: Date.parse('2026-03-19T09:00:00Z'),
      predictions: [conflict],
      priorWorldState,
      priorWorldStates: [priorWorldState],
    });

    assert.equal(worldState.simulationState.version, 4);
    assert.ok((worldState.simulationState.situationSimulations || []).every((item) => item.postureScore < 0.99));
  });

  it('promotes same-macro repeated security spillover into the reportable layer', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        {
          situationId: 'sit-brazil',
          label: 'Brazil conflict situation',
          dominantDomain: 'conflict',
          familyId: 'fam-americas-war',
          familyLabel: 'Americas war theater family',
          regions: ['Brazil'],
          actorIds: ['actor-brazil', 'actor-shared'],
          effectChannels: [{ type: 'security_escalation', count: 3 }],
          posture: 'escalatory',
          postureScore: 0.88,
          totalPressure: 0.92,
          totalStabilization: 0.18,
        },
        {
          situationId: 'sit-mexico',
          label: 'Mexico conflict situation',
          dominantDomain: 'conflict',
          familyId: 'fam-americas-war',
          familyLabel: 'Americas war theater family',
          regions: ['Mexico'],
          actorIds: ['actor-mexico', 'actor-shared'],
          effectChannels: [],
          posture: 'contested',
          postureScore: 0.46,
          totalPressure: 0.57,
          totalStabilization: 0.31,
        },
      ],
      reportableInteractionLedger: [
        {
          sourceSituationId: 'sit-brazil',
          targetSituationId: 'sit-mexico',
          sourceLabel: 'Brazil conflict situation',
          targetLabel: 'Mexico conflict situation',
          strongestChannel: 'security_escalation',
          interactionType: 'actor_carryover',
          stage: 'round_1',
          score: 4.3,
          confidence: 0.67,
          actorSpecificity: 0.91,
          directLinkCount: 1,
          sharedActor: true,
          regionLink: false,
          sourceActorName: 'Named brigade command',
          targetActorName: 'Named brigade command',
        },
        {
          sourceSituationId: 'sit-brazil',
          targetSituationId: 'sit-mexico',
          sourceLabel: 'Brazil conflict situation',
          targetLabel: 'Mexico conflict situation',
          strongestChannel: 'security_escalation',
          interactionType: 'actor_carryover',
          stage: 'round_2',
          score: 4.3,
          confidence: 0.68,
          actorSpecificity: 0.91,
          directLinkCount: 1,
          sharedActor: true,
          regionLink: false,
          sourceActorName: 'Named brigade command',
          targetActorName: 'Named brigade command',
        },
      ],
    });

    assert.equal(effects.length, 1);
    assert.equal(effects[0].effectClass, 'security_spillover');
    assert.equal(effects[0].channel, 'security_escalation');
  });

  it('records blocked effect telemetry on the world state', () => {
    const worldState = buildForecastRunWorldState({
      predictions: [
        makePrediction('political', 'Israel', 'Political instability: Israel', 0.61, 0.5, '30d', []),
        makePrediction('political', 'Taiwan', 'Political instability: Taiwan', 0.53, 0.45, '30d', []),
      ],
      situationClusters: [
        {
          id: 'sit-israel',
          label: 'Israel political situation',
          forecastIds: ['fc-political-a'],
          domains: ['political'],
          regions: ['Israel'],
          actors: ['Incumbent leadership'],
          topSignals: [{ type: 'unrest', count: 2 }],
          forecastCount: 1,
          avgProbability: 0.61,
          avgConfidence: 0.5,
          dominantDomain: 'political',
          dominantRegion: 'Israel',
          branchKinds: ['base'],
          sampleTitles: ['Political instability: Israel'],
        },
        {
          id: 'sit-taiwan',
          label: 'Taiwan political situation',
          forecastIds: ['fc-political-b'],
          domains: ['political'],
          regions: ['Taiwan'],
          actors: ['Incumbent leadership'],
          topSignals: [{ type: 'unrest', count: 2 }],
          forecastCount: 1,
          avgProbability: 0.53,
          avgConfidence: 0.45,
          dominantDomain: 'political',
          dominantRegion: 'Taiwan',
          branchKinds: ['base'],
          sampleTitles: ['Political instability: Taiwan'],
        },
      ],
      situationFamilies: [
        {
          id: 'fam-israel',
          label: 'Israel political instability family',
          archetype: 'political_instability',
          situationIds: ['sit-israel'],
          dominantDomain: 'political',
          dominantRegion: 'Israel',
          forecastCount: 1,
          situationCount: 1,
        },
        {
          id: 'fam-taiwan',
          label: 'Taiwan political instability family',
          archetype: 'political_instability',
          situationIds: ['sit-taiwan'],
          dominantDomain: 'political',
          dominantRegion: 'Taiwan',
          forecastCount: 1,
          situationCount: 1,
        },
      ],
    });

    assert.ok(typeof worldState.simulationState.blockedEffectSummary.totalBlocked === 'number');
    assert.ok(Array.isArray(worldState.report.blockedEffectWatchlist));
  });
});

describe('cross-theater gate', () => {
  it('identifies cross-theater pairs correctly', () => {
    assert.equal(isCrossTheaterPair(['Israel'], ['Taiwan']), true);
    assert.equal(isCrossTheaterPair(['Israel'], ['Iran']), false);
    assert.equal(isCrossTheaterPair(['Brazil'], ['Mexico']), false);
    assert.equal(isCrossTheaterPair(['Cuba'], ['Iran']), true);
    assert.equal(isCrossTheaterPair(['China'], ['United States']), true);
    assert.equal(isCrossTheaterPair(['Baltic Sea'], ['Black Sea']), false);
    assert.equal(isCrossTheaterPair(['Israel'], ['unknown-region']), false);
    assert.equal(isCrossTheaterPair(['unknown-a'], ['unknown-b']), false);
  });

  it('maps regions to macro-regions', () => {
    assert.equal(getMacroRegion(['Israel', 'Gaza']), 'MENA');
    assert.equal(getMacroRegion(['Taiwan', 'Western Pacific']), 'EAST_ASIA');
    assert.equal(getMacroRegion(['Brazil']), 'AMERICAS');
    assert.equal(getMacroRegion(['Baltic Sea', 'Black Sea']), 'EUROPE');
    assert.equal(getMacroRegion(['unknown-region']), null);
    assert.equal(getMacroRegion([]), null);
  });

  function makeSimulation(situationId, label, domain, regions, posture, postureScore, effectChannels = []) {
    return {
      situationId,
      label,
      dominantDomain: domain,
      familyId: `fam-${situationId}`,
      familyLabel: `${label} family`,
      regions,
      actorIds: [`actor-${situationId}`],
      effectChannels,
      posture,
      postureScore,
      totalPressure: posture === 'escalatory' ? 0.88 : 0.55,
      totalStabilization: posture === 'escalatory' ? 0.22 : 0.38,
    };
  }

  function makeInteraction(srcId, srcLabel, tgtId, tgtLabel, channel, stage, score, conf, spec, sharedActor, regionLink) {
    return {
      sourceSituationId: srcId,
      targetSituationId: tgtId,
      sourceLabel: srcLabel,
      targetLabel: tgtLabel,
      strongestChannel: channel,
      interactionType: sharedActor ? 'actor_carryover' : 'spillover',
      stage,
      score,
      confidence: conf,
      actorSpecificity: spec,
      directLinkCount: (sharedActor ? 1 : 0) + (regionLink ? 1 : 0) + 1,
      sharedActor,
      regionLink,
      sourceActorName: 'Test actor',
      targetActorName: 'Test actor',
    };
  }

  it('blocks Israel → Taiwan via generic Incumbent Leadership (regional_spillover, spec 0.68)', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        makeSimulation('sit-israel', 'Israel conflict situation', 'conflict', ['Israel'], 'escalatory', 0.88,
          [{ type: 'regional_spillover', count: 3 }]),
        makeSimulation('sit-taiwan', 'Taiwan political situation', 'political', ['Taiwan'], 'contested', 0.54),
      ],
      reportableInteractionLedger: [
        makeInteraction('sit-israel', 'Israel conflict situation', 'sit-taiwan', 'Taiwan political situation',
          'regional_spillover', 'round_1', 5.2, 0.77, 0.68, true, false),
        makeInteraction('sit-israel', 'Israel conflict situation', 'sit-taiwan', 'Taiwan political situation',
          'regional_spillover', 'round_2', 5.1, 0.77, 0.68, true, false),
      ],
    });
    assert.equal(effects.length, 0, 'Israel → Taiwan via generic actor should be blocked by cross-theater gate');
  });

  it('allows China → US via Threat Actors (cyber_disruption, exempt channel)', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        makeSimulation('sit-china', 'China cyber situation', 'cyber', ['China'], 'escalatory', 0.88,
          [{ type: 'cyber_disruption', count: 3 }]),
        // target must be infrastructure for cyber_disruption:infrastructure relation to exist
        makeSimulation('sit-us', 'United States infrastructure situation', 'infrastructure', ['United States'], 'contested', 0.62),
      ],
      reportableInteractionLedger: [
        makeInteraction('sit-china', 'China cyber situation', 'sit-us', 'United States infrastructure situation',
          'cyber_disruption', 'round_1', 6.5, 0.91, 0.95, true, false),
        makeInteraction('sit-china', 'China cyber situation', 'sit-us', 'United States infrastructure situation',
          'cyber_disruption', 'round_2', 6.3, 0.90, 0.95, true, false),
      ],
    });
    assert.equal(effects.length, 1, 'China (EAST_ASIA) → US (AMERICAS) via cyber_disruption should pass (exempt channel)');
    assert.equal(effects[0].channel, 'cyber_disruption');
  });

  it('blocks Brazil → Israel conflict via External Power Broker (security_escalation, spec 0.85 < 0.90)', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        makeSimulation('sit-brazil', 'Brazil conflict situation', 'conflict', ['Brazil'], 'escalatory', 0.84,
          [{ type: 'security_escalation', count: 3 }]),
        makeSimulation('sit-israel', 'Israel conflict situation', 'conflict', ['Israel'], 'escalatory', 0.88),
      ],
      reportableInteractionLedger: [
        makeInteraction('sit-brazil', 'Brazil conflict situation', 'sit-israel', 'Israel conflict situation',
          'security_escalation', 'round_1', 5.8, 0.87, 0.85, true, false),
        makeInteraction('sit-brazil', 'Brazil conflict situation', 'sit-israel', 'Israel conflict situation',
          'security_escalation', 'round_2', 5.7, 0.86, 0.85, true, false),
      ],
    });
    assert.equal(effects.length, 0, 'Brazil → Israel via generic external actor should be blocked (actorSpec 0.85 < 0.90)');
  });

  it('allows Brazil → Mexico (same macro-region, security_escalation → infrastructure)', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        makeSimulation('sit-brazil', 'Brazil conflict situation', 'conflict', ['Brazil'], 'escalatory', 0.84,
          [{ type: 'security_escalation', count: 3 }]),
        // target must be infrastructure for security_escalation:infrastructure relation to exist
        makeSimulation('sit-mexico', 'Mexico infrastructure situation', 'infrastructure', ['Mexico'], 'escalatory', 0.72),
      ],
      reportableInteractionLedger: [
        makeInteraction('sit-brazil', 'Brazil conflict situation', 'sit-mexico', 'Mexico infrastructure situation',
          'security_escalation', 'round_1', 5.8, 0.87, 0.85, true, false),
        makeInteraction('sit-brazil', 'Brazil conflict situation', 'sit-mexico', 'Mexico infrastructure situation',
          'security_escalation', 'round_2', 5.7, 0.86, 0.85, true, false),
      ],
    });
    assert.equal(effects.length, 1, 'Brazil → Mexico should pass (both AMERICAS, cross-theater gate does not apply)');
    assert.equal(effects[0].channel, 'security_escalation');
  });

  it('blocks Cuba → Iran infrastructure (cross-theater, service_disruption, spec 0.73 < 0.90)', () => {
    const effects = buildCrossSituationEffects({
      situationSimulations: [
        makeSimulation('sit-cuba', 'Cuba infrastructure situation', 'infrastructure', ['Cuba'], 'contested', 0.62,
          [{ type: 'service_disruption', count: 3 }]),
        makeSimulation('sit-iran', 'Iran infrastructure situation', 'infrastructure', ['Iran'], 'contested', 0.58),
      ],
      reportableInteractionLedger: [
        makeInteraction('sit-cuba', 'Cuba infrastructure situation', 'sit-iran', 'Iran infrastructure situation',
          'service_disruption', 'round_1', 5.5, 0.84, 0.73, true, false),
        makeInteraction('sit-cuba', 'Cuba infrastructure situation', 'sit-iran', 'Iran infrastructure situation',
          'service_disruption', 'round_2', 5.4, 0.83, 0.73, true, false),
      ],
    });
    assert.equal(effects.length, 0, 'Cuba → Iran via generic civil-protection actor should be blocked');
  });
});

describe('military domain guarantee in publish selection', () => {
  function makeMinimalPred(id, domain, prob, confidence = 0.5) {
    const pred = makePrediction(domain, 'Test Region', `Test ${domain} forecast ${id}`, prob, confidence, '30d', []);
    pred.id = id;
    return pred;
  }

  it('injects military forecast when buried below high-scoring non-military forecasts', () => {
    // 14 well-scored conflict forecasts would fill the pool, leaving military out
    const nonMilitary = Array.from({ length: 14 }, (_, i) =>
      makeMinimalPred(`conflict-${i}`, 'conflict', 0.7 + (i * 0.001), 0.75),
    );
    const military = makeMinimalPred('mil-baltic', 'military', 0.41, 0.30);
    const pool = selectPublishedForecastPool([...nonMilitary, military]);
    const hasMilitary = pool.some((p) => p.domain === 'military');
    assert.equal(hasMilitary, true, 'military forecast should be included via domain guarantee');
  });

  it('does not inject military when none are eligible (prob = 0)', () => {
    const nonMilitary = Array.from({ length: 5 }, (_, i) =>
      makeMinimalPred(`conflict-${i}`, 'conflict', 0.6, 0.6),
    );
    const pool = selectPublishedForecastPool(nonMilitary);
    const hasMilitary = pool.some((p) => p.domain === 'military');
    assert.equal(hasMilitary, false, 'no military forecast should appear when none were input');
  });

  it('does not double-inject military when it already ranks into selection naturally', () => {
    const forecasts = [
      makeMinimalPred('mil-1', 'military', 0.80, 0.75),
      makeMinimalPred('conflict-1', 'conflict', 0.60, 0.60),
      makeMinimalPred('conflict-2', 'conflict', 0.55, 0.55),
    ];
    const pool = selectPublishedForecastPool(forecasts);
    const militaryCount = pool.filter((p) => p.domain === 'military').length;
    assert.equal(militaryCount, 1, 'only one military forecast should appear, no duplication');

  });
});
