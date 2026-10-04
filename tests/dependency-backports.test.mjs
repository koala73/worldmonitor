import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const braces = require('braces');
const CachePolicy = require('../blog-site/node_modules/http-cache-semantics');

describe('braces stack-exhaustion remediation', () => {
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      it(`${method} rejects deep ${open}${close} input within the character limit`, () => {
        const input = open.repeat(3500) + 'a,b' + close.repeat(3500);
        assert.throws(() => braces[method](input), /exceeds max depth/);
        assert.throws(() => braces[method](input, { maxDepth: Infinity }), /exceeds max depth/);
        assert.throws(() => braces[method](input, { maxDepth: 100000 }), /exceeds max depth/);
      });
    }
  }

  for (const method of ['compile', 'expand', 'stringify']) {
    it(`${method} rejects a deep AST supplied directly`, () => {
      const ast = { type: 'root', nodes: [] };
      let node = ast;
      for (let depth = 0; depth < 150; depth++) {
        const child = { type: 'paren', nodes: [], parent: node };
        node.nodes.push(child);
        node = child;
      }
      node.nodes.push({ type: 'text', value: 'a', parent: node });
      assert.throws(() => braces[method](ast), /exceeds max depth/);
    });
  }

  it('preserves ordinary expansion, compilation, literals, and caller depth limits', () => {
    assert.deepEqual(braces.expand('a{1..3}b{c,d}'), ['a1bc', 'a1bd', 'a2bc', 'a2bd', 'a3bc', 'a3bd']);
    assert.equal(braces.compile('{a,b{1..2}}'), '(a|b(1|2))');
    assert.equal(braces.stringify('a{b,c}'), 'a{b,c}');
    assert.doesNotThrow(() => braces.compile('{'.repeat(32) + 'a' + '}'.repeat(32)));
    assert.doesNotThrow(() => braces.compile('"' + '{'.repeat(3500) + '"'));
    assert.throws(() => braces.parse('{{a}}', { maxDepth: 1 }), /exceeds max depth/);
  });
});

describe('http-cache-semantics restricted response remediation', () => {
  const request = { url: 'https://example.test/account', method: 'GET', headers: {} };
  const restricted = [
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store, max-age=60' },
    { 'cache-control': 'no-cache, max-age=60' },
    { 'cache-control': 'proxy-revalidate, max-age=60' },
    { 'cache-control': 'max-age=60', 'set-cookie': 'session=secret' },
    { 'cache-control': 'max-age=60', vary: '*' },
  ];

  for (const headers of restricted) {
    it(`requires validation for ${JSON.stringify(headers)} despite stale directives`, () => {
      const initial = new CachePolicy(request, {
        status: 200,
        headers: { ...headers, 'cache-control': headers['cache-control'] + ', stale-if-error=600, stale-while-revalidate=600', age: '120' },
      });
      for (const policy of [initial, CachePolicy.fromObject(JSON.parse(JSON.stringify(initial.toObject())))]) {
        for (const directive of ['max-stale', 'max-stale=999999']) {
          const next = { ...request, headers: { 'cache-control': directive } };
          const result = policy.evaluateRequest(next);
          assert.equal(policy.satisfiesWithoutRevalidation(next), false);
          assert.equal(result.response, undefined);
          assert.equal(result.revalidation.synchronous, true);
        }
        assert.equal(policy.useStaleWhileRevalidate(), false);
        assert.equal(policy.timeToLive(), 0);
        const result = policy.revalidatedPolicy(request, { status: 503, headers: {} });
        assert.equal(result.modified, true);
        assert.equal(result.matches, false);
      }
    });
  }

  it('preserves valid fresh and explicitly allowed stale public responses', () => {
    const fresh = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=60' } });
    assert.equal(fresh.satisfiesWithoutRevalidation(request), true);
    const stale = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=60', age: '120' } });
    assert.equal(stale.satisfiesWithoutRevalidation(request), false);
    assert.equal(stale.satisfiesWithoutRevalidation({ ...request, headers: { 'cache-control': 'max-stale=300' } }), true);
    const privateCache = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'private, max-age=60', 'set-cookie': 'session=secret' } }, { shared: false });
    assert.equal(privateCache.satisfiesWithoutRevalidation(request), true);
  });
});
