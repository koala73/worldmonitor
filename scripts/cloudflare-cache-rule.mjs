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
 * with far more Cloudflare authority than the task needs.
 *
 * `--apply` touches only this one rule and then re-reads the zone to confirm it
 * actually wins. Cloudflare keeps prior ruleset versions, so a bad apply is also
 * recoverable from the dashboard's ruleset history.
 */

import { pathToFileURL } from 'node:url';

import { CONTENT_CORPUS_PREFIXES } from './discover-content-corpus-pages.mjs';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

const ZONE_NAME = 'worldmonitor.app';

/** Apex and the variant subdomains serve different documents from these paths. */
export const CORPUS_HOST = 'www.worldmonitor.app';

/**
 * The rule's identity in the zone. `--apply` matches on this string, so renaming
 * it here without renaming it in the dashboard creates a duplicate rule rather
 * than updating the existing one.
 */
const CORPUS_CACHE_RULE_DESCRIPTION = 'WWW corpus HTML - use origin CDN cache headers';

/** The cache-phase ruleset both this rule and the pre-existing bypass live in. */
const CACHE_PHASE = 'http_request_cache_settings';

/**
 * Build the wirefilter expression for the corpus families.
 *
 * Both forms of each family are claimed. The nested form is what crawlers fetch;
 * the bare form is a 308 to the trailing-slash canonical and is not cached either
 * way, but omitting it would leave the rule describing a smaller surface than the
 * vercel.json header rule it mirrors, which is how the two drift apart.
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
function buildCorpusCacheExpression(prefixes = CONTENT_CORPUS_PREFIXES) {
  const bare = prefixes.map((prefix) => `"/${prefix}"`).join(' ');
  const nested = prefixes
    .map((prefix) => `    or starts_with(http.request.uri.path, "/${prefix}/")`)
    .join('\n');
  return [
    `(http.host eq "${CORPUS_HOST}"`,
    '  and http.request.method eq "GET"',
    // middleware.ts answers a bot-UA request carrying utm_*/ref with a 308 to the
    // clean URL under `Vary: User-Agent`. Cloudflare honours Vary only for
    // Accept-Encoding, so caching the query-bearing variants risks replaying a
    // crawler's redirect to a human and stripping `ref` before referral capture.
    '  and http.request.uri.query eq ""',
    '  and (',
    `    http.request.uri.path in {${bare}}`,
    nested,
    '  ))',
  ].join('\n');
}

/**
 * The full rule object, in the shape the rulesets API expects inside `rules[]`.
 *
 * `action_parameters` mirrors the entry-HTML rule already proven on `/` rather
 * than inventing a second cache policy: one edge TTL, owned by the origin header.
 */
