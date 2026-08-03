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
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/health.js';

import {
  buildContentFreshnessReport,
  buildPortActivityMetaPayload,
  isCriticalContentRefreshDue,
  contentClockFor,
  orderColdFetchQueue,
  PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY,
  PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES,
  PORTWATCH_DECISION_CRITICAL_COUNTRIES,
  PORTWATCH_MAX_REPORTED_STALE_COUNTRIES,
} from '../scripts/seed-portwatch-port-activity.mjs';

const { ACTIVATION_MARKERS, SEED_META } = __testing__;

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

// Without slot reservation the alarm this PR adds is chronically at its own
// boundary rather than measuring an incident: MAX_COLD_FETCH_PER_RUN caps
// refreshes at 30 of 174 per run on a 12h cron, so any given country waits
// ceil(174/30) = 6 runs = 72h — exactly the content budget. CN and HK feed the
// China corridor adapter and the activity-nowcast's maritime family, so they
// must be refreshed every run they are a cache miss, not once per sweep.
// The alarm's clock must measure CONTENT, not retrieval. `fetchedAt` resets on
// every successful fetch — including the forced refetch at MAX_CACHE_AGE_MS
// (168h) that returns an UNCHANGED upstream `asof`. Ageing that would green the
// alarm for 72h of every 168h during an indefinite upstream freeze, which is
// the precise failure #6060 exists to end.
describe('content clock survives a refetch that returns unchanged upstream data', () => {
  it('ages the upstream content date, not the retrieval timestamp', () => {
    const frozenSince = NOW - 120 * HOUR_MS;
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([
        {
          iso2: 'CN',
          ports: [],
          // Just refetched — retrieval is seconds old ...
          fetchedAt: new Date(NOW - 60_000).toISOString(),
          cacheWrittenAt: NOW - 60_000,
          // ... but upstream has not advanced since it froze 120h ago.
          asof: '2026-07-28',
          contentAsOfChangedAt: frozenSince,
        },
        payload('HK', new Date(NOW - HOUR_MS).toISOString()),
      ]),
      now: NOW,
    });

    assert.deepEqual(
      report.criticalStaleCountries,
      ['CN'],
      'a fresh retrieval of frozen upstream data is not fresh content',
    );
    assert.equal(report.criticalFreshCount, 1);
    assert.equal(report.criticalOldestObservedAt, frozenSince);
    assert.equal(report.criticalOldestAgeMinutes, 120 * 60);
  });

  it('counts content as fresh when the upstream date actually advanced', () => {
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([
        {
          iso2: 'CN',
          ports: [],
          fetchedAt: new Date(NOW - 30 * HOUR_MS).toISOString(),
          cacheWrittenAt: NOW - 30 * HOUR_MS,
          asof: '2026-08-01',
          contentAsOfChangedAt: NOW - HOUR_MS,
        },
        payload('HK', new Date(NOW - HOUR_MS).toISOString()),
      ]),
      now: NOW,
    });
    assert.deepEqual(report.criticalStaleCountries, []);
    assert.equal(report.criticalFreshCount, 2);
  });

  // Now a real exported function rather than inline in fetchAll's batch loop,
  // so these assert behaviour instead of source text.
  it('carries the prior content clock forward when upstream max(date) is unchanged', () => {
    const frozenSince = NOW - 120 * HOUR_MS;
    assert.equal(
      contentClockFor(
        { asof: '2026-07-24', contentAsOfChangedAt: frozenSince },
        '2026-07-24',
        NOW,
      ),
      frozenSince,
      'a refetch returning the same upstream date must not reset the clock',
    );
  });

  it('resets the clock when the upstream date actually advances', () => {
    assert.equal(
      contentClockFor(
        { asof: '2026-07-24', contentAsOfChangedAt: NOW - 120 * HOUR_MS },
        '2026-07-25',
        NOW,
      ),
      NOW,
      'new upstream content means the clock starts now',
    );
  });

  it('seeds a legacy payload from the upstream date, not the rollout moment', () => {
    // Every payload in Redis predates this field. Stamping the refetch moment
    // would report a frozen upstream as fresh for a full budget window after
    // rollout — the alarm would look fixed, then appear to regress days later.
    assert.equal(
      contentClockFor({ asof: '2026-07-24' }, '2026-07-24', NOW),
      Date.parse('2026-07-24T23:59:59.999Z'),
    );
    assert.equal(contentClockFor(null, '2026-07-24', NOW), Date.parse('2026-07-24T23:59:59.999Z'));
  });

  it('falls back to the refetch moment only when the upstream date is unusable', () => {
    for (const bad of [null, undefined, '', 'not-a-date', 42]) {
      assert.equal(contentClockFor(null, bad, NOW), NOW, `upstreamMaxDate=${String(bad)}`);
    }
  });

  it('falls back to the retrieval timestamp only when no content clock exists', () => {
    // Legacy payloads written before the content clock was introduced.
    const report = buildContentFreshnessReport({
      countryData: countryDataOf([
        payload('CN', new Date(NOW - 100 * HOUR_MS).toISOString()),
        payload('HK', new Date(NOW - HOUR_MS).toISOString()),
      ]),
      now: NOW,
    });
    assert.deepEqual(report.criticalStaleCountries, ['CN']);
  });
});

