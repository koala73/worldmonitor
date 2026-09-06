#!/usr/bin/env node
/**
 * The Cloudflare cache rule that makes the crawlable corpus edge-cacheable (#7659).
 *
 * ## Why a rule, when the origin header is already right
 *
 * Every corpus route answers with `CDN-Cache-Control: public, s-maxage=600,
 * stale-while-revalidate=60` — tests/deploy-config.test.mjs has asserted that on
 * every family for a while. Production still answered `cf-cache-status: DYNAMIC`
 * on 14/14 sampled routes, and CrUX TTFB sat flat at ~725 ms across 25 windows.
 *
 * The cause is a zone cache rule, "Bypass cache - WWW documents", that sets
 * `cache: false` for every extensionless/HTML path on www.worldmonitor.app. Once
 * a cache rule declares a response ineligible, origin cache headers get no vote,
 * so no vercel.json change can reach this. The zone already contains the shape of
 * the answer: "WWW entry HTML - use origin CDN cache headers" sits after the
 * bypass and is why `/` and `/dashboard` — and only those two — ever report HIT.
 *
 * This script generates the same shape for the corpus families, derived from
 * CONTENT_CORPUS_PREFIXES so the rule cannot drift away from the header rules it
 * mirrors. Cloudflare evaluates every matching rule in the cache phase in order
 * and the last one to set a field wins, so the rule is appended: placed before
 * the bypass it would be silently inert.
 *
 * #7747 widened the same rule to the rest of the sitemap-declared document
 * surface, which the bypass had kept DYNAMIC for the same reason: the blog
 * (Astro static output under /blog/), the Mintlify-proxied docs (/docs/), and
 * the root agent text files (/llms.txt, /world-monitor.md, ...). Each needs BOTH
 * halves — the CDN-Cache-Control header in vercel.json for the TTL and a claim
 * here for eligibility. The issue's own diagnosis ("the header is the
 * discriminator") was a correlation: header and rule were derived from the same
 * prefix list, so every route had both or neither.
 *
 * #7804 folded `/` and `/dashboard` in as well and retired the dashboard-managed
 * "WWW entry HTML" rule that had been their answer. That rule set `cache: true`
 * for any query-free GET of the two URLs with none of the guards below, one
 * position before this rule — and Cloudflare takes the LAST matching writer of a
 * field, so a request this rule's guard rejected (`Accept: text/markdown`, which
 * Vercel answers with a markdown rendering of the homepage under the same
 * cacheable header) still found `cache: true` one rule earlier. The guard was
 * inert on the two busiest URLs on the site. A sibling rule outside the
 * generator is invisible to `--check`, so the generator now knows which rules it
 * has superseded (RETIRED_CACHE_RULES) and `--apply` deletes them once the claim
 * has landed.
 *
 * ## Representations Cloudflare cannot tell apart
 *
 * Several of these URLs answer with more than one body. Vercel converts any HTML
 * document to markdown for `Accept: text/markdown` (corpus and blog; the response
 * carries `Vary: accept`); Mintlify does the same for `text/markdown` and
 * `text/plain`, serves an RSC flight for `RSC: 1` or the `next-router-*`
 * headers, and both match media types case-insensitively (measured 2026-09-05:
 * `Accept: TEXT/MARKDOWN` answers text/markdown on both origins). Cloudflare keys
 * its cache on the URL and documents honouring `Vary` only for Accept-Encoding;
 * nothing in the zone configures otherwise. So the rule admits a request for an
 * HTML document only when it asks for it the way browsers and crawlers do — no
 * RSC headers, no markdown/plain/x-component media type in any Accept value
 * (Accept is list-typed and may arrive as several header lines; the origins
 * honour the combined list, so every value is inspected). Negotiating requests
 * fall through to the bypass and stay DYNAMIC, and nothing is stored that a
 * differently-negotiating client could be handed.
 *
 * Files with a `.md`, `.txt` or `.xml` extension are exempt from that guard: the
 * markdown twins (`/countries/iran.md`, `/docs/documentation.md`), the root agent
 * files, feeds and sitemaps answer the same body for every Accept value and for
 * `RSC: 1` (measured 2026-09-05). Guarding them would push the clients most
 * likely to advertise their media type — agents sending `Accept: text/plain` or
 * `text/markdown` — off the cache these files exist to serve.
 *
 * The homepage has one more representation that no Accept value selects:
 * middleware.ts rewrites `GET /` to /home.md for the User-Agents listed in
 * shared/agent-request-policy.json (`Vary: User-Agent`, `no-store`). The
 * no-store keeps that markdown out of the edge; the problem is the other
 * direction. Cloudflare answers from the stored browser HTML before the
 * middleware runs and ignores Vary: User-Agent, so on a warm edge server a
 * crawler never sees its document. Those requests are carved out of the `/`
 * claim alone: /dashboard and the corpus answer one body whatever the UA, and
 * the AI crawlers are the audience the corpus cache exists to serve.
 *
 * ## Safety of caching these documents at a shared edge
 *
 * The corpus is written at build time by scripts/build-crawlable-corpus.mjs and
 * is byte-identical across audiences — verified on production before this rule
 * landed: `/countries/iran/` returned the same md5 for GPTBot, a browser UA, and
 * a request carrying a session cookie. Vercel already serves these from a shared
 * cache (`x-vercel-cache: HIT` under the public `s-maxage=600`), so a second
 * shared cache in front of it exposes nothing new. Non-2xx responses are
 * excluded because a 404 under a corpus prefix is rendered per-request by
 * middleware.ts, and query-bearing URLs are excluded because they reach a
 * User-Agent-dependent 308 there.
 *
 * ## Usage
 *
 *   node scripts/cloudflare-cache-rule.mjs --print   # the generated rule, no network
 *   node scripts/cloudflare-cache-rule.mjs --check   # compare against the live zone; exit 1 on drift
 *   node scripts/cloudflare-cache-rule.mjs --apply   # idempotent upsert into the zone
 *
 * `--check` and `--apply` need `CLOUDFLARE_API_TOKEN` carrying **Zone > Cache
 * Rules > Edit on worldmonitor.app**. That is NOT the `CLOUDFLARE_API_TOKEN`
 * .github/workflows/deploy-worker.yml uses: that secret is scoped to Workers
 * Scripts:Edit + Workers Routes:Edit (see its header comment) and will fail here.
 * Wiring this into CI means provisioning a separate, cache-rules-scoped token.
 * Locally, `CLOUDFLARE_ALL_ACCESS_TOKEN` is accepted as a fallback because that
 * is what .env.local carries — note it is account-wide, so a mistake here runs
 * with far more Cloudflare authority than the task needs. Set exactly one token;
 * the script refuses to guess when both variables are present.
 *
 * `--apply` touches only this one rule and the rules it has superseded
 * (RETIRED_CACHE_RULES), then re-reads the zone to confirm it actually wins.
 * Cloudflare keeps prior ruleset versions, so a bad apply is also recoverable
 * from the dashboard's ruleset history.
 */

