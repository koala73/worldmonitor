import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { NewsPanel } from '@/components/NewsPanel';
import { clusterNews } from '@/services/clustering';
import type { NewsItem } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const at = new Date('2026-09-24T00:00:00.000Z');
function newsItem(source: string, title: string, corroborationCount?: number): NewsItem {
  return {
    source,
    title,
    link: `https://example.com/${encodeURIComponent(source + title)}`,
    pubDate: at,
    isAlert: false,
    ...(corroborationCount === undefined ? {} : { corroborationCount }),
  } as NewsItem;
}

type RenderablePanel = {
  renderFlat(items: NewsItem[]): void;
  renderClusters(clusters: unknown[]): void;
};

function mountPanel(): { panel: NewsPanel; renderable: RenderablePanel } {
  const panel = new NewsPanel('corroboration-test', 'Corroboration');
  document.body.appendChild(panel.getElement());
  return { panel, renderable: panel as unknown as RenderablePanel };
}

const flagText = (row: Element) => row.querySelector('.corroboration-flag')?.textContent ?? null;

describe('NewsPanel corroboration pill (#6419)', () => {
  it.each(['flat', 'clustered'] as const)('%s headlines without usable URLs remain unlinked', (mode) => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const items = [
      { ...newsItem('Ars Technica', 'OpenAI models hacked a crypto wallet and breached more websites'), link: '' },
      { ...newsItem('Hacker News', 'Untrusted <script> headline'), link: 'javascript:alert(1)' },
      { ...newsItem('Wired', 'Automatic cat feeders tested'), link: 'https://www.wired.com/story/feeders/?a=1&b=2' },
    ];
    if (mode === 'flat') renderable.renderFlat(items);
    else renderable.renderClusters(clusterNews(items));
    vi.runAllTimers();

    const rows = [...panel.getElement().querySelectorAll('.item')];
    for (const item of items) {
      const row = rows.find(element => element.querySelector('.item-title')?.textContent === item.title);
      expect(row).toBeDefined();
      expect(row?.querySelector('.item-source')?.textContent).toContain(item.source);
      expect(row?.querySelector('.item-time')?.textContent?.trim()).not.toBe('');
      const title = row?.querySelector('.item-title');
      const hoverRules = [...readFileSync('src/styles/main.css', 'utf8').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selector, body]) => selector?.includes('.item-title:hover') && /color:\s*var\(--accent\)/.test(body ?? ''));
      expect(hoverRules.length).toBeGreaterThan(0);
      expect(hoverRules.some(([, selector]) => title?.matches(selector!.trim().replace(/:hover/g, ''))))
        .toBe(item.source === 'Wired');
      if (item.source === 'Wired') {
        expect(title?.tagName).toBe('A');
        expect(title?.getAttribute('href')).toBe(item.link);
        expect(title?.getAttribute('rel')).toBe('noopener');
      } else {
        expect(title?.tagName).toBe('SPAN');
        expect(title?.hasAttribute('href')).toBe(false);
      }
      expect(row?.querySelector('script')).toBeNull();
    }
    expect(panel.getElement().querySelector('a[href=""]')).toBeNull();
  });

  it.each(['flat', 'clustered', 'windowed', 'secondary'] as const)('%s reveal targets the exact second blank-link identity', (mode) => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const first = { ...newsItem('First publisher', 'Same <headline> "quoted"'), link: '' };
    const selected = { ...first, source: 'Second & publisher' };
    const clusters = [first, selected].map((item, index) => ({ ...clusterNews([item])[0]!, id: `selected-${index}` }));
    if (mode === 'secondary') {
      const primary = newsItem('Primary publisher', 'Different primary headline');
      clusters[1] = { ...clusterNews([primary])[0]!, id: 'selected-1', allItems: [primary, selected] };
    }
    if (mode === 'windowed') {
      clusters.unshift(...Array.from({ length: 22 }, (_, index) => ({ ...clusterNews([newsItem(`Filler ${index}`, `Unrelated story ${index}`)])[0]!, id: `filler-${index}` })));
    }
    if (mode === 'flat') renderable.renderFlat([first, selected]);
    else renderable.renderClusters(clusters);
    vi.runAllTimers();
    const legacy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    expect(panel.hasNewsItem('', selected)).toBe(true);
    expect(panel.hasNewsItem('', { ...selected, source: 'Not loaded' })).toBe(false);
    panel.scrollToNewsItem('', { ...selected, source: 'Not loaded' });
    vi.advanceTimersByTime(350);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    panel.scrollToNewsItem('', selected);
    vi.advanceTimersByTime(350);
    const highlighted = panel.getElement().querySelector('.search-highlight');
    expect(highlighted).not.toBeNull();
    if (mode === 'flat') {
      expect(highlighted?.querySelector('.item-source')?.textContent).toContain(selected.source);
      expect(highlighted?.querySelector('.item-title')?.tagName).toBe('SPAN');
      expect(highlighted?.querySelector('.item-title')?.hasAttribute('href')).toBe(false);
      expect(legacy).toHaveBeenCalled();
    } else expect(highlighted?.getAttribute('data-cluster-id')).toBe('selected-1');
    expect(legacy.mock.contexts).toContain(highlighted);
    if (mode === 'windowed') expect(highlighted?.closest('.windowed-chunk')?.getAttribute('data-chunk')).toBe('2');
    expect(panel.getElement().querySelectorAll('.search-highlight')).toHaveLength(1);
    expect(panel.getElement().querySelector('a[href=""]')).toBeNull();
    panel.destroy();
  });

  it('legacy nonempty-link reveal finds a secondary cluster member', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const primary = newsItem('Primary', 'Shared report');
    const secondary = newsItem('Secondary', 'Shared report');
    renderable.renderClusters([{ ...clusterNews([primary])[0]!, allItems: [primary, secondary] }]);
    vi.runAllTimers();
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    expect(panel.hasNewsItem(secondary.link)).toBe(true);
    panel.scrollToNewsItem(secondary.link);
    expect(panel.getElement().querySelector('.search-highlight')?.getAttribute('data-news-id')).toBe(primary.link);
    panel.destroy();
  });

  it.each(['flat', 'clustered'] as const)('retains the exact %s selection across a queued commit without extending its lifetime', (mode) => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const first = { ...newsItem('First publisher', 'Shared headline'), link: '' };
    const selected = { ...first, source: 'Second publisher' };
    const render = (items: NewsItem[]) => mode === 'flat'
      ? renderable.renderFlat(items) : renderable.renderClusters(clusterNews(items));
    render([first, selected]);
    vi.advanceTimersByTime(150);
    render([first, selected, newsItem('Control publisher', 'Distinct control report')]);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    panel.scrollToNewsItem('', selected);
    const oldRow = panel.getElement().querySelector('.search-highlight');
    expect(oldRow).not.toBeNull();
    vi.advanceTimersByTime(150);
    const row = panel.getElement().querySelector('.search-highlight');
    expect(row).not.toBeNull();
    expect(row).not.toBe(oldRow);
    expect(row?.querySelector('.item-title')?.textContent).toBe(selected.title);
    expect(row?.querySelector('.item-source')?.textContent).toContain(mode === 'flat' ? selected.source : first.source);
    expect(oldRow?.isConnected).toBe(false);
    vi.advanceTimersByTime(2949);
    expect(row?.classList.contains('search-highlight')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    render([first, selected, newsItem('Later control', 'Another distinct report')]);
    vi.advanceTimersByTime(150);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    panel.destroy();
  });

  it('expires the selection before an inline equal-HTML callback even if timer cleanup has not run', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const selected = { ...newsItem('Selected publisher', 'Selected headline'), link: '' };
    renderable.renderFlat([selected]);
    vi.advanceTimersByTime(150);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    panel.scrollToNewsItem('', selected);
    vi.setSystemTime(Date.now() + 3101);
    renderable.renderFlat([selected]);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    panel.destroy();
  });

  it('keeps only the newer exact selection when a queued flat commit finishes', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const first = { ...newsItem('First publisher', 'Same headline'), link: '' };
    const second = { ...first, source: 'Second publisher' };
    renderable.renderFlat([first, second]);
    vi.advanceTimersByTime(150);
    renderable.renderFlat([first, second, newsItem('Control', 'Distinct report')]);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    panel.scrollToNewsItem('', first);
    vi.advanceTimersByTime(100);
    panel.scrollToNewsItem('', second);
    vi.advanceTimersByTime(150);
    const rows = panel.getElement().querySelectorAll('.search-highlight');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.item-source')?.textContent).toContain(second.source);
    vi.advanceTimersByTime(2850);
    expect(rows[0]?.classList.contains('search-highlight')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    panel.destroy();
  });

  it('does not let older enrichment replace a newer flat render and selection', async () => {
    vi.useFakeTimers();
    const panel = new NewsPanel('render-owner-test', 'Render ownership', undefined, { clusterNews: async items => clusterNews(items) });
    document.body.appendChild(panel.getElement());
    panel.renderNews([newsItem('Old publisher', 'Old cluster headline')]);
    await Promise.resolve();
    (panel as unknown as { clusteredMode: boolean }).clusteredMode = false;
    const current = { ...newsItem('Current publisher', 'Current flat headline'), link: '' };
    panel.renderNews([current]);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    panel.scrollToNewsItem('', current);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    expect(panel.getElement().querySelector('.item-title')?.textContent).toBe(current.title);
    expect(panel.getElement().querySelectorAll('.item.clustered')).toHaveLength(0);
    expect(panel.getElement().querySelector('.search-highlight')?.querySelector('.item-source')?.textContent).toContain(current.source);
    panel.destroy();
  });

  it('ignores a superseded windowed reveal callback', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const items = Array.from({ length: 24 }, (_, index) => newsItem(`Publisher ${index}`, `Qzx${index} Vbn${index} Plo${index}`));
    renderable.renderClusters(clusterNews(items));
    vi.advanceTimersByTime(150);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    panel.scrollToNewsItem(items[23]!.link, items[23]);
    vi.advanceTimersByTime(100);
    panel.scrollToNewsItem(items[0]!.link, items[0]);
    vi.advanceTimersByTime(250);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    vi.advanceTimersByTime(100);
    const rows = panel.getElement().querySelectorAll('.search-highlight');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-news-id')).toBe(items[0]!.link);
    panel.destroy();
  });

  it.each(['new-render', 'empty', 'filtered', 'destroy'] as const)('invalidates a pending reveal on %s', (action) => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const selected = { ...newsItem('Selected publisher', 'Selected headline'), link: '' };
    renderable.renderFlat([selected]);
    vi.advanceTimersByTime(150);
    renderable.renderFlat([selected, newsItem('Control', 'Distinct report')]);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    panel.scrollToNewsItem('', selected);
    if (action === 'new-render') {
      (panel as unknown as { clusteredMode: boolean }).clusteredMode = false;
      panel.renderNews([selected]);
    } else if (action === 'empty') panel.renderNews([]);
    else if (action === 'filtered') panel.renderFilteredEmpty('No matching news');
    else panel.destroy();
    vi.advanceTimersByTime(150);
    expect(panel.getElement().querySelector('.search-highlight')).toBeNull();
    if (action !== 'destroy') panel.destroy();
  });

  it('keeps windowed clusters after a pending flat write reaches its deadline', async () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    const items = Array.from({ length: 24 }, (_, i) => newsItem(`Publisher ${i}`, `Qzx${i} Vbn${i} Plo${i}`));
    const clusters = clusterNews(items);
    expect(clusters).toHaveLength(24);
    renderable.renderFlat(items);
    await vi.advanceTimersByTimeAsync(150);
    expect(panel.getElement().querySelectorAll('.item:not(.clustered)')).toHaveLength(24);
    renderable.renderFlat([...items, newsItem('New publisher', 'New distinct headline')]);
    renderable.renderClusters(clusters);
    expect(panel.getElement().querySelectorAll('[data-chunk]')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(149);
    expect(panel.getElement().querySelectorAll('[data-chunk]')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(panel.getElement().querySelectorAll('[data-chunk]')).toHaveLength(3);
    expect(panel.getElement().querySelectorAll('.item:not(.clustered)')).toHaveLength(0);
    panel.destroy();
  });

  it('flat cards flag one publisher and stay silent otherwise', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    renderable.renderFlat([
      newsItem('Meduza', 'Exile outlet reports mobilisation order', 1),
      newsItem('Reuters World', 'Central bank holds rates steady', 5),
      newsItem('BBC World', 'Storm makes landfall on the coast'),
    ]);
    vi.runAllTimers();

    const rows = [...panel.getElement().querySelectorAll('.item')];
    expect(rows.map(flagText)).toEqual(['Single publisher', null, null]);
  });

  it('cluster rows flag one publisher and low-tier-only coverage', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    renderable.renderClusters(clusterNews([
      newsItem('Hacker News', 'Startup open-sources new inference chip design'),
      newsItem('The Verge', 'Startup open-sources new inference chip design'),
      newsItem('Reuters World', 'Port strike halts container traffic in Rotterdam'),
      newsItem('BBC World', 'Port strike halts container traffic in Rotterdam'),
      newsItem('Kyiv Independent', 'Drone strike reported near Kharkiv substation'),
    ]));
    vi.runAllTimers();

    const byTitle = new Map(
      [...panel.getElement().querySelectorAll('.item.clustered')]
        .map((row) => [row.querySelector('.item-title')?.textContent?.trim() ?? '', flagText(row)]),
    );
    expect(byTitle.get('Startup open-sources new inference chip design')).toBe('Low-tier sources only');
    expect(byTitle.get('Port strike halts container traffic in Rotterdam')).toBeNull();
    expect(byTitle.get('Drone strike reported near Kharkiv substation')).toBe('Single publisher');
  });
});
