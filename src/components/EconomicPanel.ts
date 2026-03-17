import { Panel } from './Panel';
import type { FredSeries, BisData } from '@/services/economic';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import type { SpendingSummary } from '@/services/usa-spending';
import { formatAwardAmount, getAwardTypeIcon } from '@/services/usa-spending';
import { getCSSColor } from '@/utils';

type TabId = 'indicators' | 'spending' | 'centralBanks';

function formatSeriesValue(series: FredSeries): string {
  if (series.value === null) return 'N/A';
  if (series.unit === '$B') return `$${series.value.toLocaleString()}B`;
  return `${series.value.toLocaleString()}${series.unit}`;
}

function formatSeriesChange(series: FredSeries): string {
  if (series.change === null) return 'No change';
  const sign = series.change > 0 ? '+' : '';
  if (series.unit === '$B') {
    const prefix = series.change < 0 ? '-$' : `${sign}$`;
    return `${prefix}${Math.abs(series.change).toLocaleString()}B`;
  }
  return `${sign}${series.change.toLocaleString()}${series.unit}`;
}

function getSeriesChangeClass(change: number | null): string {
  if (change === null || change === 0) return 'neutral';
  return change > 0 ? 'positive' : 'negative';
}

function getMacroPressure(data: FredSeries[]): {
  label: string;
  detail: string;
  className: string;
} {
  const byId = new Map(data.map((series) => [series.id, series]));
  const vix = byId.get('VIXCLS')?.value ?? null;
  const curve = byId.get('T10Y2Y')?.value ?? null;
  const unemployment = byId.get('UNRATE')?.value ?? null;
  const fedFunds = byId.get('FEDFUNDS')?.value ?? null;

  let score = 0;
  if (vix !== null) score += vix >= 25 ? 2 : vix >= 18 ? 1 : 0;
  if (curve !== null) score += curve <= 0 ? 2 : curve < 0.5 ? 1 : 0;
  if (unemployment !== null) score += unemployment >= 4.5 ? 1 : 0;
  if (fedFunds !== null) score += fedFunds >= 5 ? 1 : fedFunds <= 2 ? -1 : 0;

  if (score >= 4) {
    return {
      label: t('components.economic.pressure.stress'),
      detail: t('components.economic.pressure.stressDetail'),
      className: 'macro-pressure-stress',
    };
  }
  if (score >= 2) {
    return {
      label: t('components.economic.pressure.watch'),
      detail: t('components.economic.pressure.watchDetail'),
      className: 'macro-pressure-watch',
    };
  }
  return {
    label: t('components.economic.pressure.steady'),
    detail: t('components.economic.pressure.steadyDetail'),
    className: 'macro-pressure-steady',
  };
}

export class EconomicPanel extends Panel {
  private fredData: FredSeries[] = [];
  private spendingData: SpendingSummary | null = null;
  private bisData: BisData | null = null;
  private lastUpdate: Date | null = null;
  private activeTab: TabId = 'indicators';