import { pathToFileURL } from 'node:url';

import { CONTENT_CORPUS_PREFIXES } from './discover-content-corpus-pages.mjs';
import agentRequestPolicy from './shared/agent-request-policy.json' with { type: 'json' };

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

const ZONE_NAME = 'worldmonitor.app';

/** Apex and the variant subdomains serve different documents from these paths. */
export const CORPUS_HOST = 'www.worldmonitor.app';

/**
 * The document families the rule claims by prefix. The corpus families are the
 * build-time static HTML from scripts/build-crawlable-corpus.mjs; `blog` is the
 * Astro output copied to public/blog; `docs` is the Mintlify proxy behind the
 * `/docs/:match*` rewrite. Each has a vercel.json header rule carrying the same
 * CDN-Cache-Control, and tests/cloudflare-cache-rule.test.mjs fails when the two
 * lists disagree.
 */
export const EDGE_CACHED_FAMILIES = Object.freeze([...CONTENT_CORPUS_PREFIXES, 'blog', 'docs']);

/**
 * Paths under a family that must stay outside this rule.
 *
 * blog: the hashed bundles, OG images and post images already belong to the
 *   zone's older "Blog" rule (month-long override TTL). Claiming them here would
 *   make this rule the last writer of `edge_ttl` for those URLs and replace that
 *   month with "respect origin" — which, for Vercel's static default of
 *   `max-age=0, must-revalidate`, means an origin round-trip on every request.
 * docs: `/docs/mcp` is the docs MCP server (api/docs-mcp.ts — no-store JSON-RPC
 *   over GET and POST), and `/docs/_*` is Mintlify's own asset and API space
 *   (`/docs/_next/…`, `/docs/_mintlify/…`). Neither is a document.
 */
export const FAMILY_EXCLUSIONS = Object.freeze({
  blog: Object.freeze({ prefixes: Object.freeze(['_astro/', 'og/', 'images/']), exact: Object.freeze([]) }),
  docs: Object.freeze({ prefixes: Object.freeze(['_', 'mcp/']), exact: Object.freeze(['mcp']) }),
});

/**
 * Families whose bare path has no vercel.json header rule to mirror. `/docs` is a
 * 307 to `/docs/documentation` and nothing more; the corpus bare forms are 308s
 * too, but they carry a header rule, and `/blog` is the blog index itself.
 */
const FAMILIES_WITHOUT_BARE_RULE = new Set(['docs']);

/**
 * Root-level agent-facing text files: single-representation static files in
 * public/ that vercel.json already serves `public, max-age=3600` with a canonical
 * Link. Their extensions (.txt, .md) are not in Cloudflare's default-cacheable
 * list and two of them are named in the bypass rule outright, so they need the
 * claim as much as the HTML does. /llms.txt and /world-monitor.md are the
 * AI-crawler entry points; the rest are the markdown pages those files link to.
 */
export const AGENT_TEXT_FILES = Object.freeze([
  'llms.txt',
  'llms-full.txt',
  'agent.txt',
  'home.md',
  'world-monitor.md',
  'agents.md',
  'ai-search.md',
  'api-versioning.md',
  'auth.md',
  'developers.md',
  'mcp-server.md',
  'openapi.md',
  'pricing.md',
  'sdks.md',
  'support.md',
]);

/** Request headers whose presence makes Mintlify answer with an RSC flight instead of the document. */
export const RSC_REQUEST_HEADERS = Object.freeze([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
]);

/**
 * Accept media types that make an origin answer with something other than the
 * HTML document: Vercel and Mintlify both negotiate `text/markdown`, Mintlify
 * also `text/plain`, and `text/x-component` is the RSC flight's own type.
 */
export const NEGOTIATED_MEDIA_TYPES = Object.freeze(['text/markdown', 'text/plain', 'text/x-component']);

/**
 * Path extensions whose response is the same body whatever the request asks for,
 * so the representation guard does not apply: markdown twins, the root agent
 * files, RSS and sitemaps. An allowlist rather than "anything with an extension"
 * so a document slug that happens to contain a dot (`/docs/v1.2`) keeps the guard.
 */
export const SINGLE_REPRESENTATION_EXTENSIONS = Object.freeze(['md', 'txt', 'xml']);

