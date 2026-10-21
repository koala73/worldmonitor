# Company Monitoring provider policy and 500-company cost package

- Frozen package review date: 2026-08-05
- Live source refresh: 2026-08-18
- Protocol: `cm_eval_v1`
- Runtime decision: **blocked**
- Stage 0 machine verdict: **STOP** (empirical results remain `not_run`)

This review freezes the policy and price inputs used by the Company Monitoring
Stage 0 decision. It is not legal advice or a durable provider guarantee. Provider
terms, prices, declared use cases, and model endpoints must be refreshed
before any paid runtime is enabled.

## Exa

The Exa adapter remains dark while
`COMPANY_MONITORING_ROLLOUT_FLAGS.exaProvider` in
`convex/config/productCatalog.ts` is false.

- Use only Exa's official API. No browser scraping or credential sharing.
- The current Search price is $7 per 1,000 requests for up to ten results,
  plus $1 per 1,000 additional results above ten. Each requested content type is
  $1 per 1,000 pages. The default Search rate limit is 10 queries per second.
- Search responses expose result-level crawl status and cost metadata. A capped,
  partial, or failed result must remain partial and cannot refresh coverage as
  adequate quiet.
- Exa's service does not confer rights to republish every indexed page. Store only
  permitted excerpts and metadata and preserve source-specific restrictions.

