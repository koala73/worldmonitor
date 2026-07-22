// Expandable Bloomberg-terminal-style price chart for a market ticker.
//
// Opened by clicking a row in MarketPanel. Follows the singleton-overlay
// pattern used by StoryModal (create overlay -> setTrustedHtml -> backdrop/Esc
// close). The chart itself is rendered by the pure terminalChart() util from the
// ticker's existing intraday number[] series — no new data source.

import type { MarketData } from '@/types';
import { t } from '@/services/i18n';
import { formatPrice, formatChange, getChangeClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { terminalChart } from '@/utils/terminal-chart';

let modalEl: HTMLElement | null = null;

function escHandler(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMarketChartModal();
}

export function closeMarketChartModal(): void {
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
    document.removeEventListener('keydown', escHandler);
  }
}

export function openMarketChartModal(stock: MarketData): void {
  closeMarketChartModal();

  const chart = terminalChart(stock.sparkline, {
    change: stock.change,
    width: 520,
    height: 240,
    formatValue: (v) => formatPrice(v),
  });
  if (!chart) return; // no plottable series

  modalEl = document.createElement('div');
  modalEl.className = 'market-chart-overlay';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-label', t('components.markets.chart.title', { symbol: stock.display }));

  const changeClass = getChangeClass(stock.change);
  setTrustedHtml(
    modalEl,
    trustedHtml(
      `
      <div class="market-chart-modal">
        <button class="market-chart-close" aria-label="${t('components.markets.chart.close')}">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="market-chart-head">
          <div>
            <div class="market-chart-name">${escapeHtml(stock.name)}</div>
            <div class="market-chart-symbol">${escapeHtml(stock.display)}</div>
          </div>
          <div class="market-chart-quote">
            <span class="market-chart-price">${formatPrice(stock.price)}</span>
            <span class="market-change ${changeClass}">${formatChange(stock.change)}</span>
          </div>
        </div>
        <div class="market-chart-canvas">${chart}</div>
      </div>
    `,
      'generated terminal-chart SVG + escaped ticker fields',
    ),
  );

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeMarketChartModal();
  });
  modalEl.querySelector('.market-chart-close')?.addEventListener('click', closeMarketChartModal);
  document.addEventListener('keydown', escHandler);

  document.body.appendChild(modalEl);
}
