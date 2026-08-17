import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  chinaTileHtml,
  hasChinaMacroData,
  isChinaLaunchReady,
  normalizeHydratedChina,
} from '../src/components/macro-tiles-china';
import {
  buildOfficialChinaMacroFixture,
  CHINA_MACRO_FIXTURE_RETRIEVAL_TIME,
  CHINA_MACRO_FIXTURE_SERIES_IDS,
} from './helpers/china-macro-fixture.mjs';

const panelSource = readFileSync(
  new URL('../src/components/MacroTilesPanel.ts', import.meta.url),
  'utf8',
);
const retrievalTime = CHINA_MACRO_FIXTURE_RETRIEVAL_TIME;
const freshNow = Date.parse(retrievalTime);

const calendar = {
  events: [{
    id: 'pboc-lpr-2026-08',
    event: 'Loan Prime Rate (LPR)',
    countryCode: 'CN',
    releaseDate: '2026-08-20',
    releaseTime: '09:00',
    timezone: 'Asia/Shanghai',
    kind: 'pboc_lpr',
    status: 'provisional',
    source: 'PBoC rule; realized date verified by ChinaMoney/CFETS',
    sourceUrl: 'https://www.chinamoney.com.cn/',
  }],
  sourceDecisions: [{
    publisherId: 'publisher:pboc-cn',
    source: 'PBoC release calendar',
    host: 'www.pbc.gov.cn',
    status: 'blocked',
    reason: 'ROBOTS_DISALLOW',
    checkedAt: retrievalTime,
    optional: false,
    requestCount: 1,
    redirectBehavior: 'none',
    requestBudget: 1,
    robotsStatus: 'disallow_all',
    termsStatus: 'not_evaluated_robots_blocked',
    sourceUrl: 'https://www.pbc.gov.cn/',
  }],
};