  constructor() {
    super({
      id: 'economic',
      title: t('panels.economic'),
      defaultRowSpan: 2,
      infoTooltip: t('components.economic.infoTooltip'),
    });
    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.panel-tab') as HTMLElement | null;
      if (tab?.dataset.tab) {
        this.activeTab = tab.dataset.tab as TabId;
        this.render();
      }
    });
  }

  public update(data: FredSeries[]): void {
    this.fredData = data;
    this.lastUpdate = new Date();
    this.render();
  }

  public updateSpending(data: SpendingSummary): void {
    this.spendingData = data;
    this.render();
  }

  public updateBis(data: BisData): void {
    this.bisData = data;
    this.render();
  }

  public setLoading(loading: boolean): void {
    if (loading) this.showLoading();
  }

  private render(): void {
    const hasSpending = this.spendingData && this.spendingData.awards?.length > 0;
    const hasBis = this.bisData && this.bisData.policyRates?.length > 0;

    const tabsHtml = `
      <div class="panel-tabs">
        <button class="panel-tab ${this.activeTab === 'indicators' ? 'active' : ''}" data-tab="indicators">
          ${t('components.economic.indicators')}
        </button>
        ${hasSpending ? `
          <button class="panel-tab ${this.activeTab === 'spending' ? 'active' : ''}" data-tab="spending">
            ${t('components.economic.gov')}
          </button>
        ` : ''}
        ${hasBis ? `
          <button class="panel-tab ${this.activeTab === 'centralBanks' ? 'active' : ''}" data-tab="centralBanks">
            ${t('components.economic.centralBanks')}
          </button>
        ` : ''}
      </div>
    `;

    let contentHtml = '';
    switch (this.activeTab) {
      case 'indicators':
        contentHtml = this.renderIndicators();
        break;
      case 'spending':
        contentHtml = this.renderSpending();
        break;
      case 'centralBanks':
        contentHtml = this.renderCentralBanks();
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
  }

  private getSourceLabel(): string {
    switch (this.activeTab) {
      case 'indicators': return 'FRED';
      case 'spending': return 'USASpending.gov';
      case 'centralBanks': return 'BIS';
    }
  }

  private renderIndicators(): string {
    if (this.fredData.length === 0) {
      if (isDesktopRuntime() && !isFeatureAvailable('economicFred')) {
        return `<div class="economic-empty">${t('components.economic.fredKeyMissing')}</div>`;
      }
      return `<div class="economic-empty">${t('components.economic.noIndicatorData')}</div>`;
    }

    const pressure = getMacroPressure(this.fredData);
    const summaryIds = ['VIXCLS', 'T10Y2Y', 'FEDFUNDS', 'UNRATE'];
    const summarySeries = this.fredData.filter((series) => summaryIds.includes(series.id));
    const detailSeries = this.fredData.filter((series) => !summaryIds.includes(series.id));
    const orderedSeries = [...summarySeries, ...detailSeries];

    return `
      <div class="economic-content-macro">
        <div class="macro-pressure-card ${pressure.className}">
          <div class="macro-pressure-label">${t('components.economic.pressure.label')}</div>
          <div class="macro-pressure-value">${escapeHtml(pressure.label)}</div>
          <div class="macro-pressure-detail">${escapeHtml(pressure.detail)}</div>
        </div>
        <div class="macro-summary-grid">
          ${summarySeries.map((series) => `
            <div class="macro-summary-card">
              <div class="macro-summary-head">
                <span class="indicator-name">${escapeHtml(series.name)}</span>
                <span class="indicator-id">${escapeHtml(series.id)}</span>
              </div>
              <div class="macro-summary-value">${escapeHtml(formatSeriesValue(series))}</div>
              <div class="macro-summary-change ${getSeriesChangeClass(series.change)}">${escapeHtml(formatSeriesChange(series))}</div>
            </div>
          `).join('')}
        </div>
        <div class="economic-indicators">
          ${orderedSeries.map((series) => `
            <div class="economic-indicator" data-series="${escapeHtml(series.id)}">
              <div class="indicator-header">
                <span class="indicator-name">${escapeHtml(series.name)}</span>
                <span class="indicator-id">${escapeHtml(series.id)}</span>
              </div>
              <div class="indicator-value">
                <span class="value">${escapeHtml(formatSeriesValue(series))}</span>
                <span class="change ${getSeriesChangeClass(series.change)}">${escapeHtml(formatSeriesChange(series))}</span>
              </div>
              <div class="indicator-date">${escapeHtml(series.date)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  private renderSpending(): string {
    if (!this.spendingData || !this.spendingData.awards?.length) {
      return `<div class="economic-empty">${t('components.economic.noSpending')}</div>`;
    }

    const { awards, totalAmount, periodStart, periodEnd } = this.spendingData;

    return `
      <div class="spending-summary">
        <div class="spending-total">
          ${escapeHtml(formatAwardAmount(totalAmount))} ${t('components.economic.in')} ${escapeHtml(String(awards.length))} ${t('components.economic.awards')}
          <span class="spending-period">${escapeHtml(periodStart)} / ${escapeHtml(periodEnd)}</span>
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

  private renderCentralBanks(): string {
    if (!this.bisData || !this.bisData.policyRates?.length) {
      return `<div class="economic-empty">${t('components.economic.noBisData')}</div>`;
    }

    const greenColor = getCSSColor('--semantic-normal');
    const redColor = getCSSColor('--semantic-critical');
    const neutralColor = getCSSColor('--text-dim');

    const sortedRates = [...this.bisData.policyRates].sort((a, b) => b.rate - a.rate);
    const policyHtml = `
      <div class="bis-section">
        <div class="bis-section-title">${t('components.economic.policyRate')}</div>
        <div class="economic-indicators">
          ${sortedRates.map(r => {
      const diff = r.rate - r.previousRate;
      const color = diff < 0 ? greenColor : diff > 0 ? redColor : neutralColor;
      const label = diff < 0 ? t('components.economic.cut') : diff > 0 ? t('components.economic.hike') : t('components.economic.hold');
      const arrow = diff < 0 ? '▼' : diff > 0 ? '▲' : '–';
      return `
              <div class="economic-indicator">
                <div class="indicator-header">
                  <span class="indicator-name">${escapeHtml(r.centralBank)}</span>
                  <span class="indicator-id">${escapeHtml(r.countryCode)}</span>
                </div>
                <div class="indicator-value">
                  <span class="value">${escapeHtml(String(r.rate))}%</span>
                  <span class="change" style="color: ${escapeHtml(color)}">${escapeHtml(arrow)} ${escapeHtml(label)}</span>
                </div>
                <div class="indicator-date">${escapeHtml(r.date)}</div>
              </div>`;
    }).join('')}
        </div>
      </div>
    `;

    let eerHtml = '';
    if (this.bisData.exchangeRates?.length > 0) {
      eerHtml = `
        <div class="bis-section">
          <div class="bis-section-title">${t('components.economic.realEer')}</div>
          <div class="economic-indicators">
            ${this.bisData.exchangeRates.map(r => {
        const color = r.realChange > 0 ? redColor : r.realChange < 0 ? greenColor : neutralColor;
        const arrow = r.realChange > 0 ? '▲' : r.realChange < 0 ? '▼' : '–';
        return `
                <div class="economic-indicator">
                  <div class="indicator-header">
                    <span class="indicator-name">${escapeHtml(r.countryName)}</span>
                    <span class="indicator-id">${escapeHtml(r.countryCode)}</span>
                  </div>
                  <div class="indicator-value">
                    <span class="value">${escapeHtml(String(r.realEer))}</span>
                    <span class="change" style="color: ${escapeHtml(color)}">${escapeHtml(arrow)} ${escapeHtml(String(r.realChange > 0 ? '+' : ''))}${escapeHtml(String(r.realChange))}%</span>
                  </div>
                  <div class="indicator-date">${escapeHtml(r.date)}</div>
                </div>`;
      }).join('')}
          </div>
        </div>
      `;
    }

    let creditHtml = '';
    if (this.bisData.creditToGdp?.length > 0) {
      const sortedCredit = [...this.bisData.creditToGdp].sort((a, b) => b.creditGdpRatio - a.creditGdpRatio);
      creditHtml = `
        <div class="bis-section">
          <div class="bis-section-title">${t('components.economic.creditToGdp')}</div>
          <div class="economic-indicators">
            ${sortedCredit.map(r => {
        const diff = r.creditGdpRatio - r.previousRatio;
        const color = diff > 0 ? redColor : diff < 0 ? greenColor : neutralColor;
        const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '–';
        const changeStr = diff !== 0 ? `${diff > 0 ? '+' : ''}${(Math.round(diff * 10) / 10)}pp` : '–';
        return `
                <div class="economic-indicator">
                  <div class="indicator-header">
                    <span class="indicator-name">${escapeHtml(r.countryName)}</span>
                    <span class="indicator-id">${escapeHtml(r.countryCode)}</span>
                  </div>
                  <div class="indicator-value">
                    <span class="value">${escapeHtml(String(r.creditGdpRatio))}%</span>
                    <span class="change" style="color: ${escapeHtml(color)}">${escapeHtml(arrow)} ${escapeHtml(changeStr)}</span>
                  </div>
                  <div class="indicator-date">${escapeHtml(r.date)}</div>
                </div>`;
      }).join('')}
          </div>
        </div>
      `;
    }

    return policyHtml + eerHtml + creditHtml;
  }
}
