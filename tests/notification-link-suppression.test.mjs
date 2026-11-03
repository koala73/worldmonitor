/**
 * Failing-first proof for #8401: the shared link-suppression matcher.
 *
 * The relay (pre-delivery) and the SW check (post-delivery click) must agree
 * on what "blocked" means. This suite pins the shared matcher directly:
 * exact URLs match after normalization, `host:` entries cover the host and
 * its subdomains, non-http(s) candidates never match, and one malformed
 * operator entry cannot disable the whole set.
 *
 * Run: node --test tests/notification-link-suppression.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  HOST_ENTRY_PREFIX,
  normalizeSuppressedUrl,
  normalizeSuppressedHost,
  parseSuppressionEntries,
  isLinkSuppressed,
} = require(resolve(__dirname, '..', 'scripts', 'shared', 'notification-link-suppression.cjs'));
const { classifyNotificationLink } = require(resolve(__dirname, '..', 'scripts', 'shared', 'notify-fields.cjs'));

const EVIL = 'https://evil.example/phish?x=1';

function parsed(...entries) {
  return parseSuppressionEntries(entries);
}

describe('notification link suppression matcher (#8401)', () => {
  it('exact URL entry suppresses the verbatim candidate', () => {
    assert.equal(isLinkSuppressed(EVIL, parsed(EVIL)), true);
  });

  it('exact entry matches across case, default-port and trailing-dot variants', () => {
    const p = parsed(EVIL);
    assert.equal(isLinkSuppressed('HTTPS://EVIL.EXAMPLE:443/phish?x=1', p), true);
    assert.equal(isLinkSuppressed('https://evil.example./phish?x=1', p), true);
  });

  it('exact entry does not match a different path, query, or host', () => {
    const p = parsed(EVIL);
    assert.equal(isLinkSuppressed('https://evil.example/other?x=1', p), false);
    assert.equal(isLinkSuppressed('https://evil.example/phish?x=2', p), false);
    assert.equal(isLinkSuppressed('https://other.example/phish?x=1', p), false);
  });

  it('host entry suppresses the host and its subdomains, nothing else', () => {
    const p = parsed(`${HOST_ENTRY_PREFIX}evil.example`);
    assert.equal(isLinkSuppressed('https://evil.example/anything', p), true);
    assert.equal(isLinkSuppressed('https://www.evil.example/deep/path?q=1', p), true);
    assert.equal(isLinkSuppressed('https://not-evil.example/', p), false);
    assert.equal(isLinkSuppressed('https://evil.example.eviler.example/', p), false);
  });

  it('host entry suppresses a valid URL longer than 2,048 characters', () => {
    const p = parsed(`${HOST_ENTRY_PREFIX}evil.example`);
    const longUrl = `https://evil.example/path?payload=${'x'.repeat(2_100)}`;
    assert.equal(isLinkSuppressed(longUrl, p), true);
  });

  it('host entry matches non-default ports (relay and SW agree)', () => {
    const p = parsed(`${HOST_ENTRY_PREFIX}evil.example`);
    assert.equal(isLinkSuppressed('https://evil.example:8443/x', p), true);
  });

  it('non-http(s) candidates never match, even with a hostile entry present', () => {
    const p = parsed('javascript:alert(1)', 'data:text/html,<h1>x</h1>', EVIL);
    assert.equal(isLinkSuppressed('javascript:alert(1)', p), false);
    assert.equal(isLinkSuppressed('data:text/html,<h1>x</h1>', p), false);
  });

  it('credential-bearing candidates do not smuggle a trusted read', () => {
    // https://worldmonitor.app@evil.example/ has a real host of evil.example;
    // normalization drops credentials so the host entry still catches it.
    const p = parsed(`${HOST_ENTRY_PREFIX}evil.example`);
    assert.equal(isLinkSuppressed('https://worldmonitor.app@evil.example/', p), true);
  });

  it('one malformed operator entry does not disable the set', () => {
    const p = parsed(null, 42, '   ', 'not a url at all {{{', EVIL);
    assert.equal(isLinkSuppressed(EVIL, p), true);
    assert.equal(isLinkSuppressed('https://other.example/', p), false);
  });

  it('non-string and empty candidates are never suppressed', () => {
    const p = parsed(EVIL);
    for (const bad of [null, undefined, 42, '', '   ', {}, []]) {
      assert.equal(isLinkSuppressed(bad, p), false, `candidate ${String(bad)} must not match`);
    }
  });

  it('normalizers reject garbage with null', () => {
    assert.equal(normalizeSuppressedUrl('not a url'), null);
    assert.equal(normalizeSuppressedUrl('javascript:alert(1)'), null);
    assert.equal(normalizeSuppressedUrl(''), null);
    assert.equal(normalizeSuppressedHost('evil.example/path'), null);
    assert.equal(normalizeSuppressedHost(''), null);
    assert.equal(normalizeSuppressedHost('has space.example'), null);
  });

  it('parse is case-insensitive on the host: prefix and dedupes', () => {
    const p = parsed('HOST:evil.example', 'host:EVIL.EXAMPLE', EVIL, EVIL);
    assert.equal(p.hosts.size, 1);
    assert.equal(p.urls.size, 1);
    assert.equal(isLinkSuppressed('https://sub.evil.example/', p), true);
  });

  it('non-ASCII host entries match the punycode host a URL parses to', () => {
    const p = parsed(`${HOST_ENTRY_PREFIX}b\u00fccher.example`);
    assert.equal(p.hosts.has('xn--bcher-kva.example'), true, 'IDN entry must be kept, not dropped');
    assert.equal(isLinkSuppressed('https://b\u00fccher.example/x', p), true);
    assert.equal(isLinkSuppressed('https://xn--bcher-kva.example/x', p), true);
    assert.equal(normalizeSuppressedHost('evil.example/path'), null);
  });

  it('scheme-relative and backslash spellings resolve like the delivery classifier', () => {
    // classifyNotificationLink resolves these against the dashboard base and
    // email/Telegram/Slack/Discord deliver https://evil.example/x, so a
    // matcher that parses them base-less (null) lets them bypass host:.
    const p = parsed(`${HOST_ENTRY_PREFIX}evil.example`);
    for (const spelling of ['//evil.example/x', '/\\evil.example/x']) {
      assert.equal(normalizeSuppressedUrl(spelling), 'https://evil.example/x', spelling);
      assert.equal(isLinkSuppressed(spelling, p), true, `${spelling} must be host-suppressed`);
    }
    assert.equal(isLinkSuppressed('//evil.example/x', parsed('https://evil.example/x')), true,
      'an exact entry must also catch the scheme-relative spelling');
  });

  it('agrees with classifyNotificationLink on every link it would deliver', () => {
    const vectors = [
      'https://evil.example/x', '//evil.example/x', '/\\evil.example/x', '\\\\evil.example/x',
      '/relative/path', 'https://EVIL.example:443/a', 'evil.example/x', 'not a url',
      'javascript:alert(1)', 'https://www.evil.example./x?q=1#h',
    ];
    for (const v of vectors) {
      const classified = classifyNotificationLink(v);
      if (classified.kind !== 'article') continue;
      const normalized = normalizeSuppressedUrl(v);
      assert.ok(normalized, `${v} is delivered as ${classified.url}, so the matcher must see it`);
      assert.equal(new URL(normalized).hostname, classified.host.replace(/\.+$/, ''), v);
      assert.equal(isLinkSuppressed(v, parsed(`${HOST_ENTRY_PREFIX}${classified.host.replace(/\.+$/, '')}`)), true, v);
    }
  });
});
