import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getGivingSummary } from '../server/worldmonitor/giving/v1/get-giving-summary.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function protoMessage(source: string, name: string): string {
  const match = source.match(new RegExp(`message\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing proto message ${name}`);
  return match[1];
}

function assertFieldNumbers(body: string, expected: Record<string, number>): void {
  for (const [field, number] of Object.entries(expected)) {
    assert.match(body, new RegExp(`\\b${field}\\s*=\\s*${number}\\s*[;\\[]`), `${field} must remain field ${number}`);
  }
}

describe('Giving published-estimate contract', () => {
  it('keeps existing field numbers and adds the exact provenance contract', () => {
    const source = readFileSync(resolve(root, 'proto/worldmonitor/giving/v1/giving.proto'), 'utf8');
    const summary = protoMessage(source, 'GivingSummary');
    const provenance = protoMessage(source, 'GivingProvenance');

    assertFieldNumbers(summary, {
      generated_at: 1,
      activity_index: 2,
      trend: 3,
      estimated_daily_flow_usd: 4,
      platforms: 5,
      categories: 6,
      crypto: 7,
      institutional: 8,
      data_mode: 9,
      trend_available: 10,
      provenance: 11,
      activity_index_available: 12,
    });
    assertFieldNumbers(provenance, {
      subject: 1,
      source_name: 2,
      source_url: 3,
      reference_period: 4,
      source_published_at: 5,
      measurement_basis: 6,
      status: 7,
      covered_metric_paths: 8,
      included_in_highlighted_aggregate: 9,
      reported_value: 10,
      reported_unit: 11,
      notes: 12,
      value_qualifier: 13,
      source_locator: 14,
      accessed_at: 15,
      denominator: 16,
      derivation: 17,
    });
    assert.match(
      source,
      /Stable proto response field paths[\s\S]*proto snake_case spelling/,
      'covered_metric_paths docs must describe the proto snake_case namespace',
    );
    assert.doesNotMatch(source, /JSON-style response metric paths/);
    assert.doesNotMatch(source, /\bsource_observed_at\b/);
  });

  it('serves a partial v2 snapshot with truthful lower-bound platform flow', async () => {
    const response = await getGivingSummary({} as never, {
      platformLimit: 2,
      categoryLimit: 2,
    });

    assert.equal(response.dataAvailable, true);
    assert.ok(response.summary);
    assert.equal(response.summary.dataMode, 'partial_estimate');
    assert.equal(response.summary.activityIndex, 0);
    assert.equal(response.summary.activityIndexAvailable, false);
    assert.equal(response.summary.trend, 'stable');
    assert.equal(response.summary.trendAvailable, false);
    assert.equal(response.fetchedAt, Date.parse(response.summary.generatedAt));

    const goFundMe = response.summary.platforms.find((item) => item.platform === 'GoFundMe');
    const globalGiving = response.summary.platforms.find((item) => item.platform === 'GlobalGiving');
    assert.ok(goFundMe);
    assert.ok(globalGiving);
    assert.equal(goFundMe.dailyVolumeUsd, 2_600_000_000 / 365);
    assert.equal(globalGiving.dailyVolumeUsd, 84_000_000 / 365);
    assert.equal(goFundMe.lastUpdated, '');
    assert.equal(globalGiving.lastUpdated, '');
    assert.equal(response.summary.estimatedDailyFlowUsd, 2_684_000_000 / 365);

    assert.equal(response.summary.platforms.length, 2);
    assert.equal(response.summary.categories.length, 2);
    assert.ok(
      response.summary.provenance.some((entry) => entry.sourceName === 'JustGiving'),
      'limits project arrays but provenance still describes the full snapshot',
    );
  });

  it('records exact auditable claims and excludes cumulative or unverified inputs', async () => {
    const response = await getGivingSummary({} as never, { platformLimit: 0, categoryLimit: 0 });
    const summary = response.summary;
    assert.ok(summary);
    assert.ok(summary.provenance.length > 0);

    for (const entry of summary.provenance) {
      assert.ok(entry.subject.trim(), 'subject is required');
      assert.ok(entry.sourceName.trim(), `${entry.subject}: sourceName is required`);
      assert.match(entry.sourceUrl, /^https:\/\//, `${entry.subject}: sourceUrl must be HTTPS`);
      assert.ok(entry.referencePeriod.trim(), `${entry.subject}: referencePeriod is required`);
      assert.ok(entry.measurementBasis.trim(), `${entry.subject}: measurementBasis is required`);
      assert.ok(entry.coveredMetricPaths.length > 0, `${entry.subject}: coveredMetricPaths are required`);
      assert.ok(
        entry.coveredMetricPaths.every((path) => !/[a-z][A-Z]/.test(path.replace(/\[[^\]]+\]/g, ''))),
        `${entry.subject}: coveredMetricPaths must use stable proto snake_case names`,
      );
      assert.ok(entry.reportedUnit.trim(), `${entry.subject}: reportedUnit is required`);
      assert.ok(entry.notes.trim(), `${entry.subject}: notes are required`);
      assert.ok(entry.valueQualifier.trim(), `${entry.subject}: valueQualifier is required`);
      assert.ok(entry.sourceLocator.trim(), `${entry.subject}: sourceLocator is required`);
      assert.equal(entry.accessedAt, '2026-07-24');
      assert.ok(entry.denominator.trim(), `${entry.subject}: denominator is required`);
      assert.ok(entry.derivation.trim(), `${entry.subject}: derivation is required`);
      assert.ok(
        ['verified', 'partially_verified', 'unverified', 'not_collected', 'not_applicable'].includes(entry.status),
        `${entry.subject}: unknown status must be normalized to unverified`,
      );
    }

    const goFundMe = summary.provenance.find((entry) => entry.sourceName === 'GoFundMe');
    assert.ok(goFundMe);
    assert.equal(goFundMe.status, 'verified');
    assert.equal(goFundMe.reportedValue, 50_000_000);
    assert.equal(goFundMe.reportedUnit, 'USD');
    assert.equal(goFundMe.valueQualifier, 'more_than');
    assert.equal(goFundMe.denominator, 'week');
    assert.match(goFundMe.derivation, /50,?000,?000.*52.*2,?600,?000,?000/i);
    assert.equal(goFundMe.includedInHighlightedAggregate, true);

    const globalGiving = summary.provenance.find((entry) => entry.sourceName === 'GlobalGiving');
    assert.ok(globalGiving);
    assert.equal(globalGiving.status, 'verified');
    assert.equal(globalGiving.reportedValue, 84_000_000);
    assert.equal(globalGiving.denominator, 'year');
    assert.equal(globalGiving.includedInHighlightedAggregate, true);

    const justGiving = summary.provenance.find((entry) => entry.sourceName === 'JustGiving');
    assert.ok(justGiving);
    assert.equal(justGiving.status, 'verified');
    assert.equal(justGiving.reportedValue, 7_000_000_000);
    assert.equal(justGiving.reportedUnit, 'GBP');
    assert.match(justGiving.denominator, /25.*cumulative/i);
    assert.equal(justGiving.includedInHighlightedAggregate, false);
    assert.match(justGiving.derivation, /not annualized|no annualization/i);
    assert.equal(summary.platforms.find((item) => item.platform === 'JustGiving')?.dailyVolumeUsd, 0);

    assert.equal(summary.crypto?.dailyInflowUsd, 0);
    assert.equal(summary.crypto?.trackedWallets, 0);
    assert.equal(summary.crypto?.transactions24h, 0);
    assert.deepEqual(summary.crypto?.topReceivers, []);
    assert.equal(summary.crypto?.pctOfTotal, 0);
    assert.equal(summary.institutional?.oecdOdaAnnualUsdBn, 223.7);
    assert.equal(summary.institutional?.oecdDataYear, 2023);
    assert.equal(summary.institutional?.candidGrantsTracked, 3_000_000);
    assert.equal(summary.institutional?.cafWorldGivingIndex, 0);
    assert.equal(summary.institutional?.cafDataYear, 0);
    assert.ok(summary.categories.every((category) =>
      category.share === 0
      && category.change24h === 0
      && category.activeCampaigns === 0
      && category.trending === false));
  });

  it('uses one eligibility rule for platform and headline flow', async () => {
    const {
      PUBLISHED_ESTIMATE_CLAIMS,
      buildPublishedEstimateSummary,
      normalizeGivingStatus,
    } = await import('../server/worldmonitor/giving/v1/published-estimates.ts');

    assert.equal(normalizeGivingStatus('future_status'), 'unverified');

    const generatedAt = '2026-07-24T12:00:00.000Z';
    const complete = PUBLISHED_ESTIMATE_CLAIMS.map((claim) => (
      claim.status === 'unverified' || claim.status === 'partially_verified'
        ? { ...claim, status: 'verified' as const }
        : claim
    ));
    assert.equal(buildPublishedEstimateSummary(complete, generatedAt).dataMode, 'published_estimate');

    const withoutGoFundMe = PUBLISHED_ESTIMATE_CLAIMS.map((claim) => (
      claim.sourceName === 'GoFundMe'
        ? { ...claim, status: 'unverified' as const }
        : claim
    ));
    const summary = buildPublishedEstimateSummary(withoutGoFundMe, generatedAt);
    assert.equal(summary.platforms.find((item) => item.platform === 'GoFundMe')?.dailyVolumeUsd, 0);
    assert.equal(summary.estimatedDailyFlowUsd, 84_000_000 / 365);

    const implementation = [
      readFileSync(resolve(root, 'server/worldmonitor/giving/v1/get-giving-summary.ts'), 'utf8'),
      readFileSync(resolve(root, 'server/worldmonitor/giving/v1/published-estimates.ts'), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(implementation, /computeActivityIndex|computeTrend/);
  });
});
