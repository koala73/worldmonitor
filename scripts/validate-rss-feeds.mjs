#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEEDS_PATH = join(__dirname, '..', 'src', 'config', 'feeds.ts');
// #4920: the SERVER digest catalog is a separate universe from the client
// config — buildDigest ingests from _feeds.ts, so completeness must be
// measured against it too, not just the client list.
const SERVER_FEEDS_PATH = join(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', '_feeds.ts');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 15_000;
const CONCURRENCY = 10;
const STALE_DAYS = 30;

// Sentinel error-message prefixes for the SSRF/config guardrails. Centralised so
// the throwing sites (assertCiAllowed, fetchFeed) and the isConfigDrift
// classifier can never drift apart — rename a reason, BOTH consumers update in
// lockstep. Without this, an innocuous reword (e.g. dropping `(--ci)`) would
// silently reclassify hard failures as soft warnings.
const CONFIG_DRIFT_REASONS = Object.freeze({
  INVALID_URL: 'Invalid URL',
  NON_HTTPS: 'Non-https scheme rejected in --ci mode:',
  HOST_NOT_ALLOWED: 'Host not in allowlist (--ci):',
  TOO_MANY_REDIRECTS: 'Too many redirects',
});

// --ci flag hardens the validator for trusted-context CI runs (push-to-main
// + schedule workflow). NOT enabled in PR CI — PR CI never runs this script
// because PR contributors can rewrite feeds.ts to make GitHub runners hit
// arbitrary URLs (SSRF surface). In CI mode:
//   1. Reject non-https schemes (no plaintext, no file:// etc.)
//   2. Reject hosts that don't pass api/_rss-allowed-domain-match.js
//      isAllowedDomain (same www-normalized check the Edge proxy enforces)
//   3. Refuse to follow cross-host redirects (manual redirect handling per
//      hop with allowlist re-check)
const CI_MODE = process.argv.includes('--ci');

function extractFeeds() {
  const src = readFileSync(FEEDS_PATH, 'utf8');
  const feeds = [];
  const seen = new Set();

  // Match rss('url') or railwayRss('url') — capture raw URL
  const rssUrlRe = /(?:rss|railwayRss)\(\s*'([^']+)'\s*\)/g;
  // Match name: 'X' or name: "X" — handles escaped apostrophes (L\'Orient-Le Jour)
  const nameRe = /name:\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]+)")/;
  // Match lang key like `en: rss(`, `fr: rss(` — find all on a line with positions
  const langKeyAllRe = /(?:^|[\s{,])([a-z]{2}):\s*(?:rss|railwayRss)\(/g;

  const lines = src.split('\n');
  let currentName = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const nameMatch = line.match(nameRe);
    if (nameMatch) currentName = nameMatch[1] || nameMatch[2];

    // Build position→lang map for this line
    const langMap = [];
    let lm;
    langKeyAllRe.lastIndex = 0;
    while ((lm = langKeyAllRe.exec(line)) !== null) {
      langMap.push({ pos: lm.index, lang: lm[1] });
    }

    let m;
    rssUrlRe.lastIndex = 0;
    while ((m = rssUrlRe.exec(line)) !== null) {
      const rawUrl = m[1];
      const rssPos = m.index;

      // Find the closest preceding lang key for this rss() call
      let lang = null;
      for (let k = langMap.length - 1; k >= 0; k--) {
        if (langMap[k].pos < rssPos) { lang = langMap[k].lang; break; }
      }

      const label = lang ? `${currentName} [${lang}]` : currentName;
      const key = `${label}|${rawUrl}`;

      if (!seen.has(key)) {
        seen.add(key);
        feeds.push({ name: label || 'Unknown', url: rawUrl });
      }
    }
  }

  // Also pick up non-rss() URLs like '/api/fwdstart'
  const directUrlRe = /name:\s*'([^']+)'[^}]*url:\s*'(\/[^']+)'/g;
  let dm;
  while ((dm = directUrlRe.exec(src)) !== null) {
    const key = `${dm[1]}|${dm[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      feeds.push({ name: dm[1], url: dm[2], isLocal: true });
    }
  }

  return feeds;
}

/**
 * #4920: text-extract the SERVER digest catalog (_feeds.ts). Entries are
 * `{ name: '…', url: '…' | gn('…') | gnLocale('…', hl, gl, ceid) }` — the
 * gn()/gnLocale() helpers are replicated here so extracted URLs match what
 * the digest fetches at runtime. Same no-import text-extraction pattern as
 * extractFeeds() above (this script must not execute app code).
 */
export function extractServerFeeds() {
  let src;
  try {
    src = readFileSync(SERVER_FEEDS_PATH, 'utf8');
  } catch {
    return [];
  }
  const gn = (q) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const gnLocale = (q, hl, gl, ceid) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;

  const feeds = [];
  const seen = new Set();
  // Names may be single- OR double-quoted ("Tom's Hardware").
  const entryRe = /name:\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]+)")\s*,\s*url:\s*(?:'([^']+)'|gn\(\s*'((?:[^'\\]|\\.)*)'\s*\)|gnLocale\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\))/g;
  let m;
  while ((m = entryRe.exec(src)) !== null) {
    const name = (m[1] ?? m[2]).replace(/\\'/g, "'");
    let url;
    if (m[3]) url = m[3];
    else if (m[4] !== undefined) url = gn(m[4].replace(/\\'/g, "'"));
    else url = gnLocale(m[5].replace(/\\'/g, "'"), m[6], m[7], m[8]);
    if (!seen.has(url)) {
      seen.add(url);
      feeds.push({ name, url, catalog: 'server' });
    }
  }
  return feeds;
}

function assertCiAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(CONFIG_DRIFT_REASONS.INVALID_URL);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${CONFIG_DRIFT_REASONS.NON_HTTPS} ${parsed.protocol}`);
  }
  if (!isAllowedDomain(parsed.hostname)) {
    throw new Error(`${CONFIG_DRIFT_REASONS.HOST_NOT_ALLOWED} ${parsed.hostname}`);
  }
  return parsed;
}

