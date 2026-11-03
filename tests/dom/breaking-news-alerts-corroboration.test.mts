import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NewsItem } from '@/types';

afterEach(() => {
  vi.resetModules();
  localStorage.clear();
});

async function captureNextAlert(dispatch: (mod: typeof import('@/services/breaking-news-alerts')) => void) {
  const mod = await import('@/services/breaking-news-alerts');
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  document.addEventListener('wm:breaking-news', listener);
  try {
    dispatch(mod);
  } finally {
    document.removeEventListener('wm:breaking-news', listener);
  }
  return seen as Array<{ corroboration: unknown }>;
}

function alertItem(corroborationCount: number): NewsItem {
  return {
    source: 'Reuters World',
    title: `Carrier group enters strait after missile launch ${corroborationCount}`,
    link: `https://example.com/strait-${corroborationCount}`,
    pubDate: new Date(),
    isAlert: true,
    threat: { level: 'critical', category: 'military', confidence: 0.9, source: 'llm' },
    corroborationCount,
  } as NewsItem;
}

describe('breaking alerts carry the corroboration verdict of the item that fired them (#6419)', () => {
  it('an RSS alert from one publisher is single-publisher', async () => {
    const alerts = await captureNextAlert((mod) => mod.checkBatchForBreakingAlerts([alertItem(1)]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.corroboration).toEqual({ state: 'single-publisher', publishers: 1 });
  });

  it('an RSS alert the digest saw from four publishers is corroborated', async () => {
    const alerts = await captureNextAlert((mod) => mod.checkBatchForBreakingAlerts([alertItem(4)]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.corroboration).toEqual({ state: 'corroborated', publishers: 4 });
  });
});
