import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { ListGroceryBasketPricesResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';

const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

export class GroceryBasketPanel extends Panel {
  constructor() {
    super({ id: 'grocery-basket', title: t('panels.groceryBasket'), infoTooltip: t('components.groceryBasket.infoTooltip') });
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('groceryBasket') as ListGroceryBasketPricesResponse | undefined;
      if (hydrated?.countries?.length) {
        if (!this.element?.isConnected) return;
        this.renderBasket(hydrated);
        void client.listGroceryBasketPrices({}).then(data => {
          if (!this.element?.isConnected || !data.countries?.length) return;
          this.renderBasket(data);
        }).catch(() => {});
        return;
      }
      const data = await client.listGroceryBasketPrices({});
      if (!this.element?.isConnected) return;
      this.renderBasket(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
    }
  }

  private renderBasket(data: ListGroceryBasketPricesResponse): void {
    if (!data.countries?.length) {
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
      return;
    }

    const countries = data.countries;
    const itemIds = countries[0]?.items?.map(i => i.itemId) ?? [];

    const headerCells = countries.map(c =>
      `<th class="gb-country-header" title="${escapeHtml(c.name)}">${escapeHtml(c.flag)}<br><span class="gb-country-name">${escapeHtml(c.name)}</span></th>`
    ).join('');

    const rows = itemIds.map(itemId => {
      const firstItem = countries[0]?.items?.find(i => i.itemId === itemId);
      // Per-item min/max USD: only countries with real data, type-safe filter
      const prices = countries
        .map(c => c.items?.find(i => i.itemId === itemId)?.usdPrice)
        .filter((p): p is number => p != null && p > 0);
      const rowMin = prices.length > 1 ? Math.min(...prices) : null;
      const rowMax = prices.length > 1 ? Math.max(...prices) : null;
      const eps = 0.001;

      const cells = countries.map(country => {
        const item = country.items?.find(i => i.itemId === itemId);
        if (!item?.available || !item.usdPrice || !item.localPrice) {
          return `<td class="gb-cell gb-na">—</td>`;
        }
        const isHigh = rowMax !== null && Math.abs(item.usdPrice - rowMax) < eps;
        const isLow = rowMin !== null && Math.abs(item.usdPrice - rowMin) < eps;
        const cls = isLow ? 'gb-cheapest' : isHigh ? 'gb-priciest' : '';
        return `<td class="gb-cell ${cls}">$${item.usdPrice.toFixed(2)}<span class="gb-local">${item.localPrice.toFixed(2)} ${escapeHtml(country.currency)}</span></td>`;
      }).join('');
      return `<tr><td class="gb-item-name">${escapeHtml(firstItem?.itemName ?? itemId)}<span class="gb-unit">${escapeHtml(firstItem?.unit ?? '')}</span></td>${cells}</tr>`;
    }).join('');

    const totalRow = `<tr class="gb-total-row"><td class="gb-item-name"><strong>Total</strong></td>${countries.map(c => {
      const isLow = c.code === data.cheapestCountry;
      const isHigh = c.code === data.mostExpensiveCountry;
      const cls = isLow ? 'gb-cheapest' : isHigh ? 'gb-priciest' : '';
      let wowBadge = '';
      if (c.wowPct != null) {
        const sign = c.wowPct >= 0 ? '▲' : '▼';
        const wowCls = c.wowPct >= 0 ? 'bm-wow-up' : 'bm-wow-down';
        wowBadge = `<span class="gb-wow ${wowCls}">${sign}${Math.abs(c.wowPct).toFixed(1)}%</span>`;
      }
      return `<td class="gb-cell gb-total ${cls}"><strong>$${c.totalUsd.toFixed(2)}</strong>${wowBadge}</td>`;
    }).join('')}</tr>`;

    let wowSummary = '';
    if (data.wowAvailable && data.wowAvgPct !== undefined) {
      const avg = data.wowAvgPct;
      const sign = avg >= 0 ? '▲' : '▼';
      const cls = avg >= 0 ? 'bm-wow-up' : 'bm-wow-down';
      wowSummary = `<div class="bm-wow-summary">Basket avg: <span class="${cls}">${sign}${Math.abs(avg).toFixed(1)}% WoW</span></div>`;
    }

    const updatedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : '';

    const html = `
      <div class="gb-wrapper">
        ${wowSummary}
        <div class="gb-scroll">
          <table class="gb-table">
            <thead><tr><th class="gb-item-col">${t('panels.groceryItem')}</th>${headerCells}</tr></thead>
            <tbody>${rows}${totalRow}</tbody>
          </table>
        </div>
        ${updatedAt ? `<div class="gb-updated">${t('components.status.updatedAt', { time: updatedAt })}</div>` : ''}
      </div>
    `;

    this.setContent(html);
  }
}
