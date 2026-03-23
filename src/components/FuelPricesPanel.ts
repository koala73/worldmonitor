import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { ListFuelPricesResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';

const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

export class FuelPricesPanel extends Panel {
  constructor() {
    super({ id: 'fuel-prices', title: t('panels.fuelPrices'), infoTooltip: t('components.fuelPrices.infoTooltip') });
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('fuelPrices') as ListFuelPricesResponse | undefined;
      if (hydrated?.countries?.length) {
        if (!this.element?.isConnected) return;
        this.renderIndex(hydrated);
        return;
      }
      const data = await client.listFuelPrices({});
      if (!this.element?.isConnected) return;
      this.renderIndex(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
    }
  }

  private renderIndex(data: ListFuelPricesResponse): void {
    if (!data.countries?.length) {
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
      return;
    }

    const sorted = [...data.countries].sort((a, b) => {
      const aPrice = a.gasoline?.usdPrice ?? 0;
      const bPrice = b.gasoline?.usdPrice ?? 0;
      return bPrice - aPrice;
    });

    const cheapestGas = data.cheapestGasoline ?? '';
    const priceiestGas = data.mostExpensiveGasoline ?? '';
    const cheapestDsl = data.cheapestDiesel ?? '';
    const priciestDsl = data.mostExpensiveDiesel ?? '';

    const showWow = data.wowAvailable;

    const rows = sorted.map(c => {
      const gas = c.gasoline;
      const dsl = c.diesel;

      function fuelCell(fuel: typeof gas, cheapCode: string, priceyCode: string, code: string): string {
        if (!fuel?.usdPrice) return `<td class="gb-cell gb-na">N/A</td>`;
        const cls = code === cheapCode ? 'gb-cheapest' : code === priceyCode ? 'gb-priciest' : '';
        let wowStr = '';
        if (showWow && fuel.wowPct != null && fuel.wowPct !== 0) {
          const sign = fuel.wowPct >= 0 ? '▲' : '▼';
          const wowCls = fuel.wowPct >= 0 ? 'bm-wow-up' : 'bm-wow-down';
          wowStr = ` <span class="${wowCls}">${sign}${Math.abs(fuel.wowPct).toFixed(1)}%</span>`;
        }
        return `<td class="gb-cell ${cls}">$${fuel.usdPrice.toFixed(3)}${wowStr}</td>`;
      }

      return `<tr>
        <td class="gb-item-name">${escapeHtml(c.flag)} ${escapeHtml(c.name)}</td>
        ${fuelCell(gas, cheapestGas, priceiestGas, c.code)}
        ${fuelCell(dsl, cheapestDsl, priciestDsl, c.code)}
      </tr>`;
    }).join('');

    const updatedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : '';
    const countLabel = data.countryCount ? ` (${data.countryCount} ${t('components.fuelPrices.countries')})` : '';

    const html = `
      <div class="gb-wrapper">
        <div class="gb-scroll">
          <table class="gb-table">
            <thead><tr>
              <th class="gb-item-col">${t('panels.fuelPricesCountry')}</th>
              <th class="gb-cell">${t('panels.fuelPricesGasoline')}</th>
              <th class="gb-cell">${t('panels.fuelPricesDiesel')}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${updatedAt ? `<div class="gb-updated">${t('components.status.updatedAt', { time: updatedAt })}${countLabel}</div>` : ''}
      </div>
    `;

    this.setContent(html);
  }
}