describe('decision-critical cold-fetch priority', () => {
  function queueItem(iso2, refreshAttemptedAt) {
    return { iso2, iso3: `${iso2}X`, prevPayload: { iso2, refreshAttemptedAt } };
  }

  it('puts decision-critical countries at the head of the queue', () => {
    // CN/HK were attempted most recently, so oldest-attempt-first alone would
    // sort them dead last — behind every one of the 172 others.
    const queue = [
      ...Array.from({ length: 172 }, (_, index) =>
        queueItem(`X${String(index).padStart(3, '0')}`, 1_000 + index)),
      queueItem('CN', 9_000_000),
      queueItem('HK', 9_000_001),
    ];
    const ordered = orderColdFetchQueue(queue).map((item) => item.iso2);

    assert.deepEqual(ordered.slice(0, 2), ['CN', 'HK']);
    assert.equal(ordered.length, queue.length, 'ordering is a permutation');
    assert.equal(new Set(ordered).size, queue.length, 'no country is duplicated');
  });

  it('keeps oldest-attempt-first among the non-critical remainder', () => {
    const ordered = orderColdFetchQueue([
      queueItem('BR', 5_000),
      queueItem('CN', 9_000),
      queueItem('ZA', 1_000),
      queueItem('US', 3_000),
    ]).map((item) => item.iso2);
    assert.deepEqual(ordered, ['CN', 'ZA', 'US', 'BR']);
  });

  it('orders critical countries among themselves by oldest attempt', () => {
    const ordered = orderColdFetchQueue([
      queueItem('HK', 2_000),
      queueItem('CN', 8_000),
      queueItem('US', 1_000),
    ]).map((item) => item.iso2);
    assert.deepEqual(ordered, ['HK', 'CN', 'US']);
  });

  it('still lets a never-attempted critical country lead', () => {
    const ordered = orderColdFetchQueue([
      queueItem('US', 1_000),
      { iso2: 'CN', iso3: 'CHN', prevPayload: null },
    ]).map((item) => item.iso2);
    assert.deepEqual(ordered, ['CN', 'US']);
  });

  it('reserves fewer slots than the per-run cap so rotation still advances', () => {
    assert.ok(
      PORTWATCH_DECISION_CRITICAL_COUNTRIES.length < 30,
      'critical reservations must not consume the whole cold-fetch budget',
    );
  });
});

describe('decision-critical cache-hit refresh deadline', () => {
  it('moves a critical cache hit into the cold queue before the 72h boundary', () => {
    const budgetMs = PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES * MINUTE_MS;
    const cadenceMs = 12 * HOUR_MS;
    const atDeadline = new Date(NOW - budgetMs + cadenceMs).toISOString();
    const justBeforeDeadline = new Date(NOW - budgetMs + cadenceMs + 1).toISOString();

    assert.equal(
      isCriticalContentRefreshDue({
        iso2: 'CN',
        prevPayload: payload('CN', atDeadline),
        now: NOW,
      }),
      true,
    );
    assert.equal(
      isCriticalContentRefreshDue({
        iso2: 'HK',
        prevPayload: payload('HK', justBeforeDeadline),
        now: NOW,
      }),
      false,
    );
  });

  it('does not evict a fresh non-critical cache hit for the content policy', () => {
    assert.equal(
      isCriticalContentRefreshDue({
        iso2: 'US',
        prevPayload: payload('US', new Date(NOW - 100 * HOUR_MS).toISOString()),
        now: NOW,
      }),
      false,
    );
  });

  it('fails closed for a critical cache payload without a usable observation time', () => {
    assert.equal(
      isCriticalContentRefreshDue({
        iso2: 'CN',
        prevPayload: { iso2: 'CN', asof: '2026-07-29', cacheWrittenAt: NOW - HOUR_MS },
        now: NOW,
      }),
      true,
    );
  });
});

