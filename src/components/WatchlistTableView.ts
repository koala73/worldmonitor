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
// Unscaled base for the `--watchlist-row-height` custom property in panels.css.
// Spacer generation uses this base; bind() measures the rendered row after
// global or per-panel scaling for exact scroll-to-index mapping.
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
  // Generation stamps gate each async DOM update to the bind() that queued it.
  // A stale frame must not mutate a replacement table or clear its pending gate.
  private scrollRafGeneration: number | null = null;
  private scaleRafGeneration: number | null = null;
  private scaleObservers: MutationObserver[] = [];
  private tableResizeObserver: ResizeObserver | null = null;
  private scaleObservationGeneration = 0;
  private lastMeasuredVirtualRowHeight: number | null = null;
  private lastMeasuredTableHeaderHeight: number | null = null;
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
    const baseHeight = rowCount * VIRTUAL_ROW_HEIGHT_PX;
    if (baseHeight + extraHeight <= 0) return '';
    const extra = extraHeight > 0 ? ` + ${extraHeight}px` : '';
    const height = `calc(${baseHeight}px * var(--wm-panel-effective-scale, 1)${extra})`;
    return `<tr class="watchlist-virtual-spacer watchlist-virtual-spacer-${position}" aria-hidden="true"><td colspan="${this.config.columns.length}" style="height:${height};padding:0;border:0"></td></tr>`;
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
  private computeVirtualStart(scrollTop: number, list: T[], rowHeightPx = VIRTUAL_ROW_HEIGHT_PX): number {
    if (!this.shouldVirtualize(list)) return 0;
    const maxStart = Math.max(0, list.length - VIRTUAL_VISIBLE_ROWS);
    const startFrom = (top: number): number =>
      Math.min(maxStart, Math.max(0, Math.floor(top / rowHeightPx) - VIRTUAL_OVERSCAN_ROWS));
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
          <select class="watchlist-sort" data-watchlist-sort="1" aria-label="Sort watchlist">${sortOpts}</select>
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
    this.disconnectScaleObserver();
    const rootEl = root.querySelector('.watchlist-table-view') as HTMLElement | null;
    if (!rootEl) return;
    const generation = this.scaleObservationGeneration;

    // Row click → toggle expanded (one-at-a-time semantics: clicking a
    // different row collapses the previous one). Delegated on the stable
    // <table> element so it survives the in-place <tbody> swaps the scroll
    // handler performs (a per-row listener would be lost on every window shift).
    const tableEl = rootEl.querySelector('.watchlist-table') as HTMLElement | null;
    const previousHeaderHeight = this.lastMeasuredTableHeaderHeight;
    const initialHeaderHeight = this.measureTableHeaderHeight(tableEl);
    let headerHeight = initialHeaderHeight
      ?? previousHeaderHeight
      ?? 0;
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
      const previousRowHeight = this.lastMeasuredVirtualRowHeight;
      const initialRowHeight = this.measureVirtualRowHeight(scrollEl);
      let rowHeight = initialRowHeight
        ?? previousRowHeight
        ?? VIRTUAL_ROW_HEIGHT_PX;
      if (
        initialRowHeight !== null
        && previousRowHeight !== null
        && initialRowHeight !== previousRowHeight
      ) {
        const reconciled = this.reconcileScaledVirtualState(
          rootEl,
          previousRowHeight,
          initialRowHeight,
          previousHeaderHeight ?? 0,
          initialHeaderHeight ?? headerHeight,
        );
        if (reconciled && this.shouldVirtualize(reconciled.list)) {
          this.replaceVirtualWindow(tbodyEl, rootEl, reconciled.list, reconciled.nextStart);
        }
      }
      if (initialRowHeight !== null) this.lastMeasuredVirtualRowHeight = initialRowHeight;
      if (initialHeaderHeight !== null) this.lastMeasuredTableHeaderHeight = initialHeaderHeight;
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
        if (this.scrollRafGeneration === generation) return;
        this.scrollRafGeneration = generation;
        scheduleFrame(() => {
          if (this.scrollRafGeneration === generation) this.scrollRafGeneration = null;
          if (generation !== this.scaleObservationGeneration || !rootEl.isConnected) return;
          this.updateVirtualWindow(scrollEl, tbodyEl, rootEl, rowHeight);
        });
      }, { passive: true });

      const reconcileScaledRows = (): void => {
        if (this.scaleRafGeneration === generation) return;
        this.scaleRafGeneration = generation;
        scheduleFrame(() => {
          if (this.scaleRafGeneration === generation) this.scaleRafGeneration = null;
          if (generation !== this.scaleObservationGeneration || !rootEl.isConnected) return;
          const nextRowHeight = this.measureVirtualRowHeight(scrollEl);
          // A hidden panel reports zero-sized rows. Keep the last good
          // measurement and retry when the panel's visibility class changes.
          if (nextRowHeight === null) return;
          this.lastMeasuredVirtualRowHeight = nextRowHeight;
          if (nextRowHeight === rowHeight) return;
          const nextHeaderHeight = this.measureTableHeaderHeight(tableEl);
          if (nextHeaderHeight !== null) {
            this.lastMeasuredTableHeaderHeight = nextHeaderHeight;
          }
          const reconciled = this.reconcileScaledVirtualState(
            rootEl,
            rowHeight,
            nextRowHeight,
            headerHeight,
            nextHeaderHeight ?? headerHeight,
          );
          rowHeight = nextRowHeight;
          headerHeight = nextHeaderHeight ?? headerHeight;
          scrollEl.scrollTop = this.state.virtualScrollTop;
          if (reconciled && this.shouldVirtualize(reconciled.list)) {
            this.replaceVirtualWindow(tbodyEl, rootEl, reconciled.list, reconciled.nextStart);
          }
        });
      };
      if (typeof ResizeObserver !== 'undefined' && tableEl) {
        // The table survives virtual tbody swaps. Its box changes whenever
        // row scale or panel visibility changes, so it is a stable source for
        // both global and panel-scale reconciliation.
        this.tableResizeObserver = new ResizeObserver(reconcileScaledRows);
        this.tableResizeObserver.observe(tableEl);
      } else {
        const globalScaleObserver = new MutationObserver(reconcileScaledRows);
        globalScaleObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style'],
        });
        this.scaleObservers.push(globalScaleObserver);
        const panel = rootEl.closest('.panel');
        if (panel) {
          const panelScaleObserver = new MutationObserver(reconcileScaledRows);
          panelScaleObserver.observe(panel, { attributes: true, attributeFilter: ['class', 'style'] });
          this.scaleObservers.push(panelScaleObserver);
        }
      }
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

  private measureExpandedDetailHeight(rootEl: HTMLElement): number {
    if (!this.state.expandedKey) return 0;

    const mountedDetail = rootEl.querySelector<HTMLElement>('.watchlist-detail-row');
    if (mountedDetail) {
      return Math.ceil(mountedDetail.getBoundingClientRect().height || mountedDetail.offsetHeight || 0);
    }

    const item = this.getFilteredSorted().find(
      candidate => this.config.getKey(candidate) === this.state.expandedKey,
    );
    const sourceTable = rootEl.querySelector<HTMLTableElement>('.watchlist-table');
    if (!item || !sourceTable) return 0;

    const measurementTable = sourceTable.cloneNode(false) as HTMLTableElement;
    measurementTable.style.position = 'absolute';
    measurementTable.style.visibility = 'hidden';
    measurementTable.style.pointerEvents = 'none';
    measurementTable.style.width = `${sourceTable.getBoundingClientRect().width}px`;
    const body = document.createElement('tbody');
    setTrustedHtml(
      body,
      trustedHtml(this.renderRow(item), 'watchlist expanded detail scale measurement'),
    );
    measurementTable.appendChild(body);
    rootEl.appendChild(measurementTable);
    const detail = measurementTable.querySelector<HTMLElement>('.watchlist-detail-row');
    const measured = Math.ceil(detail?.getBoundingClientRect().height || detail?.offsetHeight || 0);
    measurementTable.remove();
    return measured;
  }

  // Scroll-driven window update: recompute the visible window and swap ONLY the
  // <tbody> content, bypassing the panel's debounced full rerender + rebind.
  // No re-sort (memoized list) and no focus restore. The live row measurement
  // keeps scroll math aligned with the current global or per-panel scale.
  private updateVirtualWindow(
    scrollEl: HTMLElement,
    tbodyEl: HTMLElement | null,
    rootEl: HTMLElement,
    rowHeightPx: number,
  ): void {
    const list = this.getFilteredSorted();
    if (!this.shouldVirtualize(list)) return;
    const nextStart = this.computeVirtualStart(scrollEl.scrollTop, list, rowHeightPx);
    if (nextStart === this.state.virtualStart) return;
    this.state.virtualStart = nextStart;
    this.replaceVirtualWindow(tbodyEl, rootEl, list, nextStart);
  }

  private replaceVirtualWindow(
    tbodyEl: HTMLElement | null,
    rootEl: HTMLElement,
    list: T[],
    start: number,
  ): void {
    if (!tbodyEl) return;
    setTrustedHtml(
      tbodyEl,
      trustedHtml(this.renderTableBody(list, start), 'watchlist virtual window scroll update'),
    );
    rootEl.dataset.watchlistRenderedrows = String(this.getRenderedRowCount(list, start));
  }

  private measureVirtualRowHeight(scrollEl: HTMLElement): number | null {
    const row = scrollEl.querySelector<HTMLElement>('.watchlist-row');
    const height = row?.getBoundingClientRect().height || 0;
    return height > 0 ? height : null;
  }

  private measureTableHeaderHeight(tableEl: HTMLElement | null): number | null {
    const header = tableEl?.querySelector<HTMLElement>('thead');
    const height = header?.getBoundingClientRect().height || 0;
    return height > 0 ? height : null;
  }

  private reconcileScaledVirtualState(
    rootEl: HTMLElement,
    previousRowHeight: number,
    nextRowHeight: number,
    previousHeaderHeight: number,
    nextHeaderHeight: number,
  ): { list: T[]; nextStart: number } | null {
    if (previousRowHeight <= 0 || nextRowHeight <= 0 || previousRowHeight === nextRowHeight) return null;
    const ratio = nextRowHeight / previousRowHeight;
    const list = this.getFilteredSorted();
    const previousDetailHeight = this.state.expandedDetailHeight;
    const expandedIndex = this.getExpandedIndex(list);
    const detailIsAboveViewport = this.isExpandedDetailAboveViewport(
      expandedIndex,
      previousRowHeight,
      previousHeaderHeight,
      previousDetailHeight,
    );
    const nextDetailHeight = this.measureExpandedDetailHeight(rootEl);
    this.state.virtualScrollTop = this.scaleVirtualScrollTop(
      ratio,
      previousHeaderHeight,
      nextHeaderHeight,
      detailIsAboveViewport ? previousDetailHeight : 0,
      detailIsAboveViewport ? nextDetailHeight : 0,
    );
    this.state.expandedDetailHeight = nextDetailHeight;
    const nextStart = this.computeVirtualStart(this.state.virtualScrollTop, list, nextRowHeight);
    this.state.virtualStart = nextStart;
    return { list, nextStart };
  }

  private scaleVirtualScrollTop(
    ratio: number,
    previousHeaderHeight: number,
    nextHeaderHeight: number,
    previousDetailHeight: number,
    nextDetailHeight: number,
  ): number {
    const previousScrollTop = this.state.virtualScrollTop;
    if (previousScrollTop <= 0) return 0;
    if (previousHeaderHeight > 0 && previousScrollTop <= previousHeaderHeight) {
      return previousScrollTop * (nextHeaderHeight / previousHeaderHeight);
    }
    const rowOffset = Math.max(
      0,
      previousScrollTop - previousHeaderHeight - previousDetailHeight,
    );
    return nextHeaderHeight + rowOffset * ratio + nextDetailHeight;
  }

  private isExpandedDetailAboveViewport(
    expandedIndex: number,
    rowHeight: number,
    headerHeight: number,
    detailHeight: number,
  ): boolean {
    if (expandedIndex < 0) return false;
    // ResizeObserver runs after layout, when mounted detail geometry already
    // reflects the new scale. Classify it in the cached old coordinate system
    // so a scale-up cannot move an overscan detail below the viewport before
    // we decide whether to preserve its height in the scroll anchor.
    const detailEnd = headerHeight + (expandedIndex + 1) * rowHeight + detailHeight;
    return this.state.virtualScrollTop >= detailEnd;
  }

  public destroy(): void {
    this.disconnectScaleObserver();
  }

  private disconnectScaleObserver(): void {
    this.scaleObservationGeneration += 1;
    this.scrollRafGeneration = null;
    this.scaleRafGeneration = null;
    this.scaleObservers.forEach(observer => observer.disconnect());
    this.scaleObservers = [];
    this.tableResizeObserver?.disconnect();
    this.tableResizeObserver = null;
  }
}
