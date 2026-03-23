import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { ListBigMacPricesResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';

const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

export class BigMacPanel extends Panel {
  constructor() {
    super({ id: 'bigmac', title: t('panels.bigmac'), infoTooltip: t('components.bigmac.infoTooltip') });
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('bigmac') as ListBigMacPricesResponse | undefined;
      if (hydrated?.countries?.length) {
        if (!this.element?.isConnected) return;
        this.renderIndex(hydrated);
        return;
      }
      const data = await client.listBigMacPrices({});
      if (!this.element?.isConnected) return;
      this.renderIndex(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
    }
  }

  private renderIndex(data: ListBigMacPricesResponse): void {
    if (!data.countries?.length) {
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
      return;
    }

    const sorted = [...data.countries]
      .filter((c): c is typeof c & { usdPrice: number } => c.usdPrice != null && c.usdPrice > 0)
      .sort((a, b) => b.usdPrice - a.usdPrice);

    const maxCode = sorted[0]?.code;
    const minCode = sorted[sorted.length - 1]?.code;

    const showWow = data.wowAvailable && data.wowAvgPct !== undefined;
    const wowHeader = showWow ? `<th class="gb-cell">${t('panels.bigmacWow')}</th>` : '';

    const rows = sorted.map(c => {
      const cls = c.code === minCode ? 'gb-cheapest' : c.code === maxCode ? 'gb-priciest' : '';
      let wowCell = '';
      if (showWow) {
        const pct = c.wowPct ?? null;
        if (pct == null) {
          wowCell = `<td class="gb-cell gb-na">—</td>`;
        } else {
          const sign = pct >= 0 ? '▲' : '▼';
          const wowCls = pct >= 0 ? 'bm-wow-up' : 'bm-wow-down';
          wowCell = `<td class="gb-cell ${wowCls}">${sign}${Math.abs(pct).toFixed(1)}%</td>`;
        }
      }
      return `<tr>
        <td class="gb-item-name">${escapeHtml(c.flag)} ${escapeHtml(c.name)}</td>
        <td class="gb-cell ${cls}">$${c.usdPrice.toFixed(2)}</td>
        ${wowCell}
      </tr>`;
    }).join('');

    let wowSummary = '';
    if (showWow) {
      const avg = data.wowAvgPct;
      const sign = avg >= 0 ? '▲' : '▼';
      const cls = avg >= 0 ? 'bm-wow-up' : 'bm-wow-down';
      wowSummary = `<div class="bm-wow-summary">Global avg: <span class="${cls}">${sign}${Math.abs(avg).toFixed(1)}% ${t('panels.bigmacWow')}</span></div>`;
    }

    const updatedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : '';

    const html = `
      <div class="gb-wrapper">
        ${wowSummary}
        <div class="gb-scroll">
          <table class="gb-table">
            <thead><tr>
              <th class="gb-item-col">${t('panels.bigmacCountry')}</th>
              <th class="gb-cell">USD</th>
              ${wowHeader}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${updatedAt ? `<div class="gb-updated">${t('components.status.updatedAt', { time: updatedAt })}</div>` : ''}
      </div>
    `;

    this.setContent(html);
  }
}
