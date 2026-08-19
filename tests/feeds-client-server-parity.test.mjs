/**
 * Feed parity test — client vs server (PR #3715 review follow-up).
 *
 * The client feed config (`src/config/feeds.ts`) and the server-side digest
 * feed config (`server/worldmonitor/news/v1/_feeds.ts`) are independent files
 * that frequently share feed NAMES. When a publisher dies and we fall back
 * to Google News on one side but forget to mirror the change on the other,
 * the digest path keeps fetching the dead URL while the direct-RSS path is
 * healthy (or vice versa) — exactly the Blockworks drift caught on #3715.
 *
 * This test fails when a feed NAME appears on both sides with INCONSISTENT
 * routing — i.e. client uses Google News while server uses a direct upstream
 * URL (or vice versa). It does NOT require URL byte-equality (server uses a
 * `gn()` helper with slightly different topic terms in places), only that
 * both sides agree on the "Google News fallback or direct fetch" question.
 *
 * KNOWN_DRIFTS grandfathers in feeds that already drift at the time this
 * test landed. Each is its own per-feed judgment (some intentionally use
 * Google News on one side because the direct URL recently broke). New drift
 * fails the test. The set should SHRINK over time as feeds get reconciled,
 * not grow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CLIENT_PATH = resolve(ROOT, 'src/config/feeds.ts');
const SERVER_PATH = resolve(ROOT, 'server/worldmonitor/news/v1/_feeds.ts');

/**
 * Extract feed name + a routing hint from a source file.
 *
 * Handles both shapes:
 *
 *     // inline
 *     { name: 'X', url: rss('https://...') },
 *     { name: 'Y', url: gn('site:y.com when:1d') },
 *
 *     // multiline with locale-keyed URL object (locale variants all use
 *     // direct rss/gn helpers, never mixed)
 *     {
 *       name: 'Z',
 *       url: {
 *         en: rss('...'),
 *         fr: rss('...'),
 *       },
 *     }
 *
 * The earlier single-line-only regex missed ~46 multiline entries on the
 * client side, which caused the orphan check below to falsely flag entries
 * that ARE on both sides (France 24, EuroNews, etc.) as server-only.
 *
 * Returns a Map<name, { isGoogleNews: boolean, snippet: string }>.
 */
function extractFeedRouting(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const out = new Map();
  const NAME_RE = /\bname:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = NAME_RE.exec(src)) !== null) {
    const [, name] = m;
    // Scan forward from this `name:` to find the matching `url:` — within
    // the next ~600 chars (enough to span a multiline locale-object url
    // without crossing into the sibling entry's name).
    const window = src.slice(m.index, m.index + 600);
    const urlMatch = window.match(/\burl:\s*([\s\S]*?)(?:,\s*$|}\s*[,\]])/m);
    if (!urlMatch) continue;
    const urlExpr = urlMatch[1];
    // Match the bare `gn(...)` helper AND any sibling like `gnLocale(...)` —
    // both emit `news.google.com/rss/search?...` URLs that the cache /
    // user-experience pipeline should treat identically. Don't widen this to
    // unrelated `gn*` identifiers; restrict to known prefixes that wrap GN.
    const isGN =
      /news\.google\.com\/rss\/search/i.test(urlExpr) ||
      /\bgn(?:Locale)?\s*\(/.test(urlExpr);
    // First-seen wins — names can repeat across categories (localized
    // variants etc.); the first definition is the canonical routing.
    if (!out.has(name)) {
      out.set(name, { isGoogleNews: isGN, snippet: urlExpr.trim().slice(0, 120) });
    }
  }
  return out;
}

/**
 * Extract feed names by their containing category array.
 *
 * A global name match is insufficient here: the digest truncates and the
 * client filters within each category, so a same-name client feed in another
 * category cannot make a server item visible. The client intentionally uses
 * CANONICAL_FEEDS, the cross-variant union for a category, when a user enables
 * a custom panel; this extractor mirrors that behavior by unioning catalogs
 * by category. Use the TypeScript AST so multiline entries remain visible.
 *
 * Returns a Map<category, Set<name>>.
 */
function extractFeedNamesByCategory(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const ast = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map();

  const propertyName = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    return null;
  };

  const collectNames = (category, elements) => {
    for (const element of elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const nameProperty = element.properties.find(
        property =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === 'name' &&
          ts.isStringLiteral(property.initializer),
      );
      if (!nameProperty || !ts.isPropertyAssignment(nameProperty) || !ts.isStringLiteral(nameProperty.initializer)) {
        continue;
      }
      const names = out.get(category) ?? new Set();
      names.add(nameProperty.initializer.text);
      out.set(category, names);
    }
  };

  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(node.initializer)) {
      const category = propertyName(node.name);
      if (category) collectNames(category, node.initializer.elements);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'INTEL_SOURCES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      collectNames('intel', node.initializer.elements);
    }
    ts.forEachChild(node, visit);
  };

  visit(ast);
  return out;
}

describe('feed parity: client vs server (PR #3715 follow-up)', () => {
  const client = extractFeedRouting(CLIENT_PATH);
  const server = extractFeedRouting(SERVER_PATH);

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
    'White House',
    'Pentagon',
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
    // The exact failure mode that prompted this test — server still pointed
    // at https://blockworks.co/feed after client moved to Google News, so the
    // digest path kept hitting Cloudflare-blocked upstream. Both sides have
    // since removed Blockworks (The Block covers the same territory). Lock
    // it in: a future contributor must not re-add the dead URL.
    for (const [path, label] of [[CLIENT_PATH, 'client'], [SERVER_PATH, 'server']]) {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !/['"]https?:\/\/blockworks\.co\/feed['"]/.test(src),
        `${label} (${path}) still references the dead blockworks.co/feed URL`,
      );
    }
  });

  // Server-only feeds get aggregated, ranked, and TRUNCATED to
  // MAX_ITEMS_PER_CATEGORY in list-feed-digest.ts, THEN data-loader.ts filters
  // them by `enabledNames` from src/config/feeds.ts.
  // If the server emits a feed whose name has no client-side counterpart, the
  // server fetches it for nothing AND its items crowd out visible items in the
  // same category, shrinking the visible result set. Exactly the
  // Commodity-Trade-Mantra failure mode the #3717 reviewer caught.
  //
  it('every server feed has a client home in the same category before MAX_ITEMS_PER_CATEGORY truncation', () => {
    const clientByCategory = extractFeedNamesByCategory(CLIENT_PATH);
    const serverByCategory = extractFeedNamesByCategory(SERVER_PATH);
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
    // The #3717 reviewer caught this: I removed CTM from the client in #3715
    // but left it on the server, so the server fetched it, counted it toward
    // MAX_ITEMS_PER_CATEGORY, then the client filter dropped it — invisible
    // crowd-out. Lock it in.
    const src = readFileSync(SERVER_PATH, 'utf-8');
    assert.ok(
      !/name:\s*['"]Commodity Trade Mantra['"]/.test(src),
      `${SERVER_PATH} still has a 'Commodity Trade Mantra' entry — it has no client counterpart so its items get truncated-then-dropped`,
    );
  });
});
