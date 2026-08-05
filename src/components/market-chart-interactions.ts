import type { MarketData } from '@/types';
import { escapeHtml } from '@/utils/sanitize';

type MarketProvider = () => readonly MarketData[];
type MarketChartOpener = (stock: MarketData) => void;

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function hasPlottableMarketSeries(stock: MarketData): boolean {
  return Array.isArray(stock.sparkline) && stock.sparkline.filter((value) => Number.isFinite(value)).length >= 2;
}

export function getMarketChartRowAttributes(stock: MarketData, index: number, ariaLabel: string): string {
  if (!hasPlottableMarketSeries(stock)) return ' class="market-item"';

  return ` class="market-item market-item-clickable" data-market-chart="${index}" role="button" tabindex="0" aria-label="${escapeHtml(ariaLabel)}"`;
}

export function bindMarketChartActivation(
  content: HTMLElement,
  getMarkets: MarketProvider,
  openChart: MarketChartOpener,
): void {
  const openFromTarget = (target: HTMLElement): void => {
    const row = target.closest<HTMLElement>('[data-market-chart]');
    if (!row) return;

    const index = Number(row.dataset.marketChart);
    const stock = Number.isInteger(index) && index >= 0 ? getMarkets()[index] : undefined;
    if (stock) openChart(stock);
  };

  content.addEventListener('click', (event) => openFromTarget(event.target as HTMLElement));
  content.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target as HTMLElement).closest('[data-market-chart]')) return;

    event.preventDefault();
    openFromTarget(event.target as HTMLElement);
  });
}

export interface MarketChartFocusController {
  readonly returnFocus: HTMLElement | null;
  activate(initialFocus?: HTMLElement | null): void;
  deactivate(options?: { restoreFocus?: boolean }): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

export function createMarketChartFocusController(
  container: HTMLElement,
  onEscape: () => void,
  returnFocus: HTMLElement | null,
): MarketChartFocusController {
  let active = false;

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = focusableElements(container);
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const current = document.activeElement;
    const shouldWrap = !focusable.includes(current as HTMLElement)
      || (event.shiftKey && current === first)
      || (!event.shiftKey && current === last);
    if (!shouldWrap) return;

    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };

  return {
    returnFocus,
    activate(initialFocus = null): void {
      if (!active) {
        document.addEventListener('keydown', onKeydown, true);
        active = true;
      }
      (initialFocus ?? focusableElements(container)[0])?.focus();
    },
    deactivate({ restoreFocus = true } = {}): void {
      if (active) {
        document.removeEventListener('keydown', onKeydown, true);
        active = false;
      }
      if (restoreFocus && returnFocus?.isConnected) {
        returnFocus.focus();
      }
    },
  };
}
