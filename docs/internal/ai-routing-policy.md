# Customer AI routing policy

An account can be restricted to a fixed list of AI providers, for example when
a contract says the customer's AI traffic goes to Anthropic directly and
nowhere else. When a policy exists, its provider list is the whole LLM
provider chain for that account's requests: no default chain, no free
fallbacks, no OpenRouter unless the list names it.

## What it covers

Every LLM call made at request time on behalf of a restricted account,
through the REST API, MCP, or a dashboard session:

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

Each of these handlers adds `:ai=<providers>` to its Redis cache key for a
restricted caller, so the caller is never served text another provider wrote.
Unrestricted callers keep the existing keys. These RPCs are tier-gated, so the
gateway marks their responses private and the CDN never stores them.

## What it does not cover

- **Shared content generated in the background** (insights, forecasts, the
  shared country brief, feed classification, digests of public headlines).
  It contains no customer input and is the same for everyone.
- **Background jobs that use one user's data** run on Railway and still use
  their own chains:
  - `scripts/notification-relay.cjs`: AI alert summaries that include the
    user's alert profile (via `scripts/lib/llm-chain.cjs`).
  - `scripts/lib/brief-llm.mjs` `generateDigestProse(userId, …)`: per-user
    digest prose.
  - `scripts/lib/company-monitoring-classifier-client.mjs`: hard-codes
    OpenRouter. Company Monitoring is dark (`COMPANY_MONITORING_ROLLOUT_FLAGS`);
    this must be covered before it ships.

  Until those honour the policy, do not enable AI alert summaries, AI digests
  or Company Monitoring for a restricted account.
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

- `ANTHROPIC_API_KEY` must be set on Vercel. Without it the `anthropic`
  provider is unavailable and restricted accounts get no AI answers.
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