Sources: [Exa pricing](https://exa.ai/pricing),
[Search API](https://exa.ai/docs/reference/search),
[Contents API](https://exa.ai/docs/reference/contents-api-guide), and
[rate limits](https://exa.ai/docs/reference/rate-limits).

## X

The X adapter remains dark while `COMPANY_MONITORING_ROLLOUT_FLAGS.xProvider`
in `convex/config/productCatalog.ts` is false. Activation must retain the
content-handling controls below.

- Use only the official X API. Recent search covers seven days and returns up to
  100 Posts per request; full-archive search is a separate pay-per-use or
  Enterprise surface.
- Current pay-per-use pricing is $0.005 per Post read and $0.010 per User read.
  Pay-per-use plans have a two-million-Post monthly read cap. The $200/month
  console spend cap was confirmed 2026-08-18 (#6653). One Bearer covers Track A
  and Track B.
- X post text is R4: panels may show API-fresh posts or official embeds;
  alerts, MCP, and embed partners get derived facts plus permalink only, never
  tweet bodies. Default storage remains `metadata_only`. 24-hour
  deletion/tombstone compliance is required. Scraping is prohibited.
- Track A budget is about $115/month of that cap. Track B bring-up is 50
  companies at a 2-hourly cadence, about $60/month. The 500-company entitlement
  in the frozen cost package is unchanged committed scope and is not this
  bring-up portfolio.
- X requires the declared use case to remain current. Its agreement requires an
  Enterprise plan when use grows beyond commercial prototyping, initial
  integration, or a limited number of end users. API credentials and purchased
  credits do not activate the Company Monitoring rollout flag.
- Offline X Content must track deletion, edit, protection, suspension, and
  withholding. Applicable removals must occur as soon as reasonably possible and
  within 24 hours of a request. Batch compliance may be used for bounded audits;
  high-volume compliance streams require Enterprise access.
- X Content may not train an AI or machine-learning model. Raw X text, handles,
  or provider URLs cannot enter customer alerts, logs, or committed evaluation
  fixtures.

Before activation, runtime enforcement must cover offline edit, deletion,
protection, and withholding handling plus the model-training prohibition.

Sources: [X pricing](https://docs.x.com/x-api/getting-started/pricing),
[usage and billing](https://docs.x.com/x-api/fundamentals/post-cap),
[search access](https://docs.x.com/x-api/posts/search/introduction),
[Developer Policy](https://docs.x.com/developer-terms/policy),
[Developer Agreement](https://docs.x.com/developer-terms/agreement), and
[Batch Compliance](https://docs.x.com/x-api/compliance/batch-compliance/introduction).

## Model routing

Status: the dedicated runtime contract is implemented; empirical use remains
blocked by the frozen Stage 0 decision.

The cost model uses OpenRouter's `deepseek/deepseek-v4-flash` price snapshot:
$0.09 per million input tokens and $0.18 per million output tokens, plus the
5.5% credit-purchase fee. Reasoning is disabled for this extraction/classification
shape.

Every Company Monitoring request must:

- pin and record the model and provider-policy version;
- send `provider.zdr: true` or an equivalent enforced organization guardrail;
- disallow providers that train on prompts;
- retain no prompts or completions in OpenRouter activity logging; and
- fail closed when no eligible zero-data-retention endpoint exists.

The provider result must separately mark the route approved and prove all four
runtime controls: ZDR, no prompt training, disabled reasoning, and pinned model
and provider routing. Declaring those requirements in policy without runtime
enforcement remains blocked.

OpenRouter states that its own prompts are not retained unless prompt logging is
enabled, supports request-level zero-data-retention routing, and conservatively
marks endpoints with unknown policy as retaining and training. The dedicated
Company Monitoring client now sends `provider.only` with one configured route,
`allow_fallbacks: false`, `require_parameters: true`, `data_collection: deny`,
and `zdr: true`. It sends `temperature: 0`, disables reasoning, requests router
metadata, and fails closed unless the response proves the requested model,
direct single-attempt route, selected endpoint, expected resolved provider, no
transformation pipeline, and request cost. Live admission requires both
`COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE` and
`COMPANY_MONITORING_CLASSIFIER_RESOLVED_PROVIDER`; a key and model alone no
longer enable admission classification. Admission receipts include the
requested route and the attested resolved provider in their model-version
identity.

These request controls do not override the checked-in protocol. While Stage 0 is
`STOP`, the worker's checked-in classifier runtime gate remains `false`, and the
offline prediction command exits before it loads credentials or sends a paid
request. Provisioning the key, model, and route therefore cannot activate live
classification. Account-level activity-logging state also remains an external
attestation; no score can infer it from a successful model response.

Sources: [OpenRouter zero data retention](https://openrouter.ai/docs/guides/features/zdr),
[provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging/),
[pricing](https://openrouter.ai/pricing), and
[DeepSeek V4 Flash pricing](https://openrouter.ai/deepseek/deepseek-v4-flash/pricing).

The 2026-08-16 refresh found two items that prevent the frozen cost package from
serving as current production approval. OpenRouter's live model catalog still
lists `deepseek/deepseek-v4-flash`, but at $0.06146 per million input tokens and
$0.12292 per million output tokens, not the frozen price snapshot. OpenRouter
also states that account-level ZDR disables response caching, while per-request
`provider.zdr` does not affect cache eligibility. The current client proves the
per-request routing constraint, but it does not prove the external account-level
ZDR and logging settings. Current price or account-control evidence must use a
new reviewed package; it cannot rewrite `cm_eval_v1` after scoring.

The 2026-08-18 refresh folds #6653 X facts into this package without rewriting
the frozen 500-company arithmetic. Console spend cap $200/month is confirmed.
The inadmissible 2026-08-18 audit did not flip `paidRuntimeApproved`, any
`COMPANY_MONITORING_ROLLOUT_FLAGS` value, or the frozen economics object. Local
`EXA_API_KEYS` and `X_BEARER_TOKEN` were missing in the measurement worktree; X
Bearer remains on Railway `company-monitoring-worker`. The audit used SEC Form D
(reference / selection) and Google News RSS (news search), not Exa or X product
runtime. It is not acceptance evidence for `cm_eval_v1`.

## Production-shaped monthly model

The model covers exactly one account-level shared-discovery workload of 500
companies for a 30-day month. It is a budget envelope, not measured capacity or
a promise of provider yield.

| Component | Frozen assumption | Monthly cost |
|---|---|---:|
| Exa Search | 12 searches/day, 25 results/search; $0.007 base plus 15 additional results at $0.001 each | $7.92 |
| Exa content | One content type for 25 pages across 12 searches/day at $0.001/page | $9.00 |
| X Post reads | 250 Posts/day at $0.005/Post | $37.50 |
| X User reads | 500 User reads/month at $0.010/User | $5.00 |
| Model | 250 candidates/day, 4,000 input and 1,000 output tokens each, plus 5.5% fee | $4.27275 |
| Allocated infrastructure | Convex, Railway, storage, and telemetry envelope | $25.00 |
| Subtotal | Before contingency | $88.69275 |
| Contingency | 25% | $22.1731875 |
| **Total** | 500 companies | **$110.8659375** |

The frozen ceiling is $125 per account-month, or $0.25 per monitored company.
The modeled total is $0.221731875 per company and therefore passes the arithmetic
gate for the frozen 2026-08-05 snapshot. It is not a current price approval and
does not override the Stage 0 stop. Before paid beta, the fourteen-day
tracer must replace every volume assumption with measured requests, returned
resources, caps, tokens, storage, and retry cost. Any changed provider price or
workload shape requires a new cost-package version and product-owner decision.
In particular, changing the portfolio size from 500 or modeling more than one
account cannot reuse this package.

## Frozen requirements and mutable runtime evidence

Provider access, retention, compliance, and model-routing requirements are part
of the frozen approved-threshold projection. Runtime status, evidence digests,
and enforcement flags live in a separate mutable result record. That separation
permits honest evidence to arrive without changing the approved threshold digest
while preventing a status-only promotion.
