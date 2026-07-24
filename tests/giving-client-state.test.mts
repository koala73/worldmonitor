import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { GetGivingSummaryResponse } from '../src/generated/client/worldmonitor/giving/v1/service_client.ts';
import { __testing__ } from '../src/services/giving/model.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATERIALIZED_AT = Date.parse('2026-07-24T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function provenance(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'GoFundMe weekly giving',
    sourceName: 'GoFundMe',
    sourceUrl: 'https://www.gofundme.com/?lang=en',
    referencePeriod: 'Average week across 2023-2024',
    sourcePublishedAt: '',
    measurementBasis: 'Published lower-bound weekly platform claim',
    status: 'verified',
    coveredMetricPaths: [
      'summary.platforms[platform=GoFundMe].daily_volume_usd',
      'summary.estimated_daily_flow_usd',
    ],
    includedInHighlightedAggregate: true,
    reportedValue: 50_000_000,
    reportedUnit: 'USD',
    notes: 'More than USD 50 million is raised each week.',
    valueQualifier: 'more_than',
    sourceLocator: 'Homepage claim',
    accessedAt: '2026-07-24',
    denominator: 'week',
    derivation: '50,000,000 * 52',
    ...overrides,
  };
}

function v2Response(overrides: {
  dataMode?: string;
  provenance?: ReturnType<typeof provenance>[];
  fetchedAt?: number;
  generatedAt?: string;
} = {}): GetGivingSummaryResponse {
  return {
    dataAvailable: true,
    fetchedAt: overrides.fetchedAt ?? MATERIALIZED_AT,
    summary: {
      generatedAt: overrides.generatedAt ?? '2026-07-24T12:00:00.000Z',
      activityIndex: 0,
      trend: 'stable',
      estimatedDailyFlowUsd: 2_684_000_000 / 365,
      platforms: [{
        platform: 'GoFundMe',
        dailyVolumeUsd: 2_600_000_000 / 365,
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
        oecdOdaAnnualUsdBn: 223.7,
        oecdDataYear: 2023,
        cafWorldGivingIndex: 0,
        cafDataYear: 0,
        candidGrantsTracked: 3_000_000,
        dataLag: 'Annual published context',
      },
      dataMode: overrides.dataMode ?? 'partial_estimate',
      trendAvailable: false,
      provenance: overrides.provenance ?? [provenance()],
      activityIndexAvailable: false,
    },
  };
}

describe('Giving client v2 response classification', () => {
  it('preserves the original materialization timestamp and normalizes evidence state', () => {
    const classified = __testing__.classifyGivingResponse(v2Response(), MATERIALIZED_AT + 60_000);
    assert.equal(classified.kind, 'v2');
    assert.equal(classified.snapshot?.materializedAt, MATERIALIZED_AT);
    assert.equal(classified.snapshot?.data.generatedAt, '2026-07-24T12:00:00.000Z');
    assert.equal(classified.snapshot?.data.availability, 'available-but-partial');
    assert.equal(classified.snapshot?.data.provenance[0]?.status, 'verified');

    const unknownStatus = v2Response({
      dataMode: 'published_estimate',
      provenance: [provenance({ status: 'future_status' })],
    });
    const unknown = __testing__.classifyGivingResponse(unknownStatus, MATERIALIZED_AT + 60_000);
    assert.equal(unknown.kind, 'v2');
    assert.equal(unknown.snapshot?.data.availability, 'available-but-partial');
    assert.equal(unknown.snapshot?.data.provenance[0]?.status, 'unverified');
  });

  it('keeps unavailable and legacy payloads out of the v2 last-good cache', () => {
    assert.equal(__testing__.classifyGivingResponse({
      dataAvailable: false,
      fetchedAt: 0,
    }, MATERIALIZED_AT).kind, 'unavailable');

    const legacy = v2Response();
    if (legacy.summary) {
      legacy.summary.dataMode = '';
      legacy.summary.provenance = [];
    }
    assert.equal(__testing__.classifyGivingResponse(legacy, MATERIALIZED_AT).kind, 'legacy');
    assert.equal(__testing__.isCacheableGivingResponse(legacy), false);
    assert.equal(__testing__.GIVING_BREAKER_CACHE_KEY, 'v2');
  });

  it('preserves a valid v2 last-good snapshot for exactly 24 hours after refresh failures', () => {
    const accepted = __testing__.classifyGivingResponse(v2Response(), MATERIALIZED_AT);
    assert.equal(accepted.kind, 'v2');
    assert.ok(accepted.snapshot);

    for (const failure of ['transport', 'unavailable', 'legacy'] as const) {
      const resolved = __testing__.resolveGivingRefresh(
        null,
        accepted.snapshot,
        MATERIALIZED_AT + DAY_MS,
        failure,
      );
      assert.equal(resolved.ok, true);
      assert.equal(resolved.state, 'cached-refresh-unavailable');
      assert.equal(resolved.refreshFailure, failure);
      assert.equal(resolved.cachedAt, '2026-07-24T12:00:00.000Z');
      assert.equal(resolved.data.generatedAt, '2026-07-24T12:00:00.000Z');
    }

    const expired = __testing__.resolveGivingRefresh(
      null,
      accepted.snapshot,
      MATERIALIZED_AT + DAY_MS + 1,
      'transport',
    );
    assert.equal(expired.ok, false);
    assert.equal(expired.state, 'unavailable');
    assert.equal(expired.cachedAt, undefined);
    assert.equal(expired.data.generatedAt, '');
  });

  it('never promotes an unavailable or legacy-only refresh without a v2 last-good snapshot', () => {
    for (const failure of ['transport', 'unavailable', 'legacy'] as const) {
      const resolved = __testing__.resolveGivingRefresh(null, null, MATERIALIZED_AT, failure);
      assert.equal(resolved.ok, false);
      assert.equal(resolved.state, 'unavailable');
      assert.equal(resolved.data.generatedAt, '');
      assert.deepEqual(resolved.data.platforms, []);
    }
  });

  it('wires strict v2 validation into a versioned breaker cache path', () => {
    const source = readFileSync(resolve(root, 'src/services/giving/index.ts'), 'utf8');
    const loader = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');
    assert.match(source, /cacheKey:\s*GIVING_BREAKER_CACHE_KEY/);
    assert.match(source, /shouldCache:\s*isCacheableGivingResponse/);
    assert.doesNotMatch(source, /cachedAt\s*=\s*Date\.now\(\)/);
    assert.doesNotMatch(source, /generatedAt:\s*new Date\(\)\.toISOString\(\)/);
    assert.match(loader, /givingResult\.state === 'cached-refresh-unavailable'[\s\S]*recordError\('giving'/);
  });
});
