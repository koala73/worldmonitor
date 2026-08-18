/**
 * Full-page stock research overlay. Composes the existing Yahoo/sparkline
 * chart, AnalyzeStock, and backtest entry. Does not add a market vendor.
 */

import type { MarketData } from '@/types';
import { formatChange, formatPrice, getChangeClass } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { terminalChart } from '@/utils/terminal-chart';
import { hasPremiumAccess } from '@/services/panel-gating';
import {
  tapeClaimForMarketSource,
  tapeClaimLabel,
  type MarketTapeSource,
  type TapeClaim,
} from '@/services/market-tape-claim';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { MarketServiceClient } from '@/services/generated-rpc-clients';
import {
  createMarketChartFocusController,
  hasPlottableMarketSeries,
  type MarketChartFocusController,
} from '@/components/market-chart-interactions';
import {
  normalizeStockResearchSymbol,
  stockResearchUrl,
} from './stock-research-route';

/** '/' is rewritten to the marketing page in production; the app lives here. */
const DASHBOARD_PATH = '/dashboard';

let overlayEl: HTMLElement | null = null;
let focusController: MarketChartFocusController | null = null;
let analyzeAbort: AbortController | null = null;
let popStateBound = false;
/**
 * Distinguishes overlapping opens. The deep-link timer and a Market Panel click
 * can both call in; without a token the later teardown/rebuild would clobber
 * whichever overlay the user actually asked for.
 */
let openGeneration = 0;
/** Where to send the address bar when the overlay closes. */
let returnUrl: string | null = null;

const ANALYZE_TIMEOUT_MS = 20_000;

/**
 * Resolve the badge for the header quote.
 *
 * The quote comes from ListMarketQuotes, which answers the default symbol
 * universe from the Railway seed snapshot rather than a live Yahoo fetch — and
 * MarketData carries no provenance field to tell the two apart. Hardcoding
 * `{ source: 'yahoo' }` labelled a seeded row "Delayed / unverified", a
 * confident claim about data this surface cannot classify. Until provenance is
 * threaded through MarketQuote -> MarketData, render no badge rather than a
 * wrong one; this seam is where the real source plugs in.
 */
function tapeNote(source?: MarketTapeSource, keyConfigured = true): { claim: TapeClaim; label: string } | null {
  if (!source) return null;
  const claim = tapeClaimForMarketSource({ source, keyConfigured });
  return { claim, label: tapeClaimLabel(claim) };
}

function removeOverlay(restoreFocus: boolean): void {
  analyzeAbort?.abort();
  analyzeAbort = null;
  overlayEl?.remove();
  overlayEl = null;
  focusController?.deactivate({ restoreFocus });
  focusController = null;
}

function onPopState(): void {
  // Back must close the overlay. Use removeOverlay, not the public close: the
  // browser has already restored the previous entry, so writing history here
  // would stack a second edit on top of it.
  if (!overlayEl || isStockResearchLocation()) return;
  removeOverlay(true);
  // The browser restored the entry itself, so the recorded return target is
  // spent; keeping it would misdirect a later close.
  returnUrl = null;
}

export function closeStockResearchOverlay(): void {
  removeOverlay(true);
  if (!isStockResearchLocation()) return;
  // Preserve history.state: it carries the shared overlay marker that other
  // sheets rely on for Back handling (see event-handlers.ts writeUrlState).
  const next = returnUrl ?? `${DASHBOARD_PATH}${window.location.search}`;
  returnUrl = null;
  window.history.replaceState(window.history.state, '', next);
}

function isStockResearchLocation(): boolean {
  return /^\/stocks(?:\/|$)/.test(window.location.pathname);
}

export function navigateToStockResearch(symbol: string, stock?: MarketData): void {
  const normalized = normalizeStockResearchSymbol(symbol);
  if (!normalized) return;
  const url = stockResearchUrl(normalized);
  if (window.location.pathname !== url) {
    if (!isStockResearchLocation()) {
      returnUrl = `${window.location.pathname}${window.location.search}`;
    }
    window.history.pushState(
      { ...(window.history.state as Record<string, unknown> | null ?? {}), stockResearch: normalized },
      '',
      url,
    );
  }
  void openStockResearchOverlay(normalized, stock);
}

