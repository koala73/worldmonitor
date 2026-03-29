import { Panel } from './Panel';
import type { FredSeries, BisData } from '@/services/economic';
import { BLS_METRO_IDS } from '@/services/economic';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import type { SpendingSummary } from '@/services/usa-spending';
import { formatAwardAmount, getAwardTypeIcon } from '@/services/usa-spending';
import { getCSSColor } from '@/utils';
import { sparkline } from '@/utils/sparkline';
import type { GetEconomicStressResponse, EconomicStressComponent } from '@/generated/client/worldmonitor/economic/v1/service_client';

type TabId = 'indicators' | 'spending' | 'centralBanks' | 'labor' | 'stress';

function stressScoreColor(score: number): string {
  if (score < 20) return '#27ae60';
  if (score < 40) return '#f1c40f';
  if (score < 60) return '#e67e22';
  if (score < 80) return '#e74c3c';
  return '#8e44ad';
}

function stressFormatRaw(id: string, raw: number): string {
  if (id === 'ICSA') return raw >= 1000 ? (raw / 1000).toFixed(0) + 'K' : raw.toFixed(0);
  if (id === 'VIXCLS') return raw.toFixed(2);
  if (id === 'STLFSI4' || id === 'GSCPI') return raw.toFixed(3);
  return raw.toFixed(2);
}

const STRESS_NOTIFICATION_KEY = 'wm:economic-stress:last-notified-level';

function notifyIfStressCrossed(score: number): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const level = score >= 85 ? 2 : score >= 70 ? 1 : 0;
  if (level === 0) return;
  try {
    const lastLevel = parseInt(sessionStorage.getItem(STRESS_NOTIFICATION_KEY) ?? '0', 10);
    if (level <= lastLevel) return;
    sessionStorage.setItem(STRESS_NOTIFICATION_KEY, String(level));
    new Notification('Economic Stress Alert', {
      body: `Composite stress index reached ${score.toFixed(1)} (${score >= 85 ? 'Critical' : 'Severe'})`,
      icon: '/favico/favicon-32x32.png',
      tag: 'economic-stress',
    });
  } catch { /* Notification API can throw in some environments */ }
}

function stressComponentCard(c: EconomicStressComponent): string {
  if (c.missing) {
    return `<div style="background:rgba(255,255,255,0.02);border-radius:6px;padding:8px 10px;border:1px solid rgba(255,255,255,0.05)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(c.label)}</span>
        <span style="font-size:10px;color:#888">N/A</span>
      </div>
      <div style="font-size:9px;color:#666;font-style:italic">Data unavailable</div>
    </div>`;
  }
  const color = stressScoreColor(c.score);
  const barWidth = Math.min(100, Math.max(0, c.score)).toFixed(1);
  const rawDisplay = stressFormatRaw(c.id, c.rawValue);
  return `<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:8px 10px;border:1px solid rgba(255,255,255,0.07)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(c.label)}</span>
      <span style="font-size:10px;color:var(--text-dim)">${escapeHtml(rawDisplay)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;background:rgba(255,255,255,0.07);border-radius:3px;height:5px;overflow:hidden">
        <div style="height:100%;width:${barWidth}%;background:${color};border-radius:3px;transition:width 0.3s"></div>
      </div>
      <span style="font-size:10px;font-weight:600;color:${color};min-width:28px;text-align:right">${c.score.toFixed(0)}</span>
    </div>
  </div>`;
}

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

type FredLoadState = 'loading' | 'ok' | 'error' | 'retrying';