/**
 * The two app-shell documents the dashboard-managed "WWW entry HTML" rule used
 * to cache with no representation guard (#7804). Both carry the shared 600s
 * header in vercel.json, both answer a markdown rendering for
 * `Accept: text/markdown` under that same header (measured 2026-09-06 through
 * the query-bearing form, which every rule keeps on the bypass), and both are
 * claimed here so the guard block gates them like every other HTML document.
 * `/dashboard.html`, the rewrite destination behind `/dashboard`, is not a URL
 * anyone is sent to and stays out.
 */
export const ENTRY_DOCUMENTS = Object.freeze(['/', '/dashboard']);

/**
 * Entry documents whose body also varies by User-Agent: middleware.ts rewrites
 * `GET /` to /home.md for the declared AI agents. See the header comment for
 * why those requests must stay out even though the origin says no-store.
 */
export const USER_AGENT_ROUTED_DOCUMENTS = Object.freeze(['/']);

/** The User-Agents middleware.ts routes to markdown, lowercased for `lower(http.user_agent)`. */
export const AGENT_USER_AGENTS = Object.freeze(agentRequestPolicy.userAgents.map((agent) => agent.toLowerCase()));

/**
 * Cache-phase rules this rule has superseded. `--check` reports one still in
 * the zone as drift and `--apply` deletes it after the managed rule is in place.
 * Matched by ref, or by description when the live rule carries Cloudflare's
 * default ref (its own id): a rule that shares the description but has a ref of
 * its own belongs to somebody, and is reported as a collision, never deleted.
 *
 * "WWW entry HTML": the rule for `/` and `/dashboard`, whose unguarded
 *   `cache: true` outranked this rule's guard on those URLs (#7804). Read from
 *   the zone 2026-09-06: position 10 of 12, ref `www_entry_html_origin_cache`.
 * "Agent homepage Markdown": the UA-keyed bypass scripts/cloudflare-agent-
 *   readiness.mjs used to append LAST for the same crawlers the `/` claim now
 *   carves out. Absent from the zone on the same read (never applied), but two
 *   scripts each insisting on the last position would move each other's rule
 *   on every run.
 *
 * These two are the rules that were wrong. The invariant they broke is wider —
 * no earlier cache-enabling rule may claim a URL this rule owns — and
 * diffLiveRuleset checks that structurally as well (earlierUnguardedWriters),
 * so a third such rule under a new name is reported and blocks --apply without
 * being listed here.
 */
export const RETIRED_CACHE_RULES = Object.freeze([
  Object.freeze({ description: 'WWW entry HTML - use origin CDN cache headers', ref: 'www_entry_html_origin_cache' }),
  Object.freeze({ description: 'Agent homepage Markdown - bypass shared HTML cache', ref: 'www_agent_markdown_cache_bypass' }),
]);

const CORPUS_CACHE_RULE_DESCRIPTION = 'WWW corpus HTML - use origin CDN cache headers';

/** Stable ruleset identity, independent of dashboard description edits. */
const CORPUS_CACHE_RULE_REF = 'www_corpus_html_origin_cache';

/** The cache-phase ruleset both this rule and the pre-existing bypass live in. */
const CACHE_PHASE = 'http_request_cache_settings';

/**
 * Build the wirefilter expression for the corpus families.
 *
 * Both forms of each family are claimed (FAMILIES_WITHOUT_BARE_RULE lists the
 * exception). The nested form is what crawlers fetch; a corpus bare form is a 308
 * to the trailing-slash canonical and is not cached either way, but omitting it
 * would leave the rule describing a smaller surface than the vercel.json header
 * rule it mirrors, which is how the two drift apart.
 *
 * `starts_with` also claims the non-HTML members of each family — chiefly the
 * agent-facing markdown twins (`/countries/iran.md`). That is deliberate, though
 * not for the reason the HTML is safe: a `.md` twin is NOT static build output.
 * vercel.json rewrites `/:path.md` to the `/api/md-twin` edge handler, which is a
 * pure function of the path — api/_md-url-twin.ts forwards no auth, cookie or UA,
 * fixes its outbound Accept, and answers `public, max-age=3600`, with `no-store`
 * on every failure branch. Its one declared `Vary` is the internal loop guard
 * `x-wm-md-twin`, which Cloudflare ignores but which cannot reach a cached entry
 * anyway: only a `.md` URL reaches the handler, and the handler's own outbound
 * fetch targets the sibling non-`.md` page. AI crawlers are the audience this
 * whole change exists to serve, and production confirms `/countries/iran.md`
 * answers 200 `text/markdown` from a Cloudflare HIT.
 */
