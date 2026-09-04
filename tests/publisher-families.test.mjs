/**
 * Publisher-family map contract (#6428).
 *
 * `shared/publisher-families.js` carries the data every corroboration gate now
 * counts with. Curated data rots in two directions, so both are locked here:
 *
 *   - DEAD ENTRIES: a label in the map that no feed config declares is a typo
 *     or a rename, and it silently stops merging the publisher it named.
 *   - MISSING ENTRIES: a NEW feed for a publisher already in the map would
 *     otherwise be counted as an independent source. The host invariant below
 *     derives that case from the feed configs themselves, so a future feed
 *     addition fails here instead of quietly inflating a corroboration count.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_CORROBORATING_PUBLISHERS,
  PUBLISHER_FAMILIES,
  countPublisherFamilies,
  publisherFamiliesFor,
  publisherFamilyFor,
  publisherNameForFamily,
} from '../shared/publisher-families.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CLIENT_FEEDS = resolve(ROOT, 'src/config/feeds.ts');
const SERVER_FEEDS = resolve(ROOT, 'server/worldmonitor/news/v1/_feeds.ts');
const SOURCE_TIERS = resolve(ROOT, 'shared/source-tiers.json');

/**
 * Hosts that carry someone else's journalism. Two labels sharing one of these
 * prove nothing about the publisher, so the host invariant must not merge on
 * them — those cases are curated by hand or left as separate families.
 */
const NON_PUBLISHER_HOSTS = new Set([
  'news.google.com',
  'feeds.feedburner.com',
  'feedburner.com',
  'feeds.megaphone.fm',
  'rss.app',
  'mshibanami.github.io',
]);

/**
 * Every publisher host a feed entry points at.
 *
 * A Google News URL is only evidence of a publisher when the query is
 * `site:`-scoped; a bare keyword query returns the open web and identifies
 * nobody. Locale-keyed `url: { en: ..., fr: ... }` entries contribute every
 * locale's host, because they are all one label.
 */