export class EconomicPanel extends Panel {
  private fredData: FredSeries[] = [];
  private blsData: FredSeries[] = [];
  private spendingData: SpendingSummary | null = null;
  private bisData: BisData | null = null;
  private stressData: GetEconomicStressResponse | null = null;
  private lastUpdate: Date | null = null;
  private activeTab: TabId = 'indicators';
  private fredState: FredLoadState = 'loading';
  private fredErrorMsg = '';

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
    this.fredState = 'ok';
    this.fredErrorMsg = '';
    this.lastUpdate = new Date();
    this.render();
  }

  public setFredError(message: string): void {
    this.fredState = 'error';
    this.fredErrorMsg = message;
    this.render();
  }

  public setFredRetrying(remainingSeconds?: number): void {
    this.fredState = 'retrying';
    this.fredErrorMsg = remainingSeconds !== undefined
      ? `${t('common.retrying')} (${remainingSeconds}s)`
      : t('common.retrying');
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

  public updateBls(data: FredSeries[]): void {
    this.blsData = data;
    this.render();
  }

  public updateStress(data: GetEconomicStressResponse): void {
    this.stressData = data;
    if (Number.isFinite(data.compositeScore)) notifyIfStressCrossed(data.compositeScore);
    this.render();
  }

  public setLoading(loading: boolean): void {
    if (loading) {
      this.fredState = 'loading';
      this.fredErrorMsg = '';
    }
  }

  private render(): void {
    const hasSpending = this.spendingData && this.spendingData.awards?.length > 0;
    const hasBis = this.bisData && this.bisData.policyRates?.length > 0;
    const hasBls = this.blsData.length > 0;

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
        ${hasBls ? `
          <button class="panel-tab ${this.activeTab === 'labor' ? 'active' : ''}" data-tab="labor">
            ${t('components.economic.laborMarket')}
          </button>
        ` : ''}
        <button class="panel-tab ${this.activeTab === 'stress' ? 'active' : ''}" data-tab="stress">
          Stress Index
        </button>
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
      case 'labor':
        contentHtml = this.renderLabor();
        break;
      case 'stress':
        contentHtml = this.renderStress();
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
      case 'labor': return 'BLS';
      case 'stress': return 'FRED';
    }
  }

  private renderIndicators(): string {
    if (this.fredData.length === 0) {
      if (isDesktopRuntime() && !isFeatureAvailable('economicFred')) {
        return `<div class="economic-empty">${t('components.economic.fredKeyMissing')}</div>`;
      }
      if (this.fredState === 'error' || this.fredState === 'retrying') {
        const isRetrying = this.fredState === 'retrying';
        const raw = isRetrying ? t('common.upstreamUnavailable') : this.fredErrorMsg;
        const mainMsg = raw.includes('\u2014') ? raw.slice(0, raw.indexOf('\u2014')).trimEnd() : raw;
        const countdownLine = isRetrying ? `<div class="panel-error-countdown">${escapeHtml(this.fredErrorMsg)}</div>` : '';
        return `
          <div class="panel-error-state">
            <div class="panel-loading-radar panel-error-radar">
              <div class="panel-radar-sweep"></div>
              <div class="panel-radar-dot error"></div>
            </div>
            <div class="panel-error-msg">${escapeHtml(mainMsg)}</div>
            ${countdownLine}
          </div>
        `;
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
              ${sparkline(series.observations?.map(o => o.value) ?? [], series.change !== null && series.change >= 0 ? '#4caf50' : '#f44336', 120, 28, 'display:block;margin:2px 0')}
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

  private renderLabor(): string {
    if (this.blsData.length === 0) {
      return `<div class="economic-empty">${t('components.economic.noIndicatorData')}</div>`;
    }

    const national = this.blsData.filter(s => !BLS_METRO_IDS.has(s.id));
    const metro = this.blsData.filter(s => BLS_METRO_IDS.has(s.id));

    const seriesRow = (series: FredSeries): string => `
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
        ${sparkline(series.observations?.map(o => o.value) ?? [], series.change !== null && series.change >= 0 ? '#4caf50' : '#f44336', 120, 28, 'display:block;margin:2px 0')}
      </div>`;

    return `
      <div class="economic-content-macro">
        <div class="economic-indicators">
          ${national.map(seriesRow).join('')}
        </div>
        ${metro.length > 0 ? `
          <div class="bis-section">
            <div class="bis-section-title">${t('components.economic.metroUnemployment')}</div>
            <div class="economic-indicators">
              ${metro.map(seriesRow).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderStress(): string {
    const d = this.stressData;
    if (!d || d.unavailable || !Number.isFinite(d.compositeScore)) {
      return `<div class="economic-empty">Stress index data unavailable</div>`;
    }

    const color = stressScoreColor(d.compositeScore);
    const needlePct = Math.min(100, Math.max(0, d.compositeScore)).toFixed(1);
    const cards = d.components.map((c) => stressComponentCard(c)).join('');
    const updatedNote = d.seededAt
      ? `<div style="font-size:9px;color:var(--text-dim);text-align:right;margin-top:8px">Updated ${new Date(d.seededAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>`
      : '';

    return `<div style="padding:12px 14px">
      <div style="text-align:center;margin-bottom:12px">
        <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Composite Score</div>
        <div style="font-size:38px;font-weight:700;color:${color};line-height:1">${d.compositeScore.toFixed(1)}</div>
        <div style="display:inline-block;margin-top:6px;padding:3px 10px;border-radius:12px;background:${color}22;border:1px solid ${color}66;font-size:12px;font-weight:600;color:${color}">${escapeHtml(d.label)}</div>
      </div>
      <div style="margin-bottom:16px">
        <div style="position:relative;height:12px;border-radius:6px;overflow:visible;background:linear-gradient(to right,#27ae60 0%,#f1c40f 20%,#e67e22 40%,#e74c3c 60%,#8e44ad 80%,#8e44ad 100%);margin-bottom:4px">
          <div style="position:absolute;top:-4px;left:calc(${needlePct}% - 2px);width:4px;height:20px;background:#fff;border-radius:2px;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim)">
          <span>Low</span><span>Moderate</span><span>Elevated</span><span>Severe</span><span>Critical</span>
        </div>
      </div>
      ${cards ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">${cards}</div>` : ''}
      ${updatedNote}
    </div>`;
  }
}
