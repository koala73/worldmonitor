import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { formatPrice, formatChange, getChangeClass } from '@/utils';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ListGulfQuotesResponse, GulfQuote } from '@/generated/client/worldmonitor/market/v1/service_client';

const client = new MarketServiceClient('', { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

function miniSparkline(data: number[] | undefined, change: number | null, w = 50, h = 16): string {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const color = change != null && change >= 0 ? 'var(--green)' : 'var(--red)';
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-sparkline"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderSection(title: string, quotes: GulfQuote[]): string {
  if (quotes.length === 0) return '';
  const rows = quotes.map(q => `
    <div class="market-item">
      <div class="market-info">
        <span class="market-name">${q.flag} ${escapeHtml(q.name)}</span>
        <span class="market-symbol">${escapeHtml(q.country || q.symbol)}</span>
      </div>
      <div class="market-data">
        ${miniSparkline(q.sparkline, q.change)}
        <span class="market-price">${formatPrice(q.price)}</span>
        <span class="market-change ${getChangeClass(q.change)}">${formatChange(q.change)}</span>
      </div>
    </div>
  `).join('');
  return `<div class="gulf-section"><div class="gulf-section-title">${escapeHtml(title)}</div>${rows}</div>`;
}

export class GulfEconomiesPanel extends Panel {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'gulf-economies', title: t('panels.gulfEconomies') });
    setTimeout(() => void this.fetchData(), 8_000);
  }

  destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    super.destroy();
  }

  public async fetchData(): Promise<void> {
    try {
      const data = await client.listGulfQuotes({});
      this.renderGulf(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.showError(t('common.failedMarketData'));
    }

    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.fetchData(), 60_000);
    }
  }

  private renderGulf(data: ListGulfQuotesResponse): void {
    if (!data.quotes.length) {
      const msg = data.rateLimited ? t('common.rateLimitedMarket') : t('common.failedMarketData');
      this.showError(msg);
      return;
    }

    const indices = data.quotes.filter(q => q.type === 'index');
    const currencies = data.quotes.filter(q => q.type === 'currency');
    const oil = data.quotes.filter(q => q.type === 'oil');

    const html =
      renderSection(t('panels.gulfIndices'), indices) +
      renderSection(t('panels.gulfCurrencies'), currencies) +
      renderSection(t('panels.gulfOil'), oil);

    this.setContent(html);
  }
}