function buildCorpusCacheExpression({
  families = EDGE_CACHED_FAMILIES,
  exclusions = FAMILY_EXCLUSIONS,
  files = AGENT_TEXT_FILES,
  documents = ENTRY_DOCUMENTS,
  userAgentRouted = USER_AGENT_ROUTED_DOCUMENTS,
  agents = AGENT_USER_AGENTS,
} = {}) {
  const path = 'http.request.uri.path';
  const bare = families
    .filter((family) => !FAMILIES_WITHOUT_BARE_RULE.has(family))
    .map((family) => `"/${family}"`)
    .join(' ');
  const nested = families.map((family) => {
    const excluded = exclusions[family];
    if (!excluded) return `    or starts_with(${path}, "/${family}/")`;
    const carveOuts = [
      ...excluded.exact.map((exact) => `${path} ne "/${family}/${exact}"`),
      ...excluded.prefixes.map((prefix) => `not starts_with(${path}, "/${family}/${prefix}")`),
    ];
    return [
      `    or (starts_with(${path}, "/${family}/")`,
      ...carveOuts.map((clause) => `      and ${clause}`),
      '    )',
    ].join('\n');
  });
  const agentFiles = files.map((file) => `"/${file}"`).join(' ');
  // The entry documents, exact. The homepage carves out the agents middleware.ts
  // routes to markdown: lower() because the middleware matches the UA
  // case-insensitively, and `contains` because it is the wider net — excluding
  // a request only costs a cache hit, admitting one hands a crawler browser HTML.
  const entryDocuments = documents.map((document) => {
    // An empty agent list must not emit an empty `and not ( )` group, which
    // Cloudflare rejects; it simply means there is nobody to carve out.
    if (!userAgentRouted.includes(document) || !agents.length) return `    or ${path} eq "${document}"`;
    const carveOuts = agents.map(
      (agent, index) => `        ${index ? 'or ' : ''}lower(http.user_agent) contains "${agent}"`,
    );
    return [
      `    or (${path} eq "${document}"`,
      '      and not (',
      ...carveOuts,
      '      )',
      '    )',
    ].join('\n');
  });
  // Presence of an RSC header is tested through the `http.request.headers[...]`
  // map, whose keys are the lowercased names, NOT through
  // `http.request.headers.names[*] == "rsc"`: that array keeps the sender's
  // casing, and HTTP/1.1 clients send it verbatim (Node's fetch puts `RSC: 1` on
  // the wire as-is; only HTTP/2 lowercases). Measured 2026-09-06: with the names
  // form, `RSC: 1` was MISS on /docs/documentation and stored the flight under
  // the HTML URL, so every later plain request got text/x-component from the
  // edge until a zone purge; `rsc: 1` was DYNAMIC. The live sweep sends `RSC: 1`
  // through fetch() and had been reading the cached HTML for the same reason.
  // Accept values keep their case and both origins match media types
  // case-insensitively, hence lower().
  // Accept is a list-typed header that may arrive as several lines, and Cloudflare
  // exposes each line as one array element; the origins honour the combined list
  // (`Accept: text/markdown` on a second line still yields markdown), so every
  // element is inspected — `[0]` alone would admit a request whose first line is
  // harmless and whose second asks for markdown.
  const noRscFlight = RSC_REQUEST_HEADERS.map(
    (name) => `      and not any(http.request.headers["${name}"][*] != "")`,
  );
  const noNegotiation = NEGOTIATED_MEDIA_TYPES.map(
    (type) => `      and not any(lower(http.request.headers["accept"][*])[*] contains "${type}")`,
  );
  const singleRepresentation = SINGLE_REPRESENTATION_EXTENSIONS.map((ext) => `"${ext}"`).join(' ');
  // The first `and not` opens the conjunction after `or (`; strip its leading
  // operator so the block reads `or (not any(...) and not any(...) ...)`.
  const [firstGuard, ...restGuards] = [...noRscFlight, ...noNegotiation];
  return [
    `(http.host eq "${CORPUS_HOST}"`,
    '  and http.request.method eq "GET"',
    // middleware.ts answers a bot-UA request carrying utm_*/ref with a 308 to the
    // clean URL under `Vary: User-Agent`. Cloudflare honours Vary only for
    // Accept-Encoding, so caching the query-bearing variants risks replaying a
    // crawler's redirect to a human and stripping `ref` before referral capture.
    '  and http.request.uri.query eq ""',
    // The representations an HTML document URL can answer with besides the
    // document; see the header comment. A request that negotiates is not cached,
    // not served from cache, and reaches the origin exactly as it did before this
    // rule. Single-representation files skip the guard entirely.
    '  and (',
    `    http.request.uri.path.extension in {${singleRepresentation}}`,
    `    or (${firstGuard.trim().replace(/^and /, '')}`,
    ...restGuards,
    '    )',
    '  )',
    '  and (',
    `    ${path} in {${bare}}`,
    ...nested,
    `    or ${path} in {${agentFiles}}`,
    ...entryDocuments,
    '  ))',
  ].join('\n');
}

/**
 * The full rule object, in the shape the rulesets API expects inside `rules[]`.
 *
 * `action_parameters` keeps the cache policy the retired entry-HTML rule proved
 * on `/` rather than inventing a second one: one edge TTL, owned by the origin
 * header.
 */
export function buildCorpusCacheRule(surface = {}) {
  return {
    ref: CORPUS_CACHE_RULE_REF,
    description: CORPUS_CACHE_RULE_DESCRIPTION,
    expression: buildCorpusCacheExpression(surface),
    action: 'set_cache_settings',
    action_parameters: {
      cache: true,
      browser_ttl: { mode: 'respect_origin' },
      edge_ttl: {
        // "Use the origin's cache headers, bypass when there are none." The
        // origin sends s-maxage=600 with stale-while-revalidate=60, so honouring
        // it gets revalidation for free and keeps one TTL under one owner.
        mode: 'bypass_by_default',
        status_code_ttl: [
          // -1 is Cloudflare's no-store; 0 is its no-cache, which STORES the
          // response and revalidates. The entry-HTML rule this one replaced
          // used 0 here, and production showed the effect: a 404 under a corpus
          // prefix sat at `cf-cache-status: MISS` on every request rather than
          // DYNAMIC — stored, not excluded. A 404 under these prefixes can be
          // produced by middleware.ts's originNotFoundResponse, which negotiates
          // on Accept (markdown for agents, HTML for browsers) while Cloudflare
          // honours Vary only for Accept-Encoding, so it must not be stored at all.
          { status_code_range: { from: 300, to: 499 }, value: -1 },
          { status_code_range: { from: 500 }, value: -1 },
        ],
      },
    },
    enabled: true,
  };
}

