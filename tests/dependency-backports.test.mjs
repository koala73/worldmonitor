import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const braces = require('braces');
const CachePolicy = require('../vendor/http-cache-semantics');

describe('installed dependency backports', () => {
  for (const [lockfile, name, version, resolved] of [
    ['package-lock.json', 'braces', '3.0.4-worldmonitor.1', 'file:vendor/braces'],
    ['pro-test/package-lock.json', 'braces', '3.0.4-worldmonitor.1', 'file:../vendor/braces'],
    ['blog-site/package-lock.json', 'http-cache-semantics', '4.2.1-worldmonitor.2', 'file:../vendor/http-cache-semantics'],
  ]) {
    it(`${lockfile} selects only the source backport for ${name}`, () => {
      const lock = JSON.parse(readFileSync(new URL(`../${lockfile}`, import.meta.url), 'utf8'));
      const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/${name}`));
      assert.equal(copies.length, 1);
      for (const [, entry] of copies) {
        assert.equal(entry.version, version);
        assert.equal(entry.resolved, resolved);
        assert.equal(entry.link, undefined);
      }
    });
  }

  it('installs the patched source for micromatch without symlinks or install scripts', () => {
    const consumers = [
      [createRequire(require.resolve('micromatch')), 'braces', ['index.js', 'lib/parse.js', 'lib/compile.js', 'lib/expand.js', 'lib/stringify.js', 'lib/constants.js', 'lib/utils.js']],
    ];
    for (const [consumer, name, files] of consumers) {
      const manifest = consumer(`${name}/package.json`);
      assert.equal(manifest.private, true);
      assert.equal(manifest.scripts, undefined);
      for (const file of files) {
        assert.deepEqual(readFileSync(consumer.resolve(`${name}/${file}`)), readFileSync(new URL(`../vendor/${name}/${file}`, import.meta.url)));
      }
    }
  });

  it('installs the patched source for Astro', { skip: !existsSync(new URL('../blog-site/node_modules/astro/package.json', import.meta.url)) }, () => {
    const consumer = createRequire(require.resolve('../blog-site/node_modules/astro/package.json'));
    assert.deepEqual(readFileSync(consumer.resolve('http-cache-semantics')), readFileSync(new URL('../vendor/http-cache-semantics/index.js', import.meta.url)));
    assert.equal(consumer('http-cache-semantics/package.json').private, true);
  });
});

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
  it('processes hostile Connection and Vary whitespace within a bounded time', () => {
    const source = fileURLToPath(new URL('../vendor/http-cache-semantics/index.js', import.meta.url));
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const CachePolicy = require(${JSON.stringify(source)});
      const policy = new CachePolicy({ url: '/', headers: {} }, {
        status: 200, headers: {
          'cache-control': 'public, max-age=60',
          connection: 'x-hop, x' + ' '.repeat(300000) + 'y, y-hop',
          'x-hop': 'remove', 'y-hop': 'remove', 'x-end': 'keep'
        }
      });
      const headers = policy.responseHeaders();
      assert.equal(headers['x-hop'], undefined);
      assert.equal(headers['y-hop'], undefined);
      assert.equal(headers['x-end'], 'keep');
      const request = { url: '/', headers: { 'x-match': 'same', 'y-match': 'same' } };
      const varied = new CachePolicy(request, { status: 200, headers: {
        'cache-control': 'public, max-age=60',
        vary: 'x-match, x' + ' '.repeat(300000) + 'y, y-match'
      } });
      assert.equal(varied.satisfiesWithoutRevalidation(request), true);
      assert.equal(varied.satisfiesWithoutRevalidation({ ...request, headers: { ...request.headers, 'y-match': 'different' } }), false);
    `], { timeout: 5000, encoding: 'utf8' });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  });

  const request = { url: 'https://example.test/account', method: 'GET', headers: {} };
  const restricted = [
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store, max-age=60' },
    { 'cache-control': 'no-cache, max-age=60' },
    { 'cache-control': 'proxy-revalidate, max-age=60' },
    { 'cache-control': 'max-age=60', 'set-cookie': 'session=secret' },
    { 'cache-control': 'max-age=60', vary: '*' },
    { 'cache-control': 'max-age=60', vary: ' * ' },
    { 'cache-control': 'max-age=60', vary: 'accept, *' },
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

  it('does not treat inherited object properties as matching Vary headers', () => {
    for (const vary of ['constructor', '__proto__', 'inherited']) {
      const headers = Object.create({ inherited: 'secret' });
      const original = { ...request, headers };
      const policy = new CachePolicy(original, { status: 200, headers: { 'cache-control': 'public, max-age=60', vary } });
      assert.equal(policy.satisfiesWithoutRevalidation({ ...request, headers: Object.create({ inherited: 'secret' }) }), false);
    }
  });

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
