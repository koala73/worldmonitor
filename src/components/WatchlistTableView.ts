// Reusable table-with-expand view for watchlist-style panels (50+ symbols).
// Renders a search/filter/sort control bar + sortable table where each row
// expands inline to show full detail. Used by StockAnalysisPanel and
// StockBacktestPanel; the long-scroll one-card-per-symbol layout doesn't
// scale past ~10 symbols. Layout is option B from the watchlist panel
// playground (watchlist-panel-playground.html).
//
// Lifecycle (called from owning panel):
//   1. const view = new WatchlistTableView<T>({...config});
//   2. view.setItems(items);
//   3. panel.setSafeContent(unsafeRawHtml(view.render(), '...'));
//   4. view.bind(panel.content, () => { panel.setSafeContent(...); view.bind(...); });
//
// State is held internally so sort/filter/search/expanded persist across
// data refreshes within a session. Reset on full page reload (no
// localStorage — keeps the surface narrow).

import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

const VIRTUALIZE_ROW_THRESHOLD = 100;
// MUST stay in sync with the pinned `--watchlist-row-height` custom property /
// `.watchlist-row` height in panels.css. The CSS pins each data row to exactly
// this height (single line, no wrap) so the spacer pixel math and the
// scroll→index mapping below are exact instead of drifting with cell content.
const VIRTUAL_ROW_HEIGHT_PX = 33;
const VIRTUAL_VISIBLE_ROWS = 32;
const VIRTUAL_OVERSCAN_ROWS = 6;

// rAF gate that degrades to a 16ms timeout where rAF is unavailable (non-browser
// hosts). bind() only runs in the browser, but this keeps the path defensive.
const scheduleFrame: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => { requestAnimationFrame(cb); }
    : (cb) => { setTimeout(cb, 16); };

export interface WatchlistColumn<T> {
  // Stable HTML-attribute-safe key. Used in data-sortkey attributes.
  key: string;
  // Header label (already humanized; no further transform applied).
  label: string;
  // When true, clicking the header column toggles/applies the matching
  // sort option (looked up by sortOptionKey or falling back to key).
  sortable?: boolean;
  // The sort option to apply when this header is clicked.
  sortOptionKey?: string;
  // 'right' aligns the column content + header (numeric columns).
  align?: 'left' | 'right';
  // Returns HTML for the cell. Caller is responsible for escaping.
  cell: (item: T) => string;
}

export interface WatchlistFilter<T> {
  key: string;
  label: string;
  // Returns true to include the item.
  match: (item: T) => boolean;
}

export interface WatchlistSortOption<T> {
  key: string;
  label: string;
  cmp: (a: T, b: T) => number;
}

export interface WatchlistConfig<T> {
  columns: WatchlistColumn<T>[];
  filters: WatchlistFilter<T>[];
  sortOptions: WatchlistSortOption<T>[];
  defaultSort: string;
  defaultFilter: string;
  // Stable per-item key — drives expanded-row identity across rerenders.
  getKey: (item: T) => string;
  // Lower-cased haystack for the search-input filter.
  getSearchText: (item: T) => string;
  // The full detail card rendered when a row is expanded. Reuses the
  // existing per-symbol renderer from the owning panel.
  renderDetail: (item: T) => string;
  // Optional intro text rendered above the controls (e.g. "Analyst-grade
  // equity reports for the N tickers in your watchlist...").
  intro?: string;
  // Shown when no items match the current filter/search.
  emptyMessage?: string;
  searchPlaceholder?: string;
}

export class WatchlistTableView<T> {
  private items: T[] = [];
  // Single-slot memo of the filtered+sorted list, keyed on the inputs that
  // affect it. Pure-scroll window shifts reuse it instead of re-running
  // .slice()+filter+.sort() on every frame. Self-invalidates when items,
  // sort, filter, or search change (the key no longer matches).
  private sortedCache: { sort: string; filter: string; search: string; items: T[]; result: T[] } | null = null;
  // Guards the scroll handler so at most one window update runs per frame.
  private scrollRafPending = false;
  private state: {
    sort: string;
    filter: string;
    search: string;
    expandedKey: string | null;
    virtualStart: number;
    virtualScrollTop: number;
    expandedDetailHeight: number;
  };

