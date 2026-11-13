import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Execute the production helpers without starting the relay's background workers.
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const start = source.indexOf('function rateLimitKeyForIp(');
const end = source.indexOf('function logThrottled(', start);
assert.ok(start >= 0 && end > start);
const helpers = source.slice(start, end);
const secretConfig = source.match(/^const CF_EDGE_PROOF_SECRET = .*;$/m)?.[0];

function limiter(secret = 'edge-secret') {
  const buckets = new Map();
  const create = new Function('crypto', 'process', 'requestRateBuckets', `
    ${secretConfig || ''}
    const RELAY_RATE_LIMIT_WINDOW_MS = 60000;
    const RELAY_RATE_LIMIT_MAX = 1200;
    const RELAY_RSS_RATE_LIMIT_MAX = 300;
    const RELAY_OPENSKY_RATE_LIMIT_MAX = 600;
    const RELAY_GOOGLE_FLIGHTS_RATE_LIMIT_MAX = 600;
    const RELAY_OREF_RATE_LIMIT_MAX = 600;
    ${helpers}
    return { getClientIp, consumeRateLimit };
  `);
  const env = secret === null ? {} : { CF_EDGE_PROOF_SECRET: secret };
  return { ...create(crypto, { env }, buckets), buckets };
}

function request(headers = {}, peer = '192.0.2.10') {
  return { headers, socket: { remoteAddress: peer } };
}

for (const proof of [undefined, '', 'wrong-secret', ['edge-secret']]) {
  test(`rotated public IP headers cannot bypass RSS limits with proof ${JSON.stringify(proof)}`, () => {
    const { consumeRateLimit, buckets } = limiter('');
    for (let i = 1; i <= 301; i++) {
      const req = request({
        'cf-connecting-ip': `198.18.${Math.floor(i / 256)}.${i % 256}`,
        'x-real-ip': `spoof-${i}`,
        'x-forwarded-for': `spoof-${i}`,
        ...(proof === undefined ? {} : { 'x-wm-edge-proof': proof }),
      });
      const result = consumeRateLimit(req, '/rss', true);
      assert.equal(result.limited, i > 300, `request ${i}`);
    }
    assert.equal(buckets.size, 1, 'spoofed identities must not grow the bucket map');
    assert.equal(buckets.get('rss:192.0.2.10').count, 301);
  });
}

test('an unset or blank secret never authenticates an edge header', () => {
  for (const secret of [null, '', '   ']) {
    const { getClientIp } = limiter(secret);
    assert.equal(getClientIp(request({
      'cf-connecting-ip': '198.51.100.1', 'x-wm-edge-proof': secret,
    }), true), '192.0.2.10');
  }
});

test('valid edge proof preserves separate public client buckets', () => {
  const { consumeRateLimit, getClientIp, buckets } = limiter(' edge-secret ');
  for (const ip of ['198.51.100.1', '2001:db8::1']) {
    const req = request({ 'cf-connecting-ip': ` ${ip} `, 'x-wm-edge-proof': ' edge-secret ' });
    assert.equal(getClientIp(req, true), ip);
    for (let i = 1; i <= 301; i++) {
      assert.equal(consumeRateLimit(req, '/rss', true).limited, i > 300);
    }
  }
  assert.equal(buckets.size, 2);
});

test('configured proof rejects spoofed CF identities without consuming any bucket', () => {
  const { consumeRateLimit, buckets } = limiter();
  for (const proof of [undefined, '', 'wrong-secret', ['edge-secret']]) {
    for (let i = 0; i < 400; i++) {
      assert.equal(consumeRateLimit(request({
        'cf-connecting-ip': `198.18.0.${i % 256}`, 'x-wm-edge-proof': proof,
      }), '/rss', true).unproven, true);
    }
  }
  assert.equal(buckets.size, 0);
  assert.equal(consumeRateLimit(request(), '/rss', true).remaining, 299);
});

test('IPv6 rotation within a /64 cannot create fresh public buckets', () => {
  for (const proven of [false, true]) {
    const { consumeRateLimit, buckets } = limiter();
    for (let i = 1; i <= 301; i++) {
      const ip = `2001:db8:abcd:1234::${i.toString(16)}`;
      const req = proven
        ? request({ 'cf-connecting-ip': ip, 'x-wm-edge-proof': 'edge-secret' })
        : request({}, ip);
      assert.equal(consumeRateLimit(req, '/rss', true).limited, i > 300);
    }
    assert.equal(buckets.size, 1);
    const headers = { 'cf-connecting-ip': '2001:db8:abcd:1235::1', 'x-wm-edge-proof': 'edge-secret' };
    assert.equal(consumeRateLimit(request(headers), '/rss', true).remaining, 299);
  }
});

test('equivalent IPv6 spellings and mapped IPv4 share public buckets', () => {
  const { consumeRateLimit } = limiter();
  for (const [a, b] of [
    ['2001:db8::1', '2001:0DB8:0000:0000:0000:0000:0000:0002'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::ffff:c000:201', '192.0.2.1'],
  ]) {
    const fresh = limiter();
    assert.equal(fresh.consumeRateLimit(request({}, a), '/rss', true).remaining, 299);
    assert.equal(fresh.consumeRateLimit(request({}, b), '/rss', true).remaining, 298);
  }
  assert.equal(consumeRateLimit(request({}, '2001:db8::1%eth0'), '/rss', true).remaining, 299);
  assert.equal(consumeRateLimit(request({}, '2001:db8::2'), '/rss', true).remaining, 298);
});

test('missing, blank or duplicate CF IP headers fall back even with valid proof', () => {
  const { getClientIp } = limiter();
  for (const ip of [undefined, '', '   ', ['198.51.100.1']]) {
    assert.equal(getClientIp(request({
      'cf-connecting-ip': ip, 'x-wm-edge-proof': 'edge-secret',
    }), true), '192.0.2.10');
  }
  assert.equal(getClientIp({ headers: {} }, true), 'unknown');
});

test('socket peers, route grouping and window renewal remain independent', () => {
  const { consumeRateLimit, buckets } = limiter();
  assert.equal(consumeRateLimit(request(), '/rss', true).remaining, 299);
  assert.equal(consumeRateLimit(request({}, '192.0.2.11'), '/rss', true).remaining, 299);
  assert.equal(consumeRateLimit(request(), '/opensky', true).remaining, 599);
  buckets.get('rss:192.0.2.10').resetAt = 0;
  assert.equal(consumeRateLimit(request(), '/rss', true).remaining, 299);
  assert.equal(buckets.size, 3);
});

test('authenticated forwarding behavior is preserved', () => {
  const { getClientIp } = limiter();
  assert.equal(getClientIp(request({ 'x-real-ip': '198.51.100.1' })), '198.51.100.1');
  assert.equal(getClientIp(request({ 'x-forwarded-for': '198.51.100.2, 192.0.2.1' })), '198.51.100.2');
});
