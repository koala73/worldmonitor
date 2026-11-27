import { expect, it, vi } from 'vitest';
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async (key: string) => key === 'breaker:Aviation News:TEST:24:20' ? {
    updatedAt: Date.now(), data: [{ id: 'cached', title: 'Cached news', url: 'https://example.com', sourceName: 'test', publishedAt: '2026-09-19T08:00:00Z' }],
  } : null,
  setPersistentCache: vi.fn(async () => {}),
}));
import { AviationServiceClient } from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { fetchAviationNews } from '@/services/aviation';
import { setPersistentCache } from '@/services/persistent-cache';
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

it('does not persist an outage and retries the same search when news recovers', async () => {
  const now = Date.now();
  const rpc = vi.spyOn(AviationServiceClient.prototype, 'listAviationNews')
    .mockResolvedValueOnce({ items: [], source: 'error', updatedAt: now })
    .mockResolvedValueOnce({
      items: [{
        id: 'recovered', title: 'Recovered news', url: 'https://example.com/news',
        sourceName: 'test', publishedAt: now, snippet: '', matchedEntities: ['RECOVERY'], imageUrl: '',
      }],
      source: 'rss',
      updatedAt: now,
    });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await fetchAviationNews(['RECOVERY'])).toEqual([]);
  expect(setPersistentCache).not.toHaveBeenCalled();
  expect(await fetchAviationNews(['RECOVERY'])).toMatchObject([{ id: 'recovered' }]);
  expect(rpc).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(setPersistentCache).toHaveBeenCalledWith(
    'breaker:Aviation News:RECOVERY:24:20', [expect.objectContaining({ id: 'recovered' })],
  ));
});
