import { expect, it, vi } from 'vitest';
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async (key: string) => key.startsWith('breaker:Aviation News') ? {
    updatedAt: Date.now(), data: [{ id: 'cached', title: 'Cached news', url: 'https://example.com', sourceName: 'test', publishedAt: '2026-09-19T08:00:00Z' }],
  } : null,
}));
import { fetchAviationNews } from '@/services/aviation';
import { AirlineIntelPanel } from '@/components/AirlineIntelPanel';
it('revives a JSON news timestamp before the panel renders it', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const items = await fetchAviationNews(['TEST']);
  expect(items[0]!.publishedAt).toBeInstanceOf(Date);
  // Never mounted, so the panel starts no load of its own.
  const panel = new AirlineIntelPanel() as unknown as { newsData: unknown; renderNews(): void; getElement(): HTMLElement };
  panel.newsData = items;
  expect(() => panel.renderNews()).not.toThrow();
  expect(panel.getElement().querySelector('.news-link')?.textContent).toBe('Cached news');
  expect(fetch).not.toHaveBeenCalled();
});
