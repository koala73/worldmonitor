import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getApiBaseUrl } from '@/services/runtime';

interface FuelRegion {
  name: string;
  gasolineUsd: number;
  dieselUsd: number;
  period: string;
}

interface FuelPricesResponse {
  regions: FuelRegion[];
  keyMissing: boolean;
  updatedAt: number;
}

function formatPrice(usd: number): string {
  return `$${usd.toFixed(2)}/gal`;
}

export class FuelPricesPanel extends Panel {
  private data: FuelPricesResponse | null = null;
  private loading = true;
  private error: string | null = null;

  constructor() {
    super({
      id: 'fuel-prices',
      title: 'Fuel Prices',
      showCount: false,
      infoTooltip: 'Weekly retail gasoline and diesel prices by US region. Requires EIA API key (free at eia.gov). Source: U.S. Energy Information Administration.',
    });
    void this.fetchData();
  }

  public async fetchData(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.showLoading('Loading fuel prices…');

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/fuel-prices`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json() as FuelPricesResponse;
      this.error = null;
    } catch (error) {
      if (this.isAbortError(error)) return;
      this.error = error instanceof Error ? error.message : 'Failed to fetch';
    }

    this.loading = false;
    this.renderPanel();
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading('Loading fuel prices…');
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error ?? 'No data');
      return;
    }

    if (this.data.keyMissing) {
      this.setContent(`
        <div style="padding:16px 12px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;">
          <span style="font-size:22px;">⚙️</span>
          <p style="margin:0;font-size:13px;color:var(--text-secondary,#aaa);line-height:1.5;">
            Add your free EIA API key in Settings → API Keys to enable fuel prices.
          </p>
        </div>
      `);
      return;
    }

    const { regions } = this.data;

    const period = regions[0]?.period ?? '';

    const rows = regions.map(r => {
      const isAvg = r.name === 'U.S. Average';
      const weight = isAvg ? 'font-weight:600;' : '';
      return `
        <tr style="border-bottom:1px solid var(--border-color,rgba(255,255,255,0.07));">
          <td style="padding:6px 8px;${weight}">${escapeHtml(r.name)}</td>
          <td style="padding:6px 8px;text-align:right;${weight}">${escapeHtml(formatPrice(r.gasolineUsd))}</td>
          <td style="padding:6px 8px;text-align:right;${weight}">${escapeHtml(formatPrice(r.dieselUsd))}</td>
        </tr>
      `;
    }).join('');

    const html = `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border-color,rgba(255,255,255,0.15));">
              <th style="padding:6px 8px;text-align:left;font-weight:500;color:var(--text-secondary,#aaa);">Region</th>
              <th style="padding:6px 8px;text-align:right;font-weight:500;color:var(--text-secondary,#aaa);">Gasoline</th>
              <th style="padding:6px 8px;text-align:right;font-weight:500;color:var(--text-secondary,#aaa);">Diesel</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${period ? `<p style="margin:8px 8px 0;font-size:11px;color:var(--text-secondary,#aaa);">Week of ${escapeHtml(period)}</p>` : ''}
      </div>
    `;

    this.setContent(html);
  }
}
