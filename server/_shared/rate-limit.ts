import { Ratelimit, type Duration } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getClientIp } from './client-ip';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../api/_sentry-edge.js';
// @ts-expect-error — JS module, no declaration file
import { durationToSeconds, limitWithFallback, resetRateLimitFallbackForTest } from '../../api/_rate-limit-fallback.js';

// Client-IP derivation lives in the dependency-free client-ip.ts (#5231) so
// seeder-reachable modules (usage.ts) can use it without pulling this file's
// @upstash imports into Railway containers. Re-exported here because this was
// the helpers' original home and existing callers import them from this
// module (getClientIp: api/ask.ts, api/a2a.ts, api/mcp-proxy.ts;
// UNKNOWN_CLIENT_IP: turnstile.ts; plus the rate-limit test suites).
export { getClientIp, hasCloudflareTransitProof, UNKNOWN_CLIENT_IP } from './client-ip';

// @upstash/redis defaults to 5 retries with exponential backoff (~4.3s total)
// before surfacing an unreachable-Redis error. The node test runner sets
// NODE_TEST_CONTEXT in the child that executes each file; in that context the
// fail-open / fail-closed rate-limit tests point UPSTASH_REDIS_REST_URL at a
// fake host and would otherwise burn that full backoff on every limiter call.
// Skip retries under the test runner only — production (env unset) keeps the
// resilient default untouched. Mirrors the retry:false already shipped on the
// MCP limiter to unblock the suite (PR #3963).
const REDIS_TEST_RETRY_OPTS: { retry?: false } = process.env.NODE_TEST_CONTEXT ? { retry: false } : {};
// @upstash/ratelimit v2 returns an allow-shaped result with reason="timeout"
// when this deadline wins the Redis race. Endpoint policies inspect that
// reason below and fail closed; keeping the SDK timeout enabled bounds the
// outage latency instead of waiting for the platform function timeout.
const ENDPOINT_RATE_LIMIT_TIMEOUT_MS = process.env.NODE_TEST_CONTEXT ? 25 : 5_000;
// Abort the underlying Upstash fetch just before the SDK's availability-first
// race expires. Without this, the SDK returns its timeout result but leaves the
// Redis request alive in the isolate for an unbounded transport stall.
const ENDPOINT_REDIS_ABORT_TIMEOUT_MS = process.env.NODE_TEST_CONTEXT ? 20 : 4_500;

let ratelimit: Ratelimit | null = null;
const GLOBAL_RATE_LIMIT = 600;
const GLOBAL_RATE_WINDOW: Duration = '60 s';
const GLOBAL_RATE_WINDOW_SECONDS = durationToSeconds(GLOBAL_RATE_WINDOW);

function getRatelimit(): Ratelimit | null {
  if (ratelimit) return ratelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token, ...REDIS_TEST_RETRY_OPTS }),
    limiter: Ratelimit.slidingWindow(GLOBAL_RATE_LIMIT, GLOBAL_RATE_WINDOW),
    prefix: 'rl',
    analytics: false,
  });
  return ratelimit;
}

// Structured one-line log so api/server log aggregation can grep for the
// "rate-limit available" gap independently of Sentry. Keep the prefix
// stable — operators and the api/_rate-limit.js mirror both emit it.
// Decide the Sentry level for a degraded-rate-limit capture. Upstash runtime
// transients — the Lua limiter script timing out under fan-out load
// (`ERR Error running script: execution timed out`), a dropped command, or a
// network/timeout blip — are absorbed by the fail-open / `failClosed`-503 path,
// so the user is unaffected. Capture those at `warning` so a sustained Redis
// outage still escalates by volume without a transient script-timeout drowning
// genuine error-level signal in the dashboard (WORLDMONITOR-RX; mirrors the
// SERVICE_UNAVAILABLE `level: 'warning'` precedent in api/user-prefs.ts). A
// `missing-config` stage is a real deploy misconfiguration and any novel error
// is unclassified — both stay at `error` so on-call still sees them.
//
// `aborted due to timeout` / `TimeoutError` is our OWN deadline reporting in:
// getEndpointRatelimit arms `AbortSignal.timeout(ENDPOINT_REDIS_ABORT_TIMEOUT_MS)`
// on the Upstash client, so a stalled transport rejects with a DOMException
// phrased "The operation was aborted due to timeout" — no `timed out`, no
// `network`, so the pre-existing alternation scored it `error`. That split the
// one condition in two: the SDK-race arm throws `Upstash endpoint rate-limit
// decision timed out` (already `warning`) while the abort arm paged
// (WORLDMONITOR-VM). Both are absorbed by the same fail-closed 503.
// Mirrored verbatim in api/_rate-limit.js.
//
// Exported purely as a test seam: the classification is only observable through
// a Sentry capture otherwise, and a source-regex assertion would false-pass on
// the mirror drifting. tests/rate-limit.test.mts calls both copies directly.
export function rateLimitErrorLevel(stage: string, msg: string): 'warning' | 'error' {
  if (stage.includes('missing-config')) return 'error';
  if (/Error running script|execution timed out|Command failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timed out|aborted due to timeout|TimeoutError|socket hang up|Redis unavailable|Redis unreachable/i.test(msg)) {
    return 'warning';
  }
  return 'error';
}

