import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { GivingSummary } from '../src/services/giving/model.ts';
import { renderGivingPanelContent } from '../src/components/giving-renderer.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const copy: Record<string, string> = {
  'components.giving.status.partial': 'Published benchmarks with partial source coverage.',
  'components.giving.status.published': 'Published benchmarks with verified source coverage.',
  'components.giving.status.legacy': 'Legacy snapshot; source details are unavailable.',
  'components.giving.status.cached': 'Showing a cached snapshot; refresh unavailable.',
  'components.giving.trackedAnnualized': 'Tracked platform giving — annualized estimate',
  'components.giving.annualizedDaily': 'Annualized daily estimate',
  'components.giving.atLeast': 'At least',
  'components.giving.about': 'About',
  'components.giving.sourceNotVerified': 'Source not verified',
  'components.giving.partialEstimate': 'Partially verified estimate',
  'components.giving.reportedCumulative': 'Reported cumulative total',
  'components.giving.sourcePeriod': '{{source}} · {{period}}',
  'components.giving.tabs.platforms': 'Platforms',
  'components.giving.tabs.categories': 'Categories',
  'components.giving.tabs.institutional': 'Institutional',
  'components.giving.platform': 'Platform',
  'components.giving.benchmark': 'Published benchmark',
  'components.giving.sourcesMethodology': 'Sources & methodology',
  'components.giving.methodologyIntro': 'Only verified annual or defensibly annualized platform claims enter the headline.',
  'components.giving.oecdOda': 'OECD ODA',
  'components.giving.candidGrants': 'Candid grants represented',
  'common.noDataShort': 'No data',
};

function tr(key: string, vars?: Record<string, string | number>): string {
  let value = copy[key] ?? key;
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replace(`{{${name}}}`, String(replacement));
  }
  return value;
}