function publisherHostsFor(urlExpr) {
  const hosts = new Set();
  for (const m of urlExpr.matchAll(/(['"`])(https?:\/\/(?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    let url;
    try {
      url = new URL(m[2]);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, '');
    if (!NON_PUBLISHER_HOSTS.has(host)) {
      hosts.add(host);
      continue;
    }
    const query = decodeURIComponent(url.searchParams.get('q') ?? '').replace(/\+/g, ' ');
    const site = query.match(/site:([A-Za-z0-9.-]+)/);
    if (site) hosts.add(site[1].replace(/^www\./, ''));
  }
  // The server config wraps Google News in gn()/gnLocale() helpers whose
  // argument is the bare query, not a URL.
  for (const m of urlExpr.matchAll(/\bgn(?:Locale)?\(\s*(['"`])([\s\S]*?)\1/g)) {
    const site = m[2].match(/site:([A-Za-z0-9.-]+)/);
    if (site) hosts.add(site[1].replace(/^www\./, ''));
  }
  return hosts;
}

/** name -> Set<publisher host>, across both feed configs. */
function collectFeedLabels() {
  const labels = new Map();
  for (const file of [CLIENT_FEEDS, SERVER_FEEDS]) {
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/\bname:\s*'((?:[^'\\]|\\.)*)'/g)) {
      const name = m[1].replace(/\\'/g, "'");
      // Scan forward to this entry's `url:`; 600 chars spans a multiline
      // locale-keyed url object without reaching the next entry's name.
      const window = src.slice(m.index, m.index + 600);
      const urlMatch = window.match(/\burl:\s*([\s\S]*?)(?:,\s*$|}\s*[,\]])/m);
      if (!labels.has(name)) labels.set(name, new Set());
      if (!urlMatch) continue;
      for (const host of publisherHostsFor(urlMatch[1])) labels.get(name).add(host);
    }
  }
  for (const name of Object.keys(JSON.parse(readFileSync(SOURCE_TIERS, 'utf-8')))) {
    if (!labels.has(name)) labels.set(name, new Set());
  }
  return labels;
}

const FEED_LABELS = collectFeedLabels();

describe('publisher-families map data', () => {
  it('parsed the feed configs (guards a silently empty inventory)', () => {
    // Named members exercise direct RSS and wrapper-backed feeds. Aggregate
    // floors allowed partial parser collapse while still passing.
    for (const label of ['BBC World', 'Reuters World', 'Nature News']) {
      assert.ok(FEED_LABELS.has(label), `expected critical publisher label ${label}`);
    }
    const withHosts = [...FEED_LABELS.values()].filter((hosts) => hosts.size > 0).length;
    assert.ok(withHosts > 0, 'publisher URL extraction must not be empty');
  });

  it('never merges labels that publish from different hosts without a declared reason', () => {
    // The host invariant above is one-directional: it proves should-be-together
    // labels ARE together. Nothing stopped a family from wrongly folding in an
    // independent outlet — which shrinks the eligible pool (the #5947
    // dark-brief direction) and passes every other check here.
    //
    // Cross-host families are legitimate but must be deliberate, so each one is
    // named with the reason it spans hosts.
    const CROSS_HOST_FAMILIES = {
      bbc: 'feeds.bbci.co.uk for the English editions, bbc.com for Afrique/Mundo',
      dw: 'rss.dw.com feed subdomain alongside dw.com — one Deutsche Welle newsroom',
      bloomberg: 'bloomberg.com plus tier-only "Bloomberg" and a Google News keyword feed',
      'hacker-news': 'hnrss.org plus news.ycombinator.com ("YC News" is the HN front page)',
      reuters: 'reuters.com plus tier-only "Reuters" and a Google News keyword feed',
      'the-verge': 'theverge.com plus tier-only podcast labels and a Google News shows feed',
      'y-combinator': 'ycombinator.com plus a Google News keyword feed',
      a16z: 'a16z.com / a16z.news plus Google News keyword feeds — no single host',
      acquired: 'podcast, reached only through Google News keyword feeds',
      asharq: 'asharqbusiness.com and asharq.com — one newsroom, two properties',
      interfax: 'interfax.ru Russian feed and interfax.com English edition — one Interfax newsroom',
      ndtv: 'both labels arrive via feedburner, which identifies no publisher',
      pivot: 'one show across a tier-only label and a megaphone.fm feed',
    };

    const offenders = [];
    for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILIES)) {
      const hosts = new Set();
      for (const label of entry.labels) {
        for (const host of FEED_LABELS.get(label) ?? []) hosts.add(host);
      }
      if (hosts.size <= 1) continue;
      if (familyId in CROSS_HOST_FAMILIES) continue;
      offenders.push(`${familyId} spans ${[...hosts].sort().join(', ')}`);
    }

    assert.deepEqual(
      offenders.sort(),
      [],
      'these families merge labels from different publisher hosts with no declared reason — ' +
        'an over-merge understates corroboration and can starve the brief. Either split them, ' +
        'or add the family to CROSS_HOST_FAMILIES with why it legitimately spans hosts:\n  ' +
        offenders.join('\n  '),
    );

    const stale = Object.keys(CROSS_HOST_FAMILIES).filter((id) => !(id in PUBLISHER_FAMILIES));
    assert.deepEqual(stale, [], 'CROSS_HOST_FAMILIES names families that no longer exist');
  });

  it('maps only labels that a feed config or the tier table declares', () => {
    const unknown = [];
    for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILIES)) {
      for (const label of entry.labels) {
        if (!FEED_LABELS.has(label)) unknown.push(`${familyId} -> "${label}"`);
      }
    }
    assert.deepEqual(
      unknown,
      [],
      'publisher-families.js names labels no feed config declares. A renamed or ' +
        'removed feed leaves a dead entry that stops merging its publisher:\n  ' +
        unknown.join('\n  '),
    );
  });

  it('never puts one label in two families', () => {
    const seen = new Map();
    const duplicates = [];
    for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILIES)) {
      for (const label of entry.labels) {
        if (seen.has(label)) duplicates.push(`"${label}" in ${seen.get(label)} and ${familyId}`);
        seen.set(label, familyId);
      }
    }
    assert.deepEqual(duplicates, [], duplicates.join('\n'));
  });

  it('keeps curated family ids out of the singleton namespace', () => {
    const colliding = Object.keys(PUBLISHER_FAMILIES).filter((id) => id.startsWith('label:'));
    assert.deepEqual(colliding, [], 'a curated id starting with "label:" can collide with an unmapped label');
  });

  it('gives every family a publisher display name and at least two labels', () => {
    for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILIES)) {
      assert.equal(typeof entry.publisher, 'string', `${familyId} has no publisher name`);
      assert.ok(entry.publisher.length > 0, `${familyId} has an empty publisher name`);
      assert.ok(
        entry.labels.length >= 2,
        `${familyId} lists ${entry.labels.length} label(s) — a one-label family is what the ` +
          'unmapped default already does, so the entry is dead weight',
      );
    }
  });

  it('puts every pair of labels that share a publisher host in one family', () => {
    const byHost = new Map();
    for (const [name, hosts] of FEED_LABELS) {
      for (const host of hosts) {
        if (!byHost.has(host)) byHost.set(host, new Set());
        byHost.get(host).add(name);
      }
    }

    const split = [];
    for (const [host, names] of byHost) {
      if (names.size < 2) continue;
      const families = new Map();
      for (const name of names) families.set(name, publisherFamilyFor(name));
      if (new Set(families.values()).size === 1) continue;
      split.push(
        `${host}: ${[...families].map(([n, f]) => `"${n}" -> ${f}`).join(', ')}`,
      );
    }

    assert.deepEqual(
      split.sort(),
      [],
      'these feed labels publish from the same host but count as separate publishers, ' +
        'so one publisher can corroborate itself. Add them to a family in ' +
        'shared/publisher-families.js:\n  ' + split.join('\n  '),
    );
  });
});

