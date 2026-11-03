# Customer AI routing policy

An account can be restricted to a fixed list of AI providers, for example when
a contract says the customer's AI traffic goes to Anthropic directly and
nowhere else. When a policy exists, its provider list is the whole LLM
provider chain for that account's requests: no default chain, no free
fallbacks, no OpenRouter unless the list names it.

## What it covers

Every LLM call that carries a restricted account's own input: request-time
calls made through the REST API, MCP or a dashboard session, and the Railway
jobs that put that user's data into a prompt.

| Surface | Handler | Under an `anthropic`-only policy |
|---|---|---|
| `analyze_situation` / deduct-situation | `server/worldmonitor/intelligence/v1/deduct-situation.ts` | Anthropic |
| `classify_event` | `classify-event.ts` | Anthropic |
| `get_country_brief` | `get-country-intel-brief.ts` | Anthropic |
| `get_stock_research` / analyze-stock | `server/worldmonitor/market/v1/analyze-stock.ts` | Anthropic |
| `analyze_news_headlines` / summarize-article | `server/worldmonitor/news/v1/summarize-article.ts` | Anthropic, whatever provider the client named |
| Dashboard chat analyst | `api/chat-analyst.ts` | Anthropic (streamed) |
| Widget builder | `scripts/ais-relay.cjs` widget agent | Already Anthropic for every account |
| `search_intel_history`, `get_similar_events` | query embeddings (OpenRouter only) | Refused with 403; no keyword index exists to fall back to |
| AI alert impact (user's alert profile) | `scripts/notification-relay.cjs` `generateEventImpact` | Anthropic |
| Personalised digest prose (profile, greeting) | `scripts/seed-digest-notifications.mjs` → `brief-llm.mjs` `generateDigestProse` | Anthropic, both synthesis levels |
| Company Monitoring admission classifier | `convex/companyMonitoring/admission.ts` claim | Candidate rejected (`ai_routing_policy_excludes_classifier`) before evidence is sent |

The Railway jobs read the policy through `/relay/ai-routing-policy` with the
delivery relay secret (`scripts/lib/ai-routing-policy.cjs`, 60 s in-process
cache, fail closed) and call Anthropic through `scripts/lib/llm-chain.cjs`,
where `anthropic` is opt-in only.

The Company Monitoring classifier runs one frozen, evaluated model route
through OpenRouter (`docs/internal/company-monitoring/provider-policy.md`).
Swapping in another provider per account would invalidate that evaluation, so
an owner whose policy excludes `openrouter` gets no classification at all
rather than a rerouted one. Allowing `openrouter` in the policy re-enables it.

Each request-time handler adds `:ai=<providers>` to its Redis cache key for a
restricted caller, so the caller is never served text another provider wrote.
Unrestricted callers keep the existing keys. Apart from translate mode and
the summary-cache read, these RPCs are tier-gated, so the gateway marks their
responses private and the CDN never stores them.

**How the caller is identified.** Handlers read the gateway-set `x-user-id`.
The gateway sets it for `wm_` user keys on every route, for MCP OAuth (signed
internal calls), and for Clerk sessions on tier-gated and quota routes.
`summarize-article` also falls back to the identity it resolves itself, which
covers a Clerk session in free translate mode.

## What it does not cover

- **Shared content generated in the background** (insights, forecasts, the
  shared country brief, feed classification, the public digest, and per-story
  "why it matters" and descriptions inside a digest). It contains no customer
  input and is the same for everyone.
- **The dashboard's summary-cache shortcut.** Before summarizing, the browser
  reads `summarize-article-cache` with an anonymous credential for a
  brief-mode summary of the public feed (no framework, no profile), so the
  server cannot tell a restricted user apart there and serves the shared
  summary. It sends nothing anywhere; a miss goes to `summarize-article`,
  which is policy-bound. `wm_` key and MCP callers are identified on that
  read and get their own namespace; a Clerk session there is not resolved,
  so it reads the shared row, which holds public-feed text only.
- **Stock-analysis history.** The per-symbol history and backtest ledger are
  one shared store. Restricted callers' analyses are not written to it.
- **Operator keys** (`WORLDMONITOR_VALID_KEYS`) carry no user id and are never
  restricted. Provision a restricted customer with account-bound access:
  `wm_` user keys, MCP OAuth, or dashboard sign-in.

## Setting a policy

The policy is stored in the Convex `aiRoutingPolicies` table, keyed by the
Clerk user id. It is deliberately not part of `entitlements.features`, because
billing webhooks rewrite that object.

```bash
npx convex run --prod entitlements:setAiRoutingPolicy \
  '{"userId":"user_XXXX","allowedProviders":["anthropic"],"reason":"Enterprise API Agreement 6.1"}'
```

```bash
npx convex run --prod entitlements:clearAiRoutingPolicy '{"userId":"user_XXXX"}'
```

Valid provider names: `anthropic`, `openrouter`, `openrouter-free`,
`openrouter-free-backup`, `ollama`, `generic`. Unknown names, an empty list and
an empty reason are rejected. The policy is per user: set it for every user id
the customer signs in or holds keys with, and for any seat added later.

The edge caches each lookup for 60 s in Redis (`ai-routing:{env}:{userId}`).
Setting or clearing a policy deletes that entry, so the change applies on the
next request when Upstash is reachable, and within 60 s otherwise.

## Failure behaviour

If the policy lookup fails for a signed-in caller (Convex error, timeout,
missing configuration, malformed answer), the caller is treated as allowing
no provider: the AI call returns its normal "unavailable" result and nothing
is sent anywhere. It never falls back to the default chain.

If Anthropic itself fails, the call fails. There is no cross-provider
fallback. The adapter enables Anthropic's server-side refusal fallback
(`fallbacks: "default"`), which retries a declined request on another
Anthropic model.

## Configuration

- `ANTHROPIC_API_KEY` must be set on Vercel and on the Railway
  `notification-relay` and digest services. Without it the `anthropic`
  provider is unavailable and restricted accounts get no AI answers there.
  The Railway jobs also need `CONVEX_NOTIFICATION_RELAY_SECRET` and
  `CONVEX_SITE_URL` (or `CONVEX_URL`), which they already use.
- `ANTHROPIC_MODEL` (default `claude-opus-5-5`) and optional
  `ANTHROPIC_REASONING_MODEL`. Utility calls run at effort `low`, reasoning
  calls at `medium`. Current models reject `temperature`, so it is not sent.
  Thinking tokens count against `max_tokens`, so the adapter adds 4,096 tokens
  of headroom on top of the caller's visible-output budget.

## Verifying for a customer

1. Set the policy, then call `classify_event` or `analyze_situation` over MCP
   with the customer's key.
2. Check `llm_call` usage telemetry in Axiom for that request: `provider` must
   be `anthropic` on every attempt, with no `openrouter*`, `ollama` or
   `generic` rows.
3. Call `search_intel_history`: it must return 403 with the policy message.