function summary(overrides: Partial<GivingSummary> = {}): GivingSummary {
  return {
    generatedAt: '2026-07-24T12:00:00.000Z',
    materializedAt: '2026-07-24T12:00:00.000Z',
    availability: 'available-but-partial',
    refreshFailure: null,
    activityIndex: 0,
    activityIndexAvailable: false,
    trend: 'stable',
    trendAvailable: false,
    estimatedDailyFlowUsd: 2_684_000_000 / 365,
    platforms: [
      {
        platform: 'GoFundMe',
        dailyVolumeUsd: 2_600_000_000 / 365,
        activeCampaignsSampled: 0,
        newCampaigns24h: 0,
        donationVelocity: 0,
        dataFreshness: 'annual',
        lastUpdated: '',
      },
      {
        platform: 'JustGiving',
        dailyVolumeUsd: 0,
        activeCampaignsSampled: 0,
        newCampaigns24h: 0,
        donationVelocity: 0,
        dataFreshness: 'cumulative',
        lastUpdated: '',
      },
    ],
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
    dataMode: 'partial_estimate',
    provenance: [
      {
        subject: 'GoFundMe weekly giving',
        sourceName: 'GoFundMe',
        sourceUrl: 'https://www.gofundme.com/?lang=en',
        referencePeriod: 'Average week across 2023-2024',
        sourcePublishedAt: '',
        measurementBasis: 'Weekly lower-bound claim',
        status: 'verified',
        coveredMetricPaths: ['summary.platforms[platform=GoFundMe].daily_volume_usd'],
        includedInHighlightedAggregate: true,
        reportedValue: 50_000_000,
        reportedUnit: 'USD',
        notes: 'More than USD 50 million each week.',
        valueQualifier: 'more_than',
        sourceLocator: 'Homepage claim',
        accessedAt: '2026-07-24',
        denominator: 'week',
        derivation: '50,000,000 * 52',
      },
      {
        subject: 'JustGiving cumulative giving',
        sourceName: 'JustGiving',
        sourceUrl: 'https://www.justgiving.com/about',
        referencePeriod: '25 years cumulative',
        sourcePublishedAt: '',
        measurementBasis: 'Cumulative lower-bound claim',
        status: 'verified',
        coveredMetricPaths: ['summary.platforms[platform=JustGiving].daily_volume_usd'],
        includedInHighlightedAggregate: false,
        reportedValue: 7_000_000_000,
        reportedUnit: 'GBP',
        notes: 'More than GBP 7 billion over 25 years.',
        valueQualifier: 'more_than',
        sourceLocator: 'About page',
        accessedAt: '2026-07-24',
        denominator: '25 years cumulative',
        derivation: 'No annualization.',
      },
      {
        subject: 'GlobalGiving 2024 giving',
        sourceName: 'GlobalGiving',
        sourceUrl: 'https://www.globalgiving.org/2024/',
        referencePeriod: '2024',
        sourcePublishedAt: '',
        measurementBasis: 'Annual lower-bound claim',
        status: 'verified',
        coveredMetricPaths: ['summary.estimated_daily_flow_usd'],
        includedInHighlightedAggregate: true,
        reportedValue: 84_000_000,
        reportedUnit: 'USD',
        notes: 'More than USD 84 million in 2024.',
        valueQualifier: 'more_than',
        sourceLocator: '2024 review',
        accessedAt: '2026-07-24',
        denominator: 'year',
        derivation: 'Reported annual amount.',
      },
      {
        subject: 'Candid grants represented annually',
        sourceName: 'Candid',
        sourceUrl: 'https://candid.org/about/our-data/grants-data-fact-sheet/',
        referencePeriod: 'Current fact sheet accessed 2026-07-24',
        sourcePublishedAt: '',
        measurementBasis: 'Published approximate annual grants-data coverage',
        status: 'verified',
        coveredMetricPaths: ['summary.institutional.candid_grants_tracked'],
        includedInHighlightedAggregate: false,
        reportedValue: 3_000_000,
        reportedUnit: 'grants',
        notes: 'Candid data represents about 3 million grants annually.',
        valueQualifier: 'about',
        sourceLocator: 'Grants data fact sheet',
        accessedAt: '2026-07-24',
        denominator: 'year',
        derivation: 'No derivation.',
      },
      {
        subject: 'Unsafe legacy source',
        sourceName: 'Unsafe source',
        sourceUrl: 'http://example.com/source',
        referencePeriod: 'Unknown',
        sourcePublishedAt: '',
        measurementBasis: 'Unsupported',
        status: 'unverified',
        coveredMetricPaths: ['summary.categories[*].share'],
        includedInHighlightedAggregate: false,
        reportedValue: 1,
        reportedUnit: 'share',
        notes: 'Not verified.',
        valueQualifier: 'unverified',
        sourceLocator: 'Unknown',
        accessedAt: '2026-07-24',
        denominator: 'unknown',
        derivation: 'None.',
      },
    ],
    ...overrides,
  };
}