const RATE_LIMIT_SENTRY_DEDUP_MS = 60_000;
const lastRateLimitSentryCaptureAt = new Map<string, number>();

function logRateLimitDegraded(stage: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[rate-limit] redis-error stage=${stage} msg=${msg}`);
  // Keep every occurrence in provider logs, but emit at most one Sentry event
  // per limiter stage per minute from this isolate. A Redis outage otherwise
  // turns every fail-closed request into another identical ingestion event.
  const now = Date.now();
  const lastCaptureAt = lastRateLimitSentryCaptureAt.get(stage);
  if (lastCaptureAt !== undefined && now - lastCaptureAt < RATE_LIMIT_SENTRY_DEDUP_MS) return;
  lastRateLimitSentryCaptureAt.set(stage, now);
  captureSilentError(err, {
    tags: { surface: 'server', component: 'rate-limit', stage },
    fingerprint: ['rate-limit', 'redis-error', stage],
    level: rateLimitErrorLevel(stage, msg),
  });
}

const scopedMissingConfigStages = new Set<string>();

function logScopedRateLimitMissingConfig(scope: string): void {
  const stage = `checkScopedRateLimit:${scope}:missing-config`;
  if (scopedMissingConfigStages.has(stage)) return;
  scopedMissingConfigStages.add(stage);
  logRateLimitDegraded(stage, new Error('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing'));
}

// Marker header set on every degraded (fail-closed) response so observability
// can correlate "rate-limit unavailable" windows with downstream behaviour
// without parsing the JSON body. Mirrored in api/_rate-limit.js.
export const RATE_LIMIT_DEGRADED_HEADERS = {
  'X-RateLimit-Mode': 'degraded',
  // Short Retry-After encourages clients to retry once the limiter is back,
  // rather than treating the 503 as a hard outage.
  'Retry-After': '5',
} as const;

function tooManyRequestsResponse(limit: number, reset: number, corsHeaders: Record<string, string>, windowSeconds: number): Response {
  // `reset` is a Unix epoch in MILLISECONDS (Upstash). IETF RateLimit fields
  // carry a delta-seconds reset (`t` / RateLimit-Reset), NOT an epoch — derive
  // it here. Legacy X-RateLimit-Reset stays epoch-ms for back-compat.
  const resetSeconds = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      // IETF RateLimit fields (draft-ietf-httpapi-ratelimit-headers). The
      // combined RateLimit member references the "default" policy advertised on
      // every API response via vercel.json so agents can self-throttle. Mirrors
      // api/_rate-limit.js.
      'RateLimit-Policy': `"default";q=${limit};w=${windowSeconds}`,
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(resetSeconds),
      RateLimit: `"default";r=0;t=${resetSeconds}`,
      // Legacy X-RateLimit-* retained for back-compat (Reset is epoch-ms).
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(reset),
      'Retry-After': String(resetSeconds),
      ...corsHeaders,
    },
  });
}

function rateLimitDegradedResponse(corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: 'Rate-limit service temporarily unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      ...RATE_LIMIT_DEGRADED_HEADERS,
      ...corsHeaders,
    },
  });
}

export interface RateLimitOptions {
  /**
   * When true and Redis is unavailable, return a 503 (with the
   * `X-RateLimit-Mode: degraded` marker) instead of allowing the request
   * through. Pass `true` for endpoints where the rate-limit IS the abuse
   * defence (LLM, checkout, lead capture). Default `false` keeps the
   * availability-first posture for general traffic so a Redis blip doesn't
   * black-hole the whole site. (#3531)
   */
  failClosed?: boolean;
  /**
   * Optional trusted server-derived user ID for policies that should isolate
   * authenticated principals sharing one public IP. Callers must never pass a
   * raw client-controlled header here. The limiter owns the namespace prefix
   * so user IDs cannot collide with anonymous IP buckets.
   */
  principalUserId?: string;
}

export type EndpointRateLimitOptions = RateLimitOptions;

function getPrincipalRateLimitIdentifier(principalUserId?: string): string | null {
  return principalUserId ? `user:${principalUserId}` : null;
}

export async function checkRateLimit(request: Request, corsHeaders: Record<string, string>, opts: RateLimitOptions = {}): Promise<Response | null> {
  const rl = getRatelimit();
  if (!rl) {
    if (opts.failClosed) {
      logRateLimitDegraded('checkRateLimit:missing-config', new Error('Upstash Redis is not configured'));
      return rateLimitDegradedResponse(corsHeaders);
    }
    return null;
  }

  // Preserve the long-standing raw-IP key for anonymous traffic so an
  // in-flight 60-second bucket does not reset during rollout. Trusted
  // principals use a separate namespace.
  const identifier =
    getPrincipalRateLimitIdentifier(opts.principalUserId) ??
    getClientIp(request);

  try {
    const { success, limit, reset } = await limitWithFallback(
      rl,
      identifier,
      `rl:fw:${identifier}`,
      GLOBAL_RATE_LIMIT,
      GLOBAL_RATE_WINDOW_SECONDS,
    );

    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders, GLOBAL_RATE_WINDOW_SECONDS);
    }

    return null;
  } catch (err) {
    logRateLimitDegraded('checkRateLimit', err);
    if (opts.failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}

// --- Per-endpoint rate limiting ---

interface EndpointRatePolicy {
  limit: number;
  window: Duration;
}

// Exported so scripts/enforce-rate-limit-policies.mjs can import it directly
// (#3278) instead of regex-parsing this file. Internal callers should keep
// using checkEndpointRateLimit / hasEndpointRatePolicy below — the export is
// for tooling, not new runtime callers.
export const ENDPOINT_RATE_POLICIES: Record<string, EndpointRatePolicy> = {
  // LLM article summarization is Pro-gated, but still needs a scoped,
  // fail-closed budget so Redis degradation cannot silently lift the
  // per-endpoint spend control.
  '/api/news/v1/summarize-article': { limit: 30, window: '60 s' },
  '/api/news/v1/summarize-article-cache': { limit: 3000, window: '60 s' },
  '/api/intelligence/v1/classify-event': { limit: 600, window: '60 s' },
  // LLM-backed situational deduction (imports callLlmReasoning) can drive
  // provider spend on cache misses, so it must fail closed on Redis outage
  // rather than inherit the global fail-open fallback. Mirror the sibling
  // classify-event budget (same limit/window) — both are AI-backed Intelligence
  // RPCs. (#4676)
  '/api/intelligence/v1/deduct-situation': { limit: 600, window: '60 s' },
  // Historical intelligence memory (#5694): both semantic routes embed the
  // caller's free text through the OpenRouter embeddings API on every cache
  // miss, so they are provider-backed spend, not pure reads. They are also
  // premium-gated, which means the gateway serves them with no CDN cache — a
  // The three intel-history reads. All are Pro-gated and reach the function on
  // every request, but they spend two different budgets, so they are sized
  // against two different ceilings.
  //
  // search + similar-events each embed their input on a paid provider. They
  // share ONE budget while the registry is keyed per PATH, so a caller
  // alternating them gets the sum, not the cap — 30/min each holds the
  // combined worst case at the 60/min per-principal embeddings bill this is
  // sized for. Still generous for interactive use (a search plus follow-ups),
  // and far under the LLM routes' 600/min because nothing here runs in a
  // page-load fan-out.
  //
  // timeline embeds nothing, which is why it originally carried no policy at
  // all. That reasoning was right about money and wrong about the resource
  // that actually scales with retention: Convex reads whole documents, and
  // every intelHistory row carries a 512-float embedding the projection
  // immediately discards. One limit=200 call scoped by both domain and
  // country scans TIMELINE_MAX_SCAN=800 rows (4x over-fetch for the
  // post-filter) — roughly 3MB of Convex read budget, which the 600/min
  // availability-first fallback did not bound. 120/min keeps a timeline read
  // comfortable while capping that worst case.
  '/api/intelligence/v1/search-intel-history': { limit: 30, window: '60 s' },
  '/api/intelligence/v1/get-similar-events': { limit: 30, window: '60 s' },
  '/api/intelligence/v1/get-intel-timeline': { limit: 120, window: '60 s' },
  // Batch humanitarian-summary fans out to the external HAPI (humdata) provider
  // on cache miss — up to 25 countries per request, 5 concurrent upstream
  // fetches. Batch aircraft-details fans out to the external Wingbits provider —
  // up to 10 ICAO24 lookups per request. Both proxy external providers, so keep
  // them at the same 30/min budget as the other provider-proxy routes
  // (sanctions lookup / resilience ranking); conservative because a single
  // request already amplifies into many upstream calls. (#4676)
  '/api/conflict/v1/get-humanitarian-summary-batch': { limit: 30, window: '60 s' },
  '/api/military/v1/get-aircraft-details-batch': { limit: 30, window: '60 s' },
  // Generic batch fan-out: one request re-dispatches up to 20 gateway GETs, so
  // cap the multiplier at the same 30/min budget as the other batch routes.
  '/api/batch/v1/execute': { limit: 30, window: '60 s' },
  // Legacy /api/sanctions-entity-search rate limit was 30/min per IP. Preserve
  // that budget now that LookupSanctionEntity proxies OpenSanctions live.
  '/api/sanctions/v1/lookup-sanction-entity': { limit: 30, window: '60 s' },
  // Corporate intelligence (#5695): each cache miss proxies SEC EDGAR and/or
  // Finnhub on the caller's behalf, and the per-company inputs are effectively
  // unbounded (any ticker/name/domain), so these cannot inherit the fail-open
  // global fallback. Same 30/min provider-proxy budget as the sanctions lookup
  // and batch fan-out routes above.
  '/api/intelligence/v1/get-company-enrichment': { limit: 30, window: '60 s' },
  '/api/intelligence/v1/list-company-signals': { limit: 30, window: '60 s' },
  '/api/intelligence/v1/search-sec-filings': { limit: 30, window: '60 s' },
  // Public market/economic provider proxies (#6236): caller-controlled symbols,
  // indicators, and year ranges create unbounded cache-key cardinality; the
  // country-index route is bounded to the 45-country contract but still
  // proxies Yahoo Finance on a cache miss. None may inherit the global
  // fail-open budget. The dashboard can legitimately fan out across 50 Pro
  // watchlist symbols, so those three per-symbol routes admit one full load
  // plus headroom. analyze-stock remains separately constrained by the
  // fail-closed per-user daily direct-LLM quota.
  '/api/market/v1/analyze-stock': { limit: 60, window: '60 s' },
  '/api/market/v1/backtest-stock': { limit: 60, window: '60 s' },
  '/api/market/v1/get-insider-transactions': { limit: 60, window: '60 s' },
  '/api/market/v1/get-country-stock-index': { limit: 30, window: '60 s' },
  // Stablecoins are seed-backed for the DEFAULT request, but naming coins the
  // snapshot does not carry reaches CoinGecko, and the caller picks the IDs —
  // unbounded cardinality, so the per-ID-set cache cannot bound spend alone.
  //
  // Sized against the dashboard, not the provider: this path is in
  // PRO_FRESH_CACHE_RPC_PATHS, so it carries a panel that refreshes on a timer
  // for every open dashboard, and the limit is per-IP for anonymous traffic —
  // one office NAT is one bucket. 60/min matches the sibling per-symbol market
  // routes, which are likewise sized to admit a full legitimate load plus
  // headroom rather than to price the upstream call.
  //
  // Note this makes the route fail closed on a Redis outage, which the four
  // other panels in PRO_FRESH_CACHE_RPC_PATHS are not. That is survivable
  // because the handler cannot serve data during that outage either (the seed
  // read is the same Redis) — and it deliberately performs no provider work
  // when that read fails, so the fail-closed 503 is a second line, not the
  // only thing standing between a Redis outage and a CoinGecko fan-out. (#6308)
  '/api/market/v1/list-stablecoin-markets': { limit: 60, window: '60 s' },
  '/api/economic/v1/list-world-bank-indicators': { limit: 30, window: '60 s' },
  // #6305: list-market-quotes stopped being a pure seed read. The fixed seed
  // still answers the default universe with no upstream call, but a symbol the
  // seed does not carry (a custom watchlist ticker) now resolves through the
  // bounded, Redis-cached Finnhub gap fetch — so caller-controlled symbols can
  // reach a paid provider and this route can no longer inherit the fail-open
  // global budget. Same 60/min as the sibling per-symbol market routes: the
  // dashboard issues one multi-symbol call per refresh and the response is
  // CDN-cached (medium tier), so 60/min is far above any legitimate per-IP
  // load. Provider spend is separately capped at MARKET_QUOTES_UPSTREAM_LIMIT
  // lookups per request.
  '/api/market/v1/list-market-quotes': { limit: 60, window: '60 s' },
  // Company Monitoring is contract-only and remains unrouted until #6003
  // passes, but generated mutation routes still need a fail-closed policy
  // before any later lane can wire them. Import can carry 100 rows, so keep its
  // request budget lower than the single-company mutations.
  '/api/company-monitoring/v1/create-monitored-company': { limit: 30, window: '60 s' },
  '/api/company-monitoring/v1/update-monitored-company': { limit: 30, window: '60 s' },
  '/api/company-monitoring/v1/set-monitored-company-state': { limit: 30, window: '60 s' },
  '/api/company-monitoring/v1/import-monitored-company-batch': { limit: 10, window: '60 s' },
  // Lead capture: preserve the 3/hr and 5/hr budgets from legacy api/contact.js
  // and api/register-interest.js. Lower limits than normal IP rate limit since
  // these hit Convex + Resend per request.
  '/api/leads/v1/submit-contact': { limit: 3, window: '1 h' },
  '/api/leads/v1/register-interest': { limit: 5, window: '1 h' },
  // Scenario engine: legacy /api/scenario/v1/run capped at 10 jobs/min/IP via
  // inline Upstash INCR. Gateway preserves the same budget while using a
  // trusted paid-user principal when available, otherwise the client IP.
  '/api/scenario/v1/run-scenario': { limit: 10, window: '60 s' },
  // #3734: trigger-simulation PRO endpoint, same shape as run-scenario.
  // It follows the same trusted-principal-or-IP attribution contract.
  '/api/forecast/v1/trigger-simulation': { limit: 10, window: '60 s' },
  // Live tanker map (Energy Atlas): one user with 6 chokepoints × 1 call/min
  // = 6 req/min/IP base load. 60/min headroom covers tab refreshes + zoom
  // pans within a single user without flagging legitimate traffic.
  '/api/maritime/v1/get-vessel-snapshot': { limit: 60, window: '60 s' },
  // Country Resilience ranking can synchronously warm the full country table
  // on cold/stale cache paths; keep it well below the global 600/min fallback.
  '/api/resilience/v1/get-resilience-ranking': { limit: 30, window: '60 s' },
  // #3805 / PR #3821: MCP proxy is a top-level Vercel Edge Function in
  // `api/mcp-proxy.ts` (registered as `external-protocol` in
  // api/api-route-exceptions.json — JSON-RPC shape dictated by the MCP spec),
  // so it does NOT flow through the gateway and `checkEndpointRateLimit`
  // never fires for it. The handler reads this policy and enforces it
  // in-handler via `checkScopedRateLimit` — keeping the registry as the
  // single source of truth so future audit additions (and the
  // enforce-rate-limit-policies lint) see the endpoint. The audit script
  // resolves edge-function paths via api/api-route-exceptions.json instead
  // of the OpenAPI specs.
  '/api/mcp-proxy': { limit: 30, window: '60 s' },
  // Docs MCP facade (`api/docs-mcp.ts`, external-protocol exception — serves
  // /docs/mcp, proxying the Mintlify docs MCP server and lifting its
  // protocol-level tool-call failures into proper JSON-RPC error objects).
  // Anonymous by design (upstream is fully public), so the per-IP minute
  // limit is the whole abuse defence; 60/min mirrors the MCP public-method
  // posture. Enforced in-handler via `checkScopedRateLimit`, same pattern as
  // /api/mcp-proxy.
  '/api/docs-mcp': { limit: 60, window: '60 s' },
  // A2A concierge endpoint (`api/a2a.ts`, external-protocol exception —
  // JSON-RPC shape dictated by the A2A spec, served at /a2a). Anonymous and
  // quota-free by design (routes over the public tool catalog + public
  // freshness envelope only), so the per-IP minute limit is the whole abuse
  // defence; 60/min mirrors the MCP public-method posture. Enforced
  // in-handler via `checkScopedRateLimit`, same pattern as /api/mcp-proxy.
  '/api/a2a': { limit: 60, window: '60 s' },
  // NLWeb /ask endpoint (`api/ask.ts`, external-protocol exception — request/
  // response shape dictated by the NLWeb spec, served at /ask). Same anonymous
  // cheap-catalog posture as /api/a2a, same in-handler enforcement.
  '/api/ask': { limit: 60, window: '60 s' },
};

interface RateLimitPolicyDecision {
  reason: string;
}

// Repo-native guardrail for routes where the rate-limit is part of the abuse
// defence. scripts/enforce-rate-limit-policies.mjs fails if any route listed
// here can drift back to the gateway's availability-first global fallback.
export const FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED: Record<string, RateLimitPolicyDecision> = {
  '/api/news/v1/summarize-article': {
    reason: 'LLM-backed summarization can drive provider spend on cache misses.',
  },
  '/api/intelligence/v1/classify-event': {
    reason: 'AI classification performs expensive provider-backed analysis.',
  },
  '/api/intelligence/v1/deduct-situation': {
    reason: 'LLM-backed situational deduction can drive provider spend on cache misses.',
  },
  '/api/intelligence/v1/search-intel-history': {
    reason: 'Semantic history search embeds the caller\'s query through a paid embeddings provider on every request.',
  },
  '/api/intelligence/v1/get-similar-events': {
    reason: 'Precedent lookup embeds the caller\'s situation text through a paid embeddings provider on every request.',
  },
  '/api/conflict/v1/get-humanitarian-summary-batch': {
    reason: 'Batch summary fans out to the external HAPI (humdata) provider on cache miss.',
  },
  '/api/intelligence/v1/get-company-enrichment': {
    reason: 'Per-company composite fans out to SEC EDGAR and Finnhub on cache miss.',
  },
  '/api/intelligence/v1/list-company-signals': {
    reason: 'Per-company signal discovery fans out to SEC EDGAR and Finnhub on cache miss.',
  },
  '/api/intelligence/v1/search-sec-filings': {
    reason: 'Full-text filing search proxies SEC EDGAR on cache miss with unbounded query cardinality.',
  },
  '/api/market/v1/analyze-stock': {
    reason: 'Per-symbol analysis can fan out to Finnhub plus the Exa, Brave, and SerpAPI search ladder on cache miss.',
  },
  '/api/market/v1/backtest-stock': {
    reason: 'Per-symbol backtests proxy scraped Yahoo Finance data with unbounded symbol cardinality.',
  },
  '/api/market/v1/get-insider-transactions': {
    reason: 'Per-symbol insider lookups proxy the paid Finnhub provider on cache miss.',
  },
  '/api/market/v1/get-country-stock-index': {
    reason: 'Per-country stock-index lookups proxy Yahoo Finance on cache miss.',
  },
  '/api/market/v1/list-stablecoin-markets': {
    reason: 'Caller-named coin IDs absent from the seed snapshot fan out to CoinGecko on cache miss with unbounded ID cardinality.',
  },
  '/api/market/v1/list-market-quotes': {
    reason: 'Custom watchlist symbols the fixed seed does not carry resolve through the paid Finnhub provider on cache miss (#6305).',
  },
  '/api/economic/v1/list-world-bank-indicators': {
    reason: 'Caller-controlled indicator, country, and year inputs proxy World Bank on cache miss.',
  },
  '/api/company-monitoring/v1/create-monitored-company': {
    reason: 'Account-scoped portfolio mutation must not become fail-open when its dark contract is wired.',
  },
  '/api/company-monitoring/v1/update-monitored-company': {
    reason: 'Account-scoped portfolio mutation must not become fail-open when its dark contract is wired.',
  },
  '/api/company-monitoring/v1/set-monitored-company-state': {
    reason: 'Account-scoped lifecycle mutation must not become fail-open when its dark contract is wired.',
  },
  '/api/company-monitoring/v1/import-monitored-company-batch': {
    reason: 'A bounded import can write up to 100 portfolio rows and must fail closed when its dark contract is wired.',
  },
  '/api/military/v1/get-aircraft-details-batch': {
    reason: 'Batch enrichment fans out to the external Wingbits provider on cache miss.',
  },
  '/api/batch/v1/execute': {
    reason: 'Generic batch fan-out multiplies one request into up to 20 gateway sub-requests.',
  },
  '/api/sanctions/v1/lookup-sanction-entity': {
    reason: 'Live sanctions lookup proxies an external provider.',
  },
  '/api/leads/v1/submit-contact': {
    reason: 'Lead capture writes to Convex and sends email.',
  },
  '/api/leads/v1/register-interest': {
    reason: 'Lead capture writes to Convex and sends email.',
  },
  '/api/scenario/v1/run-scenario': {
    reason: 'Scenario runs are mutation-like jobs with a historical 10/min cap.',
  },
  '/api/forecast/v1/trigger-simulation': {
    reason: 'Forecast simulation trigger starts expensive backend work.',
  },
  '/api/maritime/v1/get-vessel-snapshot': {
    reason: 'Live vessel snapshots can generate high-frequency upstream load.',
  },
  '/api/resilience/v1/get-resilience-ranking': {
    reason: 'Cold/stale cache paths can synchronously warm the full country table.',
  },
};

// Explicit examples of read-only gateway routes where the global per-IP
// fallback remains acceptable during Redis degradation. New expensive/provider
// routes should not be added here; add them to ENDPOINT_RATE_POLICIES and
// FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED instead.
export const GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES: Record<string, RateLimitPolicyDecision> = {
  '/api/aviation/v1/list-airport-delays': {
    reason: 'Read-only cache-backed airport delay listing; availability-first fallback is acceptable.',
  },
  '/api/intelligence/v1/list-material-events': {
    reason: 'Read-only Redis read of the seeded 8-K stream; no upstream fetch on miss, so availability-first fallback carries no spend risk.',
  },
};

// Explicit allow-list of NON-GET (post/put/patch/delete) gateway routes that are
// permitted to inherit the global availability-first fallback during a Redis
// outage instead of declaring an ENDPOINT_RATE_POLICIES entry. The audit
// scripts/enforce-rate-limit-policies.mjs fails CI if any generated non-GET
// route is neither in ENDPOINT_RATE_POLICIES nor listed here — so a newly added
// expensive/mutation route can no longer silently fail open. Every entry MUST
// carry a justification for why fail-open is safe for that route. When a route
// becomes provider-backed / spend-bearing, move it to ENDPOINT_RATE_POLICIES +
// FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED instead of keeping it here. (#4676)
export const RATE_LIMIT_MUTATION_FALLBACK_EXEMPT: Record<string, RateLimitPolicyDecision> = {
  '/api/economic/v1/get-fred-series-batch': {
    reason:
      'Read-only despite POST shape: reads seeded FRED data from the Redis seed cache only; all external FRED API calls happen in the Railway seed job, so a cache miss never fans out to an external provider.',
  },
  '/api/infrastructure/v1/record-baseline-snapshot': {
    reason:
      'Redis-only write (setCachedJson) with no external provider or LLM call; if Redis is degraded the write itself cannot land, so the fail-open fallback carries no spend/abuse risk.',
  },
  '/api/v2/shipping/webhooks': {
    reason:
      'Webhook registration is API-key authenticated (validateApiKey) and premium-gated before any work, so unauthenticated abuse is already blocked; the handler only writes to Redis, with no external provider or LLM spend.',
  },
};

const endpointLimiters = new Map<string, Ratelimit>();

function getEndpointRatelimit(pathname: string): Ratelimit | null {
  const policy = ENDPOINT_RATE_POLICIES[pathname];
  if (!policy) return null;

  const cached = endpointLimiters.get(pathname);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const rl = new Ratelimit({
    redis: new Redis({
      url,
      token,
      ...REDIS_TEST_RETRY_OPTS,
      signal: () => AbortSignal.timeout(ENDPOINT_REDIS_ABORT_TIMEOUT_MS),
    }),
    limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
    prefix: 'rl:ep',
    analytics: false,
    timeout: ENDPOINT_RATE_LIMIT_TIMEOUT_MS,
  });
  endpointLimiters.set(pathname, rl);
  return rl;
}

export function hasEndpointRatePolicy(pathname: string): boolean {
  return pathname in ENDPOINT_RATE_POLICIES;
}

export async function checkEndpointRateLimit(request: Request, pathname: string, corsHeaders: Record<string, string>, opts: EndpointRateLimitOptions = {}): Promise<Response | null> {
  if (!hasEndpointRatePolicy(pathname)) return null;

  const rl = getEndpointRatelimit(pathname);
  if (!rl) {
    const failClosed = opts.failClosed ?? true;
    if (failClosed) {
      logRateLimitDegraded(`checkEndpointRateLimit:${pathname}:missing-config`, new Error('Upstash Redis is not configured'));
      return rateLimitDegradedResponse(corsHeaders);
    }
    return null;
  }

  const identifier =
    getPrincipalRateLimitIdentifier(opts.principalUserId) ??
    `ip:${getClientIp(request)}`;
  const policy = ENDPOINT_RATE_POLICIES[pathname];
  // hasEndpointRatePolicy(pathname) above already guarantees this — the
  // extra check exists only to satisfy noUncheckedIndexedAccess, since TS
  // can't carry that narrowing across a second independent index lookup.
  if (!policy) return null;

  try {
    const result = await limitWithFallback(rl, `${pathname}:${identifier}`, `rl:ep:fw:${pathname}:${identifier}`, policy.limit, durationToSeconds(policy.window));
    // @upstash/ratelimit v2's timeout is intentionally availability-first:
    // it resolves { success: true, reason: 'timeout' }. Explicit endpoint
    // policies are the abuse defence, so that result is degraded, not an allow.
    if (result.reason === 'timeout') {
      throw new Error('Upstash endpoint rate-limit decision timed out');
    }
    const { success, limit, reset } = result;

    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders, durationToSeconds(policy.window));
    }

    return null;
  } catch (err) {
    logRateLimitDegraded(`checkEndpointRateLimit:${pathname}`, err);
    // Per-endpoint policies exist precisely because the limit IS the abuse
    // defence — an LLM endpoint or a 3/hr lead-capture endpoint is the
    // worst place to silently fall through during a Redis outage. Default
    // to fail-closed; callers can opt out via opts.failClosed = false.
    const failClosed = opts.failClosed ?? true;
    if (failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}

// --- In-handler scoped rate limits ---
//
// Handlers that need a per-subscope cap *in addition to* the gateway-level
// endpoint policy (e.g. a tighter budget for one request variant) use this
// helper. Gateway's checkEndpointRateLimit still runs first — this is a
// second stage.

const scopedLimiters = new Map<string, Ratelimit>();

function getScopedRatelimit(scope: string, limit: number, window: Duration): Ratelimit | null {
  const cacheKey = `${scope}|${limit}|${window}`;
  const cached = scopedLimiters.get(cacheKey);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const rl = new Ratelimit({
    redis: new Redis({ url, token, ...REDIS_TEST_RETRY_OPTS }),
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix: 'rl:scope',
    analytics: false,
  });
  scopedLimiters.set(cacheKey, rl);
  return rl;
}

export interface ScopedRateLimitResult {
  allowed: boolean;
  limit: number;
  reset: number;
  /**
   * True when Redis was unreachable and the helper fell back to the
   * fail-open default. Callers that need fail-closed semantics should
   * gate on this — e.g. lead-capture handlers can refuse the write to
   * preserve the 3/hr budget across a Redis blip. (#3531)
   */
  degraded: boolean;
}

/**
 * Returns whether the request is under the scoped budget. `scope` is an
 * opaque namespace (e.g. `${pathname}#desktop`); `identifier` is usually the
 * client IP but can be any stable caller identifier. Fail-open on Redis errors
 * to stay consistent with checkRateLimit / checkEndpointRateLimit semantics,
 * but the `degraded` flag lets callers escalate to fail-closed locally
 * (#3531). The Redis error itself is logged once per call so silent bypass
 * windows are visible in logs / Sentry.
 */
export async function checkScopedRateLimit(scope: string, limit: number, window: Duration, identifier: string): Promise<ScopedRateLimitResult> {
  const rl = getScopedRatelimit(scope, limit, window);
  if (!rl) {
    logScopedRateLimitMissingConfig(scope);
    return { allowed: true, limit, reset: 0, degraded: true };
  }
  try {
    const result = await limitWithFallback(rl, `${scope}:${identifier}`, `rl:scope:fw:${scope}:${identifier}`, limit, durationToSeconds(window));
    return {
      allowed: result.success,
      limit: result.limit,
      reset: result.reset,
      degraded: false,
    };
  } catch (err) {
    logRateLimitDegraded(`checkScopedRateLimit:${scope}`, err);
    return { allowed: true, limit, reset: 0, degraded: true };
  }
}

/**
 * Applies a distinct, fail-closed per-IP scoped guard and converts its result
 * into the gateway's standard 429/503 response contract. Use this ahead of
 * expensive identity-attribution lookups that cannot yet use the endpoint's
 * final principal-scoped bucket.
 */
export async function checkFailClosedScopedIpRateLimit(
  request: Request,
  scope: string,
  limit: number,
  window: Duration,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const result = await checkScopedRateLimit(scope, limit, window, getClientIp(request));
  if (result.degraded) return rateLimitDegradedResponse(corsHeaders);
  if (!result.allowed) {
    return tooManyRequestsResponse(result.limit, result.reset, corsHeaders, durationToSeconds(window));
  }
  return null;
}

export function __resetRateLimitForTest(): void {
  ratelimit = null;
  endpointLimiters.clear();
  scopedLimiters.clear();
  scopedMissingConfigStages.clear();
  lastRateLimitSentryCaptureAt.clear();
  resetRateLimitFallbackForTest();
}
