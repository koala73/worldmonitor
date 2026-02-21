import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './og-story.js';

function renderOgStory(query = '') {
  const req = {
    url: `https://worldmonitor.app/api/og-story${query ? `?${query}` : ''}`,
    headers: { host: 'worldmonitor.app' },
  };

  let statusCode = 0;
  let body = '';
  const headers = {};

  const res = {
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
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

test('normalizes unsupported level values to prevent SVG script injection', () => {
  const injectedLevel = encodeURIComponent('</text><script>alert(1)</script><text>');
  const response = renderOgStory(`c=US&s=50&l=${injectedLevel}`);

  assert.equal(response.statusCode, 200);
  assert.equal(/<script/i.test(response.body), false);
  assert.match(response.body, />NORMAL<\/text>/);
});

test('uses a known level when it is allowlisted', () => {
  const response = renderOgStory('c=US&s=88&l=critical');

  assert.equal(response.statusCode, 200);
  assert.match(response.body, />CRITICAL<\/text>/);
  assert.match(response.body, /#ef4444/);
});

