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

  it('search selection reveals an unlinked flat headline', () => {
    vi.useFakeTimers();
    const { panel, renderable } = mountPanel();
    renderable.renderFlat([{ ...newsItem('Ars Technica', 'Headline without destination'), link: '' }]);
    vi.runAllTimers();
    const row = panel.getElement().querySelector('.item') as HTMLElement;
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    panel.scrollToNewsItem('');
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(row.classList.contains('search-highlight')).toBe(true);
    expect(row.querySelector('a')).toBeNull();
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
