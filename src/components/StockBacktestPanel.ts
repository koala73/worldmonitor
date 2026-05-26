import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { StockBacktestResult } from '@/services/stock-backtest';
import { escapeHtml } from '@/utils/sanitize';
import { createWatchlistButton } from './watchlist-modal';
import { WatchlistTableView } from './WatchlistTableView';

function tone(value: number): string {
  if (value > 0) return '#8df0b2';
  if (value < 0) return '#ff8c8c';
  return 'var(--text-dim)';
}

function fmtPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function backtestSignalClass(winRate: number): string {
  if (winRate >= 55) return 'badge-bullish';
  if (winRate >= 45) return 'badge-neutral';
  return 'badge-bearish';
}

function backtestSignalLabel(winRate: number): string {
  if (winRate >= 55) return 'Profitable';
  if (winRate >= 45) return 'Mixed';
  return 'Losing';
}

export class StockBacktestPanel extends Panel {
  private tableView?: WatchlistTableView<StockBacktestResult>;

  constructor() {
    super({ id: 'stock-backtest', title: 'Premium Backtesting', infoTooltip: t('components.stockBacktest.infoTooltip'), premium: 'locked' });
    this.header.appendChild(createWatchlistButton('Edit Watchlist'));
  }

  public renderBacktests(items: StockBacktestResult[], source: 'live' | 'cached' = 'live'): void {
    if (items.length === 0) {
      this.setDataBadge('unavailable');
      this.showRetrying('No stock backtests available yet.');
      return;
    }

    this.setDataBadge(source, `${items.length} symbols`);

    if (!this.tableView) {
      this.tableView = new WatchlistTableView<StockBacktestResult>({
        intro: 'Historical replay of the premium stock-analysis signal engine over recent daily bars.',
        columns: [
          {
            key: 'symbol', label: 'Symbol', sortable: true, sortOptionKey: 'symbol-asc',
            cell: (i) => `<strong>${escapeHtml(i.display || i.symbol)}</strong>`,
          },
          {
            key: 'winrate', label: 'Win Rate', align: 'right', sortable: true, sortOptionKey: 'winrate-desc',
            cell: (i) => escapeHtml(fmtPct(i.winRate)),
          },
          {
            key: 'direction', label: 'Direction', align: 'right', sortable: true, sortOptionKey: 'direction-desc',
            cell: (i) => escapeHtml(fmtPct(i.directionAccuracy)),
          },
          {
            key: 'avgreturn', label: 'Avg Return', align: 'right', sortable: true, sortOptionKey: 'avgreturn-desc',
            cell: (i) => `<span style="color:${tone(i.avgSimulatedReturnPct)}">${escapeHtml(fmtPct(i.avgSimulatedReturnPct))}</span>`,
          },
          {
            key: 'signals', label: 'Signals', align: 'right', sortable: true, sortOptionKey: 'signals-desc',
            cell: (i) => escapeHtml(String(i.actionableEvaluations)),
          },
        ],
        filters: [
          { key: 'all', label: 'All', match: () => true },
          // The Win Rate ≥ 55% / ≥ 45% / < 45% bands mirror the
          // Profitable / Mixed / Losing badge classifier in
          // backtestSignalLabel so the pill semantics match the row badge.
          { key: 'profitable', label: 'Profitable', match: (i) => i.winRate >= 55 },
          { key: 'mixed', label: 'Mixed', match: (i) => i.winRate >= 45 && i.winRate < 55 },
          { key: 'losing', label: 'Losing', match: (i) => i.winRate < 45 },
        ],
        sortOptions: [
          { key: 'winrate-desc', label: 'Win Rate ↓', cmp: (a, b) => b.winRate - a.winRate },
          { key: 'direction-desc', label: 'Direction ↓', cmp: (a, b) => b.directionAccuracy - a.directionAccuracy },
          { key: 'avgreturn-desc', label: 'Avg Return ↓', cmp: (a, b) => b.avgSimulatedReturnPct - a.avgSimulatedReturnPct },
          { key: 'signals-desc', label: 'Signals ↓', cmp: (a, b) => b.actionableEvaluations - a.actionableEvaluations },
          { key: 'symbol-asc', label: 'Symbol A-Z', cmp: (a, b) => (a.display || a.symbol).localeCompare(b.display || b.symbol) },
        ],
        defaultSort: 'winrate-desc',
        defaultFilter: 'all',
        getKey: (i) => i.symbol,
        getSearchText: (i) => `${i.symbol} ${i.display || ''} ${i.name || ''}`,
        renderDetail: (i) => this.renderDetail(i),
        searchPlaceholder: 'Search ticker or name...',
      });
    }

    this.tableView.setItems(items);
    this.rerender();
  }

  private rerender(): void {
    if (!this.tableView) return;
    this.setContent(this.tableView.render());
    this.tableView.bind(this.content, () => this.rerender());
  }

  private renderDetail(item: StockBacktestResult): string {
    return `
      <section style="padding:14px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <strong style="font-size:16px;letter-spacing:-0.02em">${escapeHtml(item.name || item.symbol)}</strong>
              <span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);text-transform:uppercase">${escapeHtml(item.display || item.symbol)}</span>
              <span class="signal-badge ${backtestSignalClass(item.winRate)}">${escapeHtml(backtestSignalLabel(item.winRate))}</span>
            </div>
            <div style="margin-top:6px;font-size:12px;color:var(--text-dim);line-height:1.5">${escapeHtml(item.summary)}</div>
          </div>
          <div style="text-align:right;min-width:110px">
            <div style="font-size:18px;font-weight:700;color:${tone(item.avgSimulatedReturnPct)}">${escapeHtml(fmtPct(item.avgSimulatedReturnPct))}</div>
            <div style="font-size:11px;color:var(--text-dim)">Avg simulated return</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;font-size:11px">
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Win Rate</div><div style="margin-top:4px">${escapeHtml(fmtPct(item.winRate))}</div></div>
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Direction Accuracy</div><div style="margin-top:4px">${escapeHtml(fmtPct(item.directionAccuracy))}</div></div>
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Cumulative</div><div style="margin-top:4px;color:${tone(item.cumulativeSimulatedReturnPct)}">${escapeHtml(fmtPct(item.cumulativeSimulatedReturnPct))}</div></div>
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Signals</div><div style="margin-top:4px">${escapeHtml(String(item.actionableEvaluations))}</div></div>
        </div>
        <div style="display:grid;gap:6px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Recent Evaluations</div>
          ${item.evaluations.map((evaluation) => `
            <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);background:rgba(255,255,255,0.02);font-size:11px">
              <span>${escapeHtml(evaluation.signal)} · ${escapeHtml(evaluation.outcome)} · ${escapeHtml(fmtPct(evaluation.simulatedReturnPct))}</span>
              <span style="color:var(--text-dim)">${escapeHtml(new Date(Number(evaluation.analysisAt)).toLocaleDateString())}</span>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }
}
