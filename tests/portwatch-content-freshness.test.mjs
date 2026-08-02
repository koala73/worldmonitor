// #6060 — PortWatch transport/cardinality success is not per-country content
// freshness.
//
// Production evidence (2026-08-02): the 12:03 UTC run reported status OK, 174
// countries seeded, 174/174 coverage complete and zero refreshFailures, while
// `supply_chain:portwatch-ports:v1:CN` still carried fetchedAt
// 2026-07-29T12:02:43.475Z — more than 98 hours old and therefore stale under
// the corridor adapter's 72-hour content budget. Fresh transport metadata plus
// complete country cardinality hid stale decision-critical country content.
//
// These tests pin the seed-meta half of the split: the run publishes an
// explicit per-country content-freshness report so a complete run can never
// read as undifferentiated healthy.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContentFreshnessReport,
  buildPortActivityMetaPayload,
  PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES,
  PORTWATCH_DECISION_CRITICAL_COUNTRIES,
  PORTWATCH_MAX_REPORTED_STALE_COUNTRIES,
} from '../scripts/seed-portwatch-port-activity.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// Frozen to the audit hour in #6060 so ages are exact rather than clock-seeded.
const NOW = Date.parse('2026-08-02T14:40:00.000Z');

function payload(iso2, fetchedAt) {
  return {
    iso2,
    ports: [{ portId: `${iso2}-port`, tankerCalls30d: 1 }],
    fetchedAt,
    asof: '2026-07-29',
    cacheWrittenAt: Date.parse(fetchedAt),
  };
}

function countryDataOf(entries) {
  return new Map(entries.map((entry) => [entry.iso2, entry]));
}

