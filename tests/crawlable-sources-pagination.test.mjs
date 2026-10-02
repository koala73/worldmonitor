import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildSourcePages } from '../scripts/crawlable-sources-page.mjs';
import { sourcesBookmarkScript } from '../scripts/crawlable-sources-search.mjs';
import { Window } from 'happy-dom';

it('adds a static page when a domain exceeds 60 providers, without losing providers', () => {
  const catalog = Array.from({ length: 121 }, (_, i) => ({
    provider: `source-${i}.example`, displayName: `Source ${i}`, domainId: 'news',
  }));
  const pages = buildSourcePages(catalog);
  assert.deepEqual(pages.map(({ path }) => path), [
    '/sources/news/', '/sources/news/page/2/', '/sources/news/page/3/',
  ]);
  assert.deepEqual(pages.map(({ providers }) => providers.length), [60, 60, 1]);
  assert.deepEqual(pages.flatMap(({ providers }) => providers), catalog);
  assert.deepEqual(buildSourcePages([]), []);
});

it('recovers a provider bookmark moved by pagination without fetching for a current card', async () => {
  const window = new Window({ url: 'https://www.worldmonitor.app/sources/news/#provider-example' });
  window.document.write('<p id="source-results"></p>');
  let fetches = 0;
  window.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => [{ url: '/sources/news/page/2/#provider-example' }] };
  };
  window.eval(sourcesBookmarkScript);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.location.pathname, '/sources/news/page/2/');
  assert.equal(window.location.hash, '#provider-example');
  assert.equal(fetches, 1);
  window.document.write('<article id="provider-example"></article>');
  window.eval(sourcesBookmarkScript);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetches, 1, 'an existing static card needs no search download');
  window.close();
});