/**
 * Deep-compare two values independently of object key order.
 *
 * Cloudflare re-serialises `action_parameters` alphabetically, so a plain
 * `JSON.stringify` comparison reports drift on a rule that was just applied
 * unchanged — observed on the very first `--check` after this rule landed.
 *
 * scripts/openapi-inject-jmespath.mjs has its own copy of this shape. Two copies
 * of a ten-line pure function in unrelated one-off scripts is under the bar for a
 * shared module here: a new file under scripts/shared/ has to be threaded through
 * the Railway registry closure and the Dockerfile.relay COPY list, which is real
 * deployment risk for no behavioural gain. A third copy is the signal to extract.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identifies this caller in Cloudflare's audit log; AGENTS.md requires it on server-side fetches. */
const USER_AGENT = 'WorldMonitor Cloudflare Cache Rule/1.0';

/** Matches the ceiling scripts/_kv-storage.mjs uses for its Cloudflare API writes. */
const REQUEST_TIMEOUT_MS = 15_000;

export async function cloudflareRequest(
  path,
  {
    token,
    method = 'GET',
    body,
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchImpl = (...args) => globalThis.fetch(...args),
  } = {},
) {
  // A hung API call must not park an `--apply` between the read and the write
  // forever; fail loudly instead so the operator can retry against a fresh read.
  let response;
  try {
    response = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A timeout or transport failure on a write is ambiguous — the write may
    // still have landed — so name the request the operator has to re-read for.
    throw new Error(`Cloudflare ${method} ${path} did not complete (a write may still have landed): ${error.message}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const detail = JSON.stringify(payload?.errors ?? payload ?? response.statusText);
    throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload.result;
}

export async function resolveZoneId(token, { env = process.env, fetchImpl } = {}) {
  if (env.CLOUDFLARE_ZONE_ID) {
    // Never take the id on trust. The credential that actually runs this locally
    // is account-wide, so a stale or mistyped id would aim every write at another
    // zone's cache rules — and the script would report success.
    const zone = await cloudflareRequest(`/zones/${encodeURIComponent(env.CLOUDFLARE_ZONE_ID)}`, {
      token,
      fetchImpl,
    });
    if (zone?.name !== ZONE_NAME) {
      throw new Error(
        `CLOUDFLARE_ZONE_ID ${env.CLOUDFLARE_ZONE_ID} is zone "${zone?.name ?? 'unknown'}", not ${ZONE_NAME}`,
      );
    }
    return zone.id;
  }
  const zones = await cloudflareRequest(`/zones?name=${encodeURIComponent(ZONE_NAME)}`, { token, fetchImpl });
  const zone = zones?.[0];
  if (!zone) throw new Error(`no Cloudflare zone named ${ZONE_NAME} is visible to this token`);
  return zone.id;
}

export function resolveToken(env = process.env) {
  const tokens = [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ALL_ACCESS_TOKEN].filter(Boolean);
  if (tokens.length !== 1) {
    throw new Error(
      tokens.length
        ? 'set exactly one of CLOUDFLARE_API_TOKEN or CLOUDFLARE_ALL_ACCESS_TOKEN, not both'
        : 'exactly one of CLOUDFLARE_API_TOKEN or CLOUDFLARE_ALL_ACCESS_TOKEN is required for --check and --apply',
    );
  }
  return tokens[0];
}

/**
 * Whether a live rule carries a ref somebody chose, as opposed to Cloudflare's
 * default. Cloudflare fills an unset `ref` with the rule's own id, and — learned
 * from the live zone while landing #7747 — refuses to change it afterwards: a
 * PATCH that sends a new `ref` for such a rule fails with error 20142, "expected
 * the reference to be empty". A ref is only ever accepted at creation. So a rule
 * adopted by description keeps its default ref for life, and a default ref is
 * identity to adopt, never drift to repair.
 */
const hasOwnRef = (entry) => Boolean(entry.ref) && entry.ref !== entry.id;

/** `rule` without its `ref`, for a PATCH to a rule whose ref Cloudflare will not let us set. */
function withoutRef(rule) {
  const { ref: _ref, ...rest } = rule;
  return rest;
}

function identifyLiveRule(rules, rule) {
  const entries = (rules ?? []).map((entry, position) => ({ entry, position }));
  const refMatches = entries.filter(({ entry }) => entry.ref === rule.ref);
  const descriptionMatches = entries.filter(({ entry }) => entry.description === rule.description);
  // A description match whose ref merely echoes its id is a legacy rule to adopt,
  // not a foreign one to refuse. The first corpus rule went live before `ref`
  // existed here and sat in exactly that state; `--check` called it "ambiguous"
  // until #7747.
  const legacyMatches = descriptionMatches.filter(({ entry }) => !hasOwnRef(entry));
  const conflictingDescriptionMatches = descriptionMatches.filter(
    ({ entry }) => hasOwnRef(entry) && entry.ref !== rule.ref,
  );
  const candidates = entries.filter(
    ({ entry }) => entry.ref === rule.ref || entry.description === rule.description,
  );

  if (
    refMatches.length > 1
    || conflictingDescriptionMatches.length > 0
    || (refMatches.length === 1 && candidates.length > 1)
    || (refMatches.length === 0 && legacyMatches.length > 1)
  ) {
    return { status: 'ambiguous', matches: candidates };
  }
  if (refMatches.length === 1) return { status: 'matched', match: refMatches[0] };
  if (legacyMatches.length === 1) return { status: 'matched', match: legacyMatches[0] };
  return { status: 'missing' };
}

const isRetiredRule = (entry) => RETIRED_CACHE_RULES.some(
  (retired) => (Boolean(entry.ref) && entry.ref === retired.ref)
    || (entry.description === retired.description && !hasOwnRef(entry)),
);

/** A rule wearing a retired description under a ref somebody chose: not this script's to delete. */
const isRetiredDescriptionCollision = (entry) => !isRetiredRule(entry)
  && hasOwnRef(entry)
  && RETIRED_CACHE_RULES.some((retired) => entry.description === retired.description);

/** The superseded rules still in the zone, by position, for `--check` to name and `--apply` to delete. */
function retiredRules(rules) {
  return (rules ?? []).flatMap((entry, position) => (
    isRetiredRule(entry) ? [{ id: entry.id, description: entry.description, position }] : []
  ));
}

function retiredDescriptionCollisions(rules) {
  return (rules ?? []).flatMap((entry, position) => (
    isRetiredDescriptionCollision(entry)
      ? [{ id: entry.id, description: entry.description, ref: entry.ref, position }]
      : []
  ));
}

const describeRetired = ({ description, position }) => (
  `retired rule "${description}" is still in the zone at position ${position} and must be deleted`
);

const describeCollision = ({ description, ref, position }) => (
  `the rule at position ${position} carries the retired description "${description}" under its own ref "${ref}";`
  + ' it is not this script\'s to delete — repair the identity collision first'
);

/**
 * The path literals this rule claims, as they appear quoted in a wirefilter
 * expression. Built from the surface model rather than read back from the
 * generated expression, so the carve-outs the expression also quotes
 * (`/blog/_astro/`, `/docs/mcp`) do not count as claims — the zone's static
 * asset rule quotes `/blog/_astro/` legitimately.
 */
function claimedPathLiterals({
  families = EDGE_CACHED_FAMILIES,
  files = AGENT_TEXT_FILES,
  documents = ENTRY_DOCUMENTS,
} = {}) {
  return new Set([
    ...documents,
    ...families.filter((family) => !FAMILIES_WITHOUT_BARE_RULE.has(family)).map((family) => `/${family}`),
    ...families.map((family) => `/${family}/`),
    ...files.map((file) => `/${file}`),
  ]);
}

const quotedPathLiterals = (expression) => (expression.match(/"\/[^"]*"/g) ?? []).map((literal) => literal.slice(1, -1));

/** The hosts an expression names, if it names any; a host-less expression applies to every host. */
function namedHosts(expression) {
  const hosts = [];
  for (const match of expression.matchAll(/http\.host\s+(?:eq\s+"([^"]+)"|in\s+\{([^}]*)\})/g)) {
    if (match[1]) hosts.push(match[1]);
    else for (const literal of match[2].match(/"[^"]+"/g) ?? []) hosts.push(literal.slice(1, -1));
  }
  return hosts;
}

/**
 * Enabled cache-enabling rules BEFORE position `index` that quote a path this
 * rule claims. Cloudflare takes the last matching writer, so on any request
 * this rule's guard declines, such a rule's `cache: true` still wins — exactly
 * how the entry rule reopened the hole on `/` (#7804), and the shape a future
 * dashboard rule would take under any name. Retired rules are excluded (they
 * are deleted, not merely reported) and rules scoped to another host cannot
 * match a www URL. Measured against the 2026-09-06 zone this flags nothing but
 * the entry rule: the static-asset, API, proxy, maps and Blog rules quote no
 * claimed path.
 */
function earlierUnguardedWriters(rules, index, surface = {}) {
  const claimed = claimedPathLiterals(surface);
  const writers = [];
  for (let position = 0; position < Math.min(index, (rules ?? []).length); position += 1) {
    const entry = rules[position];
    if (entry.enabled === false || entry.action !== 'set_cache_settings') continue;
    if (entry.action_parameters?.cache !== true || isRetiredRule(entry)) continue;
    const hosts = namedHosts(entry.expression ?? '');
    if (hosts.length && !hosts.includes(CORPUS_HOST)) continue;
    const overlap = [...new Set(quotedPathLiterals(entry.expression ?? ''))].filter((literal) => claimed.has(literal));
    if (overlap.length) writers.push({ id: entry.id, description: entry.description, position, overlap });
  }
  return writers;
}

const describeEarlierWriter = ({ description, position, overlap }) => (
  `an earlier cache rule at position ${position} ("${description}") enables the cache for`
  + ` ${overlap.map((literal) => `"${literal}"`).join(', ')} without this rule's representation guard`
  + ' and wins whenever the guard declines a request; retire it (RETIRED_CACHE_RULES) or remove it in the dashboard'
);

/**
 * Report how the live zone differs from the generated rule.
 *
 * Ordering is checked as well as content: a later cache-settings rule can
 * override any field it writes even when this rule looks correct in isolation.
 * A superseded rule (RETIRED_CACHE_RULES) is drift wherever it sits: the one
 * that prompted #7804 sat BEFORE this rule, and an earlier writer wins whenever
 * this rule's guard declines a request. The same check runs structurally for
 * any earlier cache-enabling rule that quotes a claimed path, and a retired
 * description under a foreign ref is a collision; both are `blockers` — reported,
 * never written around. `ruleCurrent` says whether the managed rule itself needs
 * a write, independent of any leftover or blocker.
 */
export function diffLiveRuleset(rules, rule = buildCorpusCacheRule()) {
  const identity = identifyLiveRule(rules, rule);
  // Identity first: whatever the managed rule is called today, it is never
  // its own leftover — a PATCH followed by a DELETE of the same id would
  // "apply" the rule out of existence.
  const own = identity.match?.entry.id;
  const retired = retiredRules(rules).filter(({ id }) => id !== own);
  const collisions = retiredDescriptionCollisions(rules).filter(({ id }) => id !== own);
  // With no managed rule in the zone every position is "earlier": the rule
  // would be appended last, and any cache-enabling claimant would sit above it.
  const earlierWriters = earlierUnguardedWriters(rules, identity.match?.position ?? (rules ?? []).length);
  const blockers = [...earlierWriters.map(describeEarlierWriter), ...collisions.map(describeCollision)];
  const leftovers = retired.map(describeRetired);
  const shared = { retired, collisions, earlierWriters, blockers };
  if (identity.status === 'missing') {
    return {
      status: 'missing',
      problems: ['the rule is not in the zone', ...blockers, ...leftovers],
      misordered: false,
      ruleCurrent: false,
      ...shared,
    };
  }
  if (identity.status === 'ambiguous') {
    const positions = identity.matches.map(({ position }) => position).join(', ');
    return {
      status: 'drifted',
      problems: [
        `${identity.matches.length} rules match the managed ref or legacy description (positions ${positions});`
        + ' identity is ambiguous and must be repaired before applying',
        ...blockers,
        ...leftovers,
      ],
      misordered: false,
      ambiguous: true,
      matches: identity.matches,
      ruleCurrent: false,
      ...shared,
    };
  }

  const { entry: live, position: index } = identity.match;
  const problems = [];
  // A default ref (missing, or echoing the id) is not drift: Cloudflare will not
  // let a PATCH change it, so reporting it would make an adopted rule drift
  // forever. A chosen-but-different ref cannot reach here — identifyLiveRule
  // already calls that a conflict — so this line is belt-and-braces.
  if (hasOwnRef(live) && live.ref !== rule.ref) problems.push(`ref is ${live.ref}, expected ${rule.ref}`);
  if (live.description !== rule.description) problems.push('description differs');
  if (live.expression !== rule.expression) problems.push('expression differs');
  if (live.action !== rule.action) problems.push(`action is ${live.action}, expected ${rule.action}`);
  // Exact rather than subset: an extra field Cloudflare stores that we did not
  // ask for is a setting nobody in this repo chose, and reporting it once is
  // cheaper than letting a dashboard edit hide behind a lenient comparison.
  if (stableStringify(live.action_parameters) !== stableStringify(rule.action_parameters)) {
    problems.push('action_parameters differ');
  }
  if (live.enabled === false) problems.push('the rule is disabled');

  const laterWriters = [];
  for (let position = index + 1; position < (rules ?? []).length; position += 1) {
    const entry = rules[position];
    // A retired rule is deleted, not moved below; it is not a reason to reorder.
    if (entry.enabled === false || entry.action !== 'set_cache_settings' || isRetiredRule(entry)) continue;
    const fields = ['cache', 'browser_ttl', 'edge_ttl'].filter(
      (field) => Object.hasOwn(entry.action_parameters ?? {}, field),
    );
    if (fields.length) laterWriters.push({ entry, fields, position });
  }
  for (const { entry, fields, position } of laterWriters) {
    problems.push(
      `the rule sits at ${index}, above an enabled cache-settings rule at ${position}`
      + ` ("${entry.description}") that writes ${fields.join(', ')}`
      + ' and wins on any URL they both match',
    );
  }

  return {
    status: problems.length || blockers.length || retired.length ? 'drifted' : 'current',
    problems: [...problems, ...blockers, ...leftovers],
    index,
    misordered: laterWriters.length > 0,
    ruleCurrent: problems.length === 0,
    ...shared,
  };
}

/**
 * Decide the rule-level operations that reconcile the zone: at most one write
 * to our own rule, plus the deletion of every rule this one has superseded.
 *
 * Deliberately never rewrites the whole ruleset. The phase entrypoint PUT
 * replaces every rule in the phase, so any dashboard edit made between this
 * script's read and its write is reverted silently and without a trace — and
 * that read-modify-write window is exactly when a human is most likely to be in
 * the dashboard looking at the same rules. The per-rule endpoints touch only our
 * own rule and the retired ones, which also means no other rule's user-owned
 * `ref` is ever echoed back or lost.
 */
export function planApply(rules, rule = buildCorpusCacheRule()) {
  const diff = diffLiveRuleset(rules, rule);
  const retire = diff.retired.map(({ id }) => id);
  // Nothing is deleted until identity collisions and foreign claimants are
  // repaired by a human: a write around either would look like success.
  if (diff.ambiguous) {
    return { op: 'duplicates', duplicates: diff.matches.map(({ entry }) => entry.id), retire: [], diff };
  }
  if (diff.blockers.length) return { op: 'blocked', blockers: diff.blockers, retire: [], diff };
  if (diff.status === 'missing') return { op: 'create', retire, diff };
  if (diff.ruleCurrent) return { op: 'none', retire, diff };
  const live = rules[diff.index];
  // Cloudflare accepts position on the per-rule PATCH, so drift and movement are
  // one atomic update that preserves the existing rule id. `refLocked` says the
  // live rule carries Cloudflare's default ref, which a PATCH must not try to
  // replace (see hasOwnRef).
  return { op: 'update', id: live?.id, refLocked: !hasOwnRef(live ?? {}), retire, diff };
}

const MODES = ['--print', '--check', '--apply'];

function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

export async function runCloudflareCacheRule(
  argv,
  {
    env = process.env,
    fetchImpl = (...args) => globalThis.fetch(...args),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  // Without this, `--aply` falls through to `--print` and exits 0 — a silent
  // no-op that reads exactly like a successful apply.
  const unknown = argv.filter((arg) => !MODES.includes(arg));
  if (unknown.length) {
    writeLine(stderr, `unknown argument(s): ${unknown.join(' ')}\nusage: cloudflare-cache-rule.mjs [${MODES.join(' | ')}]`);
    return 2;
  }
  const modes = argv.filter((arg) => MODES.includes(arg));
  if (modes.length > 1) {
    writeLine(stderr, `choose exactly one mode\nusage: cloudflare-cache-rule.mjs [${MODES.join(' | ')}]`);
    return 2;
  }
  const mode = modes[0] ?? '--print';
  const rule = buildCorpusCacheRule();

  if (mode === '--print') {
    writeLine(stdout, JSON.stringify(rule, null, 2));
    return 0;
  }

  try {
    const token = resolveToken(env);
    const zoneId = await resolveZoneId(token, { env, fetchImpl });
    const ruleset = await cloudflareRequest(
      `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`,
      { token, fetchImpl },
    );
    const diff = diffLiveRuleset(ruleset.rules, rule);

    if (mode === '--check') {
      if (diff.status === 'current') {
        writeLine(stdout, `ok: "${rule.description}" is current at position ${diff.index} of ${ruleset.rules.length}`);
        return 0;
      }
      writeLine(stderr, `drift (${diff.status}): ${diff.problems.join('; ')}`);
      return 1;
    }

    if (diff.status === 'current') {
      writeLine(stdout, `no change: "${rule.description}" already matches (ruleset version ${ruleset.version})`);
      return 0;
    }

    const plan = planApply(ruleset.rules, rule);
    if (plan.op === 'duplicates') {
      writeLine(
        stderr,
        `refusing to write: ${plan.duplicates.length} rules match the managed ref or legacy description.`
        + ` Repair the identity collision first (rule ids: ${plan.duplicates.join(', ')}), then re-run.`,
      );
      return 1;
    }
    if (plan.op === 'blocked') {
      writeLine(stderr, `refusing to write: ${plan.blockers.join('; ')}`);
      return 1;
    }
    const rulesPath = `/zones/${zoneId}/rulesets/${ruleset.id}/rules`;
    if (plan.op === 'update') {
      const base = plan.refLocked ? withoutRef(rule) : rule;
      const body = plan.diff.misordered ? { ...base, position: { after: '' } } : base;
      await cloudflareRequest(`${rulesPath}/${plan.id}`, {
        token,
        method: 'PATCH',
        body,
        fetchImpl,
      });
    } else if (plan.op === 'create') {
      await cloudflareRequest(rulesPath, { token, method: 'POST', body: rule, fetchImpl });
    }
    // The claim lands before a superseded rule goes, so the URLs it covered are
    // never without an eligible rule in between. Re-read before deleting: a
    // DELETE is by id and cannot be undone by this script, so a rule that
    // changed since the plan (a dashboard edit in the window) stops the apply
    // rather than being removed on the strength of a stale read. The re-read
    // is compared with the planning snapshot, not re-classified: the ref that
    // identifies a retired rule is immutable, so an edit to its expression or
    // description would still classify as retired and be deleted.
    let retiredCount = 0;
    if (plan.retire.length) {
      const current = await cloudflareRequest(
        `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`,
        { token, fetchImpl },
      );
      const planned = new Map(ruleset.rules.map((entry) => [entry.id, stableStringify(entry)]));
      const targets = plan.retire.map((id) => ({ id, live: current.rules.find((entry) => entry.id === id) }));
      const changed = targets.filter(({ id, live }) => live && stableStringify(live) !== planned.get(id));
      if (changed.length) {
        writeLine(
          stderr,
          `not deleting ${changed.map(({ id }) => id).join(', ')}: the rule changed since planning;`
          + ' the managed rule is in place, re-run --apply against a fresh read to retire the rest',
        );
        return 1;
      }
      // Gone already (a concurrent apply, or a hand delete) is the state wanted.
      for (const { id } of targets.filter(({ live }) => !live)) {
        writeLine(stdout, `already retired: ${id} is no longer in the zone`);
      }
      for (const { id, live } of targets.filter(({ live }) => live)) {
        // Its expression is not recorded anywhere else once it is gone.
        writeLine(stdout, `retiring "${live.description}" (${id}): ${live.expression}`);
        await cloudflareRequest(`${rulesPath}/${id}`, { token, method: 'DELETE', fetchImpl });
        retiredCount += 1;
      }
    }

    // Re-read rather than trusting the write's own echo: the point of this script
    // is that a rule can be present and still not win.
    const after = await cloudflareRequest(
      `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`,
      { token, fetchImpl },
    );
    const verify = diffLiveRuleset(after.rules, rule);
    if (verify.status !== 'current') {
      writeLine(stderr, `applied but the zone still reports drift (${verify.status}): ${verify.problems.join('; ')}`);
      return 1;
    }
    const steps = [
      ...(plan.op === 'none' ? [] : [plan.op]),
      ...(retiredCount ? [`retired ${retiredCount}`] : []),
    ];
    if (!steps.length) {
      writeLine(stdout, `no change: "${rule.description}" already matches (ruleset version ${after.version})`);
      return 0;
    }
    writeLine(
      stdout,
      `applied (${steps.join(', ')}): "${rule.description}" — ruleset version ${ruleset.version} -> ${after.version},`
      + ` ${after.rules.length} rules, position ${verify.index}`,
    );
    return 0;
  } catch (error) {
    writeLine(stderr, error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudflareCacheRule(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
