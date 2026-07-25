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
import {
  createMarketChartFocusController,
  type MarketChartFocusController,
} from './market-chart-interactions';

let modalEl: HTMLElement | null = null;
let focusController: MarketChartFocusController | null = null;

function removeMarketChartModal(restoreFocus: boolean): void {
  modalEl?.remove();
  modalEl = null;
  focusController?.deactivate({ restoreFocus });
  focusController = null;
}

export function closeMarketChartModal(): void {
  removeMarketChartModal(true);
}

export function openMarketChartModal(stock: MarketData): void {
  const chart = terminalChart(stock.sparkline, {
    change: stock.change,
    width: 520,
    height: 240,
    formatValue: (v) => formatPrice(v),
    ariaLabel: t('components.markets.chart.title', { symbol: stock.display }),
  });
  if (!chart) return; // no plottable series

  // If a caller replaces an open chart, preserve the original row as the
  // eventual focus destination instead of briefly focusing it between dialogs.
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const returnFocus = focusController?.returnFocus?.isConnected
    ? focusController.returnFocus
    : activeElement?.isConnected
      ? activeElement
      : null;
  removeMarketChartModal(false);

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
        <button type="button" class="market-chart-close" aria-label="${t('components.markets.chart.close')}">
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
  const closeButton = modalEl.querySelector<HTMLElement>('.market-chart-close');
  closeButton?.addEventListener('click', closeMarketChartModal);
  focusController = createMarketChartFocusController(modalEl, closeMarketChartModal, returnFocus);

  document.body.appendChild(modalEl);
  focusController.activate(closeButton);
}
