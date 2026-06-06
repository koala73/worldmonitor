// Reddit OAuth fetch — source-structure regression tests.
//
// ais-relay.cjs calls server.listen() at top level (no require.main guard) and
// has no module.exports, so it cannot be imported for unit execution. Like
// tests/social-velocity-seed-health.test.mjs, these assert against the source
// text: that both Reddit consumers route through the shared OAuth-aware helper,
// the userless client_credentials flow is correct, and the public endpoint
// remains a graceful fallback when credentials are absent.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const relaySource = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');

function fnBody(name, approxLen = 1200) {
  const start = relaySource.indexOf(name);
  assert.notEqual(start, -1, `missing function: ${name}`);
  return relaySource.slice(start, start + approxLen);
}

test('reddit oauth is gated on BOTH client id and secret (absent → fallback, no regression)', () => {
  assert.match(relaySource, /const REDDIT_CLIENT_ID = process\.env\.REDDIT_CLIENT_ID \|\| ''/);
  assert.match(relaySource, /const REDDIT_CLIENT_SECRET = process\.env\.REDDIT_CLIENT_SECRET \|\| ''/);
  assert.match(relaySource, /const REDDIT_OAUTH_ENABLED = !!\(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET\)/);
});

test('token uses userless client_credentials grant with HTTP Basic auth on www.reddit.com', () => {
  const body = fnBody('async function _fetchRedditToken()');
  assert.match(body, /https:\/\/www\.reddit\.com\/api\/v1\/access_token/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /Authorization: `Basic \$\{basic\}`/);
  assert.match(body, /body: 'grant_type=client_credentials'/);
  // Reddit requires a descriptive, attributable User-Agent.
  assert.match(relaySource, /const REDDIT_USER_AGENT = process\.env\.REDDIT_USER_AGENT/);
});

test('token is cached single-flight with early refresh and a post-failure cooldown', () => {
  const body = fnBody('async function getRedditToken()', 900);
  assert.match(body, /if \(_redditToken && now < _redditTokenExpiry\) return _redditToken/);
  assert.match(body, /if \(now < _redditAuthCooldownUntil\) return null/);
  assert.match(body, /if \(_redditTokenPromise\) return _redditTokenPromise/);
  assert.match(body, /_redditTokenExpiry = Date\.now\(\) \+ Math\.max\(60, expiresIn - 60\) \* 1000/);
  assert.match(body, /_redditAuthCooldownUntil = Date\.now\(\) \+ REDDIT_AUTH_COOLDOWN_MS/);
});

