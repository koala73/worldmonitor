import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

interface StablecoinData {
  id: string;
  symbol: string;
  name: string;
  price: number;
  deviation: number;
  pegStatus: 'ON PEG' | 'SLIGHT DEPEG' | 'DEPEGGED';
  marketCap: number;
  volume24h: number;
  change24h: number;
  change7d: number;
  image: string;
}

interface StablecoinResult {
  timestamp: string;
  summary: {
    totalMarketCap: number;
    totalVolume24h: number;
    coinCount: number;
    depeggedCount: number;
    healthStatus: string;
  };
  stablecoins: StablecoinData[];
  unavailable?: boolean;
}

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
    super({ id: 'stablecoins', title: 'Stablecoins', showCount: false });
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
    try {
      const res = await fetch('/api/stablecoin-markets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to fetch';
    } finally {
      this.loading = false;
      this.renderPanel();
    }
  }

  private isUpstreamUnavailable(): boolean {
    return this.data?.unavailable === true;
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading('Loading stablecoins...');
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error || 'No data');
      return;
    }

    if (this.isUpstreamUnavailable()) {
      this.showError('CoinGecko API temporarily unavailable — will retry automatically');
      return;
    }

    const d = this.data;
    if (!d.stablecoins.length) {
      this.setContent('<div class="panel-loading-text">Stablecoin data temporarily unavailable</div>');
      return;
    }

    const s = d.summary;

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
          <div class="stable-section-title">Peg Health</div>
          <div class="stable-peg-list">${pegRows}</div>
        </div>
        <div class="stable-section">
          <div class="stable-section-title">Supply & Volume</div>
          <div class="stable-supply-header">
            <span>Token</span><span>MCap</span><span>24h Vol</span><span>24h Chg</span>
          </div>
          <div class="stable-supply-list">${supplyRows}</div>
        </div>
      </div>
    `;

    this.setContent(html);
  }
}
