import { Panel } from './Panel';
import type { OilAnalytics, CrudeInventoryWeek, NatGasStorageWeek, GetEuGasStorageResponse, GetOilStocksAnalysisResponse, LngVulnerabilityData } from '@/services/economic';
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
  private natGasWeeks: NatGasStorageWeek[] = [];
  private euGas: GetEuGasStorageResponse | null = null;
  private oilStocksAnalysis: GetOilStocksAnalysisResponse | null = null;
  private lngVulnerability: LngVulnerabilityData | null = null;

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

  public updateNatGas(weeks: NatGasStorageWeek[]): void {
    this.natGasWeeks = weeks;
    this.render();
  }

  public updateEuGasStorage(data: GetEuGasStorageResponse): void {
    this.euGas = data.unavailable ? null : data;
    this.render();
  }

  public setOilStocksAnalysis(data: GetOilStocksAnalysisResponse): void {
    this.oilStocksAnalysis = data.unavailable ? null : data;
    this.render();
  }

  public updateLngVulnerability(data: LngVulnerabilityData): void {
    this.lngVulnerability = data.top20LngDependent?.length ? data : null;
    this.render();
  }

  private renderOilStocksSection(): string {
    const d = this.oilStocksAnalysis;
    if (!d || d.ieaMembers.length === 0) return '';

    const rows = d.ieaMembers.map(m => {
      const daysDisplay = m.netExporter
        ? `<span class="energy-net-exporter-badge">Net Exporter</span>`
        : m.daysOfCover != null
          ? escapeHtml(String(m.daysOfCover)) + ' d'
          : '—';
      const warningBadge = m.belowObligation
        ? `<span class="energy-below-obligation-badge">Below 90d</span>`
        : '';
      return `
        <tr class="oil-stocks-row">
          <td class="oil-stocks-rank">${escapeHtml(String(m.rank))}</td>
          <td class="oil-stocks-iso">${escapeHtml(m.iso2)}</td>
          <td class="oil-stocks-days">${daysDisplay}${warningBadge}</td>
          <td class="oil-stocks-vs">${m.vsObligation != null ? (m.vsObligation > 0 ? '+' : '') + escapeHtml(String(m.vsObligation)) : '—'}</td>
        </tr>`;
    }).join('');

    const reg = d.regionalSummary;
    const euRow = reg?.europe?.avgDays != null
      ? `<div class="oil-stocks-region-row"><span class="oil-stocks-region-name">Europe</span><span>avg ${escapeHtml(String(reg.europe.avgDays))}d / min ${escapeHtml(String(reg.europe?.minDays ?? '—'))}d</span>${(reg.europe.countBelowObligation ?? 0) > 0 ? `<span class="energy-below-obligation-badge">${escapeHtml(String(reg.europe.countBelowObligation))} below 90d</span>` : ''}</div>`
      : '';
    const apRow = reg?.asiaPacific?.avgDays != null
      ? `<div class="oil-stocks-region-row"><span class="oil-stocks-region-name">Asia-Pacific</span><span>avg ${escapeHtml(String(reg.asiaPacific.avgDays))}d / min ${escapeHtml(String(reg.asiaPacific?.minDays ?? '—'))}d</span>${(reg.asiaPacific.countBelowObligation ?? 0) > 0 ? `<span class="energy-below-obligation-badge">${escapeHtml(String(reg.asiaPacific.countBelowObligation))} below 90d</span>` : ''}</div>`
      : '';
    const naRow = reg?.northAmerica
      ? `<div class="oil-stocks-region-row"><span class="oil-stocks-region-name">North America</span><span>${escapeHtml(String(reg.northAmerica.netExporters ?? 0))} net exporter(s)${reg.northAmerica.avgDays != null ? `, avg ${escapeHtml(String(reg.northAmerica.avgDays))}d` : ''}</span></div>`
      : '';

    return `
      <div class="energy-tape-section" style="margin-top:8px">
        <div class="energy-section-title">IEA Oil Stocks — Days of Cover</div>
        <table class="oil-stocks-table">
          <thead><tr><th>#</th><th>Ctry</th><th>Days</th><th>vs 90d</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="oil-stocks-regional" style="margin-top:6px">
          ${euRow}${apRow}${naRow}
        </div>
        <div class="indicator-date" style="margin-top:4px">Data: ${escapeHtml(d.dataMonth)} (IEA)</div>
      </div>`;
  }

  private renderLngVulnerabilitySection(): string {
    const d = this.lngVulnerability;
    if (!d || d.top20LngDependent.length === 0) return '';

    const top5 = d.top20LngDependent.slice(0, 5);
    const rows = top5.map(e => `
      <tr class="oil-stocks-row">
        <td class="oil-stocks-iso">${escapeHtml(e.iso2)}</td>
        <td class="oil-stocks-days">${escapeHtml((e.lngShareOfImports * 100).toFixed(1))}%</td>
        <td class="oil-stocks-vs">${escapeHtml(String(Math.round(e.lngImportsTj)))} TJ</td>
      </tr>`).join('');

    return `
      <div class="energy-tape-section" style="margin-top:8px">
        <div class="energy-section-title">LNG Vulnerability</div>
        <table class="oil-stocks-table">
          <thead><tr><th>Country</th><th>LNG Share</th><th>LNG Imports</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="indicator-date" style="margin-top:4px">Data: ${escapeHtml(d.dataMonth)} (JODI Gas)</div>
      </div>`;
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

    if (metrics.length === 0 && this.tape.length === 0 && this.crudeWeeks.length === 0 && this.natGasWeeks.length === 0 && !this.euGas && !this.oilStocksAnalysis && !this.lngVulnerability) {
      this.setContent(`<div class="economic-empty">${t('components.energyComplex.noData')}</div>`);
      return;
    }

    const footerParts = [];
    if (hasAnalytics(this.analytics)) footerParts.push('EIA');
    if (this.tape.length > 0) footerParts.push(t('components.energyComplex.liveTapeSource'));
    if (this.euGas) footerParts.push('GIE AGSI+');
    if (this.oilStocksAnalysis) footerParts.push('IEA');
    if (this.lngVulnerability) footerParts.push('JODI Gas');

    const latestWeek = this.crudeWeeks[0] ?? null;
    const wowChange = latestWeek?.weeklyChangeMb ?? null;
    const wowSign = wowChange !== null && wowChange > 0 ? '+' : '';
    const wowClass = wowChange === null ? '' : wowChange > 0 ? 'change-negative' : 'change-positive';
    const crudeSparklineValues = this.crudeWeeks.slice().reverse().map(w => w.stocksMb);

    // US nat gas storage
    const latestNg = this.natGasWeeks[0] ?? null;
    const ngChange = latestNg?.weeklyChangeBcf ?? null;
    const ngSign = ngChange !== null && ngChange > 0 ? '+' : '';
    const ngClass = ngChange === null ? '' : ngChange > 0 ? 'change-negative' : 'change-positive';
    const ngSparklineValues = this.natGasWeeks.slice().reverse().map(w => w.storBcf);

    // EU gas storage
    const euFillPct = this.euGas?.fillPct ?? null;
    const euChange1d = this.euGas?.fillPctChange1d ?? null;
    const euSign = euChange1d !== null && euChange1d > 0 ? '+' : '';
    const euClass = euChange1d === null ? '' : euChange1d > 0 ? 'change-positive' : 'change-negative';
    const euTrend = this.euGas?.trend ?? '';
    const euSparklineValues = (this.euGas?.history ?? []).slice().reverse().map(h => h.fillPct);

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
        ${this.natGasWeeks.length > 0 ? `
          <div class="energy-tape-section" style="margin-top:8px">
            <div class="energy-section-title">US Nat Gas Storage (Bcf)</div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
              ${miniSparkline(ngSparklineValues, ngChange, 80, 22)}
              <div>
                <span class="commodity-price">${escapeHtml(latestNg ? latestNg.storBcf.toFixed(0) : '—')} Bcf</span>
                ${ngChange !== null ? `<span class="commodity-change ${escapeHtml(ngClass)}" style="margin-left:6px">${escapeHtml(ngSign + ngChange.toFixed(0))} WoW</span>` : ''}
              </div>
            </div>
            <div class="indicator-date" style="margin-top:2px">${escapeHtml(latestNg?.period ?? '')}</div>
          </div>
        ` : ''}
        ${euFillPct !== null ? `
          <div class="energy-tape-section" style="margin-top:8px">
            <div class="energy-section-title">EU Gas Storage (Fill %)</div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
              ${miniSparkline(euSparklineValues, euChange1d, 80, 22)}
              <div>
                <span class="commodity-price">${escapeHtml(euFillPct.toFixed(1))}%</span>
                ${euChange1d !== null ? `<span class="commodity-change ${escapeHtml(euClass)}" style="margin-left:6px">${escapeHtml(euSign + euChange1d.toFixed(2))}% 1d</span>` : ''}
                ${euTrend ? `<span style="margin-left:6px;font-size:10px;color:var(--text-dim)">${escapeHtml(euTrend)}</span>` : ''}
              </div>
            </div>
            <div class="indicator-date" style="margin-top:2px">${escapeHtml(this.euGas?.updatedAt ?? '')}</div>
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
        ${this.renderOilStocksSection()}
        ${this.renderLngVulnerabilitySection()}
      </div>
      <div class="economic-footer">
        <span class="economic-source">${escapeHtml(footerParts.join(' • '))}</span>
      </div>
    `);
  }
}
