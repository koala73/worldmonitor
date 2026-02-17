import { Panel } from './Panel';
import type { FredSeries } from '@/services/fred';
import { t } from '@/services/i18n';
import type { OilAnalytics } from '@/services/oil-analytics';
import type { SpendingSummary } from '@/services/usa-spending';
import { getChangeClass, formatChange } from '@/services/fred';
import { formatOilValue, getTrendIndicator, getTrendColor } from '@/services/oil-analytics';
import { formatAwardAmount, getAwardTypeIcon } from '@/services/usa-spending';
import { escapeHtml } from '@/utils/sanitize';

type TabId = 'indicators' | 'oil' | 'spending';

export class EconomicPanel extends Panel {
  private fredData: FredSeries[] = [];
  private oilData: OilAnalytics | null = null;
  private spendingData: SpendingSummary | null = null;
  private lastUpdate: Date | null = null;
  private activeTab: TabId = 'indicators';

  constructor() {
    super({ id: 'economic', title: t('panels.economic') });
  }

  public update(data: FredSeries[]): void {
    this.fredData = data;
    this.lastUpdate = new Date();
    this.render();
  }

  public updateOil(data: OilAnalytics): void {
    this.oilData = data;
    this.render();
  }

  public updateSpending(data: SpendingSummary): void {
    this.spendingData = data;
    this.render();
  }

  public setLoading(loading: boolean): void {
    if (loading) {
      this.showLoading();
    }
  }

  private render(): void {
    const hasOil = this.oilData && (this.oilData.wtiPrice || this.oilData.brentPrice);
    const hasSpending = this.spendingData && this.spendingData.awards.length > 0;

    // Build tabs HTML
    const tabsHtml = `
      <div class="economic-tabs">
        <button class="economic-tab ${this.activeTab === 'indicators' ? 'active' : ''}" data-tab="indicators">
          📊 ${t('components.economic.indicators')}
        </button>
        ${hasOil ? `
          <button class="economic-tab ${this.activeTab === 'oil' ? 'active' : ''}" data-tab="oil">
            🛢️ ${t('components.economic.oil')}
          </button>
        ` : ''}
        ${hasSpending ? `
          <button class="economic-tab ${this.activeTab === 'spending' ? 'active' : ''}" data-tab="spending">
            🏛️ ${t('components.economic.gov')}
          </button>
        ` : ''}
      </div>
    `;

    let contentHtml = '';

    switch (this.activeTab) {
      case 'indicators':
        contentHtml = this.renderIndicators();
        break;
      case 'oil':
        contentHtml = this.renderOil();
        break;
      case 'spending':
        contentHtml = this.renderSpending();
        break;
    }

    const updateTime = this.lastUpdate
      ? this.lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    this.setContent(`
      ${tabsHtml}
      <div class="economic-content">
        ${contentHtml}
      </div>
      <div class="economic-footer">
        <span class="economic-source">${this.getSourceLabel()} • ${updateTime}</span>
      </div>
    `);

    // Bind tab click events
    this.content.querySelectorAll('.economic-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabId = (e.target as HTMLElement).dataset.tab as TabId;
        if (tabId) {
          this.activeTab = tabId;
          this.render();
        }
      });
    });
  }

  private getSourceLabel(): string {
    switch (this.activeTab) {
      case 'indicators': return 'FRED';
      case 'oil': return 'EIA';
      case 'spending': return 'USASpending.gov';
    }
  }

  private renderIndicators(): string {
    if (this.fredData.length === 0) {
      return `<div class="economic-empty">${t('components.economic.noIndicatorData')}</div>`;
    }

    return `
      <div class="economic-indicators">
        ${this.fredData.map(series => {
      const changeClass = getChangeClass(series.change);
      const changeStr = formatChange(series.change, series.unit);
      const arrow = series.change !== null
        ? (series.change > 0 ? '▲' : series.change < 0 ? '▼' : '–')
        : '';

      return `
            <div class="economic-indicator" data-series="${escapeHtml(series.id)}">
              <div class="indicator-header">
                <span class="indicator-name">${escapeHtml(series.name)}</span>
                <span class="indicator-id">${escapeHtml(series.id)}</span>
              </div>
              <div class="indicator-value">
                <span class="value">${escapeHtml(String(series.value !== null ? series.value : 'N/A'))}${escapeHtml(series.unit)}</span>
                <span class="change ${escapeHtml(changeClass)}">${escapeHtml(arrow)} ${escapeHtml(changeStr)}</span>
              </div>
              <div class="indicator-date">${escapeHtml(series.date)}</div>
            </div>
          `;
    }).join('')}
      </div>
    `;
  }

  private renderOil(): string {
    if (!this.oilData) {
      return `<div class="economic-empty">${t('components.economic.noOilDataRetry')}</div>`;
    }

    const metrics = [
      this.oilData.wtiPrice,
      this.oilData.brentPrice,
      this.oilData.usProduction,
      this.oilData.usInventory,
    ].filter(Boolean);

    if (metrics.length === 0) {
      return `<div class="economic-empty">${t('components.economic.noOilMetrics')}</div>`;
    }

    return `
      <div class="economic-indicators oil-metrics">
        ${metrics.map(metric => {
      if (!metric) return '';
      const trendIcon = getTrendIndicator(metric.trend);
      const trendColor = getTrendColor(metric.trend, metric.name.includes('Production'));

      return `
            <div class="economic-indicator oil-metric">
              <div class="indicator-header">
                <span class="indicator-name">${escapeHtml(metric.name)}</span>
              </div>
              <div class="indicator-value">
                <span class="value">${escapeHtml(formatOilValue(metric.current, metric.unit))} ${escapeHtml(metric.unit)}</span>
                <span class="change" style="color: ${escapeHtml(trendColor)}">
                  ${escapeHtml(trendIcon)} ${escapeHtml(String(metric.changePct > 0 ? '+' : ''))}${escapeHtml(String(metric.changePct))}%
                </span>
              </div>
              <div class="indicator-date">${t('components.economic.vsPreviousWeek')}</div>
            </div>
          `;
    }).join('')}
      </div>
    `;
  }

  private renderSpending(): string {
    if (!this.spendingData || this.spendingData.awards.length === 0) {
      return `<div class="economic-empty">${t('components.economic.noSpending')}</div>`;
    }

    const { awards, totalAmount, periodStart, periodEnd } = this.spendingData;

    return `
      <div class="spending-summary">
        <div class="spending-total">
          ${escapeHtml(formatAwardAmount(totalAmount))} ${t('components.economic.in')} ${escapeHtml(String(awards.length))} ${t('components.economic.awards')}
          <span class="spending-period">${escapeHtml(periodStart)} – ${escapeHtml(periodEnd)}</span>
        </div>
      </div>
      <div class="spending-list">
        ${awards.slice(0, 8).map(award => `
          <div class="spending-award">
            <div class="award-header">
              <span class="award-icon">${escapeHtml(getAwardTypeIcon(award.awardType))}</span>
              <span class="award-amount">${escapeHtml(formatAwardAmount(award.amount))}</span>
            </div>
            <div class="award-recipient">${escapeHtml(award.recipientName)}</div>
            <div class="award-agency">${escapeHtml(award.agency)}</div>
            ${award.description ? `<div class="award-desc">${escapeHtml(award.description.slice(0, 100))}${award.description.length > 100 ? '...' : ''}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }
}