  constructor(private config: WatchlistConfig<T>) {
    this.state = {
      sort: config.defaultSort,
      filter: config.defaultFilter,
      search: '',
      expandedKey: null,
      virtualStart: 0,
      virtualScrollTop: 0,
      expandedDetailHeight: 0,
    };
  }

  public setItems(items: T[]): void {
    this.items = items;
    // Drop the expanded row if the symbol is no longer in the dataset
    // (e.g. watchlist editor removed it between refreshes).
    if (this.state.expandedKey) {
      const stillPresent = items.some((item) => this.config.getKey(item) === this.state.expandedKey);
      if (!stillPresent) {
        this.state.expandedKey = null;
        this.state.expandedDetailHeight = 0;
      }
    }
  }

  // Replace the renderDetail closure (called on each data refresh to bind
  // the latest history/insider/etc. captured in the panel's lexical scope).
  public updateRenderDetail(fn: (item: T) => string): void {
    this.config = { ...this.config, renderDetail: fn };
  }

  // Replace the intro string (called per render so the item count or
  // skipped-symbol note stays in sync with the latest items).
  public updateIntro(intro: string): void {
    this.config = { ...this.config, intro };
  }

  public render(): string {
    const list = this.getFilteredSorted();
    // Clamp once, here, and thread the value through the render so render()
    // stays pure (no state mutation) and renderTableBody / getRenderedRowCount
    // can't disagree via an ordering dependency. The scroll handler clamps the
    // stored virtualStart on write, so reads here are normally already valid;
    // this read-time clamp only guards a stale value after setItems() shrinks
    // the list, and never writes back.
    const start = this.getClampedVirtualStart(list);
    const intro = this.config.intro
      ? `<div class="watchlist-intro">${this.config.intro}</div>`
      : '';
    const controls = this.renderControls();
    const tableBody = this.renderTableBody(list, start);
    const headers = this.config.columns.map((col) => {
      const sortKey = col.sortable ? (col.sortOptionKey || col.key) : '';
      // Build a SINGLE class string — pre-fix this code emitted two
      // `class` attributes (one for sortable, one for right-align) when
      // a column was both, and browsers silently drop the second one,
      // breaking click-to-sort on every right-aligned numeric column.
      // Greptile PR #3719 P2.
      const classes: string[] = [];
      if (sortKey) classes.push('watchlist-th-sortable');
      if (col.align === 'right') classes.push('watchlist-th-right');
      const classAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
      const sortAttr = sortKey ? ` data-sortkey="${escapeHtml(sortKey)}"` : '';
      const activeSortIndicator = sortKey && sortKey === this.state.sort ? ' ↓' : '';
      return `<th${classAttr}${sortAttr}>${escapeHtml(col.label)}${activeSortIndicator}</th>`;
    }).join('');
    return `
      <div class="watchlist-table-view" data-watchlist-totalrows="${list.length}" data-watchlist-renderedrows="${this.getRenderedRowCount(list, start)}">
        ${intro}
        ${controls}
        <div class="watchlist-table-scroll" data-watchlist-scroll="1">
          <table class="watchlist-table">
            <thead><tr>${headers}</tr></thead>
            <tbody>${tableBody}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // `start` is the already-clamped window start computed once by the caller
  // (render() or the scroll handler). renderTableBody does not read or mutate
  // state.virtualStart, so it is a pure function of (list, start, expandedKey).
  private renderTableBody(list: T[], start: number): string {
    if (list.length === 0) {
      return `<tr><td colspan="${this.config.columns.length}" class="watchlist-empty">${escapeHtml(this.config.emptyMessage || 'No symbols match the current filter.')}</td></tr>`;
    }
    if (!this.shouldVirtualize(list)) {
      return list.map((item) => this.renderRow(item)).join('');
    }

    const end = Math.min(list.length, start + VIRTUAL_VISIBLE_ROWS + VIRTUAL_OVERSCAN_ROWS * 2);
    const expandedIndex = this.getExpandedIndex(list);
    const topSpacerRows = start;
    const bottomSpacerRows = Math.max(0, list.length - end);
    const expandedDetailAbove = expandedIndex >= 0 && expandedIndex < start ? this.state.expandedDetailHeight : 0;
    const expandedDetailBelow = expandedIndex >= end ? this.state.expandedDetailHeight : 0;
    const topSpacer = this.renderSpacerRow(topSpacerRows, 'top', expandedDetailAbove);
    const rows = list.slice(start, end).map((item) => this.renderRow(item)).join('');
    const bottomSpacer = this.renderSpacerRow(bottomSpacerRows, 'bottom', expandedDetailBelow);
    return `${topSpacer}${rows}${bottomSpacer}`;
  }

  private renderSpacerRow(rowCount: number, position: 'top' | 'bottom', extraHeight = 0): string {
    const height = rowCount * VIRTUAL_ROW_HEIGHT_PX + extraHeight;
    if (height <= 0) return '';
    return `<tr class="watchlist-virtual-spacer watchlist-virtual-spacer-${position}" aria-hidden="true"><td colspan="${this.config.columns.length}" style="height:${height}px;padding:0;border:0"></td></tr>`;
  }

  private shouldVirtualize(list: T[]): boolean {
    return list.length > VIRTUALIZE_ROW_THRESHOLD;
  }

  private getClampedVirtualStart(list: T[]): number {
    if (!this.shouldVirtualize(list)) return 0;
    const maxStart = Math.max(0, list.length - VIRTUAL_VISIBLE_ROWS);
    return Math.min(Math.max(0, this.state.virtualStart), maxStart);
  }

  // Pure scrollTop → window-start mapping. Clamps to the same maxStart the
  // render path uses (so the bottom never overshoots and re-renders forever),
  // and subtracts the expanded-detail height when the expanded row sits above
  // the window — the top spacer includes that height, so the raw scrollTop is
  // offset by it and the uniform-row division would otherwise overshoot.
  private computeVirtualStart(scrollTop: number, list: T[]): number {
    if (!this.shouldVirtualize(list)) return 0;
    const maxStart = Math.max(0, list.length - VIRTUAL_VISIBLE_ROWS);
    const startFrom = (top: number): number =>
      Math.min(maxStart, Math.max(0, Math.floor(top / VIRTUAL_ROW_HEIGHT_PX) - VIRTUAL_OVERSCAN_ROWS));
    let start = startFrom(scrollTop);
    const expandedIndex = this.getExpandedIndex(list);
    if (expandedIndex >= 0 && expandedIndex < start && this.state.expandedDetailHeight > 0) {
      start = startFrom(Math.max(0, scrollTop - this.state.expandedDetailHeight));
    }
    return start;
  }

  private getRenderedRowCount(list: T[], start: number): number {
    if (list.length === 0) return 0;
    if (!this.shouldVirtualize(list)) return list.length;
    return Math.min(list.length - start, VIRTUAL_VISIBLE_ROWS + VIRTUAL_OVERSCAN_ROWS * 2);
  }

  private getExpandedIndex(list: T[]): number {
    if (!this.state.expandedKey) return -1;
    return list.findIndex((item) => this.config.getKey(item) === this.state.expandedKey);
  }

  private renderControls(): string {
    const placeholder = this.config.searchPlaceholder || 'Search symbol or name...';
    const pills = this.config.filters.map((f) => {
      const active = f.key === this.state.filter ? ' watchlist-pill-active' : '';
      return `<button class="watchlist-pill${active}" data-filterkey="${escapeHtml(f.key)}" type="button">${escapeHtml(f.label)}</button>`;
    }).join('');
    const sortOpts = this.config.sortOptions.map((opt) => {
      const selected = opt.key === this.state.sort ? ' selected' : '';
      return `<option value="${escapeHtml(opt.key)}"${selected}>${escapeHtml(opt.label)}</option>`;
    }).join('');
    return `
      <div class="watchlist-controls">
        <input
          class="watchlist-search"
          type="text"
          placeholder="${escapeHtml(placeholder)}"
          value="${escapeHtml(this.state.search)}"
          data-watchlist-search="1">
        <div class="watchlist-control-row">
          <div class="watchlist-pills">${pills}</div>
          <select class="watchlist-sort" data-watchlist-sort="1">${sortOpts}</select>
        </div>
      </div>
    `;
  }

  private renderRow(item: T): string {
    const key = this.config.getKey(item);
    const isExpanded = key === this.state.expandedKey;
    const cells = this.config.columns.map((col) => {
      const alignClass = col.align === 'right' ? ' class="watchlist-td-right"' : '';
      return `<td${alignClass}>${col.cell(item)}</td>`;
    }).join('');
    const row = `<tr class="watchlist-row${isExpanded ? ' watchlist-row-expanded' : ''}" data-rowkey="${escapeHtml(key)}">${cells}</tr>`;
    if (!isExpanded) return row;
    const detail = this.config.renderDetail(item);
    return `${row}<tr class="watchlist-detail-row"><td colspan="${this.config.columns.length}">${detail}</td></tr>`;
  }

  private getFilteredSorted(): T[] {
    // Return the memoized result when nothing that affects it has changed.
    // A scroll-driven window shift changes only virtualStart/scrollTop, so the
    // sorted list is identical and we skip the full slice+filter+sort. The
    // cached array is treated as read-only by every caller (slice/findIndex).
    const cache = this.sortedCache;
    if (
      cache
      && cache.items === this.items
      && cache.sort === this.state.sort
      && cache.filter === this.state.filter
      && cache.search === this.state.search
    ) {
      return cache.result;
    }
    let list = this.items.slice();
    const filter = this.config.filters.find((f) => f.key === this.state.filter);
    if (filter) list = list.filter((item) => filter.match(item));
    if (this.state.search.trim()) {
      const q = this.state.search.trim().toLowerCase();
      list = list.filter((item) => this.config.getSearchText(item).toLowerCase().includes(q));
    }
    const sortOption = this.config.sortOptions.find((s) => s.key === this.state.sort);
    if (sortOption) list.sort(sortOption.cmp);
    this.sortedCache = {
      sort: this.state.sort,
      filter: this.state.filter,
      search: this.state.search,
      items: this.items,
      result: list,
    };
    return list;
  }

  public bind(root: HTMLElement, onRerender: () => void): void {
    const rootEl = root.querySelector('.watchlist-table-view') as HTMLElement | null;
    if (!rootEl) return;

    // Row click → toggle expanded (one-at-a-time semantics: clicking a
    // different row collapses the previous one). Delegated on the stable
    // <table> element so it survives the in-place <tbody> swaps the scroll
    // handler performs (a per-row listener would be lost on every window shift).
    const tableEl = rootEl.querySelector('.watchlist-table') as HTMLElement | null;
    if (tableEl) {
      tableEl.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        const rowEl = target?.closest<HTMLElement>('.watchlist-row');
        if (!rowEl || !tableEl.contains(rowEl)) return;
        const key = rowEl.dataset.rowkey || '';
        if (this.state.expandedKey === key) {
          this.state.expandedKey = null;
          this.state.expandedDetailHeight = 0;
        } else {
          this.state.expandedKey = key;
        }
        onRerender();
      });
    }

    // Sortable header click → set sort option, rerender.
    rootEl.querySelectorAll<HTMLElement>('.watchlist-th-sortable').forEach((thEl) => {
      thEl.addEventListener('click', () => {
        const key = thEl.dataset.sortkey || '';
        if (!key) return;
        // Only switch sort if the option exists (defensive guard against
        // a column wired to a sortOptionKey that's not in sortOptions).
        if (this.config.sortOptions.some((o) => o.key === key)) {
          this.state.sort = key;
          this.resetVirtualWindow();
          onRerender();
        }
      });
    });

    // Filter pill click.
    rootEl.querySelectorAll<HTMLElement>('.watchlist-pill').forEach((pillEl) => {
      pillEl.addEventListener('click', () => {
        const key = pillEl.dataset.filterkey || '';
        if (key && key !== this.state.filter) {
          this.state.filter = key;
          this.resetVirtualWindow();
          onRerender();
        }
      });
    });

    // Sort dropdown change.
    const sortSelect = rootEl.querySelector('[data-watchlist-sort="1"]') as HTMLSelectElement | null;
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        this.state.sort = sortSelect.value;
        this.resetVirtualWindow();
        onRerender();
      });
    }

    const scrollEl = rootEl.querySelector('[data-watchlist-scroll="1"]') as HTMLElement | null;
    if (scrollEl) {
      const tbodyEl = scrollEl.querySelector('.watchlist-table tbody') as HTMLElement | null;
      scrollEl.scrollTop = this.state.virtualScrollTop;
      // Scroll updates the visible window IN PLACE (swap only the <tbody>) and
      // never call onRerender(). Going through the owning panel's setSafeContent
      // would (a) defer the swap behind a 150ms debounce that a fling never lets
      // settle — freezing the window and showing blank rows — and (b) re-run the
      // whole bind(), piling up duplicate listeners on the un-swapped DOM. The
      // in-place path also skips the full re-sort and the focus/measure work that
      // only a user-action rerender needs. rAF-gated to one update per frame.
      scrollEl.addEventListener('scroll', () => {
        this.state.virtualScrollTop = scrollEl.scrollTop;
        if (this.scrollRafPending) return;
        this.scrollRafPending = true;
        scheduleFrame(() => {
          this.scrollRafPending = false;
          this.updateVirtualWindow(scrollEl, tbodyEl, rootEl);
        });
      }, { passive: true });
    }

    this.syncExpandedDetailHeight(rootEl);

    // Search input — focus restored after rerender (setContent destroys
    // the DOM, so we keep the cursor position by reading selection state
    // before each keystroke triggers the rerender).
    const searchInput = rootEl.querySelector('[data-watchlist-search="1"]') as HTMLInputElement | null;
    if (searchInput) {
      // Restore focus on rerender — focus IS lost when setContent rebuilds
      // innerHTML, so we re-apply it whenever the input was the active
      // element before rerender. Detection: state.search is non-empty AND
      // the input has the placeholder/value mismatch handled by setting
      // selectionStart from the current value length.
      if (this.searchWasFocused) {
        searchInput.focus();
        const pos = this.state.search.length;
        try { searchInput.setSelectionRange(pos, pos); } catch { /* ignore */ }
        this.searchWasFocused = false;
      }
      searchInput.addEventListener('input', () => {
        this.state.search = searchInput.value;
        this.resetVirtualWindow();
        this.searchWasFocused = true;
        onRerender();
      });
      searchInput.addEventListener('focus', () => { this.searchWasFocused = true; });
      searchInput.addEventListener('blur', () => { this.searchWasFocused = false; });
    }
  }

  // Tracks whether the search input was focused immediately before the
  // last rerender. Necessary because Panel.setContent rebuilds the
  // content innerHTML, destroying focus state. Without this, typing in
  // the search box loses focus on every keystroke.
  private searchWasFocused = false;

  private resetVirtualWindow(): void {
    this.state.virtualStart = 0;
    this.state.virtualScrollTop = 0;
  }

  private syncExpandedDetailHeight(rootEl: HTMLElement): void {
    if (!this.state.expandedKey) {
      this.state.expandedDetailHeight = 0;
      return;
    }
    const detailEl = rootEl.querySelector('.watchlist-detail-row') as HTMLElement | null;
    if (!detailEl) return;
    const measured = Math.ceil(detailEl.getBoundingClientRect().height || detailEl.offsetHeight || 0);
    if (measured > 0) this.state.expandedDetailHeight = measured;
  }

  // Scroll-driven window update: recompute the visible window and swap ONLY the
  // <tbody> content, bypassing the panel's debounced full rerender + rebind.
  // No re-sort (memoized list), no getBoundingClientRect, no focus restore — the
  // detail-row height is stable across scroll, so it is not re-measured here.
  private updateVirtualWindow(scrollEl: HTMLElement, tbodyEl: HTMLElement | null, rootEl: HTMLElement): void {
    const list = this.getFilteredSorted();
    if (!this.shouldVirtualize(list)) return;
    const nextStart = this.computeVirtualStart(scrollEl.scrollTop, list);
    if (nextStart === this.state.virtualStart) return;
    this.state.virtualStart = nextStart;
    if (!tbodyEl) return;
    setTrustedHtml(
      tbodyEl,
      trustedHtml(this.renderTableBody(list, nextStart), 'watchlist virtual window scroll update'),
    );
    rootEl.dataset.watchlistRenderedrows = String(this.getRenderedRowCount(list, nextStart));
  }
}
