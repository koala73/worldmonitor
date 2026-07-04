import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WatchlistTableView } from '../src/components/WatchlistTableView';

type Item = {
  symbol: string;
  rank: number;
};

type ViewState = {
  sort: string;
  filter: string;
  search: string;
  expandedKey: string | null;
  virtualStart: number;
  virtualScrollTop: number;
  expandedDetailHeight: number;
};

function createItems(count = 618): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `SYM${String(index).padStart(3, '0')}`,
    rank: index,
  }));
}

function createView() {
  const view = new WatchlistTableView<Item>({
    columns: [
      { key: 'symbol', label: 'Symbol', sortable: true, sortOptionKey: 'symbol-asc', cell: (item) => item.symbol },
      { key: 'rank', label: 'Rank', sortable: true, sortOptionKey: 'rank-desc', align: 'right', cell: (item) => String(item.rank) },
    ],
    filters: [
      { key: 'all', label: 'All', match: () => true },
      { key: 'even', label: 'Even', match: (item) => item.rank % 2 === 0 },
    ],
    sortOptions: [
      { key: 'symbol-asc', label: 'Symbol A-Z', cmp: (a, b) => a.symbol.localeCompare(b.symbol) },
      { key: 'rank-desc', label: 'Rank down', cmp: (a, b) => b.rank - a.rank },
    ],
    defaultSort: 'symbol-asc',
    defaultFilter: 'all',
    getKey: (item) => item.symbol,
    getSearchText: (item) => item.symbol,
    renderDetail: (item) => `<section class="detail">Detail ${item.symbol}</section>`,
  });
  view.setItems(createItems());
  return view;
}

function stateOf(view: WatchlistTableView<Item>): ViewState {
  return (view as unknown as { state: ViewState }).state;
}

type Internals = {
  computeVirtualStart(scrollTop: number, list: Item[]): number;
  getFilteredSorted(): Item[];
};

function internalsOf(view: WatchlistTableView<Item>): Internals {
  return view as unknown as Internals;
}