export async function openStockResearchOverlay(rawSymbol: string, stock?: MarketData): Promise<void> {
  const symbol = normalizeStockResearchSymbol(rawSymbol);
  if (!symbol) return;

  const generation = ++openGeneration;
  if (!popStateBound) {
    window.addEventListener('popstate', onPopState);
    popStateBound = true;
  }
  if (returnUrl === null && !isStockResearchLocation()) {
    returnUrl = `${window.location.pathname}${window.location.search}`;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const returnFocus = focusController?.returnFocus?.isConnected
    ? focusController.returnFocus
    : activeElement?.isConnected
      ? activeElement
      : null;
  removeOverlay(false);

  overlayEl = document.createElement('div');
  overlayEl.className = 'stock-research-overlay';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'true');
  overlayEl.setAttribute('aria-label', `${symbol} research`);

  const entitled = hasPremiumAccess();
  const tape = tapeNote();
  const chart = stock && hasPlottableMarketSeries(stock)
    ? terminalChart(stock.sparkline, {
      change: stock.change,
      width: 640,
      height: 240,
      formatValue: (value) => formatPrice(value),
      ariaLabel: `${stock.display} price chart`,
    })
    : '';

  setTrustedHtml(
    overlayEl,
    trustedHtml(`
      <div class="stock-research-room">
        <button type="button" class="stock-research-close" aria-label="Close research">Close</button>
        <header class="stock-research-head">
          <div>
            <div class="stock-research-symbol">${escapeHtml(symbol)}</div>
            <div class="stock-research-name">${escapeHtml(stock?.name || symbol)}</div>
          </div>
          <div class="stock-research-quote">
            <span>${stock ? formatPrice(stock.price) : '—'}</span>
            <span class="${stock ? getChangeClass(stock.change) : ''}">${stock ? formatChange(stock.change) : ''}</span>
            ${tape ? `<div class="stock-research-tape" data-tape-claim="${escapeHtml(tape.claim)}">${escapeHtml(tape.label)}</div>` : ''}
          </div>
        </header>
        <div class="stock-research-chart">${chart || '<p>No plottable Yahoo series for this symbol yet.</p>'}</div>
        <section class="stock-research-analyze" data-analyze-state="${entitled ? 'loading' : 'locked'}">
          ${entitled ? '<p>Loading analysis…</p>' : '<p>Premium stock analysis and backtest stay locked.</p>'}
        </section>
      </div>
    `, 'Stock research overlay values are escaped before rendering'),
  );

  document.body.append(overlayEl);
  overlayEl.querySelector('.stock-research-close')?.addEventListener('click', () => closeStockResearchOverlay());
  overlayEl.addEventListener('click', (event) => {
    if (event.target === overlayEl) closeStockResearchOverlay();
  });
  focusController = createMarketChartFocusController(overlayEl, () => closeStockResearchOverlay(), returnFocus);
  const closeButton = overlayEl.querySelector('.stock-research-close');
  focusController.activate(closeButton instanceof HTMLElement ? closeButton : null);

  if (!entitled) return;
  const analyzeHost = overlayEl.querySelector('.stock-research-analyze');
  if (!(analyzeHost instanceof HTMLElement)) return;
  const teardown = new AbortController();
  analyzeAbort = teardown;
  const signal = AbortSignal.any([teardown.signal, AbortSignal.timeout(ANALYZE_TIMEOUT_MS)]);
  try {
    const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
    const analysis = await client.analyzeStock(
      { symbol, name: stock?.name || symbol, includeNews: true },
      { signal },
    );
    // A superseded open (or a close) must not paint over the live overlay.
    if (generation !== openGeneration || !analyzeHost.isConnected) return;
    const headlines = (analysis.headlines ?? []).slice(0, 3).map((headline) => {
      const aligned = headline.alignedTradingDate
        ? ` aligned ${escapeHtml(headline.alignedTradingDate)}`
        : '';
      // sanitizeUrl, not escapeHtml: headline.link is relayed third-party news
      // data and escapeHtml cannot reject a javascript:/data: scheme. Matches
      // StockAnalysisPanel's handling of the same field.
      const href = sanitizeUrl(headline.link);
      const title = escapeHtml(headline.title);
      const label = href
        ? `<a href="${href}" target="_blank" rel="noreferrer">${title}</a>`
        : title;
      return `<li>${label}<span>${escapeHtml(headline.source || '')}${aligned}</span></li>`;
    }).join('');
    const sentiment = analysis.newsSentiment == null
      ? ''
      : `<p data-news-overlay="model">News overlay (model): ${analysis.newsSentiment.toFixed(2)}</p>`;
    analyzeHost.dataset.analyzeState = 'ready';
    setTrustedHtml(
      analyzeHost,
      trustedHtml(`
        <h2>Analysis</h2>
        <p>${escapeHtml(analysis.ratingSummary || analysis.summary || 'No analysis summary.')}</p>
        ${sentiment}
        ${headlines ? `<ul class="stock-research-news">${headlines}</ul>` : '<p>No headlines.</p>'}
        <p class="stock-research-backtest">Backtest remains in the Premium Stock Backtest panel.</p>
      `, 'Stock research analysis values are escaped before rendering'),
    );
  } catch {
    // Our own teardown is not an outage — but a TIMEOUT also arrives as an
    // AbortError, and that one must still surface, or the overlay would sit on
    // "Loading analysis…" forever. Distinguish on which controller fired.
    if (teardown.signal.aborted) return;
    if (generation !== openGeneration || !analyzeHost.isConnected) return;
    analyzeHost.dataset.analyzeState = 'error';
    analyzeHost.replaceChildren();
    analyzeHost.append(Object.assign(document.createElement('p'), {
      textContent: 'Premium analysis is unavailable right now.',
    }));
  }
}
