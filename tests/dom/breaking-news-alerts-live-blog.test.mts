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
      source: 'Business Recorder',
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

describe('a live-blog header labelled critical alerts as high', () => {
  it('a header that names only the war', async () => {
    expect(await alertLevelFor('Live Updates: LIVE: Iran-US war - Business Recorder')).toEqual(['high']);
  });

  it('a live update that reports an attack stays critical', async () => {
    expect(await alertLevelFor('Iran war live: Tankers set ablaze in Hormuz as IRGC warns of unrest threat')).toEqual(['critical']);
  });
});