test('shared helper prefers oauth.reddit.com and falls back to the public endpoint', () => {
  const body = fnBody('async function fetchRedditHotListing(subreddit', 2600);
  assert.match(body, /if \(REDDIT_OAUTH_ENABLED\) \{/);
  assert.match(body, /https:\/\/oauth\.reddit\.com\/r\/\$\{subreddit\}\/hot\?limit=\$\{limit\}/);
  assert.match(body, /https:\/\/www\.reddit\.com\/r\/\$\{subreddit\}\/hot\.json\?limit=\$\{limit\}/);
  // never throws on HTTP status — returns a typed result (with source) the callers branch on
  assert.match(body, /if \(!resp\.ok\) return \{ ok: false, status: resp\.status, posts: \[\], source \}/);
});

test('ScrapeCreators is gated on the api key and is the preferred path', () => {
  assert.match(relaySource, /const SCRAPECREATORS_API_KEY = process\.env\.SCRAPECREATORS_API_KEY \|\| ''/);
  assert.match(relaySource, /const SCRAPECREATORS_ENABLED = !!SCRAPECREATORS_API_KEY/);
  const body = fnBody('async function fetchRedditHotListing(subreddit', 2600);
  // vendor branch: subreddit posts endpoint, sort=hot, x-api-key header, returns data.posts
  assert.match(body, /if \(SCRAPECREATORS_ENABLED\) \{/);
  assert.match(body, /https:\/\/api\.scrapecreators\.com\/v1\/reddit\/subreddit\?subreddit=\$\{encodeURIComponent\(subreddit\)\}&sort=hot/);
  assert.match(body, /'x-api-key': SCRAPECREATORS_API_KEY/);
  // array-guarded, capped to limit, and normalized to match the OAuth/public shape
  assert.match(body, /\(Array\.isArray\(data\?\.posts\) \? data\.posts : \[\]\)\.filter\(Boolean\)\.slice\(0, limit\)\.map\(_normalizeVendorPost\)/);
  // error contract preserved, tagged with its source
  assert.match(body, /if \(!resp\.ok\) return \{ ok: false, status: resp\.status, posts: \[\], source: 'scrapecreators' \}/);
});

test('path precedence is ScrapeCreators -> OAuth -> public (ordered in source)', () => {
  const body = fnBody('async function fetchRedditHotListing(subreddit', 2600);
  const sc = body.indexOf('if (SCRAPECREATORS_ENABLED)');
  const oauth = body.indexOf('if (REDDIT_OAUTH_ENABLED)');
  const pub = body.indexOf('www.reddit.com/r/${subreddit}/hot.json');
  assert.ok(sc !== -1 && oauth !== -1 && pub !== -1, 'all three branches present');
  assert.ok(sc < oauth && oauth < pub, `expected ScrapeCreators < OAuth < public, got ${sc}/${oauth}/${pub}`);
});

test('cadence is 3h and data-key TTL is co-pinned to 9h (>= health maxStaleMin)', () => {
  assert.match(relaySource, /const SOCIAL_VELOCITY_INTERVAL_MS = 3 \* 60 \* 60 \* 1000/);
  assert.match(relaySource, /const WSB_TICKERS_INTERVAL_MS = 3 \* 60 \* 60 \* 1000/);
  assert.match(relaySource, /const SOCIAL_VELOCITY_TTL = 32400/);
  assert.match(relaySource, /const WSB_TICKERS_TTL = 32400/);
});

test('both reddit consumers route through fetchRedditHotListing and label failures with the real source', () => {
  const social = fnBody('async function fetchRedditHot(subreddit, failures', 600);
  assert.match(social, /const \{ ok, status, posts, source \} = await fetchRedditHotListing\(subreddit, \{/);
  // failure label names the path that actually ran (not a hardcoded "(oauth)")
  assert.match(social, /r\/\$\{subreddit\} HTTP \$\{status\} \(\$\{source\}\)/);
  const wsb = fnBody('async function fetchWsbRedditHot(subreddit)', 400);
  assert.match(wsb, /const \{ ok, status, posts, source \} = await fetchRedditHotListing\(subreddit, \{ limit: 50/);
  assert.match(wsb, /HTTP \$\{status\} \(\$\{source\}\)/);
  // The old unauthenticated direct fetches inside these two fetchers are gone.
  assert.doesNotMatch(social, /www\.reddit\.com\/r\/\$\{subreddit\}\/hot\.json/);
  assert.doesNotMatch(wsb, /www\.reddit\.com\/r\/\$\{subreddit\}\/hot\.json/);
});

test('helper tags each path with a source for accurate SEED_ERROR reasons', () => {
  const body = fnBody('async function fetchRedditHotListing(subreddit', 2600);
  assert.match(body, /source: 'scrapecreators'/);
  assert.match(body, /source = 'oauth'/);
  assert.match(body, /source = 'public'/);
});

test('ScrapeCreators posts are normalized to the OAuth/public shape (seconds + unescaped)', () => {
  // created_utc coerced to epoch seconds (ms → s at the 1e12 threshold)
  assert.match(relaySource, /function _redditEpochSeconds\(v\)/);
  assert.match(relaySource, /v > 1e12 \? Math\.floor\(v \/ 1000\) : v/);
  // HTML entities decoded (raw_json=1 equivalent for the vendor path)
  assert.match(relaySource, /function _decodeRedditEntities\(s\)/);
  assert.match(relaySource, /\.replace\(\/&amp;\/g, '&'\)/);
  // normalizer maps the timestamp + text fields, passes the rest through
  assert.match(relaySource, /function _normalizeVendorPost\(p\)/);
  assert.match(relaySource, /created_utc: _redditEpochSeconds\(p\.created_utc\)/);
  assert.match(relaySource, /title: _decodeRedditEntities\(p\.title\)/);
});
