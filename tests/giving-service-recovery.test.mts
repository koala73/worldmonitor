import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const TEST_STATE_KEY = '__wmGivingRecoveryTestState';

interface GivingRecoveryTestState {
  calls: number;
  hydrated?: unknown;
  hydrationSource: 'live' | 'cached' | 'mixed' | 'none';
  responses: unknown[];
}

declare global {
  // eslint-disable-next-line no-var
  var __wmGivingRecoveryTestState: GivingRecoveryTestState | undefined;
}

function v2Response(estimatedDailyFlowUsd: number, materializedAt: number): unknown {
  return {
    dataAvailable: true,
    fetchedAt: materializedAt,
    summary: {
      generatedAt: new Date(materializedAt).toISOString(),
      activityIndex: 0,
      trend: 'stable',
      estimatedDailyFlowUsd,
      platforms: [{
        platform: 'GoFundMe',
        dailyVolumeUsd: estimatedDailyFlowUsd,
        activeCampaignsSampled: 0,
        newCampaigns24h: 0,
        donationVelocity: 0,
        dataFreshness: 'annual',
        lastUpdated: '',
      }],
      categories: [],
      crypto: {
        dailyInflowUsd: 0,
        trackedWallets: 0,
        transactions24h: 0,
        topReceivers: [],
        pctOfTotal: 0,
      },
      institutional: {
        oecdOdaAnnualUsdBn: 0,
        oecdDataYear: 0,
        cafWorldGivingIndex: 0,
        cafDataYear: 0,
        candidGrantsTracked: 0,
        dataLag: '',
      },
      dataMode: 'partial_estimate',
      trendAvailable: false,
      provenance: [{
        subject: 'GoFundMe weekly giving',
        sourceName: 'GoFundMe',
        sourceUrl: 'https://www.gofundme.com/',
        referencePeriod: 'Average week across 2023-2024',
        sourcePublishedAt: '',
        measurementBasis: 'Published lower-bound weekly platform claim',
        status: 'verified',
        coveredMetricPaths: ['summary.estimated_daily_flow_usd'],
        includedInHighlightedAggregate: true,
        reportedValue: estimatedDailyFlowUsd,
        reportedUnit: 'USD',
        notes: 'Published estimate used by the recovery test.',
        valueQualifier: 'reported',
        sourceLocator: 'Giving-volume claim',
        accessedAt: '2026-07-24',
        denominator: 'day',
        derivation: 'No additional derivation in test fixture.',
      }],
      activityIndexAvailable: false,
    },
  };
}

async function loadGivingService(): Promise<{
  fetchGivingSummary(): Promise<{
    state: string;
    refreshFailure?: string;
    data: { estimatedDailyFlowUsd: number; refreshFailure: string | null };
  }>;
}> {
  const entryPath = resolve(root, 'src/services/giving/index.ts');
  const circuitBreakerPath = resolve(root, 'src/utils/circuit-breaker.ts');
  const stubModules = new Map([
    ['rpc-client-stub', `
      export function getRpcBaseUrl() { return 'https://example.test'; }
    `],
    ['bootstrap-stub', `
      export function getHydratedData() {
        const state = globalThis.${TEST_STATE_KEY};
        const hydrated = state.hydrated;
        state.hydrated = undefined;
        return hydrated;
      }
      export function getBootstrapHydrationState() {
        const source = globalThis.${TEST_STATE_KEY}.hydrationSource;
        return {
          source,
          tiers: {
            fast: { source: 'none', updatedAt: null },
            slow: { source, updatedAt: null },
          },
        };
      }
    `],
    ['generated-rpc-clients-stub', `
      export class GivingServiceClient {
        async getGivingSummary() {
          const state = globalThis.${TEST_STATE_KEY};
          state.calls += 1;
          const response = state.responses.shift();
          if (response instanceof Error) throw response;
          return structuredClone(response);
        }
      }
    `],
    ['persistent-cache-stub', `
      export async function getPersistentCache() { return null; }
      export async function setPersistentCache() {}
      export async function deletePersistentCache() {}
      export async function deletePersistentCacheByPrefix() {}
    `],
  ]);
  const aliases = new Map([
    ['@/services/rpc-client', 'rpc-client-stub'],
    ['@/services/bootstrap', 'bootstrap-stub'],
    ['@/services/generated-rpc-clients', 'generated-rpc-clients-stub'],
    ['../services/persistent-cache', 'persistent-cache-stub'],
  ]);

  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
      name: 'giving-service-recovery-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === '@/utils') return { path: circuitBreakerPath };
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubModules.get(args.path),
          loader: 'ts',
        }));
      },
    }],
  });

  const bundleUrl =
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  return import(bundleUrl);
}

after(() => {
  delete globalThis.__wmGivingRecoveryTestState;
});

describe('Giving service refresh recovery', () => {
  it('retries a cached bootstrap failure inside the breaker TTL until live recovery succeeds', async () => {
    const now = Date.now();
    const cached = v2Response(100, now - 2_000);
    const recovered = v2Response(200, now - 1_000);
    globalThis.__wmGivingRecoveryTestState = {
      calls: 0,
      hydrationSource: 'none',
      responses: [cached, new Error('refresh unavailable'), recovered],
    };
    const service = await loadGivingService();

    const initial = await service.fetchGivingSummary();
    assert.equal(initial.state, 'available-but-partial');
    assert.equal(initial.data.estimatedDailyFlowUsd, 100);
    assert.equal(globalThis.__wmGivingRecoveryTestState.calls, 1);

    globalThis.__wmGivingRecoveryTestState.hydrated = cached;
    globalThis.__wmGivingRecoveryTestState.hydrationSource = 'cached';

    const failedRefresh = await service.fetchGivingSummary();

    assert.equal(globalThis.__wmGivingRecoveryTestState.calls, 2);
    assert.equal(failedRefresh.state, 'cached-refresh-unavailable');
    assert.equal(failedRefresh.refreshFailure, 'transport');
    assert.equal(failedRefresh.data.refreshFailure, 'transport');
    assert.equal(failedRefresh.data.estimatedDailyFlowUsd, 100);

    const refreshed = await service.fetchGivingSummary();

    assert.equal(globalThis.__wmGivingRecoveryTestState.calls, 3);
    assert.equal(refreshed.state, 'available-but-partial');
    assert.equal(refreshed.refreshFailure, undefined);
    assert.equal(refreshed.data.refreshFailure, null);
    assert.equal(refreshed.data.estimatedDailyFlowUsd, 200);
  });
});
