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

test('escapes hostile country text in both SVG text fields', () => {
  const country = '</text><script>alert("x")</script><text>&';
  const response = renderOgStory(new URLSearchParams({ c: country, s: '50', t: country }).toString());
  const escaped = '&lt;/TEXT&gt;&lt;SCRIPT&gt;ALERT(&quot;X&quot;)&lt;/SCRIPT&gt;&lt;TEXT&gt;&amp;';
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.split(escaped).length - 1, 2);
  assert.doesNotMatch(response.body, /<script/i);
});

test('retains known country names and finite score geometry for hostile inputs', () => {
  for (const score of ['<script/>', '9'.repeat(400), '-50', '150']) {
    const response = renderOgStory(new URLSearchParams({ c: 'us', s: score, l: '__proto__' }).toString());
    assert.match(response.body, />UNITED STATES<\/text>/);
    assert.match(response.body, />US<\/text>/);
    assert.doesNotMatch(response.body, /NaN|Infinity|<script/i);
    assert.equal(response.headers['content-type'], 'image/svg+xml');
  }
});
