/**
 * Feed parity test — browser view vs server view (PR #3715 review follow-up).
 *
 * Every feed is declared once in shared/news-catalog.json; the browser catalog
 * (src/config/feeds.ts) and the server digest catalog
 * (server/worldmonitor/news/v1/_feeds.ts) are views over it. The views can
 * still disagree through a feed's `browser` overrides and through placements
 * that exist on one side only. These checks keep each such difference
 * deliberate: a feed NAME placed on both sides must agree on Google News vs
 * direct routing and, in the full edition, on the upstream URL, unless a
 * reviewed exception says why not.
 *
 * KNOWN_DRIFTS grandfathers routing drift that predates the test. New drift
 * fails. The set should SHRINK over time as feeds get reconciled, not grow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTEL_EDITION,
  NEWS_CATALOG,
  buildBrowserCategoryFeeds,
  buildBrowserIntelSources,
  buildServerIntelSources,
  buildServerVariantFeeds,
} from '../shared/news-catalog.ts';

// Both sides are views over shared/news-catalog.json. The browser view keeps a
// feed's `browser` overrides, so these checks now guard the overrides: a
// reviewed exception below is the only way the two views may disagree.

/** Every URL a feed entry denotes; locale-keyed URL objects yield each member. */
function upstreamUrls(url) {
  return typeof url === 'string' ? [url] : Object.values(url);
}

const isGoogleNewsUrl = (url) => /news\.google\.com\/rss\/search/i.test(url);

/** Side -> list of { category, feeds } over every edition, intel included. */
function sideCategories(side) {
  const out = [];
  if (side === 'client') {
    for (const edition of Object.keys(NEWS_CATALOG.layout.browser)) {
      for (const [category, feeds] of Object.entries(buildBrowserCategoryFeeds(edition))) {
        out.push({ edition, category, feeds });
      }
    }
    out.push({ edition: INTEL_EDITION, category: 'intel', feeds: buildBrowserIntelSources() });
  } else {
    for (const [edition, categories] of Object.entries(buildServerVariantFeeds())) {
      for (const [category, feeds] of Object.entries(categories)) {
        out.push({ edition, category, feeds });
      }
    }
    out.push({ edition: INTEL_EDITION, category: 'intel', feeds: buildServerIntelSources() });
  }
  return out;
}

/** Map<name, { isGoogleNews, snippet }>; the first placement is canonical. */
function extractFeedRouting(side) {
  const out = new Map();
  for (const { feeds } of sideCategories(side)) {
    for (const feed of feeds) {
      if (out.has(feed.name)) continue;
      const urls = upstreamUrls(feed.url);
      out.set(feed.name, {
        isGoogleNews: urls.some(isGoogleNewsUrl),
        snippet: urls.join(', ').slice(0, 120),
      });
    }
  }
  return out;
}

/**
 * Map<category, Set<name>> unioned across editions. The digest truncates and
 * the client filters within each category, so a same-name feed in another
 * category cannot make a server item visible. The client unions categories
 * across editions (CANONICAL_FEEDS) when a user enables a custom panel.
 */
function extractFeedNamesByCategory(side) {
  const out = new Map();
  for (const { category, feeds } of sideCategories(side)) {
    const names = out.get(category) ?? new Set();
    for (const feed of feeds) names.add(feed.name);
    out.set(category, names);
  }
  return out;
}

function canonicalizeUpstreamUrl(upstream) {
  const url = new URL(upstream, 'https://api.worldmonitor.app');
  url.hash = '';
  url.host = url.host.toLowerCase();
  const parameters = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  url.search = '';
  for (const [name, value] of parameters) url.searchParams.append(name, value);
  return url.toString();
}

/** Map<`category:name`, Set<canonical url>> for the full edition. */
function extractFullFeedsByCategory(side) {
  const categories = side === 'client'
    ? buildBrowserCategoryFeeds('full')
    : buildServerVariantFeeds().full;
  const out = new Map();
  for (const [category, feeds] of Object.entries(categories)) {
    for (const feed of feeds) {
      const key = `${category}:${feed.name}`;
      const existing = out.get(key) ?? new Set();
      for (const url of upstreamUrls(feed.url)) existing.add(canonicalizeUpstreamUrl(url));
      out.set(key, existing);
    }
  }
  return out;
}

