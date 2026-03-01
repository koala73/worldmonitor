import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { formatPrice, formatChange, getChangeClass } from '@/utils';
import { miniSparkline } from '@/utils/sparkline';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ListGulfQuotesResponse, GulfQuote } from '@/generated/client/worldmonitor/market/v1/service_client';

const client = new MarketServiceClient('', { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

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