describe('buildContentFreshnessReport', () => {
  it('matches the corridor adapter 72-hour content budget', () => {
    assert.equal(PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES, 72 * 60);
  });

  it('declares exactly the countries the China corridor adapter consumes', () => {
    assert.deepEqual(PORTWATCH_DECISION_CRITICAL_COUNTRIES, ['CN', 'HK']);
  });

  it('reproduces the #6060 audit: complete cardinality with stale China content', () => {
    // The exact production observation: CN at 2026-07-29T12:02:43.475Z and HK
    // at 2026-07-31T00:03:02.206Z, inside an otherwise fresh 174-country run.
    const entries = [
      payload('CN', '2026-07-29T12:02:43.475Z'),
      payload('HK', '2026-07-31T00:03:02.206Z'),
      ...Array.from({ length: 172 }, (_, index) =>
        payload(`X${index}`, new Date(NOW - HOUR_MS).toISOString())),
    ];
    const report = buildContentFreshnessReport({
      countryData: countryDataOf(entries),
      now: NOW,
    });

    assert.equal(report.coveredCount, 174, 'cardinality is still complete');
    assert.equal(report.freshCount, 173, 'HK is 62h old — inside the 72h budget');
    assert.equal(report.staleCount, 1, 'CN is 98h old — outside the 72h budget');
    assert.equal(report.unknownCount, 0);
    assert.deepEqual(report.staleCountries, ['CN']);
    assert.equal(report.staleCountriesTruncated, 0);
    assert.equal(report.oldestObservedAt, Date.parse('2026-07-29T12:02:43.475Z'));
    assert.equal(report.oldestObservedCountry, 'CN');
    assert.equal(
      report.oldestAgeMinutes,
      Math.round((NOW - Date.parse('2026-07-29T12:02:43.475Z')) / MINUTE_MS),
    );
    assert.equal(report.budgetMinutes, PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES);
    assert.equal(report.assessedAt, NOW);

    // The decision-critical view is what health gates on.
    assert.deepEqual(report.criticalCountries, ['CN', 'HK']);
    assert.equal(report.criticalFreshCount, 1, 'HK is fresh, CN is not');
    assert.deepEqual(report.criticalStaleCountries, ['CN']);
    assert.equal(report.criticalOldestObservedCountry, 'CN');
    assert.equal(
      report.criticalOldestAgeMinutes,
      Math.round((NOW - Date.parse('2026-07-29T12:02:43.475Z')) / MINUTE_MS),
    );
  });

  // The cold-fetch cap is 30 countries per run on a 12h cron, so a full
  // 174-country sweep takes ~6 runs = ~72h BY DESIGN, and served-stale
  // payloads are retained for up to 7 days. Gating on "any country past
  // budget" would therefore be permanently true — a warning nobody can clear
  // and nobody would act on. Only the countries the China corridor adapter
  // actually reads gate the verdict; the rest stay visible as counts.
  it('does not treat ordinary rotation lag on a non-critical country as a decision failure', () => {
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([
        payload('CN', new Date(NOW - HOUR_MS).toISOString()),
        payload('HK', new Date(NOW - HOUR_MS).toISOString()),
        // Back of the rotation: refreshed ~5 days ago, entirely normal.
        payload('BR', new Date(NOW - 120 * HOUR_MS).toISOString()),
        payload('ZA', new Date(NOW - 100 * HOUR_MS).toISOString()),
      ]),
      now: NOW,
    });

    assert.equal(report.staleCount, 2, 'fleet-wide rotation lag stays visible');
    assert.deepEqual(report.staleCountries, ['BR', 'ZA']);
    assert.equal(report.criticalFreshCount, 2, 'but both decision inputs are fresh');
    assert.deepEqual(report.criticalStaleCountries, []);
    assert.equal(report.criticalOldestObservedCountry, 'CN');
  });

  it('fails closed when a decision-critical country is missing from the run entirely', () => {
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([payload('HK', new Date(NOW - HOUR_MS).toISOString())]),
      now: NOW,
    });

    assert.equal(report.criticalFreshCount, 1);
    assert.deepEqual(
      report.criticalStaleCountries,
      ['CN'],
      'an absent critical country is never silently fresh',
    );
    assert.equal(report.criticalMissingCountries, 1);
  });

  it('reports a critical country with unusable content as not fresh', () => {
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([
        { iso2: 'CN', ports: [], fetchedAt: 'not-a-timestamp' },
        payload('HK', new Date(NOW - HOUR_MS).toISOString()),
      ]),
      now: NOW,
    });
    assert.equal(report.criticalFreshCount, 1);
    assert.deepEqual(report.criticalStaleCountries, ['CN']);
    assert.equal(report.criticalMissingCountries, 0);
  });

  it('treats the budget boundary as exclusive so a country exactly at budget is stale', () => {
    const atBudget = new Date(
      NOW - PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES * MINUTE_MS,
    ).toISOString();
    const justInside = new Date(
      NOW - PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES * MINUTE_MS + 1,
    ).toISOString();
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([payload('CN', atBudget), payload('HK', justInside)]),
      now: NOW,
    });
    assert.deepEqual(report.staleCountries, ['CN']);
    assert.equal(report.freshCount, 1);
  });

  it('fails closed: a country with no usable fetchedAt can never count as fresh', () => {
    for (const unusable of [undefined, null, '', 'not-a-timestamp', 12_345]) {
      const report = buildContentFreshnessReport({
        countryData: countryDataOf([
          { iso2: 'CN', ports: [], fetchedAt: unusable },
          payload('HK', new Date(NOW - HOUR_MS).toISOString()),
        ]),
        now: NOW,
      });
      assert.equal(report.freshCount, 1, `fetchedAt=${String(unusable)} is not fresh`);
      assert.equal(report.unknownCount, 1);
      assert.equal(report.staleCount, 0, 'unproven is reported apart from proven-stale');
      assert.deepEqual(
        report.staleCountries,
        ['CN'],
        'unproven content is still actionable and named',
      );
    }
  });

  it('treats a future-dated observation as suspicious rather than fresh', () => {
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([
        payload('CN', new Date(NOW + HOUR_MS).toISOString()),
        payload('HK', new Date(NOW - HOUR_MS).toISOString()),
      ]),
      now: NOW,
    });
    assert.equal(report.freshCount, 1);
    assert.equal(report.staleCount, 1);
    assert.deepEqual(report.staleCountries, ['CN']);
  });

  it('bounds the published stale-country list and reports what it dropped', () => {
    const stale = new Date(NOW - 100 * HOUR_MS).toISOString();
    const overflow = PORTWATCH_MAX_REPORTED_STALE_COUNTRIES + 7;
    const report = buildContentFreshnessReport({
      countryData: countryDataOf(
        Array.from({ length: overflow }, (_, index) =>
          payload(`C${String(index).padStart(3, '0')}`, stale)),
      ),
      now: NOW,
    });
    assert.equal(report.staleCount, overflow);
    assert.equal(report.staleCountries.length, PORTWATCH_MAX_REPORTED_STALE_COUNTRIES);
    assert.equal(report.staleCountriesTruncated, 7);
    assert.deepEqual(
      report.staleCountries,
      [...report.staleCountries].sort(),
      'the published slice is deterministic',
    );
  });

  it('reports an empty run without inventing a fresh state', () => {
    const report = buildContentFreshnessReport({ countryData: new Map(), now: NOW });
    assert.equal(report.coveredCount, 0);
    assert.equal(report.freshCount, 0);
    assert.equal(report.staleCount, 0);
    assert.equal(report.unknownCount, 0);
    assert.deepEqual(report.staleCountries, []);
    assert.equal(report.oldestObservedAt, null);
    assert.equal(report.oldestObservedCountry, null);
    assert.equal(report.oldestAgeMinutes, null);
    assert.equal(report.criticalFreshCount, 0, 'an empty run proves nothing fresh');
    assert.deepEqual(report.criticalStaleCountries, ['CN', 'HK']);
    assert.equal(report.criticalMissingCountries, 2);
    assert.equal(report.criticalOldestObservedAt, null);
    assert.equal(report.criticalOldestAgeMinutes, null);
  });
});

describe('buildPortActivityMetaPayload', () => {
  const coverage = {
    target: 174,
    referenceCountryCount: 174,
    published: 174,
    complete: true,
    missingCountries: [],
    unidentifiedMissingCount: 0,
    refreshFailures: [],
  };

  it('publishes content freshness alongside the transport/cardinality fields', () => {
    const meta = buildPortActivityMetaPayload({
      countryData: countryDataOf([
        payload('CN', '2026-07-29T12:02:43.475Z'),
        ...Array.from({ length: 173 }, (_, index) =>
          payload(`X${index}`, new Date(NOW - HOUR_MS).toISOString())),
      ]),
      coverage,
      now: NOW,
    });

    assert.equal(meta.fetchedAt, NOW, 'transport freshness still advances');
    assert.equal(meta.recordCount, 174, 'cardinality is still complete');
    assert.equal(meta.coverage, coverage);
    assert.equal(
      meta.contentFreshness.staleCount,
      1,
      'a complete run cannot publish an undifferentiated healthy state',
    );
    assert.deepEqual(meta.contentFreshness.staleCountries, ['CN']);
  });
});
