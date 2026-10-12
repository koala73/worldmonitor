import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { NewsPanel } from '@/components/NewsPanel';
import { clusterNews } from '@/services/clustering';
import type { ClusteredEvent, NewsItem, ThreatClassification } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

let panel: NewsPanel | null = null;

afterEach(() => {
  panel?.destroy();
  panel = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function newsItem(source: string, title: string): NewsItem {
  return {
    source,
    title,
    link: `https://example.com/${encodeURIComponent(source)}`,
    pubDate: new Date('2026-10-12T00:00:00.000Z'),
    isAlert: false,
  } as NewsItem;
}

describe('NewsPanel category badge escapes the classification category', () => {
  it('renders a hostile category as text, not markup', () => {
    vi.useFakeTimers();
    panel = new NewsPanel('category-escape-test', 'Category');
    document.body.appendChild(panel.getElement());

    const clusters = clusterNews([newsItem('Reuters World', 'Vessel grounding closes port approach')]) as ClusteredEvent[];
    clusters[0]!.threat = {
      level: 'high',
      category: '<img src=x onerror="window.__pwned=1">',
      confidence: 0.9,
      source: 'llm',
    } as unknown as ThreatClassification;

    (panel as unknown as { renderClusters(clusters: ClusteredEvent[]): void }).renderClusters(clusters);
    vi.runAllTimers();

    const badge = panel.getElement().querySelector('.category-tag');
    expect(badge).not.toBeNull();
    expect(badge?.querySelector('img')).toBeNull();
    expect(badge?.textContent).toBe('<img src=x onerror="window.__pwned=1">');
    expect(panel.getElement().querySelector('img')).toBeNull();
  });
});
