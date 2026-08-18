/**
 * Shared market-watchlist editor modal.
 *
 * The watchlist drives the Markets panel through a replaceable built-in base
 * plus additive searched tickers. The same effective selection feeds Premium
 * Stock Analysis, Backtesting, and the Daily Market Brief, so the editor is
 * reachable from every panel that consumes it rather than living only on the
 * Markets header.
 */

import {
  getCatalogSelection,
  getMarketWatchlistEntries,
  resolveEffectiveMarketWatchlist,
  setMarketWatchlistPreferences,
} from '@/services/market-watchlist';
import { MARKET_SYMBOLS, REGION_LABELS, STOCK_CATALOG } from '@/config/markets';
import { WatchlistEditor } from './WatchlistEditor';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { createFocusTrap } from '@/utils/focus-trap';


let activeOverlay: HTMLElement | null = null;

export function openWatchlistModal(): void {
  if (activeOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'marketWatchlistModal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'wmMarketWatchlistTitle');

  const editor = new WatchlistEditor({ initial: getMarketWatchlistEntries() });
  const resolvedInitial = resolveEffectiveMarketWatchlist(
    STOCK_CATALOG,
    MARKET_SYMBOLS,
    getCatalogSelection(),
    editor.getEntries(),
  );
  const selected = new Set(resolvedInitial.baseSymbols.map((symbol) => symbol.symbol));
  let activeRegion = 'all';
  let filterText = '';

  const close = () => {
    document.removeEventListener('keydown', onDocumentKeydown);
    focusTrap.deactivate();
    editor.destroy();
    overlay.remove();
    if (activeOverlay === overlay) activeOverlay = null;
  };
  const focusTrap = createFocusTrap(overlay);

  const onDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const modal = document.createElement('div');
  modal.className = 'modal unified-settings-modal';
  modal.style.maxWidth = '680px';

  setTrustedHtml(modal, trustedHtml(`
    <div class="modal-header">
      <span class="modal-title" id="wmMarketWatchlistTitle">Market watchlist</span>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div style="padding:14px 16px 16px 16px">
      <div style="color:var(--text-dim);font-size:calc(12px * var(--wm-panel-effective-scale, 1));line-height:1.5;margin-bottom:12px">
        Choose the built-in market universe by region, then add searchable
        company tickers below. Searchable additions stay visible and removable,
        and lead Premium Stock Analysis, Backtesting and Daily Market Brief.
      </div>
      <section aria-labelledby="wmCatalogHeading">
        <div class="wl-section-heading" id="wmCatalogHeading">Built-in catalog</div>
        <div class="wl-region-bar" role="group" aria-label="Filter catalog by region"></div>
        <label class="wl-search">
          <span class="sr-only">Search built-in market catalog</span>
          <input id="wmCatalogSearch" type="search" placeholder="Search stocks and indices" aria-label="Search stocks and indices" />
        </label>
        <div class="wl-grid" role="group" aria-label="Built-in market symbols"></div>
        <div class="wl-counter" aria-live="polite"></div>
      </section>
      <div class="wl-section-heading">Searchable additions</div>
      <div id="wmWatchlistEditorMount"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button type="button" class="panels-reset-layout" id="wmMarketResetBtn">Reset</button>
        <button type="button" class="panels-reset-layout" id="wmMarketCancelBtn">Cancel</button>
        <button type="button" class="panels-reset-layout" id="wmMarketSaveBtn" style="border-color:var(--text-dim);color:var(--text)">Save</button>
      </div>
    </div>
  `, "legacy direct innerHTML migration"));

  modal.querySelector('.modal-close')?.addEventListener('click', close);
  modal.querySelector<HTMLDivElement>('#wmWatchlistEditorMount')?.append(editor.element);

  const renderCounter = () => {
    const counter = modal.querySelector<HTMLElement>('.wl-counter');
    if (counter) counter.textContent = `${selected.size} built-in symbol${selected.size === 1 ? '' : 's'} selected`;
  };

  const renderCatalog = () => {
    const grid = modal.querySelector<HTMLElement>('.wl-grid');
    if (!grid) return;
    grid.replaceChildren();
    const query = filterText.trim().toLowerCase();
    for (const symbol of STOCK_CATALOG) {
      if (activeRegion !== 'all' && symbol.region !== activeRegion) continue;
      if (query && ![symbol.symbol, symbol.display, symbol.name].some((value) => value.toLowerCase().includes(query))) continue;
      const checked = selected.has(symbol.symbol);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wl-item${checked ? ' active' : ''}`;
      button.dataset.symbol = symbol.symbol;
      button.setAttribute('role', 'checkbox');
      button.setAttribute('aria-checked', String(checked));

      const check = document.createElement('span');
      check.className = 'wl-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = checked ? '✓' : '';
      const info = document.createElement('span');
      info.className = 'wl-item-info';
      const name = document.createElement('span');
      name.className = 'wl-item-name';
      name.textContent = symbol.name;
      const ticker = document.createElement('span');
      ticker.className = 'wl-item-ticker';
      ticker.textContent = symbol.display;
      info.append(name, ticker);
      button.append(check, info);
      button.addEventListener('click', () => {
        if (selected.has(symbol.symbol)) selected.delete(symbol.symbol);
        else selected.add(symbol.symbol);
        renderCatalog();
      });
      grid.append(button);
    }
    renderCounter();
  };

  const renderRegions = () => {
    const bar = modal.querySelector<HTMLElement>('.wl-region-bar');
    if (!bar) return;
    bar.replaceChildren();
    const regions: Array<[string, string]> = [['all', 'All'], ...Object.entries(REGION_LABELS)];
    for (const [key, label] of regions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wl-pill${activeRegion === key ? ' active' : ''}`;
      button.setAttribute('aria-pressed', String(activeRegion === key));
      button.textContent = label;
      button.addEventListener('click', () => {
        activeRegion = key;
        renderRegions();
        renderCatalog();
      });
      bar.append(button);
    }
  };

  modal.querySelector<HTMLInputElement>('#wmCatalogSearch')?.addEventListener('input', (event) => {
    filterText = (event.currentTarget as HTMLInputElement).value;
    renderCatalog();
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  document.addEventListener('keydown', onDocumentKeydown);
  renderRegions();
  renderCatalog();
  // Capture the opener for focus restore; the editor then takes initial focus.
  focusTrap.activate();
  editor.focus();

  modal.querySelector<HTMLButtonElement>('#wmMarketCancelBtn')?.addEventListener('click', close);
  modal.querySelector<HTMLButtonElement>('#wmMarketResetBtn')?.addEventListener('click', () => {
    // Clear in place — the user still confirms with Save (or backs out with
    // Cancel). The old modal reset-and-closed in one click, which committed
    // a destructive change with no confirmation step.
    editor.clear();
    selected.clear();
    for (const symbol of MARKET_SYMBOLS) selected.add(symbol.symbol);
    filterText = '';
    const search = modal.querySelector<HTMLInputElement>('#wmCatalogSearch');
    if (search) search.value = '';
    activeRegion = 'all';
    renderRegions();
    renderCatalog();
  });
  modal.querySelector<HTMLButtonElement>('#wmMarketSaveBtn')?.addEventListener('click', () => {
    const entries = editor.getEntries();
    const orderedCatalog = STOCK_CATALOG.filter((symbol) => selected.has(symbol.symbol)).map((symbol) => symbol.symbol);
    const defaults = MARKET_SYMBOLS.map((symbol) => symbol.symbol);
    const catalogSelection = orderedCatalog.length > 0
      && (orderedCatalog.length !== defaults.length || orderedCatalog.some((symbol, index) => symbol !== defaults[index]))
      ? orderedCatalog
      : null;
    setMarketWatchlistPreferences({ catalogSelection, entries });
    // Watchlist story alerts (#4922 U3): if the user's alert rule opted into
    // watchlist_story_alert, re-sync its server-side ticker-scope to the
    // just-saved list. Fire-and-forget + dynamically imported so the modal
    // stays dependency-light; gated on signed-in PRO before any network call
    // (the notification-channels endpoint 403s free users — avoid the
    // client-side 4xx flood class). The helper itself additionally no-ops
    // when the rule is disabled or never opted in.
    void (async () => {
      try {
        const [{ hasTier }, { getCurrentClerkUser }] = await Promise.all([
          import('@/services/entitlements'),
          import('@/services/clerk'),
        ]);
        if (!getCurrentClerkUser() || !hasTier(1)) return;
        const { syncWatchlistTickersToAlertRule } = await import('@/services/notification-channels');
        await syncWatchlistTickersToAlertRule([
          ...entries.map((entry) => entry.symbol),
          ...(catalogSelection ?? []),
        ]);
      } catch (err) {
        console.warn('[watchlist] alert-rule ticker re-sync failed (not saved):', err);
      }
    })();
    close();
  });
}

/**
 * Build a header button wired to {@link openWatchlistModal}. Reuses the
 * existing `live-news-settings-btn` styling so it matches the other panel
 * header affordances.
 */
export function createWatchlistButton(label = 'Watchlist'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'live-news-settings-btn';
  btn.title = 'Customize market watchlist';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openWatchlistModal();
  });
  return btn;
}
