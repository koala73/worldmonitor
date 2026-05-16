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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CLIENT_PATH = resolve(ROOT, 'src/config/feeds.ts');
const SERVER_PATH = resolve(ROOT, 'server/worldmonitor/news/v1/_feeds.ts');

/**
 * Extract feed name + a routing hint from a source file.
 * Matches `{ name: '<n>', ... url: <expr> }` entries. The `<expr>` can be
 * either a URL literal (`'https://news.google.com/...'`) or a helper call
 * (`gn('site:foo.com when:1d')` / `rss('https://...')`).
 *
 * Returns a Map<name, { isGoogleNews: boolean, snippet: string }>.
 * `snippet` is the matched URL expression for error messages.
 */
function extractFeedRouting(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  // Match `name: '<name>'` then up to a single-line entry's URL expression.
  const ENTRY_RE = /\bname:\s*['"]([^'"]+)['"][^\n]*?\burl:\s*([^,}\n][^,}\n]*[^,}\n\s])/g;
  const out = new Map();
  let m;
  while ((m = ENTRY_RE.exec(src)) !== null) {
    const [, name, urlExpr] = m;
    const isGN =
      /news\.google\.com\/rss\/search/i.test(urlExpr) || /\bgn\s*\(/.test(urlExpr);
    // Don't let later duplicates clobber earlier ones — names can repeat
    // across categories (localized variants etc.); first-seen wins.
    if (!out.has(name)) out.set(name, { isGoogleNews: isGN, snippet: urlExpr.trim() });
  }
  return out;
}

describe('feed parity: client vs server (PR #3715 follow-up)', () => {
  const client = extractFeedRouting(CLIENT_PATH);
  const server = extractFeedRouting(SERVER_PATH);

  it('extracted feeds from both files', () => {
    assert.ok(client.size > 50, `expected >50 client feeds, got ${client.size}`);
    assert.ok(server.size > 50, `expected >50 server feeds, got ${server.size}`);
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
    'Sequoia Blog',
    'EU Startups',
    'Tech in Asia',
    'SemiAnalysis',
    'EIA Reports',
    'Northern Miner',
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
});
