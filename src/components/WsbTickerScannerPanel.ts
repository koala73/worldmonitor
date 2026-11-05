import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { fetchWsbTickers, type WsbTicker } from '@/services/wsb-tickers';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';

export type { WsbTicker } from '@/services/wsb-tickers';

type SortField = 'mentionCount' | 'totalScore' | 'velocityScore';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** The velocity number's colour: the bar's hue, with the light theme's darker text shade. */
function velocityTextColor(score: number): string {
  if (score >= 80) return 'var(--red-text, #e74c3c)';
  if (score >= 50) return 'var(--semantic-high-text, #e67e22)';
  if (score >= 25) return 'var(--yellow-text, #f1c40f)';
  return 'var(--green-text, #27ae60)';
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
      const focusedSortButton = target.closest<HTMLButtonElement>('button[data-sort]');
      const shouldRestoreFocus = focusedSortButton === document.activeElement;
      if (field === this._sortField) {
        this._sortAsc = !this._sortAsc;
      } else {
        this._sortField = field;
        this._sortAsc = false;
      }
      this._render(shouldRestoreFocus ? field : null);
    });
  }

  public async fetchData(): Promise<boolean> {
    const tickers = await fetchWsbTickers();
    if (tickers.length) {
      this.updateData(tickers);
      return true;
    }
    if (!this._hasData) this.showError('No ticker data available yet', () => { void this.fetchData(); }, 60);
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

  /** aria-sort for a header cell — present only on the active column. */
  private _ariaSort(field: SortField): string {
    if (field !== this._sortField) return '';
    return ` aria-sort="${this._sortAsc ? 'ascending' : 'descending'}"`;
  }

  private _sortIndicator(field: SortField): string {
    if (field !== this._sortField) return '';
    return this._sortAsc ? ' \u25B2' : ' \u25BC';
  }

  private _render(focusField: SortField | null = null): void {
    const sorted = this._sorted();
    const maxVelocity = Math.max(1, ...sorted.map(t => t.velocityScore));

    const sortButtonStyle = 'display:block;width:100%;appearance:none;border:0;padding:0;background:transparent;color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit;cursor:inherit;white-space:inherit';

    const rows = sorted.slice(0, 50).map((tk, i) => {
      const vColor = velocityColor(tk.velocityScore);
      const barPct = Math.max(4, Math.round((tk.velocityScore / maxVelocity) * 100));
      const subs = tk.subreddits.map(s =>
        `<span style="font-size:calc(8px * var(--wm-panel-effective-scale, 1));padding:1px 4px;border-radius:2px;background:rgba(255,255,255,0.06);color:var(--text-secondary);margin-right:2px">r/${escapeHtml(s)}</span>`
      ).join('');

      return `<tr>
        <td class="wsb-rank">${i + 1}</td>
        <td class="wsb-ticker">${escapeHtml(tk.symbol)}</td>
        <td class="wsb-num">${tk.mentionCount}</td>
        <td class="wsb-num">${formatCompact(tk.totalScore)}</td>
        <td class="wsb-velocity">
          <div style="display:flex;align-items:center;gap:4px">
            <span style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));font-weight:600;color:${velocityTextColor(tk.velocityScore)};min-width:24px;text-align:right">${Math.round(tk.velocityScore)}</span>
            <div style="flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.08)">
              <div style="height:100%;width:${barPct}%;border-radius:2px;background:${vColor}"></div>
            </div>
          </div>
        </td>
        <td>${subs}</td>
      </tr>`;
    }).join('');

    this.setSafeContent(unsafeRawHtml(`
      <div class="table-scroll" role="group" tabindex="0" aria-labelledby="${this.panelId}Title" style="overflow-y:auto;max-height:480px">
        <table class="wm-table wsb-table">
          <thead>
            <tr>
              <th scope="col" class="wsb-num">#</th>
              <th scope="col">Ticker</th>
              <th scope="col" class="wsb-num" data-sort="mentionCount"${this._ariaSort('mentionCount')}>
                <button type="button" data-sort="mentionCount" style="${sortButtonStyle};text-align:right">Mentions<span aria-hidden="true">${this._sortIndicator('mentionCount')}</span></button>
              </th>
              <th scope="col" class="wsb-num" data-sort="totalScore"${this._ariaSort('totalScore')}>
                <button type="button" data-sort="totalScore" style="${sortButtonStyle};text-align:right">Score<span aria-hidden="true">${this._sortIndicator('totalScore')}</span></button>
              </th>
              <th scope="col" data-sort="velocityScore"${this._ariaSort('velocityScore')}>
                <button type="button" data-sort="velocityScore" style="${sortButtonStyle};text-align:left">Velocity<span aria-hidden="true">${this._sortIndicator('velocityScore')}</span></button>
              </th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" class="wsb-empty">No ticker data</td></tr>'}</tbody>
        </table>
      </div>
      <div style="margin-top:6px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">Reddit \u00B7 r/wallstreetbets, r/stocks, r/investing \u00B7 sorted by ${this._sortField.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
    `, 'legacy Panel.setContent() migration'), focusField ? () => {
      this.content.querySelector<HTMLButtonElement>(`button[data-sort="${focusField}"]`)
        ?.focus({ preventScroll: true });
    } : undefined);
  }
}
