import assert from 'node:assert/strict';
import { it } from 'node:test';
import { __testing__, looksLikeRssXml } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';

it('reads the five latest CNN publications and retains older articles in the country pool', () => {
  const feed = VARIANT_FEEDS.full!.politics!.find(f => f.name === 'CNN World')!;
  const now = Date.now();
  const entries = Array.from({ length: 7 }, (_, i) => {
    const published = new Date(now - (7 - i) * 60_000).toISOString();
    return `<url><loc>https://www.cnn.com/story/${i}</loc><lastmod>${new Date(now - i).toISOString()}</lastmod>
      <news:news><news:publication_date>${published}</news:publication_date><news:title>World &amp; politics ${i}</news:title></news:news></url>`;
  });
  entries.unshift(`<url><loc>https://www.cnn.com/no-title</loc><news:publication_date>${new Date(now).toISOString()}</news:publication_date></url>`);
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>missing-date</loc></url>${entries.join('')}</urlset>`;
  assert.equal(looksLikeRssXml(xml), true);
  assert.equal(looksLikeRssXml('<urlset><url><loc>x</loc></url></urlset>'), false);
  assert.equal(feed.url, 'https://www.cnn.com/sitemap/news.xml');
  const result = __testing__.parseRssXml(xml, feed, 'full')!;
  assert.deepEqual(result.items.map(x => x.title), [6, 5, 4, 3, 2].map(i => `World & politics ${i}`));
  assert.equal(result.items[0]!.publishedAt, now - 60_000);
  assert.equal(result.items[0]!.link, 'https://www.cnn.com/story/6');
  assert.ok(result.countryItems?.some(x => x.link.endsWith('/0')));
});
