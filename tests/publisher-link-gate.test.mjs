// #8398: a feed item whose link leaves its own publisher's domain must not
// produce a notification carrying that link. The gate is the shared
// publisher-link predicate (shared/publisher-link-gate.js); this test pins
// the predicate's contract. Ingest/emission wiring is pinned by the
// per-surface suites (ingest + relay + watchlist).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeLinkHostname,
  linkHostname,
  isPublisherLink,
  feedPublisherHost,
} from '../shared/publisher-link-gate.js';

describe('publisher-link-gate (#8398)', () => {
  it('accepts the publisher apex, www., and its subdomains', () => {
    assert.equal(isPublisherLink('https://www.bbc.co.uk/news/world-123', ['bbc.co.uk']), true);
    assert.equal(isPublisherLink('https://bbc.co.uk/news/world-123', ['bbc.co.uk']), true);
    assert.equal(isPublisherLink('https://amp.theguardian.com/world/2026/x', ['theguardian.com']), true);
  });

  it('rejects off-publisher links, lookalike suffixes, and non-HTTP(S) links', () => {
    // Off-publisher: the suspicious case in the pentest chain.
    assert.equal(isPublisherLink('https://evil.example/phish', ['bbc.co.uk']), false);
    // Registrable-suffix lookalike: endswith('bbc.co.uk') alone would pass.
    assert.equal(isPublisherLink('https://evilbbc.co.uk/story', ['bbc.co.uk']), false);
    assert.equal(isPublisherLink('https://bbc.co.uk.evil.com/story', ['bbc.co.uk']), false);
    // Non-HTTP(S) and relative links carry no verifiable publisher host.
    assert.equal(isPublisherLink('javascript:alert(1)', ['bbc.co.uk']), false);
    assert.equal(isPublisherLink('data:text/html,<h1>x</h1>', ['bbc.co.uk']), false);
    assert.equal(isPublisherLink('/news/world-123', ['bbc.co.uk']), false);
    assert.equal(isPublisherLink('', ['bbc.co.uk']), false);
  });

  it('normalizes expected hosts the same way (www./case/trailing-dot tolerant)', () => {
    assert.equal(isPublisherLink('https://BBC.CO.UK./news/x', ['www.bbc.co.uk.']), true);
    assert.equal(isPublisherLink('https://reuters.com/world/x', ['WWW.REUTERS.COM']), true);
  });

  it('fails closed on an empty or absent expected set', () => {
    assert.equal(isPublisherLink('https://bbc.co.uk/news/x', []), false);
    assert.equal(isPublisherLink('https://bbc.co.uk/news/x', null), false);
    assert.equal(isPublisherLink('https://bbc.co.uk/news/x', undefined), false);
    assert.equal(isPublisherLink('https://bbc.co.uk/news/x', ['']), false);
  });

  it('matches any of several expected hosts (feed host + curated family domains)', () => {
    // GDELT-style: article on a family domain while the feed label differs.
    assert.equal(
      isPublisherLink('https://www.reuters.com/world/europe/x', ['news.google.com', 'reuters.com']),
      true,
    );
    assert.equal(
      isPublisherLink('https://evil.example/x', ['news.google.com', 'reuters.com']),
      false,
    );
  });

  it('linkHostname extracts only http(s) hosts', () => {
    assert.equal(linkHostname('https://feeds.bbci.co.uk/news/world/rss.xml'), 'feeds.bbci.co.uk');
    assert.equal(linkHostname('javascript:alert(1)'), '');
    assert.equal(linkHostname('/relative/path'), '');
    assert.equal(linkHostname(null), '');
  });

  it('normalizeLinkHostname strips www., case, and trailing dots; rejects bare labels', () => {
    assert.equal(normalizeLinkHostname('WWW.BBC.co.uk.'), 'bbc.co.uk');
    assert.equal(normalizeLinkHostname('bbc.co.uk'), 'bbc.co.uk');
    assert.equal(normalizeLinkHostname('localhost'), '');
    assert.equal(normalizeLinkHostname(''), '');
    assert.equal(normalizeLinkHostname(undefined), '');
  });

  it('feedPublisherHost resolves the configured feed URL to its publisher domain', () => {
    assert.equal(feedPublisherHost('https://feeds.bbci.co.uk/news/world/rss.xml'), 'feeds.bbci.co.uk');
    assert.equal(feedPublisherHost('not a url'), '');
  });
});
