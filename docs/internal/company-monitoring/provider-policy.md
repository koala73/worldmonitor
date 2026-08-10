# Company Monitoring provider policy and 500-company cost package

- Review date: 2026-08-05
- Protocol: `cm_eval_v1`
- Runtime decision: **blocked**

This review freezes the policy and price inputs used by the Company Monitoring
Stage 0 decision. It is not legal advice or a durable provider guarantee. Provider
terms, prices, approved-use declarations, and model endpoints must be refreshed
before any paid runtime is enabled.

## Exa

Status for evaluation: approved. Status for paid runtime: blocked pending a
separate runtime-scoped approval and its 64-hex evidence digest. Evaluation
approval and API access cannot be reused as production approval.

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

Status: blocked pending written approval for the intended commercial use and a
reviewed, enforced compliance implementation. An `approved` status alone is
insufficient.

- Use only the official X API. Recent search covers seven days and returns up to
  100 Posts per request; full-archive search is a separate pay-per-use or
  Enterprise surface.
- Current pay-per-use pricing is $0.005 per Post read and $0.010 per User read.
  Pay-per-use plans have a two-million-Post monthly read cap.
- X requires the declared use case to remain current. Its agreement requires an
  Enterprise plan when use grows beyond commercial prototyping, initial
  integration, or a limited number of end users. Company Monitoring therefore
  cannot infer production approval from API credentials or purchased credits.
- Offline X Content must track deletion, edit, protection, suspension, and
  withholding. Applicable removals must occur as soon as reasonably possible and
  within 24 hours of a request. Batch compliance may be used for bounded audits;
  high-volume compliance streams require Enterprise access.
- X Content may not train an AI or machine-learning model. This product may use a
  version-locked inference policy only after the approved use case explicitly
  covers it. Raw X text, handles, or provider URLs cannot enter customer alerts,
  logs, or committed evaluation fixtures.

The runtime result passes only with a 64-hex written commercial-use evidence
digest and affirmative enforcement flags for offline edit/deletion/protection/
withholding compliance and the model-training prohibition.

Sources: [X pricing](https://docs.x.com/x-api/getting-started/pricing),
[usage and billing](https://docs.x.com/x-api/fundamentals/post-cap),
[search access](https://docs.x.com/x-api/posts/search/introduction),
[Developer Policy](https://docs.x.com/developer-terms/policy),
[Developer Agreement](https://docs.x.com/developer-terms/agreement), and
[Batch Compliance](https://docs.x.com/x-api/compliance/batch-compliance/introduction).

## Model routing

Status: blocked until the runtime proves the frozen privacy route.

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
marks endpoints with unknown policy as retaining and training. The current shared
WorldMonitor OpenRouter route does not enforce `provider.zdr: true`, so Company
Monitoring may not reuse it for portfolio-derived content until that dark contract
lands and passes its own tests.

Sources: [OpenRouter zero data retention](https://openrouter.ai/docs/guides/features/zdr),
[provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging/),
[pricing](https://openrouter.ai/pricing), and
[DeepSeek V4 Flash pricing](https://openrouter.ai/deepseek/deepseek-v4-flash/pricing).

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
gate. This does not override the Stage 0 stop. Before paid beta, the fourteen-day
tracer must replace every volume assumption with measured requests, returned
resources, caps, tokens, storage, and retry cost. Any changed provider price or
workload shape requires a new cost-package version and product-owner decision.
In particular, changing the portfolio size from 500 or modeling more than one
account cannot reuse this package.

## Frozen requirements and mutable runtime evidence

Provider access, retention, compliance, and model-routing requirements are part
of the frozen approved-threshold projection. Runtime approval status, evidence
digests, and enforcement flags live in a separate mutable result record. That
separation permits honest evidence to arrive without changing the approved
threshold digest while preventing a status-only promotion.
