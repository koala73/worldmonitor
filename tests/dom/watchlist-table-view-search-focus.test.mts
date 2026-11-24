import { afterEach, describe, expect, it } from 'vitest';

import { WatchlistTableView } from '@/components/WatchlistTableView';

type Item = { symbol: string };

function mount(): { root: HTMLElement; commit: () => void } {
  const view = new WatchlistTableView<Item>({
    columns: [{ key: 'symbol', label: 'Symbol', cell: item => item.symbol }],
    filters: [{ key: 'all', label: 'All', match: () => true }],
    sortOptions: [{ key: 'symbol', label: 'Symbol', cmp: (a, b) => a.symbol.localeCompare(b.symbol) }],
    defaultSort: 'symbol',
    defaultFilter: 'all',
    getKey: item => item.symbol,
    getSearchText: item => item.symbol,
    renderDetail: item => `<section>Detail ${item.symbol}</section>`,
  });
  view.setItems([{ symbol: 'AAA' }, { symbol: 'BBB' }]);
  const root = document.createElement('div');
  document.body.append(root);
  // Stands in for Panel's content commit: replace the markup, then bind.
  const commit = (): void => {
    root.innerHTML = view.render();
    view.bind(root, commit);
  };
  commit();
  return { root, commit };
}

const search = (root: HTMLElement): HTMLInputElement =>
  root.querySelector<HTMLInputElement>('input.watchlist-search')!;

describe('WatchlistTableView search focus across content commits', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('keeps the search box focused through consecutive background commits', async () => {
    const { root, commit } = mount();
    search(root).focus();
    commit();
    await Promise.resolve();
    commit();
    await Promise.resolve();
    expect(document.activeElement).toBe(search(root));
  });

  it('does not take focus back after the user focused something else', async () => {
    const { root, commit } = mount();
    search(root).focus();
    root.innerHTML = '<p>Retrying</p>';
    await Promise.resolve();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    commit();
    expect(document.activeElement).toBe(other);
  });
});