export function buildCorpusCacheRule(prefixes = CONTENT_CORPUS_PREFIXES) {
  return {
    description: CORPUS_CACHE_RULE_DESCRIPTION,
    expression: buildCorpusCacheExpression(prefixes),
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
          // response and revalidates. The entry-HTML rule this otherwise mirrors
          // uses 0 here, and production showed the effect: a 404 under a corpus
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

async function cloudflareRequest(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${CLOUDFLARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // A rule DELETE can answer 204 with no body; that is success, not a parse error.
  if (response.status === 204 && response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const detail = JSON.stringify(payload?.errors ?? payload ?? response.statusText);
    throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload.result;
}

async function resolveZoneId(token, env = process.env) {
  if (env.CLOUDFLARE_ZONE_ID) {
    // Never take the id on trust. The credential that actually runs this locally
    // is account-wide, so a stale or mistyped id would aim every write at another
    // zone's cache rules — and the script would report success.
    const zone = await cloudflareRequest(`/zones/${encodeURIComponent(env.CLOUDFLARE_ZONE_ID)}`, { token });
    if (zone?.name !== ZONE_NAME) {
      throw new Error(
        `CLOUDFLARE_ZONE_ID ${env.CLOUDFLARE_ZONE_ID} is zone "${zone?.name ?? 'unknown'}", not ${ZONE_NAME}`,
      );
    }
    return zone.id;
  }
  const zones = await cloudflareRequest(`/zones?name=${encodeURIComponent(ZONE_NAME)}`, { token });
  const zone = zones?.[0];
  if (!zone) throw new Error(`no Cloudflare zone named ${ZONE_NAME} is visible to this token`);
  return zone.id;
}

function resolveToken(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ALL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('CLOUDFLARE_API_TOKEN is required for --check and --apply');
  }
  return token;
}

/**
 * Report how the live zone differs from the generated rule.
 *
 * Ordering is checked as well as content: a rule that is present but sits above
 * a cache-disabling rule looks correct in the dashboard and does nothing.
 */
export function diffLiveRuleset(rules, rule = buildCorpusCacheRule()) {
  const index = (rules ?? []).findIndex((entry) => entry.description === rule.description);
  if (index === -1) {
    return { status: 'missing', problems: ['the rule is not in the zone'], misordered: false };
  }

  const live = rules[index];
  const problems = [];
  if (live.expression !== rule.expression) problems.push('expression differs');
  if (live.action !== rule.action) problems.push(`action is ${live.action}, expected ${rule.action}`);
  // Exact rather than subset: an extra field Cloudflare stores that we did not
  // ask for is a setting nobody in this repo chose, and reporting it once is
  // cheaper than letting a dashboard edit hide behind a lenient comparison.
  if (stableStringify(live.action_parameters) !== stableStringify(rule.action_parameters)) {
    problems.push('action_parameters differ');
  }
  if (live.enabled === false) problems.push('the rule is disabled');

  // Deliberately over-inclusive: any later rule that turns caching off is
  // reported, not only the document bypass. Deciding whether a given expression
  // could match a corpus URL would mean parsing wirefilter, and the failure this
  // exists to catch — a correct-looking rule sitting where it can never win — is
  // invisible in the dashboard. A false alarm costs a moment's thought; a false
  // clear costs a repeat of #7659.
  const laterBypass = rules.findIndex((entry, position) => {
    if (position <= index) return false;
    const params = entry.action_parameters;
    if (params?.cache === false) return true;
    // A later rule can also neutralise caching while leaving `cache: true`, by
    // overriding the origin TTL to zero. Same outcome, different shape.
    return params?.edge_ttl?.mode === 'override_origin' && params.edge_ttl.default === 0;
  });
  if (laterBypass !== -1) {
    problems.push(
      `the rule sits at ${index}, above a cache-disabling rule at ${laterBypass}`
      + ` ("${rules[laterBypass].description}"), which wins on any URL they both match`,
    );
  }

  return {
    status: problems.length ? 'drifted' : 'current',
    problems,
    index,
    misordered: laterBypass !== -1,
  };
}

/**
 * Decide the single rule-level operation that reconciles the zone.
 *
 * Deliberately never rewrites the whole ruleset. The phase entrypoint PUT
 * replaces every rule in the phase, so any dashboard edit made between this
 * script's read and its write is reverted silently and without a trace — and
 * that read-modify-write window is exactly when a human is most likely to be in
 * the dashboard looking at the same rules. The per-rule endpoints touch only our
 * own rule, which also means no other rule's user-owned `ref` is ever echoed
 * back or lost.
 */
export function planApply(rules, rule = buildCorpusCacheRule()) {
  const diff = diffLiveRuleset(rules, rule);
  if (diff.status === 'missing') return { op: 'create', diff };
  if (diff.status === 'current') return { op: 'none', diff };
  const id = rules[diff.index]?.id;
  // Content-only drift is a patch in place. A misordered rule has to move, and
  // Cloudflare appends a new rule last — so the corrected copy is added before
  // the stale one is removed and the corpus is never uncached in between.
  return { op: diff.misordered ? 'recreate' : 'update', id, diff };
}

async function main(argv) {
  const mode = argv.find((arg) => ['--print', '--check', '--apply'].includes(arg)) ?? '--print';
  const rule = buildCorpusCacheRule();

  if (mode === '--print') {
    console.log(JSON.stringify(rule, null, 2));
    return 0;
  }

  const token = resolveToken();
  const zoneId = await resolveZoneId(token);
  const ruleset = await cloudflareRequest(
    `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`,
    { token },
  );
  const diff = diffLiveRuleset(ruleset.rules, rule);

  if (mode === '--check') {
    if (diff.status === 'current') {
      console.log(`ok: "${rule.description}" is current at position ${diff.index} of ${ruleset.rules.length}`);
      return 0;
    }
    console.error(`drift (${diff.status}): ${diff.problems.join('; ')}`);
    return 1;
  }

  if (diff.status === 'current') {
    console.log(`no change: "${rule.description}" already matches (ruleset version ${ruleset.version})`);
    return 0;
  }

  const plan = planApply(ruleset.rules, rule);
  const rulesPath = `/zones/${zoneId}/rulesets/${ruleset.id}/rules`;
  if (plan.op === 'update') {
    await cloudflareRequest(`${rulesPath}/${plan.id}`, { token, method: 'PATCH', body: rule });
  } else {
    await cloudflareRequest(rulesPath, { token, method: 'POST', body: rule });
    if (plan.op === 'recreate') {
      await cloudflareRequest(`${rulesPath}/${plan.id}`, { token, method: 'DELETE' });
    }
  }

  // Re-read rather than trusting the write's own echo: the point of this script
  // is that a rule can be present and still not win.
  const after = await cloudflareRequest(
    `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`,
    { token },
  );
  const verify = diffLiveRuleset(after.rules, rule);
  if (verify.status !== 'current') {
    console.error(`applied but the zone still reports drift (${verify.status}): ${verify.problems.join('; ')}`);
    return 1;
  }
  console.log(
    `applied (${plan.op}): "${rule.description}" — ruleset version ${ruleset.version} -> ${after.version},`
    + ` ${after.rules.length} rules, position ${verify.index}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