describe('MacroTilesPanel China launch surface', () => {
  it('hydrates the complete official snapshot and renders attributed mixed-state tiles', async () => {
    const normalized = normalizeHydratedChina(
      await buildOfficialChinaMacroFixture(),
      calendar,
      freshNow,
    );
    assert.ok(normalized);
    assert.deepEqual(normalized.indicators.map((indicator) => indicator.id), CHINA_MACRO_FIXTURE_SERIES_IDS);
    assert.equal(isChinaLaunchReady(normalized), true);
    assert.equal(normalized.indicators.filter((indicator) => !indicator.hasValue).length, 7);
    assert.equal(normalized.sourceDecisions.length, 5);

    const industrial = normalized.indicators.find(
      (indicator) => indicator.id === 'nbs_industrial_value_added_yoy',
    );
    assert.ok(industrial);
    assert.equal(industrial.transportStatus, 'fresh');
    assert.equal(industrial.vintages.length, 1);
    assert.equal(
      JSON.parse(industrial.provenanceJson).familyId,
      'china_macro_official_numeric_observation',
    );
    const html = chinaTileHtml(industrial);
    assert.match(html, /5\.3%/);
    assert.match(html, /Period 2026-06/);
    assert.match(html, /Released 2026-07-16T02:00:00\.000Z/);
    assert.match(html, /original/);
    assert.match(html, /National Bureau of Statistics of China/);
    assert.match(html, /class="macro-summary-card"/);
    assert.match(html, /class="macro-summary-state macro-summary-state--positive"/);
    assert.match(html, /data-state="strengthening">Strengthening<\/span>/);
    assert.doesNotMatch(html, /style=/);

    const settlement = normalized.indicators.find(
      (indicator) => indicator.id === 'safe_bank_fx_settlement',
    );
    assert.ok(settlement);
    assert.equal(settlement.hasValue, true);
    assert.equal(settlement.direction, 'unavailable');
    const settlementHtml = chinaTileHtml(settlement);
    assert.match(settlementHtml, /data-state="LIVE">Live<\/span>/);
    assert.doesNotMatch(settlementHtml, /data-state="UNAVAILABLE"/);

    const unavailableHtml = chinaTileHtml({
      ...industrial,
      value: 0,
      hasValue: false,
      unavailableReason: 'ROBOTS_DISALLOW',
      transportStatus: 'blocked',
    });
    assert.match(unavailableHtml, /N\/A/);
    assert.match(unavailableHtml, /Source blocked/);
    assert.match(unavailableHtml, /data-state="ROBOTS_DISALLOW"/);
  });

  it('fails closed when current or vintage #5581 provenance is incomplete', async () => {
    const invalidCurrent = structuredClone(await buildOfficialChinaMacroFixture());
    delete invalidCurrent.observations[0].provenance.claims.publication_time;
    assert.equal(normalizeHydratedChina(invalidCurrent, calendar, freshNow), null);

    const invalidVintage = structuredClone(await buildOfficialChinaMacroFixture());
    delete invalidVintage.observations[0].vintages[0].provenance.claims.publication_time;
    assert.equal(normalizeHydratedChina(invalidVintage, calendar, freshNow), null);
  });

  it('recomputes independent transport and content freshness at the read boundary', async () => {
    const transportLate = normalizeHydratedChina(
      await buildOfficialChinaMacroFixture(),
      calendar,
      Date.parse('2026-07-29T14:31:00.000Z'),
    );
    assert.ok(transportLate);
    assert.equal(transportLate.launchReady, false);
    assert.equal(isChinaLaunchReady(transportLate), false);
    assert.equal(hasChinaMacroData(transportLate), true);
    assert.equal(transportLate.indicators[0]?.stale, false);
    assert.equal(transportLate.indicators[0]?.transportStatus, 'stale');
    assert.equal(
      JSON.parse(transportLate.indicators[0]?.provenanceJson ?? '').claims.transport_freshness.value.state,
      'stale',
    );
    assert.match(chinaTileHtml(transportLate.indicators[0]!), /data-state="TRANSPORT_STALE">Transport stale<\/span>/);

    const contentLate = normalizeHydratedChina(
      await buildOfficialChinaMacroFixture(),
      calendar,
      Date.parse('2026-08-16T00:00:00.000Z'),
    );
    assert.ok(contentLate);
    assert.equal(contentLate.launchReady, false);
    assert.equal(hasChinaMacroData(contentLate), true);
    const reserves = contentLate.indicators.find((indicator) => indicator.id === 'safe_fx_reserves');
    assert.ok(reserves);
    assert.equal(reserves.stale, true);
    assert.equal(reserves.unavailableReason, 'STALE_OBSERVATION');
    assert.equal(reserves.direction, 'unavailable');
    assert.equal(
      JSON.parse(reserves.provenanceJson).claims.content_freshness.value.state,
      'stale',
    );
    assert.equal(
      JSON.parse(reserves.vintages.find((vintage) => vintage.vintageId === reserves.vintageId)?.provenanceJson ?? '')
        .claims.content_freshness.value.state,
      'stale',
    );

    const recoveredAt = '2026-08-01T14:30:00.000Z';
    const recovered = structuredClone(await buildOfficialChinaMacroFixture());
    recovered.generatedAt = recoveredAt;
    recovered.transportLastSuccessAt = recoveredAt;
    const recoveredIndustrial = recovered.observations.find(
      (observation: { seriesId: string }) =>
        observation.seriesId === 'nbs_industrial_value_added_yoy',
    );
    recoveredIndustrial.provenance.claims.transport_freshness.value = {
      state: 'fresh',
      assessedAt: recoveredAt,
      lastSuccessAt: recoveredAt,
    };
    recoveredIndustrial.provenance.claims.content_freshness.value.assessedAt = recoveredAt;
    const recoveredVintage = recoveredIndustrial.vintages.find(
      (vintage: { vintageId: string }) =>
        vintage.vintageId === recoveredIndustrial.vintageId,
    );
    recoveredVintage.provenance.claims.transport_freshness.value = {
      state: 'fresh',
      assessedAt: recoveredAt,
      lastSuccessAt: recoveredAt,
    };
    recoveredVintage.provenance.claims.content_freshness.value.assessedAt = recoveredAt;
    const recoveredNormalized = normalizeHydratedChina(
      recovered,
      calendar,
      Date.parse(recoveredAt),
    );
    assert.ok(recoveredNormalized);
    const normalizedIndustrial = recoveredNormalized.indicators.find(
      (indicator) => indicator.id === 'nbs_industrial_value_added_yoy',
    );
    assert.equal(normalizedIndustrial?.retrievalTime, retrievalTime);
    assert.equal(normalizedIndustrial?.transportStatus, 'fresh');
    assert.equal(
      JSON.parse(normalizedIndustrial?.provenanceJson ?? '')
        .claims.transport_freshness.value.lastSuccessAt,
      recoveredAt,
    );
  });

  it('recomputes official pillar direction fail-closed at the client boundary', async () => {
    const incomparable = structuredClone(await buildOfficialChinaMacroFixture());
    incomparable.observations.find(
      (observation: { seriesId: string }) =>
        observation.seriesId === 'nbs_real_estate_investment_yoy',
    ).comparisonBasis = 'month_over_month';
    const incomparableNormalized = normalizeHydratedChina(incomparable, calendar, freshNow);
    assert.ok(incomparableNormalized);
    assert.deepEqual(
      incomparableNormalized.pillars.find((pillar) => pillar.pillar === 'investment_property'),
      {
        pillar: 'investment_property',
        direction: 'unavailable',
        reason: 'INCOMPARABLE_PERIOD_OR_BASIS',
        observationIds: [
          'nbs_fixed_asset_investment_yoy',
          'nbs_real_estate_investment_yoy',
        ],
      },
    );

    const mixed = structuredClone(await buildOfficialChinaMacroFixture());
    mixed.observations.find(
      (observation: { seriesId: string }) =>
        observation.seriesId === 'nbs_real_estate_investment_yoy',
    ).direction = 'strengthening';
    const mixedNormalized = normalizeHydratedChina(mixed, calendar, freshNow);
    assert.ok(mixedNormalized);
    assert.deepEqual(
      mixedNormalized.pillars.find((pillar) => pillar.pillar === 'investment_property'),
      {
        pillar: 'investment_property',
        direction: 'unavailable',
        reason: 'MIXED_OFFICIAL_SIGNALS',
        observationIds: [
          'nbs_fixed_asset_investment_yoy',
          'nbs_real_estate_investment_yoy',
        ],
      },
    );
  });

  // A single test used to pin the panel's Tab union, its getHydratedData call
  // sites, and its ARIA attributes by regex. The four tests above exercise the
  // hydration and provenance logic for real, and the tablist markup is
  // exercised by booting the dashboard in e2e/variant-live-smoke.spec.ts.
});
