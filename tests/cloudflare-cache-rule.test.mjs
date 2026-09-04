// The Cloudflare cache rule that lets the crawlable corpus be served from the
// edge (#7659).
//
// Background, because the header alone reads like it should be enough: every
// corpus route already answers with `CDN-Cache-Control: public, s-maxage=600,
// stale-while-revalidate=60` (asserted in tests/deploy-config.test.mjs), and
// production still returned `cf-cache-status: DYNAMIC` on 14/14 sampled routes.
// The reason is a zone-level cache rule named "Bypass cache - WWW documents"
// that sets `cache: false` for every extensionless/HTML path on
// www.worldmonitor.app. Origin headers never get a vote once a cache rule has
// declared the response ineligible, so no vercel.json change can fix it — only a
// later rule in the same phase, which is what scripts/cloudflare-cache-rule.mjs
// generates.
//
// These assertions are about the rule's SHAPE, not about the live zone. The
// live comparison is `node scripts/cloudflare-cache-rule.mjs --check`, which
// needs a Cloudflare token and therefore cannot run in the unit gate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTENT_CORPUS_PREFIXES } from '../scripts/discover-content-corpus-pages.mjs';
import {
  CORPUS_CACHE_RULE_DESCRIPTION,
  CORPUS_HOST,
  buildCorpusCacheRule,
  diffLiveRuleset,
  sanitizeRuleForPut,
  upsertCorpusCacheRule,
} from '../scripts/cloudflare-cache-rule.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));

const HTML_ENTRY_EDGE_CACHE = 'public, s-maxage=600, stale-while-revalidate=60';

/**
 * The document routes the pre-existing "WWW entry HTML" rule already caches.
 * They are app shells rather than corpus pages, so the corpus rule deliberately
 * does not claim them.
 */
const ENTRY_DOCUMENT_SOURCES = new Set(['/', '/dashboard', '/dashboard.html']);

/** `/(a|b|c)` and `/(a|b|c)/(.*)` -> ['a', 'b', 'c']. */
function familiesFromVercelSource(source) {
  const match = source.match(/^\/\(([^)]+)\)(?:\/\(\.\*\))?$/);
  if (!match) return [];
  return match[1].split('|');
}

/** Every vercel.json header rule that advertises a shared-cacheable HTML family. */
function vercelPublicCorpusFamilies() {
  const families = new Set();
  for (const entry of vercelConfig.headers ?? []) {
    const cdn = entry.headers.find((header) => header.key === 'CDN-Cache-Control');
    if (cdn?.value !== HTML_ENTRY_EDGE_CACHE) continue;
    if (ENTRY_DOCUMENT_SOURCES.has(entry.source)) continue;
    for (const family of familiesFromVercelSource(entry.source)) families.add(family);
  }
  return families;
}

