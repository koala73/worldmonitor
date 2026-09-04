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
 * `--check` and `--apply` need `CLOUDFLARE_API_TOKEN` with Zone > Cache Rules
 * edit on worldmonitor.app (the same secret .github/workflows/deploy-worker.yml
 * already uses; `CLOUDFLARE_ALL_ACCESS_TOKEN` is accepted as a fallback because
 * that is what .env.local carries locally, and the worker token is not scoped to
 * cache rules). `--apply` prints the ruleset version it replaced; Cloudflare
 * keeps prior versions, so a bad apply is recoverable from the dashboard's
 * ruleset history.
 */

import { pathToFileURL } from 'node:url';

import { CONTENT_CORPUS_PREFIXES } from './discover-content-corpus-pages.mjs';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export const ZONE_NAME = 'worldmonitor.app';

/** Apex and the variant subdomains serve different documents from these paths. */
export const CORPUS_HOST = 'www.worldmonitor.app';

/**
 * The rule's identity in the zone. `--apply` matches on this string, so renaming
 * it here without renaming it in the dashboard creates a duplicate rule rather
 * than updating the existing one.
 */
export const CORPUS_CACHE_RULE_DESCRIPTION = 'WWW corpus HTML - use origin CDN cache headers';

/** The cache-phase ruleset both this rule and the pre-existing bypass live in. */
export const CACHE_PHASE = 'http_request_cache_settings';

/**
 * Build the wirefilter expression for the corpus families.
 *
 * Both forms of each family are claimed. The nested form is what crawlers fetch;
 * the bare form is a 308 to the trailing-slash canonical and is not cached either
 * way, but omitting it would leave the rule describing a smaller surface than the
 * vercel.json header rule it mirrors, which is how the two drift apart.
 */
export function buildCorpusCacheExpression(prefixes = CONTENT_CORPUS_PREFIXES) {
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
          { status_code_range: { from: 300, to: 499 }, value: 0 },
          { status_code_range: { from: 500 }, value: -1 },
        ],
      },
    },
    enabled: true,
  };
}

/**
 * Place `rule` last in `rules`, replacing any earlier copy of itself.
 *
 * Last position is the mechanism, not a detail: the blanket document bypass also
 * matches every corpus URL, and Cloudflare lets the last matching rule win.
 * Rules that are not ours pass through untouched, in their original order.
 */
export function upsertCorpusCacheRule(rules, rule = buildCorpusCacheRule()) {
  const others = (rules ?? []).filter((entry) => entry?.description !== rule.description);
  return [...others, rule];
}

/** Fields Cloudflare owns; echoing them back on a PUT is at best noise. */
const READ_ONLY_RULE_FIELDS = ['version', 'last_updated', 'ref'];

/** Strip the server-owned fields from a rule read back out of the zone. */
export function sanitizeRuleForPut(rule) {
  const copy = { ...rule };
  for (const field of READ_ONLY_RULE_FIELDS) delete copy[field];
  return copy;
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
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const detail = JSON.stringify(payload?.errors ?? payload ?? response.statusText);
    throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload.result;
}

async function resolveZoneId(token, env = process.env) {
  if (env.CLOUDFLARE_ZONE_ID) return env.CLOUDFLARE_ZONE_ID;
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
  if (index === -1) return { status: 'missing', problems: ['the rule is not in the zone'] };

  const live = rules[index];
  const problems = [];
  if (live.expression !== rule.expression) problems.push('expression differs');
  if (live.action !== rule.action) problems.push(`action is ${live.action}, expected ${rule.action}`);
  if (JSON.stringify(live.action_parameters) !== JSON.stringify(rule.action_parameters)) {
    problems.push('action_parameters differ');
  }
  if (live.enabled === false) problems.push('the rule is disabled');

  // Deliberately over-inclusive: any later rule that turns caching off is
  // reported, not only the document bypass. Deciding whether a given expression
  // could match a corpus URL would mean parsing wirefilter, and the failure this
  // exists to catch — a correct-looking rule sitting where it can never win — is
  // invisible in the dashboard. A false alarm costs a moment's thought; a false
  // clear costs a repeat of #7659.
  const laterBypass = rules.findIndex((entry, position) => position > index
    && entry.action_parameters?.cache === false);
  if (laterBypass !== -1) {
    problems.push(
      `the rule sits at ${index}, above a cache-disabling rule at ${laterBypass}`
      + ` ("${rules[laterBypass].description}"), which wins on any URL they both match`,
    );
  }

  return { status: problems.length ? 'drifted' : 'current', problems, index };
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

  const nextRules = upsertCorpusCacheRule((ruleset.rules ?? []).map(sanitizeRuleForPut), rule);
  const updated = await cloudflareRequest(`/zones/${zoneId}/rulesets/${ruleset.id}`, {
    token,
    method: 'PUT',
    body: { name: ruleset.name, kind: ruleset.kind, phase: ruleset.phase, rules: nextRules },
  });
  console.log(
    `applied: "${rule.description}" (${diff.status}) — ruleset version ${ruleset.version} -> ${updated.version},`
    + ` ${updated.rules.length} rules`,
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