function countRows(html: string): number {
  return (html.match(/class="watchlist-row/g) || []).length;
}

// View whose `rank-desc` comparator counts invocations, so tests can assert
// whether a re-render actually re-sorts.
function createCountingView(): { view: WatchlistTableView<Item>; sortCalls: () => number } {
  let calls = 0;
  const view = new WatchlistTableView<Item>({
    columns: [
      { key: 'symbol', label: 'Symbol', sortable: true, sortOptionKey: 'symbol-asc', cell: (item) => item.symbol },
      { key: 'rank', label: 'Rank', sortable: true, sortOptionKey: 'rank-desc', align: 'right', cell: (item) => String(item.rank) },
    ],
    filters: [{ key: 'all', label: 'All', match: () => true }],
    sortOptions: [
      { key: 'symbol-asc', label: 'Symbol A-Z', cmp: (a, b) => { calls += 1; return a.symbol.localeCompare(b.symbol); } },
    ],
    defaultSort: 'symbol-asc',
    defaultFilter: 'all',
    getKey: (item) => item.symbol,
    getSearchText: (item) => item.symbol,
    renderDetail: (item) => `<section class="detail">Detail ${item.symbol}</section>`,
  });
  view.setItems(createItems());
  return { view, sortCalls: () => calls };
}

describe('WatchlistTableView virtualization', () => {
  it('renders a small semantic window for the 618-row watchlist tbody', () => {
    const view = createView();
    const html = view.render();

    assert.equal(countRows(html), 44, 'only visible rows plus overscan should mount');
    assert.match(html, /data-watchlist-totalrows="618"/);
    assert.match(html, /data-watchlist-renderedrows="44"/);
    assert.match(html, /watchlist-virtual-spacer-bottom/);
    assert.match(html, /SYM000/);
    assert.match(html, /SYM043/);
    assert.doesNotMatch(html, /SYM044/);
    assert.doesNotMatch(html, /SYM617/);
  });

  it('keeps the full sorted list scrollable by shifting the virtual window', () => {
    const view = createView();
    stateOf(view).virtualStart = 200;
    stateOf(view).virtualScrollTop = 200 * 33;

    const html = view.render();

    assert.equal(countRows(html), 44);
    assert.match(html, /watchlist-virtual-spacer-top/);
    assert.match(html, /height:6600px/);
    assert.match(html, /SYM200/);
    assert.match(html, /SYM243/);
    assert.doesNotMatch(html, /SYM199/);
    assert.doesNotMatch(html, /SYM244/);
  });

  it('applies sort, filter, search, and expansion before choosing the visible window', () => {
    const view = createView();
    const state = stateOf(view);

    state.sort = 'rank-desc';
    let html = view.render();
    assert.match(html, /data-watchlist-totalrows="618"/);
    assert.ok(html.indexOf('SYM617') < html.indexOf('SYM574'), 'rank-desc drives the visible window order');

    state.filter = 'even';
    state.virtualStart = 0;
    html = view.render();
    assert.match(html, /data-watchlist-totalrows="309"/);
    assert.match(html, /SYM616/);
    assert.doesNotMatch(html, /SYM617/);

    state.filter = 'all';
    state.sort = 'symbol-asc';
    state.search = 'SYM61';
    state.virtualStart = 0;
    html = view.render();
    assert.match(html, /data-watchlist-totalrows="8"/);
    assert.equal(countRows(html), 8, 'small search result should not virtualize');
    assert.match(html, /SYM610/);
    assert.match(html, /SYM617/);

    state.search = '';
    state.expandedKey = 'SYM002';
    html = view.render();
    assert.match(html, /watchlist-detail-row/);
    assert.match(html, /Detail SYM002/);
  });

  it('carries measured expanded-detail height into spacer rows outside the rendered window', () => {
    const view = createView();
    const state = stateOf(view);
    state.expandedKey = 'SYM002';
    state.expandedDetailHeight = 240;
    state.virtualStart = 10;

    const html = view.render();

    assert.match(html, /watchlist-virtual-spacer-top/);
    assert.match(html, /height:570px/, 'top spacer includes 10 rows plus the measured expanded detail height');
    assert.doesNotMatch(html, /Detail SYM002/, 'off-window expanded detail should be represented by spacer height, not mounted');
  });

  it('does not re-sort the full list when only the virtual window shifts', () => {
    const { view, sortCalls } = createCountingView();

    view.render();
    const afterFirst = sortCalls();
    assert.ok(afterFirst > 0, 'first render sorts the list');

    // A pure window shift (no sort/filter/search change) must reuse the memoized
    // sorted list — this is the behavioral guarantee the old source-text grep
    // only pretended to make (the resort used to happen via onRerender).
    stateOf(view).virtualStart = 200;
    view.render();
    assert.equal(sortCalls(), afterFirst, 'shifting the window must not re-sort');

    // Changing the sort DOES invalidate the memo and re-sorts.
    stateOf(view).sort = 'symbol-asc';
    stateOf(view).search = 'SYM';
    view.render();
    assert.ok(sortCalls() > afterFirst, 'a sort/filter/search change re-sorts');
  });

  it('clamps the scroll→window mapping to maxStart so the bottom never overshoots', () => {
    const view = createView();
    const internals = internalsOf(view);
    const list = internals.getFilteredSorted();
    const maxStart = list.length - 32; // length - VIRTUAL_VISIBLE_ROWS = 618 - 32 = 586

    // A scrollTop far past the end must clamp to maxStart, not exceed it — this
    // is what kept the `nextStart === virtualStart` early-return from ever
    // engaging at the bottom before the fix.
    assert.equal(internals.computeVirtualStart(10_000_000, list), maxStart);
    assert.equal(internals.computeVirtualStart(0, list), 0);
  });

  it('subtracts the expanded-detail height from the scroll→window mapping when the expanded row is above', () => {
    const view = createView();
    const state = stateOf(view);
    const internals = internalsOf(view);
    const list = internals.getFilteredSorted();

    state.expandedKey = 'SYM000'; // index 0 — always above any non-zero window
    state.expandedDetailHeight = 330; // 10 rows worth of height (10 * 33)

    // Raw mapping: floor(scrollTop/33) - overscan(6). With a 330px detail above
    // the window the top spacer is inflated by 330px, so the same scrollTop must
    // map 10 rows lower than the naive division.
    const scrollTop = 200 * 33; // 6600
    const naive = Math.floor(scrollTop / 33) - 6; // 194
    const corrected = internals.computeVirtualStart(scrollTop, list);
    assert.equal(corrected, naive - 10, 'expanded-detail height shifts the mapped start down by its row-equivalent');
  });

  it('clamps a stale large virtualStart at render time without mutating state (pure render)', () => {
    const view = createView();
    const state = stateOf(view);

    // Scrolled deep, then a filter narrows the list to 309 even rows
    // (maxStart = 309 - 32 = 277). render() must show the clamped window but
    // must NOT write the clamped value back into state.virtualStart.
    state.filter = 'even';
    state.virtualStart = 550;

    const html = view.render();

    // Clamped window start = maxStart = 309 - 32 = 277, so only the trailing 32
    // rows (277..308) render — not a full 44 — because there is nothing below.
    assert.match(html, /data-watchlist-totalrows="309"/);
    assert.match(html, /data-watchlist-renderedrows="32"/);
    assert.equal(countRows(html), 32);
    assert.equal(state.virtualStart, 550, 'render() must not mutate virtualStart (stays pure)');
    // even list sorted symbol-asc => index 277 is SYM554, index 308 is SYM616.
    assert.match(html, /SYM554/);
    assert.match(html, /SYM616/);
    assert.doesNotMatch(html, /SYM552/);
  });

  it('inflates the bottom spacer for an expanded row below the rendered window', () => {
    const view = createView();
    const state = stateOf(view);
    state.virtualStart = 0;
    state.expandedKey = 'SYM580'; // index 580 — well past the window end (44)
    state.expandedDetailHeight = 200;

    const html = view.render();

    // bottom spacer = (618 - 44) rows * 33 + 200 detail = 18942 + 200 = 19142
    assert.match(html, /watchlist-virtual-spacer-bottom/);
    assert.match(html, /height:19142px/, 'bottom spacer includes off-window expanded-detail height');
    assert.doesNotMatch(html, /watchlist-virtual-spacer-top/, 'no top spacer at virtualStart=0');
    assert.doesNotMatch(html, /Detail SYM580/, 'off-window expanded detail is spacer height, not mounted');
  });

  it('virtualizes at 101 rows but renders all rows at the 100-row threshold', () => {
    const hundred = new WatchlistTableView<Item>({
      columns: [{ key: 'symbol', label: 'Symbol', cell: (item) => item.symbol }],
      filters: [{ key: 'all', label: 'All', match: () => true }],
      sortOptions: [{ key: 'symbol-asc', label: 'A-Z', cmp: (a, b) => a.symbol.localeCompare(b.symbol) }],
      defaultSort: 'symbol-asc',
      defaultFilter: 'all',
      getKey: (item) => item.symbol,
      getSearchText: (item) => item.symbol,
      renderDetail: (item) => `Detail ${item.symbol}`,
    });

    hundred.setItems(createItems(100));
    const at100 = hundred.render();
    assert.equal(countRows(at100), 100, 'exactly 100 rows must not virtualize');
    assert.doesNotMatch(at100, /watchlist-virtual-spacer/);

    hundred.setItems(createItems(101));
    const at101 = hundred.render();
    assert.equal(countRows(at101), 44, '101 rows must virtualize to the window size');
    assert.match(at101, /watchlist-virtual-spacer-bottom/);
  });
});
