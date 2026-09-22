import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from '../api/story.js';

function requestStory(userAgent, query = 'c=US&t=ciianalysis&ts=2026-08-27T12%3A00%3A00Z') {
  const req = {
    url: `https://worldmonitor.app/api/story?${query}`,
    headers: { 'user-agent': userAgent },
  };

  let statusCode = 0;
  let body = '';
  const headers = {};

  const res = {
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    writeHead(code, values = {}) {
      statusCode = code;
      for (const [name, value] of Object.entries(values)) {
        this.setHeader(name, value);
      }
    },
    end(payload = '') {
      body = String(payload);
    },
    status(code) {
      statusCode = code;
      return this;
    },
    send(payload) {
      body = String(payload);
    },
  };

  handler(req, res);
  return { statusCode, body, headers };
}

test('keeps crawler and browser responses cache-distinct for the same URL', () => {
  const crawlerResponse = requestStory('Twitterbot/1.0');
  const browserResponse = requestStory('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');

  assert.equal(crawlerResponse.statusCode, 200);
  assert.match(crawlerResponse.body, /<meta property="og:image"/);
  assert.equal(crawlerResponse.headers.vary, 'User-Agent');
  assert.equal(
    crawlerResponse.headers['cache-control'],
    'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
  );

  assert.equal(browserResponse.statusCode, 302);
  assert.equal(browserResponse.headers.vary, 'User-Agent');
  assert.equal(browserResponse.headers['cache-control'], 'private, no-store');
  assert.equal(browserResponse.headers.location, 'https://www.worldmonitor.app/dashboard?c=US&t=ciianalysis&ts=2026-08-27T12%3A00%3A00Z');
  assert.match(crawlerResponse.body, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/dashboard"/);
});

for (const key of ['c', 't', 'ts', 's', 'l']) {
  test(`keeps reserved characters in ${key} inside one outgoing parameter`, () => {
    const values = { c: 'US', t: 'brief', ts: '123', s: '50', l: 'high' };
    values[key] = 'US&INJECTED=1#fragment+%"<>\r\n';
    const query = new URLSearchParams(values).toString();
    const browser = requestStory('Mozilla/5.0', query);
    const crawler = requestStory('Twitterbot/1.0', query);
    assert.equal(browser.statusCode, 302);
    assert.equal(crawler.statusCode, 200);
    const links = [...crawler.body.matchAll(/(?:content|href)="(https:\/\/(?:www\.)?worldmonitor\.app[^" ]*)"/g)]
      .map((match) => match[1].replaceAll('&amp;', '&'));
    assert.equal(links.length, 5);
    for (const target of [browser.headers.location, ...links]) {
      const url = new URL(target);
      assert.equal(url.origin, url.pathname === '/dashboard' ? 'https://www.worldmonitor.app' : 'https://worldmonitor.app');
      assert.equal(url.hash, '');
      assert.doesNotMatch(target, /[\r\n"<>]/);
      const keys = !url.search ? [] : url.pathname === '/api/og-story' ? ['c', 't', 's', 'l'] : ['c', 't', 'ts'];
      assert.deepEqual([...url.searchParams.keys()], keys);
      for (const name of keys) {
        assert.equal(url.searchParams.get(name), name === 'c' ? values[name].toUpperCase() : values[name]);
      }
    }
  });
}
