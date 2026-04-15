import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import { escapeHtml } from '@/utils/sanitize';

export interface WsbTicker {
  symbol: string;
  mentionCount: number;
  uniquePosts: number;
  totalScore: number;
  avgUpvoteRatio: number;
  topPost?: { title: string; url: string; score: number; subreddit: string };
  subreddits: string[];
  velocityScore: number;
}

type SortField = 'mentionCount' | 'totalScore' | 'velocityScore';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function velocityColor(score: number): string {
  if (score >= 80) return '#e74c3c';
  if (score >= 50) return '#e67e22';
  if (score >= 25) return '#f1c40f';
  return '#27ae60';
}

export class WsbTickerScannerPanel extends Panel {
  private _tickers: WsbTicker[] = [];
  private _hasData = false;
  private _sortField: SortField = 'mentionCount';
  private _sortAsc = false;

  constructor() {
    super({
      id: 'wsb-ticker-scanner',
      title: t('panels.wsbTickerScanner'),
      infoTooltip: t('components.wsbTickerScanner.infoTooltip'),
      showCount: true,
      premium: 'locked',
    });

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const sortBtn = target.closest<HTMLElement>('[data-sort]');
      if (!sortBtn) return;
      const field = sortBtn.dataset.sort as SortField;
      if (field === this._sortField) {
        this._sortAsc = !this._sortAsc;
      } else {
        this._sortField = field;
        this._sortAsc = false;
      }
      this._render();
    });
  }

  public async fetchData(): Promise<boolean> {
    const hydrated = getHydratedData('wsbTickers') as { tickers?: WsbTicker[] } | undefined;
    if (hydrated?.tickers?.length) {
      this.updateData(hydrated.tickers);
      return true;
    }
    try {
      const resp = await fetch(toApiUrl('/api/bootstrap?keys=wsbTickers'), {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const { data } = (await resp.json()) as { data: { wsbTickers?: { tickers?: WsbTicker[] } } };
        if (data.wsbTickers?.tickers?.length) {
          this.updateData(data.wsbTickers.tickers);
          return true;
        }
      }
    } catch { /* fallback failed */ }
    this.showError('No ticker data available yet', () => { void this.fetchData(); }, 60);
    return false;
  }

  public updateData(tickers: WsbTicker[]): void {
    this._tickers = [...tickers];
    this._hasData = this._tickers.length > 0;
    if (this._hasData) {
      this.setCount(this._tickers.length);
      this._render();
    } else {
      this.setCount(0);
      this.showError('No trending tickers found', () => { void this.fetchData(); }, 120);
    }
  }

  private _sorted(): WsbTicker[] {
    const dir = this._sortAsc ? 1 : -1;
    return [...this._tickers].sort((a, b) => dir * (a[this._sortField] - b[this._sortField]));
  }

  private _sortIndicator(field: SortField): string {
    if (field !== this._sortField) return '';
    return this._sortAsc ? ' \u25B2' : ' \u25BC';
  }

  private _render(): void {
    const sorted = this._sorted();
    const maxVelocity = Math.max(1, ...sorted.map(t => t.velocityScore));

    const headerStyle = 'font-size:9px;font-weight:700;color:var(--text-dim);text-transform:uppercase;padding:4px 6px;cursor:pointer;user-select:none;white-space:nowrap';
    const cellStyle = 'font-size:11px;padding:5px 6px;vertical-align:middle';

    const rows = sorted.slice(0, 50).map((tk, i) => {
      const vColor = velocityColor(tk.velocityScore);
      const barPct = Math.max(4, Math.round((tk.velocityScore / maxVelocity) * 100));
      const subs = tk.subreddits.map(s =>
        `<span style="font-size:8px;padding:1px 4px;border-radius:2px;background:rgba(255,255,255,0.06);color:var(--text-dim);margin-right:2px">r/${escapeHtml(s)}</span>`
      ).join('');

      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="${cellStyle};color:var(--text-dim);text-align:right;min-width:20px">${i + 1}</td>
        <td style="${cellStyle};font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-weight:700;color:var(--text)">${escapeHtml(tk.symbol)}</td>
        <td style="${cellStyle};text-align:right;color:var(--text)">${tk.mentionCount}</td>
        <td style="${cellStyle};text-align:right;color:var(--text)">${formatCompact(tk.totalScore)}</td>
        <td style="${cellStyle};min-width:80px">
          <div style="display:flex;align-items:center;gap:4px">
            <span style="font-size:10px;font-weight:600;color:${vColor};min-width:24px;text-align:right">${Math.round(tk.velocityScore)}</span>
            <div style="flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.08)">
              <div style="height:100%;width:${barPct}%;border-radius:2px;background:${vColor}"></div>
            </div>
          </div>
        </td>
        <td style="${cellStyle}">${subs}</td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div style="overflow-x:auto;overflow-y:auto;max-height:480px">
        <table style="width:100%;border-collapse:collapse;border-spacing:0">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="${headerStyle};text-align:right">#</th>
              <th style="${headerStyle};text-align:left">Ticker</th>
              <th style="${headerStyle};text-align:right" data-sort="mentionCount">Mentions${this._sortIndicator('mentionCount')}</th>
              <th style="${headerStyle};text-align:right" data-sort="totalScore">Score${this._sortIndicator('totalScore')}</th>
              <th style="${headerStyle};text-align:left" data-sort="velocityScore">Velocity${this._sortIndicator('velocityScore')}</th>
              <th style="${headerStyle};text-align:left">Source</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">No ticker data</td></tr>'}</tbody>
        </table>
      </div>
      <div style="margin-top:6px;font-size:9px;color:var(--text-dim)">Reddit \u00B7 r/wallstreetbets, r/stocks, r/investing \u00B7 sorted by ${this._sortField.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
    `);
  }
}