describe('corroboration threshold is one constant, not three literals', () => {
  // #6428 review: the brief-lead gate, the seeder's entity bucket, and the
  // digest's entity bucket all ask "how many publishers make this
  // corroborated?" They were three separate literal 2s. Three gates that must
  // agree, with no mechanism forcing them to, is how one of them gets tuned
  // and the other two silently disagree.
  const GATES = [
    ['scripts/_clustering.mjs', /bucket\.sources\.size < MIN_CORROBORATING_PUBLISHERS/],
    ['scripts/_clustering.mjs', /countPublisherFamilies\(cluster\?\.sources\) >= MIN_CORROBORATING_PUBLISHERS/],
    ['server/worldmonitor/news/v1/list-feed-digest.ts', /bucket\.sources\.size < MIN_CORROBORATING_PUBLISHERS/],
    ['scripts/seed-insights.mjs', />= MIN_CORROBORATING_PUBLISHERS/],
  ];

  for (const [file, pattern] of GATES) {
    it(`${file} reads the shared constant (${pattern.source.slice(0, 40)}...)`, () => {
      const src = readFileSync(resolve(ROOT, file), 'utf-8');
      assert.match(
        src,
        pattern,
        `${file} must gate on MIN_CORROBORATING_PUBLISHERS, not a bare literal — ` +
          'a hardcoded threshold here drifts from the others the moment one is tuned',
      );
    });
  }

  it('exposes the threshold as a usable number', () => {
    assert.equal(typeof MIN_CORROBORATING_PUBLISHERS, 'number');
    assert.ok(
      Number.isInteger(MIN_CORROBORATING_PUBLISHERS) && MIN_CORROBORATING_PUBLISHERS >= 2,
      'below 2 no gate would require corroboration at all',
    );
  });
});

describe('publisher-families resolution', () => {
  it('collapses one wire carried under many of its own labels', () => {
    const reutersLabels = [
      'Reuters',
      'Reuters World',
      'Reuters US',
      'Reuters Business',
      'Reuters Asia',
      'Reuters Energy',
      'Reuters Commodities',
      'Reuters India',
    ];
    assert.equal(countPublisherFamilies(reutersLabels), 1);
    assert.equal(publisherNameForFamily(publisherFamilyFor('Reuters US')), 'Reuters');
  });

  it('counts genuinely distinct publishers separately', () => {
    assert.equal(countPublisherFamilies(['Reuters World', 'BBC World', 'Al Jazeera']), 3);
  });

  it('fails closed: an unmapped label is its own family, never merged', () => {
    const family = publisherFamilyFor('Some Brand New Feed');
    assert.equal(family, 'label:some brand new feed');
    assert.equal(countPublisherFamilies(['Some Brand New Feed', 'Another New Feed']), 2);
    assert.equal(publisherNameForFamily(family), 'some brand new feed');
  });

  it('does not let one unmapped feed become two publishers through casing drift', () => {
    // The client and server feed configs are hand-maintained separately; a
    // label that differs only in case between them would otherwise resolve to
    // two singleton families and clear the two-publisher gate by itself.
    assert.equal(publisherFamilyFor('Brand New Feed'), publisherFamilyFor('brand new feed'));
    assert.equal(countPublisherFamilies(['Brand New Feed', 'brand new feed']), 1);
  });

  it('absorbs casing and whitespace drift between the feed configs', () => {
    assert.equal(publisherFamilyFor('  reuters world  '), publisherFamilyFor('Reuters World'));
  });

  it('drops blank and non-string labels instead of counting them', () => {
    assert.equal(publisherFamilyFor('   '), '');
    assert.equal(publisherFamilyFor(null), '');
    assert.equal(countPublisherFamilies(['Reuters World', '', null, undefined, 42]), 1);
    assert.equal(countPublisherFamilies('Reuters World'), 0);
    assert.deepEqual([...publisherFamiliesFor(undefined)], []);
  });
});
