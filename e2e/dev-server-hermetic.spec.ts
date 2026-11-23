import { expect, test } from '@playwright/test';

// The e2e server runs the real dev API handlers. Before #11185's follow-up they
// fetched live RSS, Redis and upstream APIs from the server process, where a
// spec's page.route cannot reach, so a live breaking-news headline could cover
// the controls a test clicks. Every server-side path out must now be closed.
test.describe('e2e dev server makes no outbound requests', () => {
  test('the news digest carries no live stories', async ({ request }) => {
    const response = await request.get('/api/news/v1/list-feed-digest?variant=full&lang=en');
    // A 200 with a digest shape: the handler took its offline path rather than
    // throwing on the blocked fetch.
    expect(response.status()).toBe(200);
    const body = await response.json() as { categories?: Record<string, { items?: unknown[] }> };
    expect(typeof body.categories).toBe('object');
    const items = Object.values(body.categories ?? {}).flatMap((category) => category.items ?? []);
    expect(items).toHaveLength(0);
  });

  test('the RSS proxy cannot fetch an allowed feed', async ({ request }) => {
    const response = await request.get(
      `/api/rss-proxy?url=${encodeURIComponent('https://feeds.bbci.co.uk/news/world/rss.xml')}`,
    );
    expect(response.status()).toBe(502);
  });

  test('proxy rules to external hosts are closed', async ({ request }) => {
    const response = await request.get('/api/earthquake/earthquakes/feed/v1.0/summary/all_hour.geojson');
    expect(response.status()).toBe(404);
  });
});
