import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NewsItem } from '@/types';

afterEach(() => {
  vi.resetModules();
  localStorage.clear();
});

async function alertLevelFor(title: string) {
  const mod = await import('@/services/breaking-news-alerts');
  const seen: Array<{ threatLevel: string }> = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  document.addEventListener('wm:breaking-news', listener);
  try {
    mod.checkBatchForBreakingAlerts([{
      source: 'Guardian World',
      title,
      link: 'https://example.com/story',
      pubDate: new Date(),
      isAlert: true,
      threat: { level: 'critical', category: 'conflict', confidence: 0.9, source: 'llm' },
    } as NewsItem]);
  } finally {
    document.removeEventListener('wm:breaking-news', listener);
  }
  return seen.map((alert) => alert.threatLevel);
}

describe('a running total labelled critical alerts as high', () => {
  it('a monthly count', async () => {
    expect(await alertLevelFor('Israeli strikes kill 16 schoolchildren so far this month, Gaza ministry says')).toEqual(['high']);
  });

  it('a new attack stays critical', async () => {
    expect(await alertLevelFor('Israeli strike on Gaza school shelter kills 14, civil defence says')).toEqual(['critical']);
  });
});
