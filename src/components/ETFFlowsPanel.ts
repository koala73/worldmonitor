import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ListEtfFlowsResponse } from '@/generated/client/worldmonitor/market/v1/service_client';

type ETFFlowsResult = ListEtfFlowsResponse;

function formatVolume(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toLocaleString();
}

function flowClass(direction: string): string {
  if (direction === 'inflow') return 'flow-inflow';
  if (direction === 'outflow') return 'flow-outflow';
  return 'flow-neutral';
}

function changeClass(val: number): string {
  if (val > 0.1) return 'change-positive';
  if (val < -0.1) return 'change-negative';
  return 'change-neutral';
}

export class ETFFlowsPanel extends Panel {
  private data: ETFFlowsResult | null = null;
  private loading = true;
  private error: string | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'etf-flows', title: t('panels.etfFlows'), showCount: false });
    // Delay initial fetch by 8s to avoid competing with stock/commodity Yahoo calls
    // during cold start — all share a global yahooGate() rate limiter on the sidecar
    setTimeout(() => void this.fetchData(), 8_000);
    this.refreshInterval = setInterval(() => this.fetchData(), 3 * 60000);
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  private async fetchData(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const client = new MarketServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
        this.data = await client.listEtfFlows({});
        this.error = null;

        if (this.data && this.data.etfs.length === 0 && !this.data.rateLimited && attempt < 2) {
          this.showRetrying();
          await new Promise(r => setTimeout(r, 20_000));
          continue;
        }
        break;
      } catch (err) {
        if (this.isAbortError(err)) return;
        if (attempt < 2) {
          this.showRetrying();
          await new Promise(r => setTimeout(r, 20_000));
          continue;
        }
        this.error = err instanceof Error ? err.message : 'Failed to fetch';
      }
    }
    this.loading = false;
    this.renderPanel();
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading(t('common.loadingEtfData'));
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error || t('common.noDataShort'));
      return;
    }

    const d = this.data;
    if (!d.etfs.length) {
      const msg = d.rateLimited ? t('components.etfFlows.rateLimited') : t('components.etfFlows.unavailable');
      this.setContent(`<div class="panel-loading-text">${msg}</div>`);
      return;
    }

    const s = d.summary || { etfCount: 0, totalVolume: 0, totalEstFlow: 0, netDirection: 'NEUTRAL', inflowCount: 0, outflowCount: 0 };
    const dirClass = s.netDirection.includes('INFLOW') ? 'flow-inflow' : s.netDirection.includes('OUTFLOW') ? 'flow-outflow' : 'flow-neutral';

    const rows = d.etfs.map(etf => `
      <tr class="etf-row ${flowClass(etf.direction)}">
        <td class="etf-ticker">${escapeHtml(etf.ticker)}</td>
        <td class="etf-issuer">${escapeHtml(etf.issuer)}</td>
        <td class="etf-flow ${flowClass(etf.direction)}">${etf.direction === 'inflow' ? '+' : etf.direction === 'outflow' ? '-' : ''}$${formatVolume(Math.abs(etf.estFlow))}</td>
        <td class="etf-volume">${formatVolume(etf.volume)}</td>
        <td class="etf-change ${changeClass(etf.priceChange)}">${etf.priceChange > 0 ? '+' : ''}${etf.priceChange.toFixed(2)}%</td>
      </tr>
    `).join('');

    const html = `
      <div class="etf-flows-container">
        <div class="etf-summary ${dirClass}">
          <div class="etf-summary-item">
            <span class="etf-summary-label">${t('components.etfFlows.netFlow')}</span>
            <span class="etf-summary-value ${dirClass}">${s.netDirection.includes('INFLOW') ? t('components.etfFlows.netInflow') : t('components.etfFlows.netOutflow')}</span>
          </div>
          <div class="etf-summary-item">
            <span class="etf-summary-label">${t('components.etfFlows.estFlow')}</span>
            <span class="etf-summary-value">$${formatVolume(Math.abs(s.totalEstFlow))}</span>
          </div>
          <div class="etf-summary-item">
            <span class="etf-summary-label">${t('components.etfFlows.totalVol')}</span>
            <span class="etf-summary-value">${formatVolume(s.totalVolume)}</span>
          </div>
          <div class="etf-summary-item">
            <span class="etf-summary-label">${t('components.etfFlows.etfs')}</span>
            <span class="etf-summary-value">${s.inflowCount}↑ ${s.outflowCount}↓</span>
          </div>
        </div>
        <div class="etf-table-wrap">
          <table class="etf-table">
            <thead>
              <tr>
                <th>${t('components.etfFlows.table.ticker')}</th>
                <th>${t('components.etfFlows.table.issuer')}</th>
                <th>${t('components.etfFlows.table.estFlow')}</th>
                <th>${t('components.etfFlows.table.volume')}</th>
                <th>${t('components.etfFlows.table.change')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    this.setContent(html);
  }
}