// Three constants claim equality with sources they cannot import: the seeder is
// a Railway script, api/health.js is an Edge function limited to api/_*.js, and
// the corridor adapter is server-side TypeScript. Comments asserting "this
// mirrors X" are exactly the kind of claim that rots silently — the same class
// as the parity-audit gap this PR already closed for the group manifest.
describe('content-freshness constant parity', () => {
  const read = (relativePath) =>
    readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

  it('uses the budget the China corridor adapter actually enforces', () => {
    const adapter = read('server/worldmonitor/supply-chain/v1/china-corridor-source-adapters.ts');
    const budgets = [
      ...adapter.matchAll(/contentFreshness\(observedAt,\s*([\d\s*]+),\s*assessedAt\)/g),
    ]
      // eslint-disable-next-line no-eval -- bounded to a digit/asterisk literal
      .map(([, expression]) => Number(expression.replace(/\s/g, '').split('*')
        .reduce((product, term) => product * Number(term), 1)));

    assert.ok(
      budgets.includes(PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES),
      `no corridor port budget equals ${PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES}; found ${JSON.stringify(budgets)}`,
    );
  });

  it('declares exactly the countries the corridor control towers read', () => {
    const towers = read('server/worldmonitor/supply-chain/v1/get-china-corridor-control-towers.ts');
    const prefix = 'supply_chain:portwatch-ports:v1:';
    const consumed = [
      ...towers.matchAll(new RegExp(`'${prefix.replace(/[:.]/g, '\\$&')}([A-Z]{2})'`, 'g')),
    ].map(([, iso2]) => iso2).sort();

    assert.deepEqual(
      [...PORTWATCH_DECISION_CRITICAL_COUNTRIES].sort(),
      [...new Set(consumed)],
      'the seeder reserves refresh slots for a different set than the adapter consumes',
    );
  });

  // A shared threshold is not enough: the alarm and the gate can agree on 72h
  // while ageing different fields, which is exactly how the alarm can go red
  // with the nowcast still green. Pin that BOTH read the content clock, with
  // the same legacy fallback.
  it('ages the same content clock as the corridor gate it guards', () => {
    const adapter = read('server/worldmonitor/supply-chain/v1/china-corridor-source-adapters.ts');
    assert.match(
      adapter,
      /isoTimestamp\(payload\.contentAsOfChangedAt\)\s*\n?\s*\?\?\s*isoTimestamp\(payload\.fetchedAt\)/,
      'the corridor gate must age the content clock, falling back to retrieval',
    );

    const report = readFileSync(
      new URL('../scripts/_portwatch-content-freshness.mjs', import.meta.url),
      'utf8',
    );
    assert.match(
      report,
      /Number\.isFinite\(payload\?\.contentAsOfChangedAt\)/,
      'the alarm must age the same clock',
    );
  });

  it('agrees with the scope health pins in its own config', () => {
    assert.deepEqual(
      [...SEED_META.portwatchPortActivity.requireContentFreshness.countries].sort(),
      [...PORTWATCH_DECISION_CRITICAL_COUNTRIES].sort(),
    );
    assert.equal(
      SEED_META.portwatchPortActivity.requireContentFreshness.budgetMinutes,
      PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES,
      'health would gate on a different budget than the seeder measures against',
    );
  });
});

describe('content-freshness activation marker', () => {
  const src = readFileSync(
    new URL('../scripts/seed-portwatch-port-activity.mjs', import.meta.url),
    'utf8',
  );

  it('matches the key api/health.js registers', () => {
    assert.equal(
      PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY,
      'seed-activated:supply_chain:portwatch-ports:content-freshness',
    );
    assert.equal(
      SEED_META.portwatchPortActivity.contentFreshnessActivation,
      'portwatchContentFreshness',
    );
    assert.equal(
      ACTIVATION_MARKERS.portwatchContentFreshness,
      PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY,
      'a drift here silently strands health in its pending-activation grace',
    );
  });

  it('is written without a TTL so the grace cannot silently re-open', () => {
    // The payload keys carry `'EX', TTL`; the marker deliberately does not —
    // it records "this producer has shipped the field at least once", which
    // must outlive a 3-day payload TTL and any run of skipped crons.
    assert.match(
      src,
      /commands\.push\(\['SET', PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY, '1'\]\);/,
    );
    assert.doesNotMatch(
      src,
      /PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY, '1', 'EX'/,
      'the activation marker must never expire',
    );
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