async function fetchFeed(url) {
  if (CI_MODE) {
    // Manual per-hop redirect handling: every hop must satisfy the same
    // https + allowlist gates. Mirrors api/rss-proxy.js redirect re-check.
    // Per-hop timer (NOT a shared budget across hops) — each hop gets the
    // full FETCH_TIMEOUT so "Timeout (15s)" in the report means a real
    // 15s on a single network call, not 17s+ aggregated across a chain.
    let currentUrl = assertCiAllowed(url).href;
    const MAX_REDIRECTS = 3;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      let resp;
      try {
        resp = await fetch(currentUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timer);
      }
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) throw new Error(`HTTP ${resp.status} without Location header`);
        if (redirectCount === MAX_REDIRECTS) throw new Error(CONFIG_DRIFT_REASONS.TOO_MANY_REDIRECTS);
        const nextUrl = new URL(loc, currentUrl);
        assertCiAllowed(nextUrl.href);
        currentUrl = nextUrl.href;
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Body stream still under the per-hop timer is the right shape, but
      // text() can complete after clearTimeout — the controller is no
      // longer wired to abort it. That's intentional: timing the response-
      // body read separately is out of scope for an SSRF-guarded validator;
      // the headers handshake is what we wanted bounded per hop.
      return await resp.text();
    }
    throw new Error(CONFIG_DRIFT_REASONS.TOO_MANY_REDIRECTS);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseNewestDate(xml) {
  // processEntities:false — we only read date strings, never decode entity-bearing content.
  // fast-xml-parser v5's default entity-expansion threshold trips on legit large feeds
  // (Guardian, Fox, Axios, CISA, WHO, MIT, …) and produces false-positive DEAD rows.
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
  const doc = parser.parse(xml);

  const dates = [];

  // RSS 2.0
  const channel = doc?.rss?.channel;
  if (channel) {
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    for (const item of items) {
      if (item.pubDate) dates.push(new Date(item.pubDate));
    }
  }

  // Atom
  const atomFeed = doc?.feed;
  if (atomFeed) {
    const entries = Array.isArray(atomFeed.entry) ? atomFeed.entry : atomFeed.entry ? [atomFeed.entry] : [];
    for (const entry of entries) {
      const d = entry.updated || entry.published;
      if (d) dates.push(new Date(d));
    }
  }

  // RDF (RSS 1.0)
  const rdf = doc?.['rdf:RDF'];
  if (rdf) {
    const items = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
    for (const item of items) {
      const d = item['dc:date'] || item.pubDate;
      if (d) dates.push(new Date(d));
    }
  }

  const valid = dates.filter(d => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map(d => d.getTime())));
}

