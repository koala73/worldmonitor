import { Panel } from './Panel';
import type { OilAnalytics } from '@/services/economic';
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

  private render(): void {
    const metrics = [
      this.analytics?.wtiPrice,
      this.analytics?.brentPrice,
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
