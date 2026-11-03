import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { NewsPanel } from '@/components/NewsPanel';
import type { NewsItem } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function newsItem(source: string, title: string): NewsItem {
  return {
    source,
    title,
    link: `https://example.com/${encodeURIComponent(source)}`,
    pubDate: new Date('2026-09-24T00:00:00.000Z'),
    isAlert: false,
  } as NewsItem;
}

describe('NewsPanel flat cards carry source provenance (#6419)', () => {
  it('renders the risk badge and fact chips the clustered card renders', () => {
    vi.useFakeTimers();
    const panel = new NewsPanel('provenance-flat-test', 'Provenance');
    document.body.appendChild(panel.getElement());

    (panel as unknown as { renderFlat(items: NewsItem[]): void }).renderFlat([
      newsItem('Meduza', 'Exile outlet report'),
      newsItem('CNA', 'State-owned broadcaster report'),
      newsItem('Voice of America', 'Government-funded broadcaster report'),
    ]);
    vi.runAllTimers();

    const sources = [...panel.getElement().querySelectorAll('.item-source')];
    expect(sources).toHaveLength(3);
    expect(sources[0]?.querySelector('.provenance-fact.perspective')?.textContent).toBe('Anti-Kremlin');
    expect(sources[1]?.querySelector('.provenance-fact.state')?.textContent).toBe('State-affiliated: Singapore');
    expect(sources[2]?.querySelector('.propaganda-badge')?.textContent).toBe('! Caution: USA');
  });
});
