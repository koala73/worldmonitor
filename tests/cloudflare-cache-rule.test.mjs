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
  CORPUS_HOST,
  buildCorpusCacheRule,
  diffLiveRuleset,
  planApply,
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
    const parsed = familiesFromVercelSource(entry.source);
    // Failing open here would gut the guard below: a family added under a source
    // shape this regex does not recognise would silently contribute nothing, and
    // the comparison would pass while the Cloudflare rule was missing it — the
    // exact drift the test exists to catch.
    assert.ok(
      parsed.length,
      `${entry.source} advertises a shared CDN-Cache-Control but does not parse as a corpus family source;`
        + ' teach familiesFromVercelSource() its shape or add it to ENTRY_DOCUMENT_SOURCES',
    );
    for (const family of parsed) families.add(family);
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

  it('deliberately claims the agent-facing markdown twins alongside the HTML', () => {
    // `starts_with(path, "/countries/")` matches /countries/iran.md as well as
    // /countries/iran/. Same static build output, same public s-maxage, and AI
    // crawlers are the audience this change exists to serve — so this is intended,
    // and pinning it makes any future narrowing a deliberate act.
    assert.ok(
      rule.expression.includes('starts_with(http.request.uri.path, "/countries/")'),
      'the prefix clause is what admits both /countries/iran/ and /countries/iran.md',
    );
    assert.ok(
      !rule.expression.includes('http.request.uri.path.extension'),
      'no extension filter: narrowing to HTML would drop the .md twins crawlers fetch',
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
          // Both -1 (no-store), not 0. Cloudflare's 0 means no-cache, which still
          // STORES the response — production showed a corpus 404 sitting at
          // cf-cache-status MISS under 0. A 404 here can come from middleware.ts's
          // Accept-negotiating originNotFoundResponse, and Cloudflare honours Vary
          // only for Accept-Encoding, so it must never be stored.
          { status_code_range: { from: 300, to: 499 }, value: -1 },
          { status_code_range: { from: 500 }, value: -1 },
        ],
      },
    });
  });

  it('creates the rule when the zone has never had it', () => {
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } };
    assert.deepEqual(planApply([bypass], rule).op, 'create');
  });

  it('does nothing when the zone already matches', () => {
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } };
    assert.equal(planApply([bypass, { ...rule, id: 'mine' }], rule).op, 'none');
  });

  it('patches in place when only the settings drifted', () => {
    // Content-only drift needs no move, and moving it would churn the rule id
    // for no reason.
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } };
    const edited = { ...rule, id: 'mine', expression: '(http.host eq "example.com")' };
    const plan = planApply([bypass, edited], rule);
    assert.equal(plan.op, 'update');
    assert.equal(plan.id, 'mine');
    assert.deepEqual(plan.diff.problems, ['expression differs']);
  });

  it('recreates the rule when it sits where it can never win', () => {
    // Ordering is the whole mechanism: the blanket document bypass matches every
    // corpus URL too, and Cloudflare lets the last matching rule win. A rule
    // above it is silently inert, so it has to move rather than be patched.
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } };
    const plan = planApply([{ ...rule, id: 'mine' }, bypass], rule);
    assert.equal(plan.op, 'recreate');
    assert.equal(plan.id, 'mine');
  });

  it('judges the last copy and refuses to write when duplicates exist', () => {
    // Reachable state: a `recreate` whose POST lands and whose DELETE fails
    // leaves two copies. Reading only the first would report `current` off a
    // correct early copy while a stale LATER copy is what Cloudflare applies —
    // the same last-rule-wins trap as #7659, reintroduced by our own tooling.
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } };
    const stale = { ...rule, id: 'stale', expression: '(http.host eq "old")' };
    const diff = diffLiveRuleset([bypass, { ...rule, id: 'good' }, stale], rule);
    assert.equal(diff.status, 'drifted', 'the LAST copy is stale, so the zone is not current');
    assert.match(diff.problems[0], /2 rules share this description/);

    const plan = planApply([bypass, { ...rule, id: 'good' }, stale], rule);
    assert.equal(plan.op, 'duplicates', 'must not silently patch one of several copies');
    assert.deepEqual(plan.duplicates, ['good'], 'the earlier copies are the ones to delete');
  });

  it('never plans a write that touches another rule', () => {
    // The regression this pins: an earlier version rewrote the whole cache-phase
    // ruleset on every apply, which silently reverts any concurrent dashboard
    // edit and round-trips every other rule's user-owned `ref`. A plan may only
    // ever name our own rule's id.
    const others = [
      { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } },
      { id: 'b', description: 'WWW entry HTML - use origin CDN cache headers', ref: 'www_entry_html_origin_cache' },
    ];
    for (const rules of [others, [...others, { ...rule, id: 'mine' }], [{ ...rule, id: 'mine' }, ...others]]) {
      const plan = planApply(rules, rule);
      assert.ok(
        plan.id === undefined || plan.id === 'mine',
        `plan targeted ${plan.id}, which is not this rule`,
      );
    }
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

  it('does not call Cloudflare’s own key ordering a drift', () => {
    // Cloudflare re-serialises action_parameters alphabetically, so the rule it
    // hands back is never key-for-key the object that was PUT. The first
    // `--check` after this rule went live reported "action_parameters differ"
    // against a zone that was byte-for-byte correct.
    const reordered = {
      ...rule,
      action_parameters: {
        browser_ttl: rule.action_parameters.browser_ttl,
        cache: rule.action_parameters.cache,
        edge_ttl: {
          status_code_ttl: rule.action_parameters.edge_ttl.status_code_ttl.map((entry) => ({
            value: entry.value,
            status_code_range: entry.status_code_range,
          })),
          mode: rule.action_parameters.edge_ttl.mode,
        },
      },
    };
    assert.equal(diffLiveRuleset([bypass, reordered], rule).status, 'current');
  });

  it('still catches a genuinely changed cache setting', () => {
    const weakened = {
      ...rule,
      action_parameters: { ...rule.action_parameters, cache: false },
    };
    assert.deepEqual(diffLiveRuleset([bypass, weakened], rule).problems, ['action_parameters differ']);
  });

  it('catches a disabled rule and an edited expression', () => {
    const edited = { ...rule, enabled: false, expression: '(http.host eq "example.com")' };
    const diff = diffLiveRuleset([bypass, edited], rule);
    assert.equal(diff.status, 'drifted');
    assert.deepEqual(diff.problems, ['expression differs', 'the rule is disabled']);
  });
});
