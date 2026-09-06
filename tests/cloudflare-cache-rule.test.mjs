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
  AGENT_TEXT_FILES,
  AGENT_USER_AGENTS,
  CORPUS_HOST,
  EDGE_CACHED_FAMILIES,
  ENTRY_DOCUMENTS,
  FAMILY_EXCLUSIONS,
  NEGOTIATED_MEDIA_TYPES,
  RETIRED_CACHE_RULES,
  RSC_REQUEST_HEADERS,
  SINGLE_REPRESENTATION_EXTENSIONS,
  USER_AGENT_ROUTED_DOCUMENTS,
  buildCorpusCacheRule,
  diffLiveRuleset,
  planApply,
  runCloudflareCacheRule,
} from '../scripts/cloudflare-cache-rule.mjs';
import agentRequestPolicy from '../shared/agent-request-policy.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));

const HTML_ENTRY_EDGE_CACHE = 'public, s-maxage=600, stale-while-revalidate=60';

/**
 * vercel.json sources that advertise the shared TTL and that the rule leaves
 * alone on purpose. `/dashboard.html` is the rewrite destination behind
 * `/dashboard`, `/stocks` and `/story`: no link or sitemap sends anyone to it,
 * and claiming it would store a second copy of the dashboard shell under a URL
 * the canonical one never invalidates. The entry documents themselves — `/` and
 * `/dashboard`, which the dashboard-managed "WWW entry HTML" rule used to cache
 * without any representation guard — are claimed since #7804 (ENTRY_DOCUMENTS).
 */
const UNCLAIMED_ENTRY_SOURCES = new Set(['/dashboard.html']);

/**
 * Classify one vercel.json header source that advertises the shared TTL.
 *
 * Shapes in use:
 *   /  /dashboard                  the entry documents, exact (ENTRY_DOCUMENTS)
 *   /(a|b|c)                       bare corpus families (308s, mirrored anyway)
 *   /(a|b|c)/(.*)                  nested corpus families
 *   /blog                          a bare family that is itself a document
 *   /blog/((?!_astro/|og/).*)      a nested family with carve-outs; `x$` marks an exact path
 *   /(llms\.txt|home\.md)          root-level files, dots escaped
 *
 * Returns null for anything else so the caller can fail loudly: a shape this
 * parser does not know would otherwise contribute nothing and let the rule
 * silently under-claim — the drift that produced #7659.
 */
function classifyVercelSource(source) {
  // Before the bare-family shape: `/dashboard` would otherwise read as a family.
  if (ENTRY_DOCUMENTS.includes(source)) return { documents: [source] };
  let match = source.match(/^\/\(([^()]+)\)\/\(\.\*\)$/);
  if (match) {
    return { nested: match[1].split('|').map((family) => [family, { prefixes: [], exact: [] }]) };
  }
  match = source.match(/^\/([a-z-]+)\/\(\(\?!([^()]+)\)\.\*\)$/);
  if (match) {
    const carveOuts = match[2].split('|');
    return {
      nested: [[match[1], {
        prefixes: carveOuts.filter((carveOut) => !carveOut.endsWith('$')),
        exact: carveOuts.filter((carveOut) => carveOut.endsWith('$')).map((carveOut) => carveOut.slice(0, -1)),
      }]],
    };
  }
  match = source.match(/^\/\(([^()]+)\)$/);
  if (match) {
    const names = match[1].split('|').map((name) => name.replace(/\\\./g, '.'));
    return {
      bare: names.filter((name) => !name.includes('.')),
      files: names.filter((name) => name.includes('.')),
    };
  }
  match = source.match(/^\/([a-z-]+)$/);
  if (match) return { bare: [match[1]] };
  return null;
}

/** Everything vercel.json advertises as shared-cacheable, by shape. */
function vercelEdgeCacheSurface() {
  const surface = { bare: new Set(), nested: new Map(), files: new Set(), documents: new Set() };
  for (const entry of vercelConfig.headers ?? []) {
    const cdn = entry.headers.find((header) => header.key === 'CDN-Cache-Control');
    if (cdn?.value !== HTML_ENTRY_EDGE_CACHE) continue;
    if (UNCLAIMED_ENTRY_SOURCES.has(entry.source)) continue;
    const parsed = classifyVercelSource(entry.source);
    assert.ok(
      parsed,
      `${entry.source} advertises a shared CDN-Cache-Control but is not a shape this test knows;`
        + ' teach classifyVercelSource() its shape or add it to UNCLAIMED_ENTRY_SOURCES',
    );
    for (const name of parsed.bare ?? []) surface.bare.add(name);
    for (const name of parsed.files ?? []) surface.files.add(name);
    for (const name of parsed.documents ?? []) surface.documents.add(name);
    for (const [family, carveOuts] of parsed.nested ?? []) surface.nested.set(family, carveOuts);
  }
  return surface;
}

/**
 * Everything the generated expression claims, in the same shape, read back from
 * the wirefilter text rather than from the constants that produced it — the
 * point is to catch the expression builder dropping something, not to compare a
 * constant with itself.
 */
function ruleClaims(expression) {
  const claims = { bare: new Set(), nested: new Map(), files: new Set(), documents: new Set() };
  for (const set of expression.matchAll(/http\.request\.uri\.path in \{([^}]*)\}/g)) {
    for (const literal of set[1].match(/"[^"]+"/g) ?? []) {
      const name = literal.slice(2, -1);
      (name.includes('.') ? claims.files : claims.bare).add(name);
    }
  }
  let current = null;
  for (const line of expression.split('\n')) {
    const document = line.match(/^\s*or \(?http\.request\.uri\.path eq "([^"]+)"/);
    if (document) {
      claims.documents.add(document[1]);
      continue;
    }
    const claim = line.match(/^\s*or \(?starts_with\(http\.request\.uri\.path, "\/([^/"]+)\/"\)/);
    if (claim) {
      claims.nested.set(claim[1], { prefixes: [], exact: [] });
      current = line.includes('or (') ? claim[1] : null;
      continue;
    }
    if (!current) continue;
    if (/^\s*\)\s*$/.test(line)) {
      current = null;
      continue;
    }
    const prefix = line.match(/and not starts_with\(http\.request\.uri\.path, "\/([^/"]+)\/(.+)"\)/);
    if (prefix) {
      assert.equal(prefix[1], current, `carve-out ${line.trim()} sits under the wrong family`);
      claims.nested.get(current).prefixes.push(prefix[2]);
      continue;
    }
    const exact = line.match(/and http\.request\.uri\.path ne "\/([^/"]+)\/(.+)"/);
    if (exact) {
      assert.equal(exact[1], current, `carve-out ${line.trim()} sits under the wrong family`);
      claims.nested.get(current).exact.push(exact[2]);
    }
  }
  return claims;
}

const sorted = (iterable) => [...iterable].sort();

