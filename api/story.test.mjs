import { strict as assert } from 'node:assert';
import test from 'node:test';
import { COUNTRY_CORPUS_NAMES, COUNTRY_CORPUS_SLUGS } from './_country-corpus-slugs.generated.js';
import handler from './story.js';

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function requestStory(userAgent, query) {
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
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
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

function canonicalOf(body) {
  return body.match(/<link rel="canonical" href="([^"]+)"\/>/)?.[1] ?? null;
}

test('a crawler on a country with a corpus page canonicalises to that page', () => {
  const response = requestStory(GOOGLEBOT, 'c=IR&t=ciianalysis&ts=1');

  assert.equal(response.statusCode, 200);
  assert.equal(canonicalOf(response.body), 'https://www.worldmonitor.app/countries/iran/');
  // og:url and og:image stay on the share URL: social preview caches key on them.
  assert.match(response.body, /<meta property="og:url" content="https:\/\/worldmonitor\.app\/api\/story\?c=IR&amp;t=ciianalysis&amp;ts=1"\/>/);
  assert.match(response.body, /<meta property="og:image" content="https:\/\/worldmonitor\.app\/api\/og-story\?c=IR&amp;t=ciianalysis"\/>/);
  // The stub offers a followable link to the corpus page, not just a hint.
  assert.match(response.body, /<a href="https:\/\/www\.worldmonitor\.app\/countries\/iran\/">Read the full Iran brief<\/a>/);
});

test('a crawler on a code with no corpus page keeps the dashboard canonical', () => {
  const response = requestStory(GOOGLEBOT, 'c=ZZ&t=ciianalysis&ts=1');

  assert.equal(response.statusCode, 200);
  assert.equal(canonicalOf(response.body), 'https://www.worldmonitor.app/dashboard');
  assert.doesNotMatch(response.body, /\/countries\//);
});

test('a browser still gets the unchanged 302 to the SPA', () => {
  const response = requestStory(BROWSER, 'c=IR&t=ciianalysis&ts=1');

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, 'https://www.worldmonitor.app/dashboard?c=IR&t=ciianalysis&ts=1');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers.vary, 'User-Agent');
  assert.equal(response.body, '');
});

test('a lowercase country code resolves the same corpus page as uppercase', () => {
  const lower = requestStory(GOOGLEBOT, 'c=ir&t=ciianalysis&ts=1');
  const upper = requestStory(GOOGLEBOT, 'c=IR&t=ciianalysis&ts=1');

  assert.equal(canonicalOf(lower.body), 'https://www.worldmonitor.app/countries/iran/');
  assert.equal(lower.body, upper.body);
});

test('an Object.prototype key cannot be borrowed as a country', () => {
  // `c` is caller-supplied on a public share URL. A prototype-inherited hit
  // would canonicalise at /countries/function%20Object()%20{...}/. Uppercasing
  // `c` hides this by accident, not by design, so assert the map itself.
  assert.equal(COUNTRY_CORPUS_SLUGS.constructor, undefined);
  assert.equal(COUNTRY_CORPUS_NAMES.constructor, undefined);
  assert.equal(Object.getPrototypeOf(COUNTRY_CORPUS_SLUGS), null);
  assert.equal(Object.getPrototypeOf(COUNTRY_CORPUS_NAMES), null);

  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    for (const value of [key, key.toUpperCase()]) {
      const response = requestStory(GOOGLEBOT, `c=${encodeURIComponent(value)}&t=ciianalysis&ts=1`);

      assert.equal(response.statusCode, 200);
      assert.equal(
        canonicalOf(response.body),
        'https://www.worldmonitor.app/dashboard',
        `c=${value} escaped the map`,
      );
      assert.doesNotMatch(response.body, /\/countries\//);
      assert.doesNotMatch(response.body, /function |\[object /i);
    }
  }
});

test('every country with a corpus page also gets its display name from the map', () => {
  // The hand-written 20-code table left 176 corpus countries titled by raw ISO2.
  const response = requestStory(GOOGLEBOT, 'c=SD&t=ciianalysis&ts=1');

  assert.match(response.body, /<title>Sudan Intelligence Brief \| World Monitor<\/title>/);
  assert.equal(canonicalOf(response.body), 'https://www.worldmonitor.app/countries/sudan/');
});
