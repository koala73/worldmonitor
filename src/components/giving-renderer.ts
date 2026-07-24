import { escapeHtml, sanitizeUrl } from '../utils/sanitize';
import type {
  CategoryBreakdown,
  GivingProvenance,
  GivingSummary,
  PlatformGiving,
} from '../services/giving/model';
import { formatCurrency } from '../services/giving/model';

export type GivingTab = 'platforms' | 'categories' | 'institutional';
export type GivingTranslate = (key: string, options?: Record<string, string | number>) => string;

function statusKey(availability: GivingSummary['availability']): string {
  if (availability === 'available') return 'components.giving.status.published';
  if (availability === 'available-but-legacy') return 'components.giving.status.legacy';
  if (availability === 'cached-refresh-unavailable') return 'components.giving.status.cached';
  return 'components.giving.status.partial';
}

function verifiedHttpsUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    return sanitizeUrl(rawUrl) || null;
  } catch {
    return null;
  }
}

function renderSourceName(entry: GivingProvenance): string {
  const safeName = escapeHtml(entry.sourceName);
  const safeUrl = verifiedHttpsUrl(entry.sourceUrl);
  if (!safeUrl) return safeName;
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${safeName}</a>`;
}

function renderSourceMeta(entry: GivingProvenance): string {
  const publication = entry.sourcePublishedAt
    ? ` · ${escapeHtml(entry.sourcePublishedAt)}`
    : '';
  return `<span class="giving-source-meta">${renderSourceName(entry)} · ${escapeHtml(entry.referencePeriod)}${publication}</span>`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toLocaleString();
}

function formatReportedValue(entry: GivingProvenance): string {
  if (entry.reportedUnit === 'USD') return formatCurrency(entry.reportedValue);
  if (entry.reportedUnit === 'GBP') return `GBP ${compactNumber(entry.reportedValue)}`;
  if (entry.reportedUnit === 'USD billion') return `$${entry.reportedValue.toFixed(1)}B`;
  if (entry.reportedUnit === 'grants') return `${compactNumber(entry.reportedValue)} grants`;
  return `${compactNumber(entry.reportedValue)} ${escapeHtml(entry.reportedUnit)}`.trim();
}

function qualifierPrefix(valueQualifier: string, translate: GivingTranslate): string {
  if (valueQualifier === 'more_than' || valueQualifier === 'at_least') {
    return `${escapeHtml(translate('components.giving.atLeast'))} `;
  }
  if (valueQualifier === 'about') {
    return `${escapeHtml(translate('components.giving.about'))} `;
  }
  return '';
}

function formatQualifiedValue(
  entry: GivingProvenance,
  value: string,
  translate: GivingTranslate,
): string {
  return `${qualifierPrefix(entry.valueQualifier, translate)}${value}`;
}

function platformProvenance(data: GivingSummary, platform: string): GivingProvenance | undefined {
  return data.provenance.find((entry) =>
    entry.sourceName === platform
    || entry.coveredMetricPaths.some((path) => path.includes(`[platform=${platform}]`)));
}

function contextProvenance(data: GivingSummary, metricPath: string): GivingProvenance | undefined {
  return data.provenance.find((entry) =>
    entry.coveredMetricPaths.some((path) => path.includes(metricPath)));
}

function renderAggregate(data: GivingSummary, translate: GivingTranslate): string {
  const contributors = data.provenance.filter((entry) =>
    entry.includedInHighlightedAggregate && entry.status === 'verified');
  const atLeast = contributors.some((entry) =>
    entry.valueQualifier === 'more_than' || entry.valueQualifier === 'at_least');
  const annualizedDaily = Number.isFinite(data.estimatedDailyFlowUsd) && data.estimatedDailyFlowUsd > 0
    ? data.estimatedDailyFlowUsd
    : 0;
  const annualized = annualizedDaily * 365;
  const value = annualized > 0 ? formatCurrency(annualized) : translate('components.giving.sourceNotVerified');
  const qualifier = atLeast ? qualifierPrefix('at_least', translate) : '';
  const sources = contributors
    .map((entry) => `${entry.sourceName} · ${entry.referencePeriod}`)
    .join(' · ');

  return `
    <div class="giving-stats-grid">
      <div class="giving-stat-box giving-stat-headline">
        <span class="giving-stat-value">${qualifier}${value}</span>
        <span class="giving-stat-label">${escapeHtml(translate('components.giving.trackedAnnualized'))}</span>
        ${sources ? `<span class="giving-source-meta">${escapeHtml(sources)}</span>` : ''}
      </div>
      <div class="giving-stat-box">
        <span class="giving-stat-value">${annualizedDaily > 0 ? formatCurrency(annualizedDaily) : '—'}</span>
        <span class="giving-stat-label">${escapeHtml(translate('components.giving.annualizedDaily'))}</span>
      </div>
    </div>`;
}

function renderPlatforms(data: GivingSummary, translate: GivingTranslate): string {
  if (data.platforms.length === 0) {
    return `<div class="panel-empty">${escapeHtml(translate('common.noDataShort'))}</div>`;
  }

  const rows = data.platforms.map((platform: PlatformGiving) => {
    const evidence = platformProvenance(data, platform.platform);
    let benchmark: string;
    if (!evidence || evidence.status === 'unverified') {
      benchmark = `<span class="giving-unverified">${escapeHtml(translate('components.giving.sourceNotVerified'))}</span>`;
    } else if (evidence.status === 'partially_verified') {
      benchmark = `
        <span class="giving-benchmark-value">${formatQualifiedValue(evidence, formatReportedValue(evidence), translate)}</span>
        <span class="giving-benchmark-kind">${escapeHtml(translate('components.giving.partialEstimate'))}</span>
        <span class="giving-methodology-note">${escapeHtml(evidence.notes)}</span>`;
    } else if (evidence.denominator.includes('cumulative')) {
      benchmark = `
        <span class="giving-benchmark-value">${formatQualifiedValue(evidence, formatReportedValue(evidence), translate)}</span>
        <span class="giving-benchmark-kind">${escapeHtml(translate('components.giving.reportedCumulative'))}</span>`;
    } else {
      const value = platform.dailyVolumeUsd > 0
        ? formatCurrency(platform.dailyVolumeUsd * 365)
        : formatReportedValue(evidence);
      benchmark = `
        <span class="giving-benchmark-value">${formatQualifiedValue(evidence, value, translate)}</span>
        <span class="giving-benchmark-kind">${escapeHtml(translate('components.giving.trackedAnnualized'))}</span>`;
    }

    return `<tr class="giving-row">
      <td class="giving-platform-name">${escapeHtml(platform.platform)}</td>
      <td class="giving-platform-benchmark">
        ${benchmark}
        ${evidence ? renderSourceMeta(evidence) : ''}
      </td>
    </tr>`;
  }).join('');

  return `
    <table class="giving-table">
      <thead>
        <tr>
          <th>${escapeHtml(translate('components.giving.platform'))}</th>
          <th>${escapeHtml(translate('components.giving.benchmark'))}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderCategories(
  data: GivingSummary,
  categories: CategoryBreakdown[],
  translate: GivingTranslate,
): string {
  if (categories.length === 0) {
    return `<div class="panel-empty">${escapeHtml(translate('common.noDataShort'))}</div>`;
  }
  const evidence = contextProvenance(data, 'categories[*].share');
  const rows = categories.map((category) => {
    const verified = evidence?.status === 'verified';
    const value = verified
      ? `${(category.share * 100).toFixed(1)}%`
      : escapeHtml(translate('components.giving.sourceNotVerified'));
    return `<tr class="giving-row">
      <td class="giving-cat-name">${escapeHtml(category.category)}</td>
      <td class="giving-category-benchmark">
        <span class="${verified ? 'giving-benchmark-value' : 'giving-unverified'}">${value}</span>
        ${evidence ? renderSourceMeta(evidence) : ''}
      </td>
    </tr>`;
  }).join('');

  return `<table class="giving-table giving-cat-table"><tbody>${rows}</tbody></table>`;
}

function renderInstitutionalMetric(
  data: GivingSummary,
  path: string,
  label: string,
  translate: GivingTranslate,
): string {
  const evidence = contextProvenance(data, path);
  const verified = evidence?.status === 'verified';
  return `
    <div class="giving-stat-box">
      <span class="${verified ? 'giving-stat-value' : 'giving-unverified'}">
        ${verified && evidence
          ? formatQualifiedValue(evidence, formatReportedValue(evidence), translate)
          : escapeHtml(translate('components.giving.sourceNotVerified'))}
      </span>
      <span class="giving-stat-label">${escapeHtml(label)}</span>
      ${evidence ? renderSourceMeta(evidence) : ''}
    </div>`;
}

function renderInstitutional(data: GivingSummary, translate: GivingTranslate): string {
  return `
    <div class="giving-inst-grid">
      ${renderInstitutionalMetric(
        data,
        'institutional.oecd_oda_annual_usd_bn',
        translate('components.giving.oecdOda'),
        translate,
      )}
      ${renderInstitutionalMetric(
        data,
        'institutional.candid_grants_tracked',
        translate('components.giving.candidGrants'),
        translate,
      )}
    </div>`;
}

function renderMethodology(data: GivingSummary, translate: GivingTranslate): string {
  const open = data.availability === 'available' ? '' : ' open';
  const records = data.provenance.map((entry) => `
    <li class="giving-methodology-item">
      <span class="giving-methodology-source">${renderSourceName(entry)}</span>
      <span class="giving-source-meta">${escapeHtml(entry.referencePeriod)} · ${escapeHtml(entry.status.replace(/_/g, ' '))}</span>
      <span class="giving-methodology-note">${escapeHtml(entry.notes)}</span>
    </li>`).join('');

  return `
    <details class="giving-methodology"${open}>
      <summary>${escapeHtml(translate('components.giving.sourcesMethodology'))}</summary>
      <p>${escapeHtml(translate('components.giving.methodologyIntro'))}</p>
      <ul>${records}</ul>
    </details>`;
}

export function availableGivingTabs(data: GivingSummary): GivingTab[] {
  const tabs: GivingTab[] = ['platforms'];
  if (data.categories.length > 0) tabs.push('categories');
  if (data.provenance.some((entry) =>
    entry.coveredMetricPaths.some((path) => path.includes('summary.institutional.')))) {
    tabs.push('institutional');
  }
  return tabs;
}

export function renderGivingPanelContent(
  data: GivingSummary,
  requestedTab: GivingTab,
  translate: GivingTranslate,
): string {
  const tabs = availableGivingTabs(data);
  const activeTab = tabs.includes(requestedTab) ? requestedTab : 'platforms';
  const tabLabels: Record<GivingTab, string> = {
    platforms: translate('components.giving.tabs.platforms'),
    categories: translate('components.giving.tabs.categories'),
    institutional: translate('components.giving.tabs.institutional'),
  };
  const tabsHtml = tabs.length > 1
    ? `<div class="panel-tabs">${tabs.map((tab) =>
      `<button class="panel-tab ${activeTab === tab ? 'active' : ''}" data-tab="${tab}">${escapeHtml(tabLabels[tab])}</button>`).join('')}</div>`
    : '';

  let content: string;
  if (activeTab === 'categories') {
    content = renderCategories(data, data.categories, translate);
  } else if (activeTab === 'institutional') {
    content = renderInstitutional(data, translate);
  } else {
    content = renderPlatforms(data, translate);
  }

  return `
    <div class="giving-panel-content">
      <div class="giving-status giving-status-${escapeHtml(data.availability)}" role="status">
        ${escapeHtml(translate(statusKey(data.availability)))}
      </div>
      ${renderAggregate(data, translate)}
      ${tabsHtml}
      ${content}
      ${renderMethodology(data, translate)}
    </div>`;
}
