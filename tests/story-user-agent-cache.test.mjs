import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from '../api/story.js';

function requestStory(userAgent) {
  const req = {
    url: 'https://worldmonitor.app/api/story?c=US&t=ciianalysis&ts=2026-08-27T12%3A00%3A00Z',
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
  assert.equal(browserResponse.headers.location, 'https://worldmonitor.app/?c=US&t=ciianalysis&ts=2026-08-27T12:00:00Z');
});