describe('cloudflare corpus cache rule', () => {
  const rule = buildCorpusCacheRule();

  it('claims every corpus family, in both the bare and the nested form', () => {
    for (const prefix of CONTENT_CORPUS_PREFIXES) {
      assert.match(
        rule.expression,
        new RegExp(`"/${prefix}"`),
        `/${prefix} must be matched; Vercel 308s it to the trailing-slash form and a 3xx is not cached anyway,`
          + ' but leaving it out makes the rule disagree with the header rule it mirrors',
      );
      assert.ok(
        rule.expression.includes(`starts_with(http.request.uri.path, "/${prefix}/")`),
        `/${prefix}/... must be matched — those are the pages crawlers actually fetch`,
      );
    }
  });

  it('matches exactly the families vercel.json advertises as shared-cacheable', () => {
    // The failure this guards is the one that produced #7659 in the first place:
    // a family gains its origin CDN-Cache-Control header and nobody extends the
    // Cloudflare rule, so the header is correct and the page still never caches.
    const claimed = new Set(
      [...rule.expression.matchAll(/starts_with\(http\.request\.uri\.path, "\/([^/"]+)\/"\)/g)]
        .map((match) => match[1]),
    );
    assert.deepEqual(
      [...claimed].sort(),
      [...vercelPublicCorpusFamilies()].sort(),
      'the Cloudflare rule and the vercel.json CDN-Cache-Control rules must cover the same families',
    );
  });

  it('is scoped to query-free GETs of the www document host', () => {
    assert.ok(
      rule.expression.includes(`http.host eq "${CORPUS_HOST}"`),
      'apex and the variant subdomains serve different documents from the same paths',
    );
    assert.ok(
      rule.expression.includes('http.request.method eq "GET"'),
      'only GET responses are cacheable here',
    );
    assert.ok(
      rule.expression.includes('http.request.uri.query eq ""'),
      // middleware.ts answers a bot-UA request carrying utm_*/ref with a 308 to the
      // clean URL, under `Vary: User-Agent`. Cloudflare honours Vary only for
      // Accept-Encoding, so a query-bearing variant of this rule could store the
      // crawler's redirect and replay it to a human, stripping `ref` before
      // referral capture. Requiring an empty query removes the whole class.
      'query-bearing URLs reach a User-Agent-dependent redirect in middleware.ts and must not be cached',
    );
  });

  it('never reaches the authenticated, API, or proxied-docs surfaces', () => {
    for (const forbidden of ['/pro', '/api/', '/dashboard', '/docs', '/mcp']) {
      assert.ok(
        !rule.expression.includes(`"${forbidden}`),
        `${forbidden} must stay outside the corpus cache rule`,
      );
    }
  });

  it('defers the TTL to the origin and refuses to cache anything but a 2xx', () => {
    assert.equal(rule.action, 'set_cache_settings');
    assert.deepEqual(rule.action_parameters, {
      cache: true,
      browser_ttl: { mode: 'respect_origin' },
      edge_ttl: {
        // "Use the origin's cache headers, bypass when there are none" — the
        // origin sends s-maxage=600 plus stale-while-revalidate=60, so honouring
        // it gets revalidation for free and keeps one TTL under one owner.
        mode: 'bypass_by_default',
        status_code_ttl: [
          // A 404 under a corpus prefix is rendered per-request by
          // middleware.ts (markdown for agents, HTML for browsers). Caching it
          // would let one audience's variant answer the other's request.
          { status_code_range: { from: 300, to: 499 }, value: 0 },
          { status_code_range: { from: 500 }, value: -1 },
        ],
      },
    });
  });

  it('appends the rule last so it overrides the blanket document bypass', () => {
    // Cloudflare evaluates every matching rule in the cache phase in order and
    // the last one to set a field wins. The corpus rule and the "Bypass cache -
    // WWW documents" rule both match a corpus URL, so ordering is the whole
    // mechanism — placed first, the rule is silently inert.
    const existing = [
      { id: 'a', description: 'Bypass cache - WWW documents', action: 'set_cache_settings' },
      { id: 'b', description: 'WWW entry HTML - use origin CDN cache headers', action: 'set_cache_settings' },
    ];
    const next = upsertCorpusCacheRule(existing, rule);
    assert.equal(next.length, 3);
    assert.equal(next.at(-1).description, CORPUS_CACHE_RULE_DESCRIPTION);
    assert.deepEqual(next.slice(0, 2), existing, 'the rules already in the zone must be left untouched');
  });

  it('replaces its own previous copy instead of stacking duplicates', () => {
    const existing = [
      { id: 'a', description: 'Bypass cache - WWW documents', action: 'set_cache_settings' },
      { id: 'stale', description: CORPUS_CACHE_RULE_DESCRIPTION, expression: '(http.host eq "old")' },
      { id: 'b', description: 'WWW entry HTML - use origin CDN cache headers', action: 'set_cache_settings' },
    ];
    const once = upsertCorpusCacheRule(existing, rule);
    assert.equal(once.filter((entry) => entry.description === CORPUS_CACHE_RULE_DESCRIPTION).length, 1);
    assert.equal(once.at(-1).expression, rule.expression, 'the stale copy must be replaced, not kept');
    assert.deepEqual(upsertCorpusCacheRule(once, rule), once, 'a second apply must be a no-op');
  });

  it('does not graft the replaced rule’s id onto the new definition', () => {
    // The entrypoint PUT replaces the whole rule list, and Cloudflare owns rule
    // ids. Carrying the stale copy's id forward would ask it to mutate a rule
    // whose body we never read, so the replacement goes in as a fresh rule.
    const existing = [{ id: 'stale', description: CORPUS_CACHE_RULE_DESCRIPTION, expression: 'old' }];
    const next = upsertCorpusCacheRule(existing, rule);
    assert.equal(next.at(-1).id, undefined, 'the replacement rule must not carry the old rule id');
  });

  it('strips the fields Cloudflare owns before echoing a rule back on a PUT', () => {
    const live = { id: 'keep', description: 'x', expression: 'y', version: '3', last_updated: 'now', ref: 'r' };
    assert.deepEqual(sanitizeRuleForPut(live), { id: 'keep', description: 'x', expression: 'y' });
    assert.equal(live.version, '3', 'the live rule read from the zone must not be mutated');
  });
});

describe('cloudflare cache rule drift report', () => {
  const rule = buildCorpusCacheRule();
  const bypass = {
    description: 'Bypass cache - WWW documents',
    action_parameters: { cache: false },
  };

  it('reports a zone that has never had the rule', () => {
    assert.deepEqual(diffLiveRuleset([bypass], rule).status, 'missing');
  });

  it('accepts a zone whose rule matches and sits last', () => {
    const diff = diffLiveRuleset([bypass, rule], rule);
    assert.equal(diff.status, 'current');
    assert.deepEqual(diff.problems, []);
  });

  it('catches the rule that looks right in the dashboard but can never win', () => {
    // The whole class of failure this guards: a correct rule placed above a
    // cache-disabling one is silently inert, and nothing in the UI says so.
    const diff = diffLiveRuleset([rule, bypass], rule);
    assert.equal(diff.status, 'drifted');
    assert.equal(diff.problems.length, 1);
    assert.match(diff.problems[0], /above a cache-disabling rule at 1/);
  });

  it('catches a disabled rule and an edited expression', () => {
    const edited = { ...rule, enabled: false, expression: '(http.host eq "example.com")' };
    const diff = diffLiveRuleset([bypass, edited], rule);
    assert.equal(diff.status, 'drifted');
    assert.deepEqual(diff.problems, ['expression differs', 'the rule is disabled']);
  });
});