describe('Giving panel provenance rendering', () => {
  it('renders disclosure before the annualized headline and removes unsupported live/index UI', () => {
    const html = renderGivingPanelContent(summary(), 'platforms', tr);
    assert.ok(html.indexOf('role="status"') < html.indexOf('Tracked platform giving'));
    assert.match(html, /At least[\s\S]*\$2\.7B/);
    assert.match(html, /Annualized daily estimate/);
    assert.match(html, /GoFundMe · Average week across 2023-2024/);
    assert.match(html, /GoFundMe[\s\S]*At least \$2\.6B[\s\S]*Tracked platform giving/);
    assert.match(html, /At least GBP 7\.0B[\s\S]*Reported cumulative total/);
    assert.doesNotMatch(html, /Activity Index|24h|\/hr|Trending|Fresh|wallet|velocity/i);
    assert.doesNotMatch(html, />stable</i);
    assert.match(html, /<details class="giving-methodology" open>/);
  });

  it('uses safe HTTPS provenance links and renders unsafe URLs as plain text', () => {
    const html = renderGivingPanelContent(summary(), 'platforms', tr);
    assert.match(
      html,
      /href="https:\/\/www\.gofundme\.com\/\?lang=en"[^>]*target="_blank"[^>]*rel="noopener noreferrer nofollow"/,
    );
    assert.doesNotMatch(html, /href="http:\/\/example\.com\/source"/);
    assert.match(html, />Unsafe source</);
  });

  it('collapses methodology only for complete published evidence', () => {
    const published = summary({
      availability: 'available',
      dataMode: 'published_estimate',
      provenance: summary().provenance.filter((entry) => entry.status === 'verified'),
    });
    const html = renderGivingPanelContent(published, 'platforms', tr);
    assert.match(html, /Published benchmarks with verified source coverage/);
    assert.match(html, /<details class="giving-methodology">/);
    assert.doesNotMatch(html, /<details class="giving-methodology" open>/);
  });

  it('uses evidence-neutral disclosure for cached partial estimates', () => {
    const html = renderGivingPanelContent(summary({
      availability: 'cached-refresh-unavailable',
      dataMode: 'partial_estimate',
    }), 'platforms', tr);
    assert.match(html, /Showing a cached snapshot; refresh unavailable\./);
    assert.doesNotMatch(html, /cached verified snapshot/i);
    assert.match(html, /<details class="giving-methodology" open>/);
  });

  it('renders headline amounts from the API aggregate even when provenance amounts diverge', () => {
    const html = renderGivingPanelContent(summary({
      estimatedDailyFlowUsd: 1_000_000,
    }), 'platforms', tr);
    assert.match(html, /At least[\s\S]*\$365\.0M/);
    assert.match(html, /\$1\.0M[\s\S]*Annualized daily estimate/);
    assert.doesNotMatch(html, /At least \$2\.7B/);
  });

  it('shows source-not-verified without a numeric category claim', () => {
    const withCategory = summary({
      categories: [{
        category: 'Medical & Health',
        share: 0.33,
        change24h: 0,
        activeCampaigns: 0,
        trending: false,
      }],
    });
    const html = renderGivingPanelContent(withCategory, 'categories', tr);
    assert.match(html, /Medical &amp; Health/);
    assert.match(html, /Source not verified/);
    assert.doesNotMatch(html, /33\.0%/);
  });

  it('renders approximate institutional qualifiers at the point of use', () => {
    const html = renderGivingPanelContent(summary(), 'institutional', tr);
    assert.match(html, /About 3\.0M grants[\s\S]*Candid grants represented/);
  });

  it('labels partially verified platform values with a caveat and excludes them from the headline', () => {
    const partial = summary();
    partial.estimatedDailyFlowUsd = 84_000_000 / 365;
    partial.provenance = partial.provenance.map((entry) =>
      entry.sourceName === 'GoFundMe'
        ? { ...entry, status: 'partially_verified', notes: 'The denominator remains under review.' }
        : entry);
    const html = renderGivingPanelContent(partial, 'platforms', tr);
    assert.match(html, /At least \$50\.0M[\s\S]*Partially verified estimate/);
    assert.match(html, /Partially verified estimate/);
    assert.match(html, /The denominator remains under review\./);
    assert.match(html, /At least \$84\.0M/);
    assert.doesNotMatch(html, /At least \$2\.7B/);
  });

  it('keeps the benchmark title and mobile metadata wrapping in the native panel surface', () => {
    const component = readFileSync(resolve(root, 'src/components/GivingPanel.ts'), 'utf8');
    const css = readFileSync(resolve(root, 'src/styles/panels.css'), 'utf8');
    assert.match(component, /components\.giving\.benchmarkTitle/);
    assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.giving-/);
    assert.match(css, /\.giving-source-meta[\s\S]*overflow-wrap:\s*anywhere/);
  });
});
