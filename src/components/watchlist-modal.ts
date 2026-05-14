/**
 * Shared market-watchlist editor modal.
 *
 * The watchlist drives the Markets panel (additive to the defaults) and the
 * PRO panels — Premium Stock Analysis, Backtesting, and the Daily Market Brief
 * — so the editor is reachable from every panel that consumes it rather than
 * living only on the Markets header.
 */

import {
  getMarketWatchlistEntries,
  resetMarketWatchlist,
  setMarketWatchlistEntries,
} from '@/services/market-watchlist';
import { WatchlistEditor } from './WatchlistEditor';

let activeOverlay: HTMLElement | null = null;

export function openWatchlistModal(): void {
  if (activeOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'marketWatchlistModal';

  const editor = new WatchlistEditor({ initial: getMarketWatchlistEntries() });

  const close = () => {
    editor.destroy();
    overlay.remove();
    if (activeOverlay === overlay) activeOverlay = null;
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const modal = document.createElement('div');
  modal.className = 'modal unified-settings-modal';
  modal.style.maxWidth = '680px';

  modal.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Market watchlist</span>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div style="padding:14px 16px 16px 16px">
      <div style="color:var(--text-dim);font-size:12px;line-height:1.5;margin-bottom:12px">
        Search a ticker or company name and pick from the list — every entry is a
        real, tracked symbol. Your picks are <strong>added</strong> to the Markets
        panel and lead the Premium Stock Analysis, Backtesting and Daily Market
        Brief panels. PRO members get every ticker in the list reported (up to 50).
      </div>
      <div id="wmWatchlistEditorMount"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button type="button" class="panels-reset-layout" id="wmMarketResetBtn">Reset</button>
        <button type="button" class="panels-reset-layout" id="wmMarketCancelBtn">Cancel</button>
        <button type="button" class="panels-reset-layout" id="wmMarketSaveBtn" style="border-color:var(--text-dim);color:var(--text)">Save</button>
      </div>
    </div>
  `;

  modal.querySelector('.modal-close')?.addEventListener('click', close);
  modal.querySelector<HTMLDivElement>('#wmWatchlistEditorMount')?.append(editor.element);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  editor.focus();

  modal.querySelector<HTMLButtonElement>('#wmMarketCancelBtn')?.addEventListener('click', close);
  modal.querySelector<HTMLButtonElement>('#wmMarketResetBtn')?.addEventListener('click', () => {
    // Clear in place — the user still confirms with Save (or backs out with
    // Cancel). The old modal reset-and-closed in one click, which committed
    // a destructive change with no confirmation step.
    editor.clear();
  });
  modal.querySelector<HTMLButtonElement>('#wmMarketSaveBtn')?.addEventListener('click', () => {
    const entries = editor.getEntries();
    if (entries.length === 0) resetMarketWatchlist();
    else setMarketWatchlistEntries(entries);
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