/** Every raw URL the catalog holds, base and browser override alike. */
function catalogUrls() {
  return NEWS_CATALOG.feeds.flatMap((feed) => [
    ...upstreamUrls(feed.url),
    ...(feed.browser?.url ? upstreamUrls(feed.browser.url) : []),
  ]);
}

function assertReasonedExceptions(exceptions, label) {
  for (const [key, reason] of exceptions) {
    assert.equal(typeof reason, 'string', `${label} ${key} must have a written reason`);
    assert.ok(reason.trim().length > 0, `${label} ${key} must have a written reason`);
  }
}

describe('feed parity: client vs server (PR #3715 follow-up)', () => {
  const client = extractFeedRouting('client');
  const server = extractFeedRouting('server');

  it('extracted feeds from both files', () => {
    assert.ok(client.size > 0, 'client feed extraction must not be empty');
    assert.ok(server.size > 0, 'server feed extraction must not be empty');
    assert.ok(client.has('CBC News'), 'client feed extraction must retain the critical CBC News member');
    assert.ok(server.has('CBC News'), 'server feed extraction must retain the critical CBC News member');
  });

  // Snapshot of feeds that ALREADY drift between client and server at PR #3715
  // merge time. Each one is its own per-feed judgment (some intentionally use
  // Google News on one side because the direct URL recently broke). The test
  // fails for NEW drift, not historic drift. This set should SHRINK over time
  // as feeds get reconciled — not grow.
  const KNOWN_DRIFTS = new Set([
    'The National',
    'CSIS',
    'South China Morning Post',
    'a16z Blog',
    'EU Startups',
    'Tech in Asia',
    'SemiAnalysis',
    'EIA Reports',
    'Northern Miner',
    // Mixed-locale routing: client uses direct rss() for en+de and a Google
    // News query for es; server uses pure direct for en. The classifier
    // treats any-locale-is-GoogleNews as Google News, so it flags this as a
    // drift even though both sides do agree on en. Worth reconciling
    // (probably: server should fall back to gn() for the same es query) but
    // out of scope for the #3717 review fix.
    'DW News',
  ]);

  it('every NEW shared feed name uses consistent routing (grandfathered drift snapshot)', () => {
    const newDrift = [];
    const resolvedKnown = [];
    for (const [name, c] of client) {
      const s = server.get(name);
      if (!s) continue;
      if (c.isGoogleNews === s.isGoogleNews) {
        if (KNOWN_DRIFTS.has(name)) resolvedKnown.push(name);
        continue;
      }
      if (KNOWN_DRIFTS.has(name)) continue; // grandfathered
      newDrift.push(
        `  - "${name}":\n` +
          `      client: ${c.isGoogleNews ? 'Google News' : 'direct'}  ${c.snippet.slice(0, 100)}\n` +
          `      server: ${s.isGoogleNews ? 'Google News' : 'direct'}  ${s.snippet.slice(0, 100)}`,
      );
    }
    assert.equal(
      newDrift.length,
      0,
      'NEW feed routing drift between client and server. Either update both sides ' +
        'or rename one entry so the parity check skips it:\n' +
        newDrift.join('\n'),
    );
    // If a previously-known drift is now consistent, the contributor should
    // remove it from KNOWN_DRIFTS — fail loudly so it gets cleaned up.
    assert.equal(
      resolvedKnown.length,
      0,
      `Drifts in KNOWN_DRIFTS are now consistent — remove from the set: ${resolvedKnown.join(', ')}`,
    );
  });

  it('REGRESSION (#3715): Blockworks does not appear on either side with a direct blockworks.co URL', () => {
    const dead = catalogUrls().filter((url) => /^https?:\/\/blockworks\.co\/feed$/.test(url));
    assert.deepEqual(dead, [], 'the news catalog still references the dead blockworks.co/feed URL');
  });

  it('every server feed has a client home in the same category before MAX_ITEMS_PER_CATEGORY truncation', () => {
    const clientByCategory = extractFeedNamesByCategory('client');
    const serverByCategory = extractFeedNamesByCategory('server');
    const clientNameCount = [...clientByCategory.values()].reduce((sum, names) => sum + names.size, 0);
    const serverNameCount = [...serverByCategory.values()].reduce((sum, names) => sum + names.size, 0);
    assert.ok(clientNameCount > 0, 'client category parser must not be empty');
    assert.ok(serverNameCount > 0, 'server category parser must not be empty');
    const orphans = [];
    for (const [category, serverNames] of serverByCategory) {
      const clientNames = clientByCategory.get(category) ?? new Set();
      for (const name of serverNames) {
        if (!clientNames.has(name)) orphans.push(`${category}: ${name}`);
      }
    }
    assert.equal(
      orphans.length,
      0,
      'Server-only feed entries detected. The server will fetch these, ' +
        'rank them into MAX_ITEMS_PER_CATEGORY, then the client filter will ' +
        'drop them from that category — silently shrinking the visible result set. Either add a ' +
        'matching entry with the same name and category to src/config/feeds.ts, or remove ' +
        'the server entry:\n' +
        orphans.map(entry => `  - ${entry}`).join('\n'),
    );
  });

  it('REGRESSION (#3717): Commodity Trade Mantra is not on the server side', () => {
    assert.ok(
      !server.has('Commodity Trade Mantra'),
      'the server view still places Commodity Trade Mantra; it has no client counterpart so its items get truncated-then-dropped',
    );
  });

  const INTENTIONAL_URL_DIVERGENCES = new Map([
    ['politics:AP News', 'The server digest adds a one-day Google News window.'],
    ['politics:Reuters World', 'The server digest adds a one-day Google News window.'],
    ['us:Reuters US', 'The server digest adds a one-day Google News window.'],
    ['europe:ANSA', 'The server uses ANSA’s site-wide feed; the client uses its top-news feed.'],
    ['europe:DW News', 'Locale variants intentionally select language-specific DW feeds.'],
    ['europe:France 24', 'Locale variants intentionally select language-specific France 24 feeds.'],
    ['europe:EuroNews', 'Locale variants intentionally select language-specific EuroNews feeds.'],
    ['europe:Le Monde', 'Locale variants intentionally select language-specific Le Monde feeds.'],
    ['europe:Meduza', 'Locale variants intentionally select language-specific Meduza feeds.'],
    ['europe:Suspilne', 'Locale variants intentionally select language-specific Suspilne feeds.'],
    ['europe:Ukrinform', 'Locale variants intentionally select language-specific Ukrinform feeds.'],
    ['middleeast:Al Arabiya', 'Locale variants intentionally select language-specific Al Arabiya feeds.'],
    ['middleeast:Al Jazeera', 'Locale variants intentionally select language-specific Al Jazeera feeds.'],
    ['middleeast:Rudaw', 'The client requests the en edition explicitly; the server relies on the default edition.'],
    ['middleeast:The National', 'Grandfathered direct-versus-Google-News drift tracked by the routing test.'],
    ['finance:Reuters Business', 'The server digest adds a one-day Google News window.'],
    ['gov:State Dept', 'The server digest narrows the query and adds a one-day window.'],
    ['gov:Treasury', 'The server digest narrows the query and adds a one-day window.'],
    ['gov:DOJ', 'The server digest narrows the query and adds a one-day window.'],
    ['layoffs:Layoffs.fyi', 'The server adds broader terms and a three-day window.'],
    ['thinktanks:CSIS', 'Grandfathered direct-versus-Google-News drift tracked by the routing test.'],
    ['thinktanks:War on the Rocks', 'The two sides differ only by a documented trailing slash.'],
    ['africa:Africanews', 'Locale variants intentionally select language-specific Africanews feeds.'],
    ['asia:Asia News', 'The client uses a broad Asia query; the server targets AsiaNews.it.'],
    ['asia:South China Morning Post', 'Grandfathered direct-versus-Google-News drift tracked by the routing test.'],
    ['asia:The Hindu', 'The client uses the national feed; the server uses the site-wide feed.'],
    ['asia:RFE/RL Central Asia', 'The client spells the phrase; the server URL-encodes a plus in the same phrase.'],
    ['energy:Nuclear Energy', 'The server uses a narrower reactor-focused query.'],
    ['energy:Reuters Energy', 'The server uses a narrower, more recent energy query.'],
  ]);

  it('REGRESSION (#6427): parity exceptions require written reasons', () => {
    assertReasonedExceptions(INTENTIONAL_URL_DIVERGENCES, 'URL-divergence exception');
    assert.throws(
      () => assertReasonedExceptions(new Map([['us:Example', '   ']]), 'test exception'),
      /must have a written reason/,
    );
  });

  it('REGRESSION (#6427): shared full-variant feeds resolve to the same upstream', () => {
    assertReasonedExceptions(INTENTIONAL_URL_DIVERGENCES, 'URL-divergence exception');
    const clientFullFeeds = extractFullFeedsByCategory('client');
    const serverFullFeeds = extractFullFeedsByCategory('server');
    assert.ok(clientFullFeeds.size > 0);
    assert.ok(serverFullFeeds.size > 0);

    const differences = [];
    const resolvedExceptions = [];
    for (const [key, clientUrls] of clientFullFeeds) {
      const serverUrls = serverFullFeeds.get(key);
      if (!serverUrls) continue;
      const isSame =
        clientUrls.size === serverUrls.size && [...clientUrls].every(url => serverUrls.has(url));
      if (isSame) {
        if (INTENTIONAL_URL_DIVERGENCES.has(key)) resolvedExceptions.push(key);
        continue;
      }
      if (INTENTIONAL_URL_DIVERGENCES.has(key)) continue;
      differences.push(
        `  - ${key}\n      client: ${[...clientUrls].join(', ')}\n      server: ${[...serverUrls].join(', ')}`,
      );
    }
    assert.equal(
      differences.length,
      0,
      'Shared feed names point at different upstreams. Align both sides, or add a reviewed reason to INTENTIONAL_URL_DIVERGENCES:\n' +
        differences.join('\n'),
    );
    assert.equal(
      resolvedExceptions.length,
      0,
      `URL-divergence exceptions are now aligned — remove them: ${resolvedExceptions.join(', ')}`,
    );
    const staleExceptions = [...INTENTIONAL_URL_DIVERGENCES.keys()].filter(
      key => !clientFullFeeds.has(key) || !serverFullFeeds.has(key),
    );
    assert.equal(
      staleExceptions.length,
      0,
      `URL-divergence exceptions no longer describe a shared feed — remove them: ${staleExceptions.join(', ')}`,
    );
  });

  it('REGRESSION (#6427): new client-only full-variant feeds require a reviewed server decision', () => {
    const clientFullFeeds = extractFullFeedsByCategory('client');
    const serverFullFeeds = extractFullFeedsByCategory('server');
    // Empty since U6 batch 4: the full digest fetches every full-variant feed.
    const INTENTIONAL_CLIENT_ONLY = new Map();
    assertReasonedExceptions(INTENTIONAL_CLIENT_ONLY, 'client-only exception');
    const unreviewed = [];
    for (const key of clientFullFeeds.keys()) {
      if (serverFullFeeds.has(key) || INTENTIONAL_CLIENT_ONLY.has(key)) continue;
      unreviewed.push(key);
    }
    const staleClientOnly = [...INTENTIONAL_CLIENT_ONLY.keys()].filter(
      key => !clientFullFeeds.has(key) || serverFullFeeds.has(key),
    );
    assert.equal(
      unreviewed.length,
      0,
      'Client-only full-variant feeds are invisible to the server digest. Add the feed to both sides, or record a reviewed client-only decision:\n' +
        unreviewed.map(key => `  - ${key}: ${INTENTIONAL_CLIENT_ONLY.get(key) ?? ''}`).join('\n'),
    );
    assert.equal(
      staleClientOnly.length,
      0,
      `Client-only exceptions are no longer client-only — remove them: ${staleClientOnly.join(', ')}`,
    );
  });
});
