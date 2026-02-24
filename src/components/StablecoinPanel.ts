import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ListStablecoinMarketsResponse } from '@/generated/client/worldmonitor/market/v1/service_client';

type StablecoinResult = ListStablecoinMarketsResponse;

function formatLargeNum(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function pegClass(status: string): string {
  if (status === 'ON PEG') return 'peg-on';
  if (status === 'SLIGHT DEPEG') return 'peg-slight';
  return 'peg-off';
}

function healthClass(status: string): string {
  if (status === 'HEALTHY') return 'health-good';
  if (status === 'CAUTION') return 'health-caution';
  return 'health-warning';
}

export class StablecoinPanel extends Panel {
  private data: StablecoinResult | null = null;
  private loading = true;
  private error: string | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'stablecoins', title: t('panels.stablecoins'), showCount: false });
    void this.fetchData();
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
        this.data = await client.listStablecoinMarkets({ coins: [] });
        this.error = null;

        if (this.data && this.data.stablecoins.length === 0 && attempt < 2) {
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
      this.showLoading(t('common.loadingStablecoins'));
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error || t('common.noDataShort'));
      return;
    }

    const d = this.data;
    if (!d.stablecoins.length) {
      this.setContent(`<div class="panel-loading-text">${t('components.stablecoins.unavailable')}</div>`);
      return;
    }

    const s = d.summary || { totalMarketCap: 0, totalVolume24h: 0, coinCount: 0, depeggedCount: 0, healthStatus: 'UNAVAILABLE' };

    const pegRows = d.stablecoins.map(c => `
      <div class="stable-row">
        <div class="stable-info">
          <span class="stable-symbol">${escapeHtml(c.symbol)}</span>
          <span class="stable-name">${escapeHtml(c.name)}</span>
        </div>
        <div class="stable-price">$${c.price.toFixed(4)}</div>
        <div class="stable-peg ${pegClass(c.pegStatus)}">
          <span class="peg-badge">${escapeHtml(c.pegStatus)}</span>
          <span class="peg-dev">${c.deviation.toFixed(2)}%</span>
        </div>
      </div>
    `).join('');

    const supplyRows = d.stablecoins.map(c => `
      <div class="stable-supply-row">
        <span class="stable-symbol">${escapeHtml(c.symbol)}</span>
        <span class="stable-mcap">${formatLargeNum(c.marketCap)}</span>
        <span class="stable-vol">${formatLargeNum(c.volume24h)}</span>
        <span class="stable-change ${c.change24h >= 0 ? 'change-positive' : 'change-negative'}">${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(2)}%</span>
      </div>
    `).join('');

    const html = `
      <div class="stablecoin-container">
        <div class="stable-health ${healthClass(s.healthStatus)}">
          <span class="health-label">${escapeHtml(s.healthStatus)}</span>
          <span class="health-detail">MCap: ${formatLargeNum(s.totalMarketCap)} | Vol: ${formatLargeNum(s.totalVolume24h)}</span>
        </div>
        <div class="stable-section">
          <div class="stable-section-title">${t('components.stablecoins.pegHealth')}</div>
          <div class="stable-peg-list">${pegRows}</div>
        </div>
        <div class="stable-section">
          <div class="stable-section-title">${t('components.stablecoins.supplyVolume')}</div>
          <div class="stable-supply-header">
            <span>${t('components.stablecoins.token')}</span><span>${t('components.stablecoins.mcap')}</span><span>${t('components.stablecoins.vol24h')}</span><span>${t('components.stablecoins.chg24h')}</span>
          </div>
          <div class="stable-supply-list">${supplyRows}</div>
        </div>
      </div>
    `;

    this.setContent(html);
  }
}
