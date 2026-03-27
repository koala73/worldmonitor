import { Panel } from './Panel';
import type {
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
  GetCustomsRevenueResponse,
  ListComtradeFlowsResponse,
  TariffDataPoint,
  EffectiveTariffRate,
} from '@/services/trade';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isFeatureAvailable } from '@/services/runtime-config';
import { isDesktopRuntime } from '@/services/runtime';

type TabId = 'restrictions' | 'tariffs' | 'flows' | 'barriers' | 'revenue' | 'comtrade';

export class TradePolicyPanel extends Panel {
  private restrictionsData: GetTradeRestrictionsResponse | null = null;
  private tariffsData: GetTariffTrendsResponse | null = null;
  private flowsData: GetTradeFlowsResponse | null = null;
  private barriersData: GetTradeBarriersResponse | null = null;
  private revenueData: GetCustomsRevenueResponse | null = null;
  private comtradeData: ListComtradeFlowsResponse | null = null;
  private activeTab: TabId = 'restrictions';

  constructor() {
    super({ id: 'trade-policy', title: t('panels.tradePolicy'), defaultRowSpan: 2, infoTooltip: t('components.tradePolicy.infoTooltip') });
    this.content.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.panel-tab') as HTMLElement | null;
      if (!target) return;
      const tabId = target.dataset.tab as TabId;
      if (tabId && tabId !== this.activeTab) {
        this.activeTab = tabId;
        this.render();
      }
    });
  }

  public updateRestrictions(data: GetTradeRestrictionsResponse): void {
    this.restrictionsData = data;
    this.render();
  }

  public updateTariffs(data: GetTariffTrendsResponse): void {
    this.tariffsData = data;
    this.render();
  }

  public updateFlows(data: GetTradeFlowsResponse): void {
    this.flowsData = data;
    this.render();
  }

  public updateBarriers(data: GetTradeBarriersResponse): void {
    this.barriersData = data;
    this.render();
  }

  public updateComtradeFlows(data: ListComtradeFlowsResponse): void {
    this.comtradeData = data;
    this.render();
  }

  public updateRevenue(data: GetCustomsRevenueResponse): void {
    this.revenueData = data;
    if (isDesktopRuntime() && !isFeatureAvailable('wtoTrade') && this.activeTab !== 'revenue') {
      this.activeTab = 'revenue';
    }
    this.render();
  }

  private render(): void {
    const wtoAvailable = !isDesktopRuntime() || isFeatureAvailable('wtoTrade');
    const hasTariffs = wtoAvailable && this.tariffsData && this.tariffsData.datapoints?.length > 0;
    const hasFlows = wtoAvailable && this.flowsData && this.flowsData.flows?.length > 0;
    const hasBarriers = wtoAvailable && this.barriersData && this.barriersData.barriers?.length > 0;
    const hasRevenue = this.revenueData && this.revenueData.months?.length > 0;
    const hasComtrade = this.comtradeData && this.comtradeData.flows?.length > 0;

    if (!wtoAvailable && !hasRevenue && !hasComtrade) {
      this.setContent(`<div class="economic-empty">${t('components.tradePolicy.apiKeyMissing')}</div>`);
      return;
    }

    if (!wtoAvailable && this.activeTab !== 'revenue' && this.activeTab !== 'comtrade') {
      this.activeTab = 'revenue';
    }

    const tabsHtml = `
      <div class="panel-tabs">
        ${wtoAvailable ? `<button class="panel-tab ${this.activeTab === 'restrictions' ? 'active' : ''}" data-tab="restrictions">
          ${t('components.tradePolicy.overview')}
        </button>` : ''}
        ${hasTariffs ? `<button class="panel-tab ${this.activeTab === 'tariffs' ? 'active' : ''}" data-tab="tariffs">
          ${t('components.tradePolicy.tariffs')}
        </button>` : ''}
        ${hasFlows ? `<button class="panel-tab ${this.activeTab === 'flows' ? 'active' : ''}" data-tab="flows">
          ${t('components.tradePolicy.flows')}
        </button>` : ''}
        ${hasBarriers ? `<button class="panel-tab ${this.activeTab === 'barriers' ? 'active' : ''}" data-tab="barriers">
          ${t('components.tradePolicy.barriers')}
        </button>` : ''}
        ${hasRevenue ? `<button class="panel-tab ${this.activeTab === 'revenue' ? 'active' : ''}" data-tab="revenue">
          ${t('components.tradePolicy.revenue')}
        </button>` : ''}
        ${hasComtrade ? `<button class="panel-tab ${this.activeTab === 'comtrade' ? 'active' : ''}" data-tab="comtrade">
          ${t('components.tradePolicy.strategicFlows')}
        </button>` : ''}
      </div>
    `;

    const activeHasData = this.activeTab === 'restrictions'
      ? (this.restrictionsData?.restrictions?.length ?? 0) > 0
      : this.activeTab === 'tariffs'
      ? (this.tariffsData?.datapoints?.length ?? 0) > 0
      : this.activeTab === 'flows'
      ? (this.flowsData?.flows?.length ?? 0) > 0
      : this.activeTab === 'barriers'
      ? (this.barriersData?.barriers?.length ?? 0) > 0
      : this.activeTab === 'comtrade'
      ? (this.comtradeData?.flows?.length ?? 0) > 0
      : (this.revenueData?.months?.length ?? 0) > 0;
    const activeData = this.activeTab === 'restrictions' ? this.restrictionsData
      : this.activeTab === 'tariffs' ? this.tariffsData
      : this.activeTab === 'flows' ? this.flowsData
      : this.activeTab === 'barriers' ? this.barriersData
      : this.activeTab === 'comtrade' ? this.comtradeData
      : this.revenueData;
    const unavailableBanner = !activeHasData && activeData?.upstreamUnavailable
      ? `<div class="economic-warning">${this.activeTab === 'revenue' ? t('components.tradePolicy.treasuryUnavailable') : this.activeTab === 'comtrade' ? t('components.tradePolicy.comtradeUnavailable') : t('components.tradePolicy.upstreamUnavailable')}</div>`
      : '';

    let contentHtml = '';
    switch (this.activeTab) {
      case 'restrictions': contentHtml = this.renderRestrictions(); break;
      case 'tariffs': contentHtml = this.renderTariffs(); break;
      case 'flows': contentHtml = this.renderFlows(); break;
      case 'barriers': contentHtml = this.renderBarriers(); break;
      case 'revenue': contentHtml = this.renderRevenue(); break;
      case 'comtrade': contentHtml = this.renderComtradeFlows(); break;
    }

    const source = this.activeTab === 'comtrade' ? t('components.tradePolicy.sourceComtrade')
      : this.activeTab === 'revenue' ? t('components.tradePolicy.sourceTreasury')
      : (this.activeTab === 'tariffs' || this.activeTab === 'restrictions') && this.tariffsData?.effectiveTariffRate?.sourceName
      ? `${t('components.tradePolicy.sourceWto')} / ${this.tariffsData.effectiveTariffRate.sourceName}`
      : t('components.tradePolicy.sourceWto');

    this.setContent(`
      ${tabsHtml}
      ${unavailableBanner}
      <div class="economic-content">${contentHtml}</div>
      <div class="economic-footer">
        <span class="economic-source">${escapeHtml(source)}</span>
      </div>
    `);

  }

  private renderRestrictions(): string {
    if (!this.restrictionsData || !this.restrictionsData.restrictions?.length) {
      return `<div class="economic-empty">${t('components.tradePolicy.noOverviewData')}</div>`;
    }

    return `${this.renderRestrictionsContext()}
    <div class="trade-restrictions-list">
      ${this.restrictionsData.restrictions.map(r => {
        const statusClass = r.status === 'high' ? 'status-active' : r.status === 'moderate' ? 'status-notified' : 'status-terminated';
        const statusLabel = r.status === 'high' ? t('components.tradePolicy.highTariff') : r.status === 'moderate' ? t('components.tradePolicy.moderateTariff') : t('components.tradePolicy.lowTariff');
        const sourceLink = this.renderSourceUrl(r.sourceUrl);
        return `<div class="trade-restriction-card">
          <div class="trade-restriction-header">
            <span class="trade-country">${escapeHtml(r.reportingCountry)}</span>
            <span class="trade-badge">${escapeHtml(r.measureType)}</span>
            <span class="trade-status ${statusClass}">${statusLabel}</span>
          </div>
          <div class="trade-restriction-body">
            <div class="trade-sector">${escapeHtml(r.productSector)}</div>
            ${r.description ? `<div class="trade-description">${escapeHtml(r.description)}</div>` : ''}
            ${this.renderRestrictionEffectiveContext(r.reportingCountry)}
            ${r.affectedCountry ? `<div class="trade-affected">Affects: ${escapeHtml(r.affectedCountry)}</div>` : ''}
          </div>
          <div class="trade-restriction-footer">
            ${r.notifiedAt ? `<span class="trade-date">${escapeHtml(r.notifiedAt)}</span>` : ''}
            ${sourceLink}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  private renderRestrictionsContext(): string {
    const gapSummary = this.getEffectiveTariffGapSummary();
    if (!gapSummary) {
      return `<div class="trade-policy-note">${t('components.tradePolicy.overviewNoteNoEffective')}</div>`;
    }

    const gapSign = gapSummary.gap > 0 ? '+' : '';
    const sourceLink = this.renderSourceUrl(gapSummary.effectiveRate.sourceUrl);
    return `<div class="trade-policy-note">
      ${t('components.tradePolicy.usBaselineLabel')}: <strong>${gapSummary.baseline.tariffRate.toFixed(1)}%</strong>.
      ${t('components.tradePolicy.effectiveTariffRateLabel')}: <strong>${gapSummary.effectiveRate.tariffRate.toFixed(1)}%</strong>.
      ${t('components.tradePolicy.gapLabel')}: <strong>${gapSign}${gapSummary.gap.toFixed(1)}pp</strong>.
      ${t('components.tradePolicy.overviewNoteTail')}
      ${sourceLink}
    </div>`;
  }

  private renderTariffs(): string {
    if (!this.tariffsData || !this.tariffsData.datapoints?.length) {
      return `<div class="economic-empty">${t('components.tradePolicy.noTariffData')}</div>`;
    }

    const sortedDatapoints = [...this.tariffsData.datapoints].sort((a, b) => b.year - a.year);
    const latestBaseline = sortedDatapoints[0] ?? null;
    const effectiveRate = this.tariffsData.effectiveTariffRate ?? null;
    const summaryHtml = this.renderTariffSummary(latestBaseline, effectiveRate);

    const rows = sortedDatapoints.map(d =>
      `<tr>
        <td>${d.year}</td>
        <td>${d.tariffRate.toFixed(1)}%</td>
        <td>${escapeHtml(d.productSector || '—')}</td>
      </tr>`
    ).join('');

    return `${summaryHtml}
    <div class="trade-tariffs-table">
      <table>
        <thead>
          <tr>
            <th>Year</th>
            <th>${t('components.tradePolicy.mfnAppliedRate')}</th>
            <th>Sector</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private renderTariffSummary(latestBaseline: TariffDataPoint | null, effectiveRate: EffectiveTariffRate | null): string {
    if (!latestBaseline) return '';

    const baselineMeta = t('components.tradePolicy.wtoBaselineMeta', { year: String(latestBaseline.year) });
    const baselineCard = `
      <div class="trade-tariff-card">
        <div class="trade-tariff-label">${t('components.tradePolicy.baselineMfnTariff')}</div>
        <div class="trade-tariff-value">${latestBaseline.tariffRate.toFixed(1)}%</div>
        <div class="trade-tariff-meta">${escapeHtml(baselineMeta)}</div>
      </div>
    `;

    if (!effectiveRate) {
      return `<div class="trade-tariff-summary">
        ${baselineCard}
        <div class="trade-tariff-card trade-tariff-card-muted">
          <div class="trade-tariff-label">${t('components.tradePolicy.effectiveTariffRateLabel')}</div>
          <div class="trade-tariff-value">—</div>
          <div class="trade-tariff-meta">${t('components.tradePolicy.noEffectiveCoverageForCountry')}</div>
        </div>
      </div>`;
    }

    const gap = effectiveRate.tariffRate - latestBaseline.tariffRate;
    const gapSign = gap > 0 ? '+' : '';
    const gapClass = gap >= 0 ? 'trade-tariff-gap-positive' : 'trade-tariff-gap-negative';
    const effectiveMetaParts = [
      effectiveRate.sourceName,
      effectiveRate.observationPeriod,
      effectiveRate.updatedAt ? `Updated ${effectiveRate.updatedAt}` : '',
    ].filter(Boolean);
    const sourceLink = this.renderSourceUrl(effectiveRate.sourceUrl);

    return `<div class="trade-tariff-summary">
      ${baselineCard}
      <div class="trade-tariff-card">
        <div class="trade-tariff-label">${t('components.tradePolicy.effectiveTariffRateLabel')}</div>
        <div class="trade-tariff-value">${effectiveRate.tariffRate.toFixed(1)}%</div>
        <div class="trade-tariff-meta">
          ${escapeHtml(effectiveMetaParts.join(' | '))}
          ${sourceLink ? `<span class="trade-tariff-source">${sourceLink}</span>` : ''}
        </div>
      </div>
      <div class="trade-tariff-card">
        <div class="trade-tariff-label">${t('components.tradePolicy.gapLabel')}</div>
        <div class="trade-tariff-value ${gapClass}">${gapSign}${gap.toFixed(1)}pp</div>
        <div class="trade-tariff-meta">${t('components.tradePolicy.effectiveMinusBaseline')}</div>
      </div>
    </div>`;
  }

  private getLatestBaselineTariffPoint(): TariffDataPoint | null {
    if (!this.tariffsData?.datapoints?.length) return null;
    return [...this.tariffsData.datapoints].sort((a, b) => b.year - a.year)[0] ?? null;
  }

  private getEffectiveTariffGapSummary(): { baseline: TariffDataPoint; effectiveRate: EffectiveTariffRate; gap: number } | null {
    const baseline = this.getLatestBaselineTariffPoint();
    const effectiveRate = this.tariffsData?.effectiveTariffRate ?? null;
    if (!baseline || !effectiveRate) return null;
    return {
      baseline,
      effectiveRate,
      gap: effectiveRate.tariffRate - baseline.tariffRate,
    };
  }

  private renderRestrictionEffectiveContext(reportingCountry: string): string {
    if (reportingCountry !== 'United States') return '';
    const gapSummary = this.getEffectiveTariffGapSummary();
    if (!gapSummary) return '';
    const gapSign = gapSummary.gap > 0 ? '+' : '';
    return `<div class="trade-policy-inline-note">
      ${t('components.tradePolicy.effectiveTariffRateLabel')}: ${gapSummary.effectiveRate.tariffRate.toFixed(1)}%
      <span class="trade-policy-inline-sep">|</span>
      ${t('components.tradePolicy.gapVsMfnLabel')}: ${gapSign}${gapSummary.gap.toFixed(1)}pp
    </div>`;
  }

  private renderFlows(): string {
    if (!this.flowsData || !this.flowsData.flows?.length) {
      return `<div class="economic-empty">${t('components.tradePolicy.noFlowData')}</div>`;
    }

    return `<div class="trade-flows-list">
      ${this.flowsData.flows.map(f => {
        const exportArrow = f.yoyExportChange >= 0 ? '\u25B2' : '\u25BC';
        const importArrow = f.yoyImportChange >= 0 ? '\u25B2' : '\u25BC';
        const exportClass = f.yoyExportChange >= 0 ? 'change-positive' : 'change-negative';
        const importClass = f.yoyImportChange >= 0 ? 'change-positive' : 'change-negative';
        return `<div class="trade-flow-card">
          <div class="trade-flow-year">${f.year}</div>
          <div class="trade-flow-metrics">
            <div class="trade-flow-metric">
              <span class="trade-flow-label">${t('components.tradePolicy.exports')}</span>
              <span class="trade-flow-value">$${f.exportValueUsd.toFixed(0)}M</span>
              <span class="trade-flow-change ${exportClass}">${exportArrow} ${Math.abs(f.yoyExportChange).toFixed(1)}%</span>
            </div>
            <div class="trade-flow-metric">
              <span class="trade-flow-label">${t('components.tradePolicy.imports')}</span>
              <span class="trade-flow-value">$${f.importValueUsd.toFixed(0)}M</span>
              <span class="trade-flow-change ${importClass}">${importArrow} ${Math.abs(f.yoyImportChange).toFixed(1)}%</span>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  private renderBarriers(): string {
    if (!this.barriersData || !this.barriersData.barriers?.length) {
      return `<div class="economic-empty">${t('components.tradePolicy.noBarriers')}</div>`;
    }

    return `<div class="trade-barriers-list">
      ${this.barriersData.barriers.map(b => {
        const sourceLink = this.renderSourceUrl(b.sourceUrl);
        return `<div class="trade-barrier-card">
          <div class="trade-barrier-header">
            <span class="trade-country">${escapeHtml(b.notifyingCountry)}</span>
            <span class="trade-badge">${escapeHtml(b.measureType)}</span>
          </div>
          <div class="trade-barrier-body">
            <div class="trade-barrier-title">${escapeHtml(b.title)}</div>
            ${b.productDescription ? `<div class="trade-sector">${escapeHtml(b.productDescription)}</div>` : ''}
            ${b.objective ? `<div class="trade-description">${escapeHtml(b.objective)}</div>` : ''}
          </div>
          <div class="trade-barrier-footer">
            ${b.dateDistributed ? `<span class="trade-date">${escapeHtml(b.dateDistributed)}</span>` : ''}
            ${sourceLink}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  private renderRevenue(): string {
    if (!this.revenueData || !this.revenueData.months?.length) {
      return `<div class="economic-empty">${t('components.tradePolicy.noRevenueData')}</div>`;
    }

    const months = this.revenueData.months;
    const latest = months[months.length - 1]!;
    const latestFy = latest.fiscalYear;

    const currentFyMonths = months.filter(m => m.fiscalYear === latestFy);
    const currentFyCount = currentFyMonths.length;
    const priorFyAll = months.filter(m => m.fiscalYear === latestFy - 1);
    const priorFyMonths = priorFyAll.slice(0, currentFyCount);
    const currentFytd = currentFyMonths.reduce((s, m) => s + m.monthlyAmountBillions, 0);
    const priorFytd = priorFyMonths.reduce((s, m) => s + m.monthlyAmountBillions, 0);
    const yoyChange = priorFytd > 0 ? ((currentFytd - priorFytd) / priorFytd) * 100 : 0;
    const changeClass = yoyChange >= 0 ? 'change-negative' : 'change-positive';
    const arrow = yoyChange >= 0 ? '\u25B2' : '\u25BC';

    const summaryHtml = `
      <div class="trade-revenue-summary">
        <div class="trade-revenue-headline">
          <span class="trade-revenue-label">${t('components.tradePolicy.fytdLabel', { year: String(latestFy) })}</span>
          <span class="trade-revenue-value">$${currentFytd.toFixed(1)}B</span>
        </div>
        <div class="trade-revenue-compare">
          ${t('components.tradePolicy.vsPriorFy', { year: String(latestFy - 1) })}: $${priorFytd.toFixed(1)}B
          <span class="${changeClass}">${arrow} ${Math.abs(yoyChange).toFixed(0)}%</span>
        </div>
      </div>
    `;

    const priorAvg = priorFyMonths.length > 0 ? priorFytd / priorFyMonths.length : 0;

    const chartMonths = [...months].slice(-12);
    const maxVal = Math.max(...chartMonths.map(m => m.monthlyAmountBillions), 1);
    const chartBars = chartMonths.map(m => {
      const pct = Math.round((m.monthlyAmountBillions / maxVal) * 100);
      const label = m.recordDate.slice(0, 7);
      const isSpike = m.monthlyAmountBillions > priorAvg * 1.5;
      return `<div class="trade-chart-col" title="${label}: $${m.monthlyAmountBillions.toFixed(1)}B">
        <div class="trade-chart-bar${isSpike ? ' trade-chart-spike' : ''}" style="height:${pct}%"></div>
        <div class="trade-chart-label">${m.recordDate.slice(5, 7)}</div>
      </div>`;
    }).join('');

    const chartHtml = `<div class="trade-revenue-chart">${chartBars}</div>`;

    const rows = [...months].reverse().slice(0, 24).map(m => {
      const highlight = m.monthlyAmountBillions > priorAvg * 2 ? ' class="trade-revenue-spike"' : '';
      return `<tr${highlight}>
        <td>${m.recordDate}</td>
        <td>$${m.monthlyAmountBillions.toFixed(1)}B</td>
        <td>$${m.fytdAmountBillions.toFixed(1)}B</td>
      </tr>`;
    }).join('');

    return `${summaryHtml}
    ${chartHtml}
    <div class="trade-tariffs-table">
      <table>
        <thead>
          <tr>
            <th>${t('components.tradePolicy.colDate')}</th>
            <th>${t('components.tradePolicy.colMonthly')}</th>
            <th>${t('components.tradePolicy.colFytd')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private renderComtradeFlows(): string {
    const flows = this.comtradeData?.flows;
    if (!flows?.length) {
      return `<div class="economic-empty">${t('components.tradePolicy.noComtradeData')}</div>`;
    }

    // Prefer world-total rows: UN Comtrade API returns partnerCode as integer 0 for world aggregates,
    // stored as string "0"; "000" is the seed fallback default. If no world-total rows exist
    // (bilateral-only preview data), fall back to all flows so the table is never empty.
    // Two-step dedup: (1) within same (reporter, cmd, year) keep max tradeValueUsd
    //   — world-total path: disambiguates exports vs imports; fallback path: keeps highest-value bilateral entry;
    // (2) then keep latest year per (reporter, cmd).
    const worldTotals = flows.filter(f => f.partnerCode === '0' || f.partnerCode === '000');
    const toDedup = worldTotals.length > 0 ? worldTotals : flows;
    const byYearDominant = new Map<string, typeof flows[0]>();
    for (const f of toDedup) {
      const key = `${f.reporterCode}:${f.cmdCode}:${f.year}`;
      const existing = byYearDominant.get(key);
      if (!existing || f.tradeValueUsd > existing.tradeValueUsd) byYearDominant.set(key, f);
    }
    const latest = new Map<string, typeof flows[0]>();
    for (const f of byYearDominant.values()) {
      const key = `${f.reporterCode}:${f.cmdCode}`;
      const existing = latest.get(key);
      if (!existing || f.year > existing.year) latest.set(key, f);
    }

    const sorted = [...latest.values()].sort((a, b) => {
      if (a.isAnomaly !== b.isAnomaly) return a.isAnomaly ? -1 : 1;
      return Math.abs(b.yoyChange) - Math.abs(a.yoyChange);
    });

    const rows = sorted.map(f => {
      const yoySign = f.yoyChange >= 0 ? '▲' : '▼';
      const yoyClass = f.yoyChange >= 0 ? 'change-positive' : 'change-negative';
      const yoyPct = `${yoySign} ${Math.abs(f.yoyChange * 100).toFixed(0)}%`;
      const valueStr = f.tradeValueUsd >= 1e9
        ? `$${(f.tradeValueUsd / 1e9).toFixed(1)}B`
        : `$${(f.tradeValueUsd / 1e6).toFixed(0)}M`;
      const anomalyBadge = f.isAnomaly
        ? `<span style="margin-left:6px;font-size:9px;font-weight:600;letter-spacing:0.05em;padding:1px 5px;border-radius:3px;background:rgba(255,68,68,0.15);color:var(--red);vertical-align:middle;text-transform:uppercase">${t('components.tradePolicy.anomalyBadge')}</span>`
        : '';
      return `<tr class="${f.isAnomaly ? 'trade-anomaly-row' : ''}">
        <td>${escapeHtml(f.reporterName)}${anomalyBadge}</td>
        <td>${escapeHtml(f.cmdDesc)}</td>
        <td>${valueStr} <span class="trade-flow-year">${f.year}</span></td>
        <td class="${yoyClass}">${yoyPct}</td>
      </tr>`;
    }).join('');

    return `<div class="trade-tariffs-table">
      <table>
        <thead><tr>
          <th>${t('components.tradePolicy.colReporter')}</th>
          <th>${t('components.tradePolicy.colCommodity')}</th>
          <th>${t('components.tradePolicy.colTradeValue')}</th>
          <th>${t('components.tradePolicy.yoyChange')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private renderSourceUrl(url: string): string {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="trade-source-link">Source</a>`;
      }
    } catch { /* invalid URL */ }
    return '';
  }
}
