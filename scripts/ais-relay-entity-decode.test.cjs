/**
 * Regression tests for _decodeRedditEntities in ais-relay.cjs (#5436).
 *
 * ais-relay.cjs starts an HTTP/WebSocket server, poll loops, and intervals at
 * top level (no require.main guard), so it cannot be require()d from a test.
 * Instead we lift the real function body out of the production source and eval
 * it, so the assertions run against the shipped code, not a copy.
 *
 * Run: node --test scripts/ais-relay-entity-decode.test.cjs
 */
'use strict';

const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const relaySource = readFileSync(join(__dirname, 'ais-relay.cjs'), 'utf8');

function loadFunction(name) {
  const match = relaySource.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `could not locate ${name}() in ais-relay.cjs`);
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return ${name};`)();
}

const _decodeRedditEntities = loadFunction('_decodeRedditEntities');

test('_decodeRedditEntities decodes exactly one level (no double-decode)', () => {
  // A Reddit title whose literal text is `&lt;script&gt;` arrives escaped as
  // `&amp;lt;script&amp;gt;`. Replacing `&amp;` first would yield `<script>`.
  assert.equal(_decodeRedditEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  assert.equal(_decodeRedditEntities('&amp;quot;no comment&amp;quot;'), '&quot;no comment&quot;');
  assert.equal(_decodeRedditEntities('&amp;#39;'), '&#39;');
  assert.equal(_decodeRedditEntities('&amp;amp;'), '&amp;');
});

test('_decodeRedditEntities still decodes single-level entities', () => {
  assert.equal(_decodeRedditEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(_decodeRedditEntities('a &lt; b &gt; c'), 'a < b > c');
  assert.equal(_decodeRedditEntities('&quot;hello&quot;'), '"hello"');
  assert.equal(_decodeRedditEntities('it&#39;s'), "it's");
  assert.equal(
    _decodeRedditEntities('AT&amp;T &lt;tag&gt; &quot;q&quot; it&#39;s'),
    'AT&T <tag> "q" it\'s',
  );
});

test('_decodeRedditEntities leaves non-entities and unknown text alone', () => {
  assert.equal(_decodeRedditEntities('plain headline & no entities'), 'plain headline & no entities');
  assert.equal(_decodeRedditEntities('&nbsp; stays'), '&nbsp; stays');
});

test('_decodeRedditEntities passes non-strings through unchanged', () => {
  assert.equal(_decodeRedditEntities(null), null);
  assert.equal(_decodeRedditEntities(undefined), undefined);
  assert.equal(_decodeRedditEntities(42), 42);
});
