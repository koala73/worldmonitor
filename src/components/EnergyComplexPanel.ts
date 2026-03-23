import { Panel } from './Panel';
import type { OilAnalytics, CrudeInventoryWeek } from '@/services/economic';
import { formatOilValue, getTrendColor, getTrendIndicator } from '@/services/economic';
import type { MarketData } from '@/types';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { formatPrice, formatChange, getChangeClass } from '@/utils';
import { miniSparkline } from '@/utils/sparkline';

function hasAnalytics(data: OilAnalytics | null): boolean {
  return !!(data?.wtiPrice || data?.brentPrice || data?.usProduction || data?.usInventory);
}

export class EnergyComplexPanel extends Panel {
  private analytics: OilAnalytics | null = null;
  private tape: MarketData[] = [];
  private crudeWeeks: CrudeInventoryWeek[] = [];

  constructor() {
    super({
      id: 'energy-complex',
      title: t('panels.energyComplex'),
      defaultRowSpan: 2,
      infoTooltip: t('components.energyComplex.infoTooltip'),
    });
  }

  public updateAnalytics(data: OilAnalytics): void {
    this.analytics = data;
    this.render();
  }

  public updateTape(data: MarketData[]): void {
    this.tape = data.filter((item) => item.price !== null);
    this.render();
  }

  public updateCrudeInventories(weeks: CrudeInventoryWeek[]): void {
    this.crudeWeeks = weeks;
    this.render();
  }

  private render(): void {
    // Suppress EIA price cards when live tape already covers the same commodity
    // to avoid showing two different prices for the same product (EIA is weekly/stale).
    const tapeCoveredSymbols = new Set(this.tape.filter(d => d.price !== null).map(d => d.symbol));
    const wtiInTape = tapeCoveredSymbols.has('CL=F');
    const brentInTape = tapeCoveredSymbols.has('BZ=F');

    const metrics = [
      wtiInTape ? null : this.analytics?.wtiPrice,
      brentInTape ? null : this.analytics?.brentPrice,
      this.analytics?.usProduction,
      this.analytics?.usInventory,
    ].filter(Boolean);

    if (metrics.length === 0 && this.tape.length === 0) {
      this.setContent(`<div class="economic-empty">${t('components.energyComplex.noData')}</div>`);
      return;
    }

    const footerParts = [];
    if (hasAnalytics(this.analytics)) footerParts.push('EIA');
    if (this.tape.length > 0) footerParts.push(t('components.energyComplex.liveTapeSource'));

    const latestWeek = this.crudeWeeks[0] ?? null;
    const wowChange = latestWeek?.weeklyChangeMb ?? null;
    const wowSign = wowChange !== null && wowChange > 0 ? '+' : '';
    const wowClass = wowChange === null ? '' : wowChange > 0 ? 'change-negative' : 'change-positive';
    const crudeSparklineValues = this.crudeWeeks.slice().reverse().map(w => w.stocksMb);

    this.setContent(`
      <div class="energy-complex-content">
        ${metrics.length > 0 ? `
          <div class="energy-summary-grid">
            ${metrics.map((metric) => {
              if (!metric) return '';
              const trendColor = getTrendColor(metric.trend, metric.name.includes('Production'));
              const change = `${metric.changePct > 0 ? '+' : ''}${metric.changePct.toFixed(1)}%`;
              return `
                <div class="energy-summary-card">
                  <div class="energy-summary-head">
                    <span class="energy-summary-name">${escapeHtml(metric.name)}</span>
                    <span class="energy-summary-trend" style="color:${escapeHtml(trendColor)}">${escapeHtml(getTrendIndicator(metric.trend))}</span>
                  </div>
                  <div class="energy-summary-value">${escapeHtml(formatOilValue(metric.current, metric.unit))} <span class="energy-unit">${escapeHtml(metric.unit)}</span></div>
                  <div class="energy-summary-change" style="color:${escapeHtml(trendColor)}">${escapeHtml(change)}</div>
                  <div class="indicator-date">${escapeHtml(metric.lastUpdated.slice(0, 10))}</div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
        ${this.crudeWeeks.length > 0 ? `
          <div class="energy-tape-section" style="margin-top:8px">
            <div class="energy-section-title">US Crude Inventories (Mb)</div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
              ${miniSparkline(crudeSparklineValues, wowChange, 80, 22)}
              <div>
                <span class="commodity-price">${escapeHtml(latestWeek ? latestWeek.stocksMb.toFixed(1) : '—')} Mb</span>
                ${wowChange !== null ? `<span class="commodity-change ${escapeHtml(wowClass)}" style="margin-left:6px">${escapeHtml(wowSign + wowChange.toFixed(1))} WoW</span>` : ''}
              </div>
            </div>
            <div class="indicator-date" style="margin-top:2px">${escapeHtml(latestWeek?.period ?? '')}</div>
          </div>
        ` : ''}
        ${this.tape.length > 0 ? `
          <div class="energy-tape-section">
            <div class="energy-section-title">${t('components.energyComplex.liveTape')}</div>
            <div class="commodities-grid energy-tape-grid">
              ${this.tape.map((item) => `
                <div class="commodity-item energy-tape-card">
                  <div class="commodity-name">${escapeHtml(item.display)}</div>
                  ${miniSparkline(item.sparkline, item.change, 60, 18)}
                  <div class="commodity-price">${formatPrice(item.price!)}</div>
                  <div class="commodity-change ${getChangeClass(item.change ?? 0)}">${formatChange(item.change ?? 0)}</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
      <div class="economic-footer">
        <span class="economic-source">${escapeHtml(footerParts.join(' • '))}</span>
      </div>
    `);
  }
}
