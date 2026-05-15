/**
 * Search-first market watchlist editor.
 *
 * Replaces the old free-text textarea: the user types a ticker or company
 * name, picks from a keyboard-navigable dropdown of REAL symbols (Finnhub-
 * backed via /api/symbol-search), and the pick becomes a chip. Invalid input
 * is structurally impossible — every entry comes from a resolved search
 * result, so the watchlist only ever contains tickers the data pipeline can
 * actually track.
 *
 * Keyboard: ↑/↓ move the dropdown highlight, Enter adds the highlighted
 * result, Backspace on an empty input removes the last chip, Esc closes the
 * dropdown.
 */

import { escapeHtml } from '@/utils/sanitize';
import { searchSymbols, toWatchlistEntry, type SymbolSearchResult } from '@/services/symbol-search';
import type { MarketWatchlistEntry } from '@/services/market-watchlist';

const SEARCH_DEBOUNCE_MS = 280;
const MAX_ENTRIES = 50;

export interface WatchlistEditorOptions {
  /** The user's current watchlist — seeds the chips. */
  initial: MarketWatchlistEntry[];
}

function dedupeEntries(list: MarketWatchlistEntry[]): MarketWatchlistEntry[] {
  const seen = new Set<string>();
  const out: MarketWatchlistEntry[] = [];
  for (const e of list || []) {
    const symbol = (e?.symbol || '').trim();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      ...(e.name ? { name: e.name } : {}),
      ...(e.display ? { display: e.display } : {}),
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

export class WatchlistEditor {
  public readonly element: HTMLDivElement;
  private input: HTMLInputElement;
  private dropdown: HTMLUListElement;
  private chipsEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private entries: MarketWatchlistEntry[];
  private results: SymbolSearchResult[] = [];
  private highlight = -1;
  private loading = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;

  constructor(opts: WatchlistEditorOptions) {
    this.entries = dedupeEntries(opts.initial);

    this.element = document.createElement('div');
    this.element.style.cssText = 'display:flex;flex-direction:column;gap:10px';

    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'position:relative';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = 'Search ticker or company — e.g. NVDA or Nvidia';
    this.input.setAttribute('aria-label', 'Search ticker or company');
    this.input.style.cssText =
      'width:100%;box-sizing:border-box;background:rgba(255,255,255,0.04);border:1px solid var(--border);' +
      'color:var(--text);border-radius:10px;padding:10px 12px;font-family:inherit;font-size:13px;outline:none';

    this.dropdown = document.createElement('ul');
    this.dropdown.setAttribute('role', 'listbox');
    this.dropdown.style.cssText =
      'position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:5;margin:0;padding:4px;list-style:none;' +
      'max-height:240px;overflow-y:auto;background:var(--bg,#0b0b0b);border:1px solid var(--border);' +
      'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:none';

    searchWrap.append(this.input, this.dropdown);

    this.chipsEl = document.createElement('div');
    this.chipsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;min-height:8px';

    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'font-size:11px;color:var(--text-dim)';

    this.element.append(searchWrap, this.chipsEl, this.statusEl);

    this.input.addEventListener('input', this.onInput);
    this.input.addEventListener('focus', this.onFocus);
    this.input.addEventListener('blur', () => setTimeout(() => this.hideDropdown(), 150));
    this.input.addEventListener('keydown', this.onKeydown);
    this.dropdown.addEventListener('mousedown', this.onDropdownMouseDown);
    this.chipsEl.addEventListener('click', this.onChipsClick);

    this.renderChips();
  }

  /** Working entries — the modal persists these on Save. */
  public getEntries(): MarketWatchlistEntry[] {
    return this.entries.slice();
  }

  /** Reset to an empty watchlist (the modal's Reset button). */
  public clear(): void {
    // Invalidate any in-flight search before wiping state — otherwise a
    // debounce timer that has already fired (but whose searchSymbols
    // response is still pending) can repopulate the dropdown after clear.
    // Bumping searchSeq makes the runSearch completion path drop the result.
    this.cancelPendingSearch();
    this.entries = [];
    this.input.value = '';
    this.results = [];
    this.highlight = -1;
    this.hideDropdown();
    this.renderChips();
  }

  public focus(): void {
    this.input.focus();
  }

  public destroy(): void {
    this.cancelPendingSearch();
  }

  /** Cancels both the debounced timer AND any in-flight runSearch via the
   * sequence guard, then clears the loading flag. Used by clear() and
   * destroy() so a search that was kicked off seconds before reset/teardown
   * cannot render results into a stale editor. */
  private cancelPendingSearch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.searchSeq++;
    this.loading = false;
  }

  // ── search ──────────────────────────────────────────────────────────────

  private onFocus = (): void => {
    if (this.results.length > 0 || this.input.value.trim()) this.showDropdown();
  };

  private onInput = (): void => {
    const q = this.input.value.trim();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (!q) {
      this.results = [];
      this.loading = false;
      this.hideDropdown();
      return;
    }
    this.loading = true;
    this.showDropdown();
    this.renderDropdown();
    this.debounceTimer = setTimeout(() => { void this.runSearch(q); }, SEARCH_DEBOUNCE_MS);
  };

  private async runSearch(q: string): Promise<void> {
    const seq = ++this.searchSeq;
    const results = await searchSymbols(q);
    // A newer keystroke superseded this search — drop the stale response.
    if (seq !== this.searchSeq) return;
    this.results = results;
    this.loading = false;
    this.highlight = results.length > 0 ? 0 : -1;
    this.renderDropdown();
  }

  // ── entries ─────────────────────────────────────────────────────────────

  private hasEntry(symbol: string): boolean {
    return this.entries.some((e) => e.symbol === symbol);
  }

  private addResult(result: SymbolSearchResult): void {
    if (this.hasEntry(result.symbol)) {
      this.input.value = '';
      this.results = [];
      this.hideDropdown();
      this.input.focus();
      return;
    }
    if (this.entries.length >= MAX_ENTRIES) {
      this.renderChips();
      return;
    }
    this.entries.push(toWatchlistEntry(result));
    this.input.value = '';
    this.results = [];
    this.highlight = -1;
    this.hideDropdown();
    this.renderChips();
    this.input.focus();
  }

  private removeEntry(symbol: string): void {
    this.entries = this.entries.filter((e) => e.symbol !== symbol);
    this.renderChips();
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private showDropdown(): void { this.dropdown.style.display = 'block'; }
  private hideDropdown(): void { this.dropdown.style.display = 'none'; }

  private renderDropdown(): void {
    this.dropdown.innerHTML = '';

    if (this.loading) {
      this.dropdown.append(this.messageRow('Searching…'));
      return;
    }
    if (this.results.length === 0) {
      this.dropdown.append(this.messageRow('No matching stocks'));
      return;
    }

    this.results.forEach((r, idx) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.idx = String(idx);
      const added = this.hasEntry(r.symbol);
      const active = idx === this.highlight;
      li.style.cssText =
        'display:flex;align-items:baseline;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;' +
        `font-size:12px;${active ? 'background:rgba(255,255,255,0.08);' : ''}` +
        (added ? 'opacity:0.5;' : '');
      if (active) li.setAttribute('aria-selected', 'true');
      li.innerHTML =
        `<span style="font-family:var(--font-mono);font-weight:600;min-width:64px">${escapeHtml(r.display || r.symbol)}</span>` +
        `<span style="color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)}</span>` +
        (added ? `<span style="margin-left:auto;color:var(--semantic-normal);font-size:11px">added</span>` : '');
      this.dropdown.append(li);
    });
  }

  private messageRow(text: string): HTMLLIElement {
    const li = document.createElement('li');
    li.style.cssText = 'padding:8px 9px;font-size:12px;color:var(--text-dim)';
    li.textContent = text;
    return li;
  }

  private renderChips(): void {
    this.chipsEl.innerHTML = '';
    for (const e of this.entries) {
      const chip = document.createElement('span');
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 9px;border:1px solid var(--border);' +
        'border-radius:999px;font-size:11px;background:rgba(255,255,255,0.03)';
      const label = e.name && e.name !== e.symbol ? `${e.display || e.symbol} · ${e.name}` : (e.display || e.symbol);
      chip.innerHTML =
        `<span><span style="font-family:var(--font-mono);font-weight:600">${escapeHtml(e.display || e.symbol)}</span>` +
        `${e.name && e.name !== e.symbol ? `<span style="color:var(--text-dim)"> · ${escapeHtml(e.name)}</span>` : ''}</span>` +
        `<button type="button" data-remove="${escapeHtml(e.symbol)}" aria-label="Remove ${escapeHtml(label)}" ` +
        `style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:13px;line-height:1;padding:0 2px">×</button>`;
      this.chipsEl.append(chip);
    }
    this.renderStatus();
  }

  private renderStatus(): void {
    const n = this.entries.length;
    if (n === 0) {
      this.statusEl.textContent = 'No tickers yet — search above to add. Defaults are shown until you add your own.';
    } else if (n >= MAX_ENTRIES) {
      this.statusEl.textContent = `${n} tickers tracked — that's the maximum.`;
    } else {
      this.statusEl.textContent = `${n} ticker${n === 1 ? '' : 's'} tracked (up to ${MAX_ENTRIES}).`;
    }
  }

  // ── events ──────────────────────────────────────────────────────────────

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.results.length === 0) return;
      this.highlight = Math.min(this.highlight + 1, this.results.length - 1);
      this.renderDropdown();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.results.length === 0) return;
      this.highlight = Math.max(this.highlight - 1, 0);
      this.renderDropdown();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = this.results[this.highlight];
      if (picked) this.addResult(picked);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hideDropdown();
      return;
    }
    if (e.key === 'Backspace' && this.input.value === '' && this.entries.length > 0) {
      // Empty input + Backspace removes the last chip — standard token-input UX.
      e.preventDefault();
      this.removeEntry(this.entries[this.entries.length - 1]!.symbol);
    }
  };

  // mousedown (not click) so it fires before the input's blur hides the list.
  private onDropdownMouseDown = (e: MouseEvent): void => {
    const item = (e.target as HTMLElement).closest('[data-idx]') as HTMLElement | null;
    if (!item) return;
    e.preventDefault();
    const idx = Number.parseInt(item.dataset.idx ?? '', 10);
    const picked = this.results[idx];
    if (picked) this.addResult(picked);
  };

  private onChipsClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement).closest('[data-remove]') as HTMLElement | null;
    if (!btn) return;
    const symbol = btn.dataset.remove;
    if (symbol) this.removeEntry(symbol);
  };
}
