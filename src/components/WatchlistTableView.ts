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
//   3. panel.setContent(view.render());
//   4. view.bind(panel.content, () => { panel.setContent(view.render()); view.bind(...); });
//
// State is held internally so sort/filter/search/expanded persist across
// data refreshes within a session. Reset on full page reload (no
// localStorage — keeps the surface narrow).

import { escapeHtml } from '@/utils/sanitize';

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
  private state: {
    sort: string;
    filter: string;
    search: string;
    expandedKey: string | null;
  };

  constructor(private config: WatchlistConfig<T>) {
    this.state = {
      sort: config.defaultSort,
      filter: config.defaultFilter,
      search: '',
      expandedKey: null,
    };
  }

  public setItems(items: T[]): void {
    this.items = items;
    // Drop the expanded row if the symbol is no longer in the dataset
    // (e.g. watchlist editor removed it between refreshes).
    if (this.state.expandedKey) {
      const stillPresent = items.some((item) => this.config.getKey(item) === this.state.expandedKey);
      if (!stillPresent) this.state.expandedKey = null;
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
    const intro = this.config.intro
      ? `<div class="watchlist-intro">${this.config.intro}</div>`
      : '';
    const controls = this.renderControls();
    const tableBody = list.length === 0
      ? `<tr><td colspan="${this.config.columns.length}" class="watchlist-empty">${escapeHtml(this.config.emptyMessage || 'No symbols match the current filter.')}</td></tr>`
      : list.map((item) => this.renderRow(item)).join('');
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
      <div class="watchlist-table-view">
        ${intro}
        ${controls}
        <table class="watchlist-table">
          <thead><tr>${headers}</tr></thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>
    `;
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
    let list = this.items.slice();
    const filter = this.config.filters.find((f) => f.key === this.state.filter);
    if (filter) list = list.filter((item) => filter.match(item));
    if (this.state.search.trim()) {
      const q = this.state.search.trim().toLowerCase();
      list = list.filter((item) => this.config.getSearchText(item).toLowerCase().includes(q));
    }
    const sortOption = this.config.sortOptions.find((s) => s.key === this.state.sort);
    if (sortOption) list.sort(sortOption.cmp);
    return list;
  }

  public bind(root: HTMLElement, onRerender: () => void): void {
    const rootEl = root.querySelector('.watchlist-table-view') as HTMLElement | null;
    if (!rootEl) return;

    // Row click → toggle expanded (one-at-a-time semantics: clicking a
    // different row collapses the previous one).
    rootEl.querySelectorAll<HTMLElement>('.watchlist-row').forEach((rowEl) => {
      rowEl.addEventListener('click', () => {
        const key = rowEl.dataset.rowkey || '';
        this.state.expandedKey = this.state.expandedKey === key ? null : key;
        onRerender();
      });
    });

    // Sortable header click → set sort option, rerender.
    rootEl.querySelectorAll<HTMLElement>('.watchlist-th-sortable').forEach((thEl) => {
      thEl.addEventListener('click', () => {
        const key = thEl.dataset.sortkey || '';
        if (!key) return;
        // Only switch sort if the option exists (defensive guard against
        // a column wired to a sortOptionKey that's not in sortOptions).
        if (this.config.sortOptions.some((o) => o.key === key)) {
          this.state.sort = key;
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
          onRerender();
        }
      });
    });

    // Sort dropdown change.
    const sortSelect = rootEl.querySelector('[data-watchlist-sort="1"]') as HTMLSelectElement | null;
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        this.state.sort = sortSelect.value;
        onRerender();
      });
    }

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
}
