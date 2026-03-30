import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getApiBaseUrl } from '@/services/runtime';
import { readJsonResponse } from '@/utils/http-json';

interface DebtCountry {
  code: string;
  name: string;
  debtPctGdp: number;
  year: string;
}

interface NationalDebtResponse {
  countries: DebtCountry[];
  updatedAt: number;
  error?: string;
}

function debtColor(pct: number): string {
  if (pct < 60) return '#4caf50';
  if (pct < 90) return '#ffeb3b';
  if (pct < 150) return '#ff9800';
  return '#f44336';
}

export class NationalDebtPanel extends Panel {
  private static readonly UNAVAILABLE_MESSAGE = 'National debt data unavailable right now';
  private data: NationalDebtResponse | null = null;
  private sortAsc = false;

  constructor() {
    super({
      id: 'national-debt',
      title: 'National Debt',
      showCount: true,
      infoTooltip: 'Government debt as % of GDP for the world\'s most indebted nations. Source: World Bank (free, updated annually).',
    });
    void this.fetchData();
  }

  public async fetchData(): Promise<void> {
    this.showLoading();
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/national-debt`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await readJsonResponse<NationalDebtResponse>(res, NationalDebtPanel.UNAVAILABLE_MESSAGE);
      this.data = json;
    } catch (error) {
      if (this.isAbortError(error)) return;
      this.showError(error instanceof Error ? error.message : NationalDebtPanel.UNAVAILABLE_MESSAGE);
      return;
    }
    this.renderPanel();
  }

  private renderPanel(): void {
    const d = this.data;
    if (!d) { this.showError('No data'); return; }
    if (d.error && (!d.countries || d.countries.length === 0)) {
      this.showError(NationalDebtPanel.UNAVAILABLE_MESSAGE);
      return;
    }

    const sorted = [...d.countries]
      .sort((a, b) => this.sortAsc ? a.debtPctGdp - b.debtPctGdp : b.debtPctGdp - a.debtPctGdp)
      .slice(0, 20);

    this.setCount(sorted.length);

    const rows = sorted.map(c => {
      const barWidth = Math.min((c.debtPctGdp / 300) * 100, 100).toFixed(1);
      const color = debtColor(c.debtPctGdp);
      return `<tr>
        <td style="padding:4px 8px;white-space:nowrap">${escapeHtml(c.name)}</td>
        <td style="padding:4px 8px;min-width:120px">
          <div style="position:relative;height:18px;display:flex;align-items:center">
            <div style="position:absolute;left:0;top:0;bottom:0;width:${barWidth}%;background:${color};opacity:0.25;border-radius:2px"></div>
            <span style="position:relative;color:${color};font-weight:600;font-size:0.85em">${c.debtPctGdp.toFixed(1)}%</span>
          </div>
        </td>
        <td style="padding:4px 8px;color:var(--text-muted,#888);font-size:0.8em">${escapeHtml(c.year)}</td>
      </tr>`;
    }).join('');

    const arrow = this.sortAsc ? '&#8593;' : '&#8595;';
    const html = `
      <div style="overflow:auto;max-height:100%">
        <table class="debt-table" style="width:100%;border-collapse:collapse;font-size:0.9em">
          <thead>
            <tr style="border-bottom:1px solid var(--border-color,#333)">
              <th style="padding:4px 8px;text-align:left">Country</th>
              <th style="padding:4px 8px;text-align:left">
                Debt/GDP
                <button data-sort-debt class="debt-sort-btn" style="background:none;border:none;cursor:pointer;color:var(--text-muted,#888);font-size:0.85em;padding:0 2px">${arrow}</button>
              </th>
              <th style="padding:4px 8px;text-align:left">Year</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    this.setContent(html);

    const btn = this.getContentElement().querySelector('[data-sort-debt]');
    btn?.addEventListener('click', () => {
      this.sortAsc = !this.sortAsc;
      this.renderPanel();
    });
  }
}
