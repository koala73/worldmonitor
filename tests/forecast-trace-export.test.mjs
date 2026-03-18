import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  makePrediction,
  buildForecastCase,
  populateFallbackNarratives,
  buildForecastTraceArtifacts,
  buildForecastRunWorldState,
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
      {
        generatedAt: Date.parse('2026-03-15T08:00:00Z'),
        predictions: [a, b],
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
    assert.ok(artifacts.summary.quality.fullRun.quietDomains.includes('military'));
    assert.equal(artifacts.summary.quality.traced.topPromotionSignals[0].type, 'cii');
    assert.ok(artifacts.summary.worldStateSummary.summary.includes('active forecasts'));
    assert.ok(artifacts.summary.worldStateSummary.reportSummary.includes('leading domains'));
    assert.ok(typeof artifacts.summary.worldStateSummary.reportContinuitySummary === 'string');
    assert.equal(artifacts.summary.worldStateSummary.domainCount, 2);
    assert.equal(artifacts.summary.worldStateSummary.regionCount, 2);
    assert.ok(typeof artifacts.summary.worldStateSummary.situationCount === 'number');
    assert.ok(artifacts.summary.worldStateSummary.situationCount >= 1);
    assert.ok(typeof artifacts.summary.worldStateSummary.historyRuns === 'number');
    assert.ok(Array.isArray(artifacts.worldState.actorRegistry));
    assert.ok(artifacts.worldState.actorRegistry.every(actor => actor.name && actor.id));
    assert.equal(artifacts.summary.worldStateSummary.persistentActorCount, 0);
    assert.ok(typeof artifacts.summary.worldStateSummary.newlyActiveActors === 'number');
    assert.equal(artifacts.summary.worldStateSummary.branchCount, 6);
    assert.equal(artifacts.summary.worldStateSummary.newBranches, 6);
    assert.equal(artifacts.summary.triggerContext.triggerRequest.requester, 'seed-military-flights');
    assert.ok(Array.isArray(artifacts.worldState.situationClusters));
    assert.ok(Array.isArray(artifacts.worldState.report.situationWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.actorWatchlist));
    assert.ok(Array.isArray(artifacts.worldState.report.branchWatchlist));
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
    assert.ok(worldState.report.summary.includes('leading domains'));
    assert.ok(worldState.report.continuitySummary.includes('Actors:'));
    assert.ok(worldState.report.regionalHotspots.length >= 1);
    assert.ok(worldState.report.branchWatchlist.length >= 1);
    assert.ok(Array.isArray(worldState.report.situationWatchlist));
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
    assert.ok(worldState.reportContinuity.repeatedStrengtheningCount >= 1);
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
});