async function validateFeed(feed) {
  if (feed.isLocal) {
    return { ...feed, status: 'SKIP', detail: 'Local API endpoint' };
  }

  try {
    const xml = await fetchFeed(feed.url);
    const newest = parseNewestDate(xml);

    if (!newest) {
      return { ...feed, status: 'EMPTY', detail: 'No parseable dates' };
    }

    const age = Date.now() - newest.getTime();
    const staleCutoff = STALE_DAYS * 24 * 60 * 60 * 1000;

    if (age > staleCutoff) {
      return { ...feed, status: 'STALE', detail: newest.toISOString().slice(0, 10), newest };
    }

    return { ...feed, status: 'OK', newest };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout (15s)' : err.message;
    return { ...feed, status: 'DEAD', detail: msg };
  }
}

async function runBatch(items, fn, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function pad(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str.padEnd(len);
}

async function main() {
  const clientFeeds = extractFeeds().map((f) => ({ ...f, catalog: 'client' }));
  const serverFeeds = extractServerFeeds();
  // Merge on URL: a feed present in both catalogs is validated once and
  // labeled 'both'. The server catalog is what the digest ingests — its
  // health is the completeness signal (#4920).
  const byUrl = new Map();
  for (const feed of clientFeeds) byUrl.set(feed.url, feed);
  for (const feed of serverFeeds) {
    const existing = byUrl.get(feed.url);
    if (existing) existing.catalog = 'both';
    else byUrl.set(feed.url, feed);
  }
  const feeds = [...byUrl.values()];
  const mode = CI_MODE ? 'CI (https-only + allowlist + per-hop redirect re-check)' : 'standard';
  console.log(`Validating ${feeds.length} RSS feeds (${clientFeeds.length} client, ${serverFeeds.length} server) [${mode}] (${CONCURRENCY} concurrent, ${FETCH_TIMEOUT / 1000}s timeout)...\n`);

  const results = await runBatch(feeds, validateFeed, CONCURRENCY);

  const ok = results.filter(r => r.status === 'OK');
  const stale = results.filter(r => r.status === 'STALE');
  const dead = results.filter(r => r.status === 'DEAD');
  const empty = results.filter(r => r.status === 'EMPTY');
  const skipped = results.filter(r => r.status === 'SKIP');

  if (stale.length) {
    stale.sort((a, b) => a.newest - b.newest);
    console.log(`STALE (newest item > ${STALE_DAYS} days):`);
    console.log(`  ${pad('Feed Name', 35)} | ${pad('Newest Item', 12)} | URL`);
    console.log(`  ${'-'.repeat(35)} | ${'-'.repeat(12)} | ---`);
    for (const r of stale) {
      console.log(`  ${pad(r.name, 35)} | ${pad(r.detail, 12)} | ${r.url}`);
    }
    console.log();
  }

  if (dead.length) {
    console.log('DEAD (fetch/parse failed):');
    console.log(`  ${pad('Feed Name', 35)} | ${pad('Error', 20)} | URL`);
    console.log(`  ${'-'.repeat(35)} | ${'-'.repeat(20)} | ---`);
    for (const r of dead) {
      console.log(`  ${pad(r.name, 35)} | ${pad(r.detail, 20)} | ${r.url}`);
    }
    console.log();
  }

  if (empty.length) {
    console.log('EMPTY (no items/dates found):');
    console.log(`  ${pad('Feed Name', 35)} | URL`);
    console.log(`  ${'-'.repeat(35)} | ---`);
    for (const r of empty) {
      console.log(`  ${pad(r.name, 35)} | ${r.url}`);
    }
    console.log();
  }

  console.log(`Summary: ${ok.length} OK, ${stale.length} stale, ${dead.length} dead, ${empty.length} empty` +
    (skipped.length ? `, ${skipped.length} skipped` : ''));

  // Exit policy:
  //   HARD-FAIL on config/SSRF-guard drift — these are bugs the maintainer can fix.
  //     Reasons enumerated in CONFIG_DRIFT_REASONS (top of file). Both the throwing
  //     sites and this classifier consume the same constants so a future reword
  //     can't silently demote a hard fail to a warning.
  //   SOFT-FAIL (exit 0 with warning) on third-party state — third-party 4xx/timeouts,
  //     STALE feeds, EMPTY feeds. These rot naturally; failing the build on them
  //     produces 100% CI noise and the prior workflow proved no one acts on it.
  //   Promoting third-party failures to hard-fail requires a registry-cleanup PR
  //   first; revisit once the long tail is groomed.
  const isConfigDrift = (r) =>
    typeof r.detail === 'string' &&
    Object.values(CONFIG_DRIFT_REASONS).some(prefix => r.detail.startsWith(prefix));
  const configDrift = dead.filter(isConfigDrift);
  const thirdPartyDead = dead.filter(r => !isConfigDrift(r));

  if (configDrift.length) {
    console.error(
      `\nFAIL: ${configDrift.length} feed(s) violate the CI guardrails ` +
      `(allowlist drift or plaintext URL). Fix src/config/feeds.ts and/or the 5 ` +
      `allowlist mirrors (shared/rss-allowed-domains.json, .cjs, ` +
      `scripts/shared/rss-allowed-domains.json, ` +
      `api/_rss-allowed-domains.js, vite.config.ts:RSS_PROXY_ALLOWED_DOMAINS).`
    );
    process.exit(1);
  }

  // #4920: publish per-feed health + silent-zero streaks to Redis when
  // credentials are present (the daily GitHub Actions run passes them as
  // secrets; local/PR runs without creds skip silently). Best-effort: a
  // Redis outage must not fail feed validation. Deliberately AFTER the
  // config-drift hard-fail (#4927 review P3): a guardrail-failing run must
  // not refresh health metadata first and mask the failure as fresh/OK.
  await publishFeedHealth(results).catch((err) =>
    console.warn(`WARN: feed-health publish failed: ${err.message}`),
  );

  if (stale.length || thirdPartyDead.length || empty.length) {
    console.warn(
      `\nWARN: ${thirdPartyDead.length} third-party dead, ${stale.length} stale, ` +
      `${empty.length} empty. Third-party state — not a build failure. ` +
      `Groom src/config/feeds.ts when the count crosses a threshold worth a PR.`
    );
  }
}

export async function publishFeedHealth(results) {
  const { getOptionalUpstashCreds, upstashCommand } = await import('./_upstash-rest.mjs');
  const creds = getOptionalUpstashCreds();
  if (!creds) {
    console.log('feed-health publish skipped (no UPSTASH_REDIS_REST_URL/TOKEN in env)');
    return { published: false, reason: 'no-creds' };
  }
  const { buildFeedHealthPayload } = await import('./_feed-health.mjs');
  const redis = (command) => upstashCommand(creds, command);

  // Streak continuity (#4927 external review): distinguish "key absent"
  // (first run — fresh streaks are correct) from "read FAILED" (transient
  // Redis/network error — publishing would silently reset every
  // consecutive-empty streak and hide silent-zero continuity). On a
  // failed read, skip this run's publish entirely; tomorrow's run
  // continues the streaks.
  let previous = null;
  try {
    const got = await redis(['GET', 'news:feed-health:v1']);
    if (typeof got?.result === 'string') previous = JSON.parse(got.result);
  } catch (err) {
    console.warn(`feed-health publish skipped: previous-state read failed (${err.message}) — preserving streaks`);
    return { published: false, reason: 'previous-read-failed' };
  }

  const payload = buildFeedHealthPayload(results, previous, Date.now());
  await redis(['SET', 'news:feed-health:v1', JSON.stringify(payload), 'EX', String(3 * 86400)]);
  await redis(['SET', 'seed-meta:news:feed-health', JSON.stringify({
    fetchedAt: payload.checkedAt,
    recordCount: payload.summary.ok,
    sourceVersion: 'feed-health-v1',
  }), 'EX', String(7 * 86400)]);
  // Durable activation marker — NO TTL by design (#4927 re-review P1):
  // health endpoints soften missing data only while this key is absent;
  // once we have ever published, a dead publisher must alarm as stale,
  // not revert to pending-activation when the 7d meta expires.
  await redis(['SET', 'seed-activated:news:feed-health', '1']);

  if (payload.silentZeros.length) {
    console.warn(`\nSILENT ZEROS (${payload.silentZeros.length} Google News wrappers delivering nothing across runs):`);
    for (const feed of payload.silentZeros) {
      console.warn(`  ${feed.name} — ${feed.consecutiveEmpty} consecutive empty runs — ${feed.url}`);
    }
  }
  console.log(`feed-health published: ${payload.summary.ok}/${payload.feedCount} OK, ${payload.silentZeros.length} silent zeros`);
  return { published: true, payload };
}

// Importable for tests (#4920): only run when executed directly.
// pathToFileURL handles Windows drive letters and percent-encoding that a
// hand-built file:// string gets wrong.
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(2);
  });
}