/** The live "WWW entry HTML" rule as read from the zone on 2026-09-06, under a fixture id. */
function retiredEntryRule(overrides = {}) {
  return {
    id: 'entry-id',
    ref: 'www_entry_html_origin_cache',
    description: 'WWW entry HTML - use origin CDN cache headers',
    expression: '(http.host eq "www.worldmonitor.app" and http.request.method eq "GET" and http.request.uri.path in {"/" "/dashboard"} and http.request.uri.query eq "")',
    action: 'set_cache_settings',
    action_parameters: { cache: true, browser_ttl: { mode: 'respect_origin' }, edge_ttl: { mode: 'bypass_by_default' } },
    enabled: true,
    ...overrides,
  };
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

  it('claims exactly the surface vercel.json advertises as shared-cacheable', () => {
    // The failure this guards is the one that produced #7659 and then #7747: a
    // route gains its origin CDN-Cache-Control header and nobody extends the
    // Cloudflare rule (or the reverse), so one half is correct and the page still
    // never caches. Both directions, all three shapes.
    const advertised = vercelEdgeCacheSurface();
    const claimed = ruleClaims(rule.expression);

    // Positive controls: the parsers must actually be seeing the new shapes.
    assert.ok(advertised.nested.has('blog') && advertised.nested.has('docs'), 'vercel.json must advertise /blog and /docs');
    assert.ok(advertised.files.has('llms.txt'), 'vercel.json must advertise /llms.txt');
    assert.ok(claimed.nested.get('docs')?.exact.length, 'the rule must carve an exact path out of /docs');

    assert.ok(advertised.documents.has('/') && advertised.documents.has('/dashboard'), 'vercel.json must advertise / and /dashboard');

    assert.deepEqual(sorted(claimed.bare), sorted(advertised.bare), 'bare document paths');
    assert.deepEqual(sorted(claimed.files), sorted(advertised.files), 'root agent text files');
    assert.deepEqual(sorted(claimed.documents), sorted(advertised.documents), 'entry documents (#7804)');
    assert.deepEqual(sorted(claimed.nested.keys()), sorted(advertised.nested.keys()), 'prefix-claimed families');
    for (const [family, carveOuts] of advertised.nested) {
      const inRule = claimed.nested.get(family);
      assert.deepEqual(sorted(inRule.prefixes), sorted(carveOuts.prefixes), `${family}: carve-out prefixes`);
      assert.deepEqual(sorted(inRule.exact), sorted(carveOuts.exact), `${family}: carve-out exact paths`);
    }

    // And the constants the script exports are what both halves were built from.
    assert.deepEqual(sorted(claimed.nested.keys()), sorted(EDGE_CACHED_FAMILIES));
    assert.deepEqual(sorted(claimed.files), sorted(AGENT_TEXT_FILES));
    assert.deepEqual(sorted(claimed.documents), sorted(ENTRY_DOCUMENTS));
  });

  it('admits an HTML document only for the HTML representation: no RSC flight headers, no negotiated media types', () => {
    // Vercel answers `Accept: text/markdown` with markdown for the corpus and the
    // blog; Mintlify does the same for text/markdown and text/plain and serves an
    // RSC flight for `RSC: 1` / the next-router-* headers. Cloudflare keys on the
    // URL, so a request asking for any of those must not be admitted — it is
    // neither stored nor answered from the store, and reaches the origin as
    // before. Pinned lists: dropping one entry re-opens a poisoning path.
    assert.deepEqual(
      [...RSC_REQUEST_HEADERS],
      ['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch'],
    );
    assert.deepEqual([...NEGOTIATED_MEDIA_TYPES], ['text/markdown', 'text/plain', 'text/x-component']);
    const guards = [
      // Presence via the lowercase-keyed headers map, never `headers.names[*] ==`:
      // that array keeps the sender's casing and an HTTP/1.1 `RSC: 1` (Node's
      // fetch sends it verbatim) slipped past the guard, read the cached HTML and,
      // on a MISS, stored the flight under the HTML URL (2026-09-06).
      ...RSC_REQUEST_HEADERS.map((name) => `not any(http.request.headers["${name}"][*] != "")`),
      // Every Accept value, lowercased: Accept may arrive as several header lines
      // and the origins honour the combined list (measured: a second line
      // `Accept: text/markdown` still yields markdown), and both origins match
      // media types case-insensitively (`Accept: TEXT/MARKDOWN` -> text/markdown).
      // `[0]` alone would admit a request whose first line is harmless.
      ...NEGOTIATED_MEDIA_TYPES.map((type) => `not any(lower(http.request.headers["accept"][*])[*] contains "${type}")`),
    ];
    for (const guard of guards) {
      assert.ok(rule.expression.includes(guard), `missing guard: ${guard}`);
    }
    assert.ok(!rule.expression.includes('["accept"][0]'), 'only the first Accept line was inspected');
    assert.ok(
      !rule.expression.includes('http.request.headers.names'),
      'header-name equality is case-sensitive at Cloudflare: an uppercase RSC: 1 would be admitted and poison the HTML entry',
    );

    // Structure: one guard block, gating every HTML document family, disjoined
    // with the single-representation exemption, and closed before the path
    // disjunction opens.
    const lines = rule.expression.split('\n');
    const exemption = lines.findIndex((line) => line.trim() === `http.request.uri.path.extension in {${SINGLE_REPRESENTATION_EXTENSIONS.map((ext) => `"${ext}"`).join(' ')}}`);
    assert.ok(exemption > 0, 'the single-representation exemption must be present');
    assert.equal(lines[exemption - 1].trim(), 'and (', 'the exemption opens the guard block');
    assert.ok(lines[exemption + 1].trim().startsWith(`or (${guards[0]}`), 'the guard conjunction is the exemption\'s alternative');
    const guardClose = lines.findIndex((line, index) => index > exemption && line.trim() === ')');
    const blockClose = guardClose + 1;
    assert.equal(lines[blockClose].trim(), ')', 'the guard block closes');
    assert.equal(lines[blockClose + 1].trim(), 'and (', 'the path disjunction follows the guard block');
    for (const guard of guards) {
      const at = lines.findIndex((line) => line.includes(guard));
      assert.ok(at > exemption && at < guardClose, `${guard} must sit inside the guard block`);
    }
    assert.ok(
      !lines.slice(blockClose + 1).some((line) => line.includes('http.request.headers[')),
      'no per-family guard: the block applies to every family once',
    );
  });

  it('exempts single-representation files from the representation guard', () => {
    // /countries/iran.md, /docs/documentation.md, /llms.txt, /blog/rss.xml and
    // the sitemaps answer the same body for every Accept value and for `RSC: 1`
    // (measured 2026-09-05). Guarding them would push agents that advertise
    // `Accept: text/plain` or `text/markdown` — the clients these files exist for
    // — off the cache. An allowlist, not "any extension": a document slug with a
    // dot in it (`/docs/v1.2`) must keep the guard.
    assert.deepEqual([...SINGLE_REPRESENTATION_EXTENSIONS], ['md', 'txt', 'xml']);
    assert.ok(rule.expression.includes('http.request.uri.path.extension in {"md" "txt" "xml"}'));
    assert.ok(!rule.expression.includes('path.extension ne ""'), 'must not exempt every extension');
    assert.ok(!rule.expression.includes('path.extension in {"" "html"}'), 'the exemption is an allowlist of files, not a denylist of documents');
  });

  it('leaves the blog asset prefixes to the zone\'s older "Blog" rule', () => {
    // That rule gives /blog/_astro/, /blog/og/ and /blog/images/ a month-long
    // override TTL. Cloudflare lets the last matching rule write edge_ttl, so
    // claiming them here would replace the month with "respect origin" — for
    // Vercel's static default, an origin round-trip per request.
    assert.deepEqual([...FAMILY_EXCLUSIONS.blog.prefixes], ['_astro/', 'og/', 'images/']);
    for (const prefix of FAMILY_EXCLUSIONS.blog.prefixes) {
      assert.ok(rule.expression.includes(`and not starts_with(http.request.uri.path, "/blog/${prefix}")`));
    }
    assert.ok(rule.expression.includes('"/blog"'), '/blog is the blog index, a document in its own right');
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
    // The only use of the path extension is the single-representation exemption,
    // which widens what is admitted for .md/.txt/.xml; nothing narrows the path
    // claims to HTML, which would drop the .md twins crawlers fetch.
    const extensionUses = rule.expression.match(/http\.request\.uri\.path\.extension[^\n]*/g) ?? [];
    assert.deepEqual(extensionUses, ['http.request.uri.path.extension in {"md" "txt" "xml"}']);
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

  it('never reaches the authenticated or API surfaces, and carves the MCP server and Mintlify internals out of /docs', () => {
    // /dashboard left this list in #7804: it is an entry document, claimed
    // behind the representation guard like the rest of the HTML surface.
    for (const forbidden of ['/pro', '/api/', '/mcp"', '/mcp-grant', '/embed']) {
      assert.ok(
        !rule.expression.includes(`"${forbidden}`),
        `${forbidden} must stay outside the corpus cache rule`,
      );
    }
    // /docs/mcp is api/docs-mcp.ts — a no-store JSON-RPC endpoint that answers
    // GET as well as POST — and /docs/_* is Mintlify's asset and API space. Both
    // share the prefix with the documents and neither is one. The exact-path
    // form matters: a prefix carve-out on "/docs/mcp" would also drop the
    // /docs/mcp-overview page.
    assert.deepEqual(FAMILY_EXCLUSIONS.docs, { prefixes: ['_', 'mcp/'], exact: ['mcp'] });
    assert.ok(rule.expression.includes('and http.request.uri.path ne "/docs/mcp"'));
    assert.ok(rule.expression.includes('and not starts_with(http.request.uri.path, "/docs/mcp/")'));
    assert.ok(rule.expression.includes('and not starts_with(http.request.uri.path, "/docs/_")'));
    assert.ok(!rule.expression.includes('not starts_with(http.request.uri.path, "/docs/mcp")'), 'a prefix carve-out would swallow /docs/mcp-overview');
    // Bare /docs is a 307 with no vercel.json header rule of its own, so it is
    // the one family whose bare form is not mirrored.
    assert.ok(!/in \{[^}]*"\/docs"[^}]*\}/.test(rule.expression), 'bare /docs must not be claimed');
  });

  it('claims the entry documents the retired "WWW entry HTML" rule cached, behind the same guard (#7804)', () => {
    // The zone's dashboard-managed entry rule cached GET / and GET /dashboard
    // with no representation guard, while Vercel converts both to markdown for
    // `Accept: text/markdown` under the same cacheable 600s header. That is the
    // poisoning shape the corpus rule was hardened against, one rule earlier in
    // the phase — and Cloudflare takes the last matching writer of `cache`, so a
    // request this rule's guard rejected still found cache: true there. The
    // corpus rule now claims both documents inside its path disjunction, which
    // sits after the guard block, and the entry rule is retired (see below).
    assert.deepEqual([...ENTRY_DOCUMENTS], ['/', '/dashboard']);
    const lines = rule.expression.split('\n').map((line) => line.trim());
    const pathDisjunction = lines.lastIndexOf('and (');
    const dashboard = lines.indexOf('or http.request.uri.path eq "/dashboard"');
    const home = lines.indexOf('or (http.request.uri.path eq "/"');
    assert.ok(dashboard > pathDisjunction, '/dashboard must be claimed inside the path disjunction, behind the representation guard');
    assert.ok(home > pathDisjunction, '/ must be claimed inside the path disjunction, behind the representation guard');
    assert.ok(!rule.expression.includes('"/dashboard.html"'), 'the rewrite destination is not a URL anyone is sent to');
  });

  it('keeps the declared AI agents off the homepage entry, and only the homepage', () => {
    // middleware.ts rewrites GET / to /home.md for the User-Agents in
    // shared/agent-request-policy.json (`Vary: User-Agent`, no-store). The
    // no-store keeps that markdown out of the edge; the other direction is the
    // problem: Cloudflare answers from the stored browser HTML before the
    // middleware runs, so a crawler on a warm edge server never sees its
    // document. Cloudflare ignores Vary: User-Agent, so the request has to stay
    // out of the rule. /dashboard and the corpus answer one body whatever the
    // UA, and AI crawlers are the audience the corpus cache exists for, so the
    // carve-out is scoped to the one URL whose body varies.
    assert.deepEqual([...USER_AGENT_ROUTED_DOCUMENTS], ['/']);
    assert.deepEqual([...AGENT_USER_AGENTS], agentRequestPolicy.userAgents.map((ua) => ua.toLowerCase()));
    assert.ok(AGENT_USER_AGENTS.includes('gptbot') && AGENT_USER_AGENTS.includes('claudebot'), 'positive control on the policy');

    const lines = rule.expression.split('\n');
    const home = lines.findIndex((line) => line.trim() === 'or (http.request.uri.path eq "/"');
    assert.ok(home > 0, 'the homepage must be claimed as its own guarded group');
    let close = home + 1;
    while (close < lines.length && lines[close] !== '    )') close += 1;
    const clause = lines.slice(home, close + 1).join('\n');
    assert.ok(clause.includes('and not ('), 'the homepage claim must carve the agents out');
    for (const agent of AGENT_USER_AGENTS) {
      assert.ok(clause.includes(`lower(http.user_agent) contains "${agent}"`), `${agent} must be carved out of the homepage claim`);
    }
    assert.equal(
      (rule.expression.match(/http\.user_agent/g) ?? []).length,
      AGENT_USER_AGENTS.length,
      'the User-Agent carve-out belongs to the homepage claim alone: corpus, docs and blog answer one body per UA',
    );
    assert.ok(
      lines.some((line) => line.trim() === 'or http.request.uri.path eq "/dashboard"'),
      '/dashboard is UA-invariant and needs no carve-out',
    );

    // Nobody to carve out is a plain claim, never an empty `and not ( )` group,
    // which Cloudflare would reject at --apply time.
    const nobody = buildCorpusCacheRule({ agents: [] }).expression;
    assert.ok(nobody.includes('    or http.request.uri.path eq "/"\n'), 'an empty agent list claims the homepage unguarded');
    assert.ok(!nobody.includes('and not ('), 'no empty carve-out group');
  });

  it('adopts a rule whose ref is Cloudflare\'s default — its own id', () => {
    // Cloudflare fills an unset ref with the rule id. The first corpus rule was
    // applied before this script set a ref and lived in that state; treating the
    // echoed id as a foreign ref made --check report "ambiguous" against a zone
    // that held exactly one copy, and --apply refuse to touch it.
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } };
    const echoed = {
      ...rule,
      id: '7a9b6e5ba37940ecb103d9063db3a5f2',
      ref: '7a9b6e5ba37940ecb103d9063db3a5f2',
      expression: '(http.host eq "the #7659 expression")',
    };
    const plan = planApply([bypass, echoed], rule);
    assert.equal(plan.op, 'update');
    assert.equal(plan.id, echoed.id);
    // The echoed ref is not reported: Cloudflare refuses to change it (error
    // 20142 on the live zone, 2026-09-05), so it can never be "repaired", and a
    // drift that can never clear would keep --check red on a correct zone.
    assert.deepEqual(plan.diff.problems, ['expression differs']);
    assert.equal(plan.refLocked, true);

    // Once the content matches, the rule is current under its default ref.
    assert.equal(planApply([bypass, { ...echoed, expression: rule.expression }], rule).op, 'none');

    // A genuinely foreign ref on the same description is still a conflict.
    const foreign = { ...rule, id: 'x', ref: 'someone_elses_ref' };
    assert.equal(planApply([bypass, foreign], rule).op, 'duplicates');
    // And an echoed-id copy next to a managed copy is still two copies.
    assert.equal(planApply([bypass, { ...rule, id: 'mine' }, echoed], rule).op, 'duplicates');
  });

  it('defers the TTL to the origin and refuses to cache anything but a 2xx', () => {
    assert.equal(rule.ref, 'www_corpus_html_origin_cache');
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

  it('patches and moves the same rule when it sits where it can never win', () => {
    // Ordering is the whole mechanism: the blanket document bypass matches every
    // corpus URL too, and Cloudflare lets the last matching rule win. A rule
    // above it is silently inert, so it has to move rather than be patched.
    const bypass = {
      id: 'a',
      description: 'Bypass cache - WWW documents',
      action: 'set_cache_settings',
      action_parameters: { cache: false },
      enabled: true,
    };
    const plan = planApply([{ ...rule, id: 'mine' }, bypass], rule);
    assert.equal(plan.op, 'update');
    assert.equal(plan.id, 'mine');
    assert.equal(plan.diff.misordered, true);
  });

  it('matches the stable ref when the description drifts', () => {
    const renamed = { ...rule, id: 'mine', description: 'renamed in the dashboard' };
    const plan = planApply([renamed], rule);
    assert.equal(plan.op, 'update');
    assert.equal(plan.id, 'mine');
    assert.deepEqual(plan.diff.problems, ['description differs']);
  });

  it('adopts one legacy description-only rule and rejects ambiguous identity', () => {
    const legacy = { ...rule, id: 'legacy', expression: '(http.host eq "stale")' };
    delete legacy.ref;
    const plan = planApply([legacy], rule);
    assert.equal(plan.op, 'update');
    assert.equal(plan.id, 'legacy');
    assert.equal(plan.refLocked, true, 'a PATCH must not try to give the adopted rule our ref');
    assert.deepEqual(plan.diff.problems, ['expression differs'], 'the missing ref itself is not drift');

    // Identical content under a default ref is simply current.
    const current = { ...rule, id: 'legacy' };
    delete current.ref;
    assert.equal(planApply([current], rule).op, 'none');

    const renamed = { ...rule, id: 'managed', description: 'renamed in the dashboard' };
    const ambiguous = planApply([renamed, legacy], rule);
    assert.equal(ambiguous.op, 'duplicates');
    assert.deepEqual(ambiguous.duplicates, ['managed', 'legacy']);
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
    assert.match(diff.problems[0], /2 rules match the managed ref or legacy description/);

    const plan = planApply([bypass, { ...rule, id: 'good' }, stale], rule);
    assert.equal(plan.op, 'duplicates', 'must not silently patch one of several copies');
    assert.deepEqual(plan.duplicates, ['good', 'stale']);
  });

  it('never plans a write that touches another rule', () => {
    // The regression this pins: an earlier version rewrote the whole cache-phase
    // ruleset on every apply, which silently reverts any concurrent dashboard
    // edit and round-trips every other rule's user-owned `ref`. A plan may only
    // ever name our own rule's id.
    const others = [
      { id: 'a', description: 'Bypass cache - WWW documents', action_parameters: { cache: false } },
      { id: 'b', description: 'Static assets - WWW use cache-control', ref: 'www_static_assets' },
    ];
    for (const rules of [others, [...others, { ...rule, id: 'mine' }], [{ ...rule, id: 'mine' }, ...others]]) {
      const plan = planApply(rules, rule);
      assert.ok(
        plan.id === undefined || plan.id === 'mine',
        `plan targeted ${plan.id}, which is not this rule`,
      );
      assert.deepEqual(plan.retire, [], 'a rule this script has not taken over is never deleted');
    }
  });

  it('retires the rules whose surface it has taken over, and nothing else (#7804)', () => {
    // The dashboard-managed "WWW entry HTML" rule cached / and /dashboard with no
    // representation guard, one position before this rule. Claiming the two
    // documents is half the fix; the earlier rule has to go, and only this
    // script can see that it should — `--check` said "current" against the
    // 2026-09-06 zone because the managed rule WAS current.
    assert.deepEqual(RETIRED_CACHE_RULES.map((entry) => entry.description), [
      'WWW entry HTML - use origin CDN cache headers',
      'Agent homepage Markdown - bypass shared HTML cache',
    ]);
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    const entry = { id: 'entry', ref: 'entry', description: 'WWW entry HTML - use origin CDN cache headers', action: 'set_cache_settings', action_parameters: { cache: true }, enabled: true };
    const stale = { ...rule, id: 'mine', expression: '(http.host eq "old")' };

    const alongside = planApply([bypass, entry, stale], rule);
    assert.equal(alongside.op, 'update');
    assert.equal(alongside.id, 'mine');
    assert.deepEqual(alongside.retire, ['entry']);

    const alone = planApply([bypass, entry, { ...rule, id: 'mine' }], rule);
    assert.equal(alone.op, 'none', 'the managed rule itself is current');
    assert.deepEqual(alone.retire, ['entry'], 'but the leftover still has to go');

    // Identified by the ref the other script chose, whatever the dashboard calls it now.
    const agentBypass = { id: 'agent', description: 'renamed', ref: 'www_agent_markdown_cache_bypass', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    assert.deepEqual(planApply([bypass, { ...rule, id: 'mine' }, agentBypass], rule).retire, ['agent']);

    assert.deepEqual(planApply([bypass, { ...rule, id: 'mine' }], rule).retire, []);
  });

  it('blocks on an earlier cache-enabling rule that claims an owned URL, whatever it is called', () => {
    // #7804 named the two rules that were wrong. The invariant is wider: no
    // earlier cache: true writer may quote a URL this rule owns, or it wins on
    // every request the guard declines. A dashboard rule under a fresh name
    // must not be able to reproduce the incident unnoticed.
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    const stray = {
      id: 'stray',
      ref: 'stray',
      description: 'Homepage cache (dashboard)',
      action: 'set_cache_settings',
      action_parameters: { cache: true, edge_ttl: { mode: 'bypass_by_default' } },
      enabled: true,
      expression: '(http.host eq "www.worldmonitor.app" and http.request.uri.path in {"/" "/dashboard"} and http.request.uri.query eq "")',
    };
    const plan = planApply([bypass, stray, { ...rule, id: 'mine' }], rule);
    assert.equal(plan.op, 'blocked');
    assert.deepEqual(plan.retire, [], 'a rule this script has not taken over is never deleted');
    assert.deepEqual(
      plan.diff.earlierWriters.map(({ id, overlap }) => ({ id, overlap })),
      [{ id: 'stray', overlap: ['/', '/dashboard'] }],
    );
    assert.match(plan.blockers[0], /earlier cache rule at position 1 \("Homepage cache \(dashboard\)"\) enables the cache for "\/", "\/dashboard"/);

    // Nothing to sit above yet still blocks: created last, the managed rule would land below the claimant.
    assert.equal(planApply([bypass, stray], rule).op, 'blocked');
    // A cache-disabling earlier rule is the bypass this rule exists to override, never a blocker.
    assert.equal(planApply([bypass, { ...stray, action_parameters: { cache: false } }, { ...rule, id: 'mine' }], rule).op, 'none');
    // A claimant scoped to another host cannot match a www URL.
    const elsewhere = { ...stray, expression: '(http.host eq "maps.worldmonitor.app" and http.request.uri.path eq "/")' };
    assert.equal(planApply([bypass, elsewhere, { ...rule, id: 'mine' }], rule).op, 'none');
    // A retired rule is deleted, not reported as a claimant.
    const retiring = planApply([bypass, retiredEntryRule(), { ...rule, id: 'mine' }], rule);
    assert.equal(retiring.op, 'none');
    assert.deepEqual(retiring.retire, ['entry-id']);
    assert.deepEqual(retiring.diff.earlierWriters, []);
  });

  it('leaves the zone\'s legitimate earlier cache writers alone', () => {
    // The cache phase as read on 2026-09-06: every rule before ours that sets
    // cache: true, expressions verbatim. None quotes a claimed path — the
    // static-asset rule quotes the /blog/_astro/ carve-out, which is why claims
    // come from the surface model and not from the generated expression's own
    // literals.
    const writers = [
      { id: 'static', description: 'Static assets - WWW use cache-control', expression: '(starts_with(http.request.uri.path, "/assets/")) or (starts_with(http.request.uri.path, "/map-styles/")) or (starts_with(http.request.uri.path, "/data/")) or (starts_with(http.request.uri.path, "/textures/")) or (starts_with(http.request.uri.path, "/pro/assets/")) or (starts_with(http.request.uri.path, "/favico/")) or (starts_with(http.request.uri.path, "/blog/_astro/"))' },
      { id: 'api', description: 'API - api.worldmonitor.app use cache-control', expression: '(http.host eq "api.worldmonitor.app") and\n(http.request.method eq "GET") and\nstarts_with(http.request.uri.path, "/api/") and\nnot starts_with(http.request.uri.path, "/api/health")' },
      { id: 'proxy', description: 'Proxy - proxy.worldmonitor.app use cache-control', expression: '(http.host eq "proxy.worldmonitor.app") and\n(http.request.method eq "GET")' },
      { id: 'maps', description: ' maps.worldmonitor.app', expression: '(http.host eq " maps.worldmonitor.app")' },
      { id: 'blog', description: 'Blog', expression: '(http.request.uri.path wildcard r"/blog/og/*") or (http.request.uri.path wildcard r"/blog/images/*") or (http.request.uri.path wildcard r"/blog/_astro/*")' },
    ].map((entry) => ({ ...entry, action: 'set_cache_settings', action_parameters: { cache: true }, enabled: true }));
    const diff = diffLiveRuleset([...writers, { ...rule, id: 'mine' }], rule);
    assert.equal(diff.status, 'current', diff.problems.join('; '));
    assert.deepEqual(diff.earlierWriters, []);
  });

  it('reports a retired description under a foreign ref as a collision and never deletes it', () => {
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    const foreign = retiredEntryRule({ id: 'foreign', ref: 'another-owner' });
    const plan = planApply([bypass, foreign, { ...rule, id: 'mine' }], rule);
    assert.equal(plan.op, 'blocked');
    assert.deepEqual(plan.retire, []);
    assert.deepEqual(plan.diff.collisions.map(({ id, ref }) => ({ id, ref })), [{ id: 'foreign', ref: 'another-owner' }]);
    assert.ok(
      plan.blockers.some((message) => /retired description "WWW entry HTML - use origin CDN cache headers" under its own ref "another-owner"/.test(message)),
      plan.blockers.join('; '),
    );

    // The live entry rule carries the ref the script knows, so a dashboard rename still retires it...
    const renamed = retiredEntryRule({ description: 'renamed in the dashboard' });
    assert.deepEqual(planApply([bypass, renamed, { ...rule, id: 'mine' }], rule).retire, ['entry-id']);
    // ...and a copy created without a ref (Cloudflare fills in its id) retires by description.
    const defaulted = retiredEntryRule({ ref: 'entry-id' });
    assert.deepEqual(planApply([bypass, defaulted, { ...rule, id: 'mine' }], rule).retire, ['entry-id']);
  });

  it('never retires the managed rule itself, whatever the dashboard renamed it to', () => {
    const bypass = { id: 'a', description: 'Bypass cache - WWW documents', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    // Identified by its chosen ref, renamed to a retired description: a PATCH
    // fixes the name; nothing is deleted.
    const renamedMine = { ...rule, id: 'mine', description: RETIRED_CACHE_RULES[0].description };
    const plan = planApply([bypass, renamedMine], rule);
    assert.equal(plan.op, 'update');
    assert.equal(plan.id, 'mine');
    assert.deepEqual(plan.retire, []);
    // A default-ref copy renamed the same way is unidentifiable as ours and is
    // replaced: created fresh, then the stray copy retired. One rule survives.
    const lostCopy = { ...renamedMine, ref: 'mine' };
    const replaced = planApply([bypass, lostCopy], rule);
    assert.equal(replaced.op, 'create');
    assert.deepEqual(replaced.retire, ['mine']);
  });

  it('stays under Cloudflare\'s expression ceiling with room for more agents', () => {
    // Cloudflare rejects an expression over 4096 characters at write time, which
    // --apply would report and --print would not. Each agent in the policy costs
    // about 55 characters on the homepage carve-out.
    assert.ok(rule.expression.length < 4096, `expression is ${rule.expression.length} characters`);
    assert.ok(
      rule.expression.length < 3600,
      `expression is ${rule.expression.length} characters: under 500 of headroom, split the rule before adding agents`,
    );
  });
});

describe('cloudflare cache rule drift report', () => {
  const rule = buildCorpusCacheRule();
  const bypass = {
    description: 'Bypass cache - WWW documents',
    action: 'set_cache_settings',
    action_parameters: { cache: false },
    enabled: true,
  };

  it('reports a zone that has never had the rule', () => {
    assert.deepEqual(diffLiveRuleset([bypass], rule).status, 'missing');
  });

  it('accepts a zone whose rule matches and sits last', () => {
    const diff = diffLiveRuleset([bypass, rule], rule);
    assert.equal(diff.status, 'current');
    assert.deepEqual(diff.problems, []);
    assert.deepEqual(diff.retired, []);
  });

  it('reports a retired rule that is still in the zone, wherever it sits (#7804)', () => {
    const entry = {
      id: 'entry-id',
      description: 'WWW entry HTML - use origin CDN cache headers',
      action: 'set_cache_settings',
      action_parameters: { cache: true },
      enabled: true,
    };
    const before = diffLiveRuleset([bypass, entry, rule], rule);
    assert.equal(before.status, 'drifted');
    assert.equal(before.ruleCurrent, true, 'the managed rule itself is fine');
    assert.deepEqual(before.problems, [
      'retired rule "WWW entry HTML - use origin CDN cache headers" is still in the zone at position 1 and must be deleted',
    ]);
    assert.deepEqual(before.retired, [{ id: 'entry-id', description: entry.description, position: 1 }]);

    // A retired rule after ours is not "a later writer to move below": it is
    // deleted, so it must not make the managed rule look misordered as well.
    const after = diffLiveRuleset([bypass, rule, entry], rule);
    assert.equal(after.misordered, false);
    assert.deepEqual(after.retired.map(({ position }) => position), [2]);
    assert.equal(after.problems.length, 1);

    // A zone that has never had the managed rule still names the leftover.
    const missing = diffLiveRuleset([bypass, entry], rule);
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.retired.map(({ id }) => id), ['entry-id']);
    assert.equal(missing.problems.length, 2);
    assert.deepEqual(missing.blockers, []);
  });

  it('names the leftovers even when the managed identity is ambiguous', () => {
    const legacy = { ...rule, id: 'legacy' };
    delete legacy.ref;
    const renamed = { ...rule, id: 'managed', description: 'renamed in the dashboard' };
    const diff = diffLiveRuleset([bypass, retiredEntryRule(), renamed, legacy], rule);
    assert.equal(diff.ambiguous, true);
    assert.match(diff.problems.at(-1), /retired rule "WWW entry HTML/);
    // Nothing is deleted until the identity collision is repaired.
    const plan = planApply([bypass, retiredEntryRule(), renamed, legacy], rule);
    assert.equal(plan.op, 'duplicates');
    assert.deepEqual(plan.retire, []);
  });

  it('catches the rule that looks right in the dashboard but can never win', () => {
    // The whole class of failure this guards: a correct rule placed above a
    // cache-disabling one is silently inert, and nothing in the UI says so.
    const diff = diffLiveRuleset([rule, bypass], rule);
    assert.equal(diff.status, 'drifted');
    assert.equal(diff.problems.length, 1);
    assert.match(diff.problems[0], /above an enabled cache-settings rule at 1/);
    assert.match(diff.problems[0], /writes cache/);
  });

  it('reports each cache field written by a later enabled cache-settings rule', () => {
    for (const field of ['cache', 'browser_ttl', 'edge_ttl']) {
      const later = {
        description: `later ${field}`,
        action: 'set_cache_settings',
        action_parameters: { [field]: field === 'cache' ? true : { mode: 'respect_origin' } },
        enabled: true,
      };
      const diff = diffLiveRuleset([rule, later], rule);
      assert.equal(diff.status, 'drifted');
      assert.match(diff.problems.at(-1), new RegExp(`writes ${field}`));
    }
  });

  it('ignores disabled and non-cache-settings rules after the managed rule', () => {
    const later = [
      {
        description: 'disabled cache writer',
        action: 'set_cache_settings',
        action_parameters: { cache: false, browser_ttl: { mode: 'override_origin', default: 60 } },
        enabled: false,
      },
      {
        description: 'different action',
        action: 'skip',
        action_parameters: { cache: false, edge_ttl: { mode: 'override_origin', default: 0 } },
        enabled: true,
      },
    ];
    assert.equal(diffLiveRuleset([rule, ...later], rule).status, 'current');
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

function outputSink() {
  const chunks = [];
  return {
    chunks,
    stream: { write: (chunk) => chunks.push(String(chunk)) },
  };
}

function cloudflareResponse(result, { status = 200, success = true, errors = [] } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => ({ success, result, errors }),
  };
}

function interceptedFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      assert.ok(responses.length, `unexpected Cloudflare request: ${options.method} ${url}`);
      return responses.shift();
    },
  };
}

const API = 'https://api.cloudflare.com/client/v4';
const ZONE_PATH = `${API}/zones/zone-id`;
const ENTRYPOINT_PATH = `${API}/zones/zone-id/rulesets/phases/http_request_cache_settings/entrypoint`;
const RULES_PATH = `${API}/zones/zone-id/rulesets/ruleset-id/rules`;
const RUN_ENV = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ZONE_ID: 'zone-id' };

describe('cloudflare cache rule runner', () => {
  it('rejects multiple recognized modes in either order before network access', async () => {
    for (const argv of [['--apply', '--check'], ['--print', '--apply']]) {
      let networkCalls = 0;
      const stderr = outputSink();
      const code = await runCloudflareCacheRule(argv, {
        env: RUN_ENV,
        fetchImpl: async () => { networkCalls += 1; },
        stdout: outputSink().stream,
        stderr: stderr.stream,
      });
      assert.equal(code, 2);
      assert.equal(networkCalls, 0);
      assert.match(stderr.chunks.join(''), /choose exactly one mode/);
    }
  });

  it('requires exactly one compatible token variable before network access', async () => {
    for (const env of [
      { CLOUDFLARE_ZONE_ID: 'zone-id' },
      {
        CLOUDFLARE_API_TOKEN: 'scoped',
        CLOUDFLARE_ALL_ACCESS_TOKEN: 'broad',
        CLOUDFLARE_ZONE_ID: 'zone-id',
      },
    ]) {
      let networkCalls = 0;
      const stderr = outputSink();
      const code = await runCloudflareCacheRule(['--check'], {
        env,
        fetchImpl: async () => { networkCalls += 1; },
        stdout: outputSink().stream,
        stderr: stderr.stream,
      });
      assert.equal(code, 1);
      assert.equal(networkCalls, 0);
      assert.match(stderr.chunks.join(''), /exactly one of CLOUDFLARE_API_TOKEN or CLOUDFLARE_ALL_ACCESS_TOKEN/);
    }
  });

  it('accepts CLOUDFLARE_ALL_ACCESS_TOKEN when it is the only token', async () => {
    const rule = buildCorpusCacheRule();
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '1', rules: [{ ...rule, id: 'managed-id' }] }),
    ]);
    const code = await runCloudflareCacheRule(['--check'], {
      env: { CLOUDFLARE_ALL_ACCESS_TOKEN: 'broad', CLOUDFLARE_ZONE_ID: 'zone-id' },
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls, [
      { url: ZONE_PATH, method: 'GET', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
    ]);
  });

  it('refuses ambiguous identity before any write', async () => {
    const rule = buildCorpusCacheRule();
    const legacy = { ...rule, id: 'legacy-id' };
    delete legacy.ref;
    const renamed = { ...rule, id: 'managed-id', description: 'renamed in dashboard' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '3', rules: [renamed, legacy] }),
    ]);
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.deepEqual(intercepted.calls, [
      { url: ZONE_PATH, method: 'GET', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
    ]);
    assert.match(stderr.chunks.join(''), /refusing to write: 2 rules match/);
  });

  it('moves an existing ref-matched rule with one PATCH and no create or delete', async () => {
    const rule = buildCorpusCacheRule();
    const managed = { ...rule, id: 'managed-id', description: 'renamed in dashboard' };
    const later = {
      id: 'later-id',
      description: 'later browser TTL',
      action: 'set_cache_settings',
      action_parameters: { browser_ttl: { mode: 'override_origin', default: 60 } },
      enabled: true,
    };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '4', rules: [managed, later] }),
      cloudflareResponse({ ...rule, id: 'managed-id' }),
      cloudflareResponse({ id: 'ruleset-id', version: '5', rules: [later, { ...rule, id: 'managed-id' }] }),
    ]);
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls, [
      { url: ZONE_PATH, method: 'GET', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
      {
        url: `${RULES_PATH}/managed-id`,
        method: 'PATCH',
        body: { ...rule, position: { after: '' } },
      },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
    ]);
  });

  it('adopts exactly one legacy description-only rule with a PATCH that leaves its ref alone', async () => {
    const rule = buildCorpusCacheRule();
    const legacy = { ...rule, id: 'legacy-id', expression: '(http.host eq "stale")' };
    delete legacy.ref;
    const { ref: _ref, ...ruleWithoutRef } = rule;
    // Cloudflare echoes the default ref (the id) back; that must read as current.
    const adopted = { ...rule, id: 'legacy-id', ref: 'legacy-id' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '8', rules: [legacy] }),
      cloudflareResponse(adopted),
      cloudflareResponse({ id: 'ruleset-id', version: '9', rules: [adopted] }),
    ]);
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls, [
      { url: ZONE_PATH, method: 'GET', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
      { url: `${RULES_PATH}/legacy-id`, method: 'PATCH', body: ruleWithoutRef },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
    ]);
  });

  it('re-expresses the live #7659 rule without touching its Cloudflare-default ref', async () => {
    // The exact shape the zone held on 2026-09-05: our description, ref === id,
    // the old expression, sitting last. The first attempt sent `ref` and
    // Cloudflare answered 400 / 20142 "expected the reference to be empty".
    const rule = buildCorpusCacheRule();
    const { ref: _ref, ...ruleWithoutRef } = rule;
    const live = {
      ...rule,
      id: '7a9b6e5ba37940ecb103d9063db3a5f2',
      ref: '7a9b6e5ba37940ecb103d9063db3a5f2',
      expression: '(http.host eq "the #7659 expression")',
    };
    const bypass = {
      id: 'bypass-id',
      description: 'Bypass cache - WWW documents',
      action: 'set_cache_settings',
      action_parameters: { cache: false },
      enabled: true,
    };
    const after = { ...live, expression: rule.expression };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '59', rules: [bypass, live] }),
      cloudflareResponse(after),
      cloudflareResponse({ id: 'ruleset-id', version: '60', rules: [bypass, after] }),
    ]);
    const stdout = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: stdout.stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls[2], {
      url: `${RULES_PATH}/${live.id}`,
      method: 'PATCH',
      body: ruleWithoutRef,
    });
    assert.ok(!('position' in intercepted.calls[2].body), 'already last: no move');
    assert.match(stdout.chunks.join(''), /applied \(update\)/);
  });

  it('creates a missing rule with POST and verifies the result', async () => {
    const rule = buildCorpusCacheRule();
    const other = { id: 'other-id', description: 'unrelated', action: 'skip', enabled: true };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '1', rules: [other] }),
      cloudflareResponse({ ...rule, id: 'managed-id' }),
      cloudflareResponse({ id: 'ruleset-id', version: '2', rules: [other, { ...rule, id: 'managed-id' }] }),
    ]);
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls, [
      { url: ZONE_PATH, method: 'GET', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
      { url: RULES_PATH, method: 'POST', body: rule },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
    ]);
  });

  it('retires the entry rule with a DELETE only after its documents are claimed (#7804)', async () => {
    // Order matters: the PATCH that claims / and /dashboard lands first, so the
    // two URLs are never without an eligible rule in between. Then the zone is
    // re-read, the entry rule goes, and the last read confirms one guarded rule.
    const rule = buildCorpusCacheRule();
    const { ref: _ref, ...ruleWithoutRef } = rule;
    const bypass = { id: 'bypass-id', description: 'Bypass cache - WWW documents', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    const entry = retiredEntryRule();
    const live = { ...rule, id: 'corpus-id', ref: 'corpus-id', expression: '(http.host eq "the #7747 expression")' };
    const claimed = { ...live, expression: rule.expression };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [bypass, entry, live] }),
      cloudflareResponse(claimed),
      cloudflareResponse({ id: 'ruleset-id', version: '63', rules: [bypass, entry, claimed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '64', rules: [bypass, claimed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '64', rules: [bypass, claimed] }),
    ]);
    const stdout = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: stdout.stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls, [
      { url: ZONE_PATH, method: 'GET', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
      { url: `${RULES_PATH}/corpus-id`, method: 'PATCH', body: ruleWithoutRef },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
      { url: `${RULES_PATH}/entry-id`, method: 'DELETE', body: undefined },
      { url: ENTRYPOINT_PATH, method: 'GET', body: undefined },
    ]);
    const out = stdout.chunks.join('');
    assert.match(
      out,
      /retiring "WWW entry HTML - use origin CDN cache headers" \(entry-id\): \(http\.host eq "www\.worldmonitor\.app"/,
      'the deleted expression is logged: it is recorded nowhere else once it is gone',
    );
    assert.match(out, /applied \(update, retired 1\)/);
  });

  it('creates a missing managed rule before retiring its predecessor', async () => {
    const rule = buildCorpusCacheRule();
    const bypass = { id: 'bypass-id', description: 'Bypass cache - WWW documents', action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true };
    const entry = retiredEntryRule();
    const managed = { ...rule, id: 'corpus-id' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '1', rules: [bypass, entry] }),
      cloudflareResponse(managed),
      cloudflareResponse({ id: 'ruleset-id', version: '2', rules: [bypass, entry, managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '3', rules: [bypass, managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '3', rules: [bypass, managed] }),
    ]);
    const stdout = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: stdout.stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls.map(({ url, method }) => `${method} ${url}`), [
      `GET ${ZONE_PATH}`,
      `GET ${ENTRYPOINT_PATH}`,
      `POST ${RULES_PATH}`,
      `GET ${ENTRYPOINT_PATH}`,
      `DELETE ${RULES_PATH}/entry-id`,
      `GET ${ENTRYPOINT_PATH}`,
    ]);
    assert.match(stdout.chunks.join(''), /applied \(create, retired 1\)/);
  });

  it('retires a leftover entry rule even when the managed rule is already current', async () => {
    const rule = buildCorpusCacheRule();
    const entry = retiredEntryRule();
    const managed = { ...rule, id: 'corpus-id' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [entry, managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [entry, managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '63', rules: [managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '63', rules: [managed] }),
    ]);
    const stdout = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: stdout.stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.deepEqual(intercepted.calls.map(({ url, method }) => `${method} ${url}`), [
      `GET ${ZONE_PATH}`,
      `GET ${ENTRYPOINT_PATH}`,
      `GET ${ENTRYPOINT_PATH}`,
      `DELETE ${RULES_PATH}/entry-id`,
      `GET ${ENTRYPOINT_PATH}`,
    ]);
    assert.match(stdout.chunks.join(''), /applied \(retired 1\)/);
  });

  it('stops before the DELETE when the retired rule changed since planning', async () => {
    // A DELETE is by id and this script cannot undo it. Between the plan and
    // the delete somebody edited the rule in the dashboard — same id and, since
    // Cloudflare never lets a ref change, the same ref, so it still classifies
    // as retired — and it is no longer the rule the plan was made against.
    const rule = buildCorpusCacheRule();
    const entry = retiredEntryRule();
    const managed = { ...rule, id: 'corpus-id' };
    const takenOver = {
      ...entry,
      description: 'Homepage cache (dashboard)',
      expression: '(http.host eq "www.worldmonitor.app" and http.request.uri.path eq "/pricing")',
      last_updated: '2026-09-06T14:00:00Z',
    };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [entry, managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '63', rules: [takenOver, managed] }),
    ]);
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.equal(intercepted.calls.length, 3, 'no DELETE');
    assert.match(stderr.chunks.join(''), /not deleting entry-id: the rule changed since planning/);
  });

  it('treats a retired rule that vanished between plan and delete as already done', async () => {
    // A concurrent --apply or a hand delete reached the wanted state first; the
    // second run must not fail on it (and must not report a deletion it did not make).
    const rule = buildCorpusCacheRule();
    const managed = { ...rule, id: 'corpus-id' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [retiredEntryRule(), managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '63', rules: [managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '63', rules: [managed] }),
    ]);
    const stdout = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: stdout.stream,
      stderr: outputSink().stream,
    });

    assert.equal(code, 0);
    assert.ok(!intercepted.calls.some(({ method }) => method === 'DELETE'), 'nothing left to delete');
    const out = stdout.chunks.join('');
    assert.match(out, /already retired: entry-id is no longer in the zone/);
    assert.match(out, /no change: "WWW corpus HTML - use origin CDN cache headers" already matches \(ruleset version 63\)/);
  });

  it('--check goes red on a leftover entry rule alone', async () => {
    const rule = buildCorpusCacheRule();
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [retiredEntryRule(), { ...rule, id: 'corpus-id' }] }),
    ]);
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--check'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.equal(intercepted.calls.length, 2);
    assert.match(stderr.chunks.join(''), /drift \(drifted\): retired rule "WWW entry HTML/);
  });

  it('refuses to write past an unnamed earlier claimant', async () => {
    const rule = buildCorpusCacheRule();
    const stray = retiredEntryRule({ id: 'stray', ref: 'stray', description: 'Homepage cache (dashboard)' });
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [stray, { ...rule, id: 'corpus-id' }] }),
    ]);
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.equal(intercepted.calls.length, 2, 'no write');
    assert.match(stderr.chunks.join(''), /refusing to write: an earlier cache rule at position 0 \("Homepage cache \(dashboard\)"\)/);
  });

  it('returns failure and stops when a DELETE fails', async () => {
    const rule = buildCorpusCacheRule();
    const entry = retiredEntryRule();
    const managed = { ...rule, id: 'corpus-id' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [entry, managed] }),
      cloudflareResponse({ id: 'ruleset-id', version: '62', rules: [entry, managed] }),
      cloudflareResponse(null, { status: 500, success: false, errors: [{ message: 'delete failed' }] }),
    ]);
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.equal(intercepted.calls.length, 4);
    assert.match(stderr.chunks.join(''), /Cloudflare DELETE .* failed \(500\).*delete failed/);
  });

  it('names the request when the transport fails mid-apply', async () => {
    // A timeout on a write is ambiguous — it may have landed — so the operator
    // needs to know which request to re-read for.
    const rule = buildCorpusCacheRule();
    const edited = { ...rule, id: 'managed-id', expression: '(http.host eq "wrong.example")' };
    const responses = [
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '2', rules: [edited] }),
    ];
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: async () => {
        if (responses.length) return responses.shift();
        throw new Error('The operation was aborted due to timeout');
      },
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.match(stderr.chunks.join(''), /Cloudflare PATCH .*\/rules\/managed-id did not complete \(a write may still have landed\): The operation was aborted due to timeout/);
  });

  it('returns failure and stops when a PATCH fails', async () => {
    const rule = buildCorpusCacheRule();
    const edited = { ...rule, id: 'managed-id', expression: '(http.host eq "wrong.example")' };
    const intercepted = interceptedFetch([
      cloudflareResponse({ id: 'zone-id', name: 'worldmonitor.app' }),
      cloudflareResponse({ id: 'ruleset-id', version: '2', rules: [edited] }),
      cloudflareResponse(null, { status: 500, success: false, errors: [{ message: 'write failed' }] }),
    ]);
    const stderr = outputSink();
    const code = await runCloudflareCacheRule(['--apply'], {
      env: RUN_ENV,
      fetchImpl: intercepted.fetchImpl,
      stdout: outputSink().stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.equal(intercepted.calls.length, 3);
    assert.deepEqual(intercepted.calls.at(-1), {
      url: `${RULES_PATH}/managed-id`,
      method: 'PATCH',
      body: rule,
    });
    assert.match(stderr.chunks.join(''), /Cloudflare PATCH .* failed \(500\).*write failed/);
  });
});
