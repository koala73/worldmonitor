# OpenRouter Free Fallback Model for WorldMonitor

- Research date: 2026-08-15
- Scope: exact zero-price OpenRouter chat-model IDs that can replace the Groq
  `llama-3.3-70b-versatile` fallback
- Sources: official OpenRouter pages and APIs, plus official model-owner
  documentation only

## Decision

Use `google/gemma-4-26b-a4b-it:free` as the default zero-price fallback.
Use `openai/gpt-oss-20b:free` as the backup.

Do not use `nvidia/nemotron-3-super-120b-a12b:free` in production, despite its
stronger technical profile. OpenRouter's endpoint notice says NVIDIA logs free
endpoint use for security and product improvement and tells users not to submit
confidential or personal data. It also binds use to the NVIDIA API Trial Terms.
Those terms limit the service and generated content to trial, internal testing,
and evaluation unless the user has a separate production subscription.

This recommendation is for a best-effort outage fallback, not a production
capacity replacement. OpenRouter says free models are usually unsuitable for
production. The shared free-model allowance is only 50 requests per day unless
the account has purchased at least $10 of credits, after which it is 1,000
requests per day.

## Why this fits WorldMonitor

WorldMonitor currently uses the Groq model for fast extraction and parsing,
prompt-driven JSON, insight narratives and summaries, and forecast resolution.
The relevant callers generally give an attempt 15 to 30 seconds, validate the
returned text themselves, and do not consistently send `response_format` or a
JSON schema. A useful fallback therefore needs fast non-reasoning generation,
good instruction following, and reliable plain-text JSON, not only tool support.

`google/gemma-4-26b-a4b-it:free` is the best current compromise:

- The live OpenRouter catalog reports $0 input and $0 output pricing, a 262,144
  token catalog context, a 32,768 token maximum output, and support for
  `response_format`, structured outputs, and tools.
- The current endpoint inventory has two free providers. One exposes a 262,144
  token context and the other 131,072 tokens. Treat 131,072 as the portable
  routing floor unless the request pins a provider.
- Google's model card describes native system-role support, configurable
  thinking, native function calling, a 256K context for the 26B A4B model, and
  multilingual support. Those properties match extraction, international news
  summaries, and bounded forecast-resolution prompts.
- Disable reasoning for short utility calls. This avoids spending a small output
  budget on hidden reasoning and is consistent with WorldMonitor's existing
  OpenRouter utility-call policy.

The main quality risk is size: Gemma 4 26B A4B has 25.2B total parameters and
3.8B active per token, so it is not a like-for-like replacement for Llama 3.3
70B. Forecast resolution and long narrative synthesis need validation against
WorldMonitor's real prompts before promotion beyond fallback status. The free
Google endpoint also logs prompts for 55 days, although its OpenRouter policy
says prompts are not used for training.

## Shortlist

| Exact model ID | Zero price | Context / max output | Advertised JSON and tools | WorldMonitor assessment |
|---|---:|---:|---|---|
| `google/gemma-4-26b-a4b-it:free` | $0 / $0 | 262K catalog; 131K portable endpoint floor / 32K | `response_format`, structured outputs, tools | **Default.** Best fit for short extraction, multilingual summaries, and bounded JSON. Validate forecast decisions. |
| `openai/gpt-oss-20b:free` | $0 / $0 | 131K / 32K | `response_format`, structured outputs, tools | **Backup.** Strong instruction, tool, and adjustable reasoning support, but smaller and English-heavy. Provider availability and data policy can change. |
| `nvidia/nemotron-3-super-120b-a12b:free` | $0 / $0 | 262K / 262K | `response_format`, structured outputs, tools | Technically attractive for synthesis and resolution, but the free endpoint logs/trains on use and its trial terms prohibit production use without a separate subscription. |
| `liquid/lfm-2.5-2.6b:free` | $0 / $0 | 128K / 8K | `response_format`, structured outputs, tools | Small, fast emergency option for extraction only. Too small for the full workload and currently has one free endpoint. |
| `openrouter/free` | $0 / $0 | 200K router declaration | Filters by requested features | Do not use as the fixed fallback. It randomly selects an available free model, so quality, latency, context, and model identity can change per request. |

OpenAI describes gpt-oss-20b as a 21B-total, 3.6B-active, text-only model with
128K context, adjustable reasoning effort, instruction following, tool use, and
Structured Outputs. It is a reasonable independent backup, but its mostly
English training mix and smaller active size make it less suitable than Gemma 4
for WorldMonitor's multilingual and judgment-heavy tasks.

## All exact `:free` IDs in the live catalog

The following entries had both `pricing.prompt == "0"` and
`pricing.completion == "0"` in the official Models API on the research date.
"JSON" means the catalog advertises both `response_format` and
`structured_outputs`; "tools" means it advertises `tools`. All entries reported
`expiration_date: null`, but that is not an availability guarantee.

| Exact ID | Context | JSON | Tools |
|---|---:|:---:|:---:|
| `liquid/lfm-2.5-2.6b:free` | 128K | yes | yes |
| `nvidia/nemotron-3.5-lightning:free` | 1M | no | yes |
| `poolside/laguna-s-2.1:free` | 262K | no | yes |
| `poolside/laguna-xs-2.1:free` | 262K | no | yes |
| `cohere/north-mini-code:free` | 256K | no | yes |
| `nvidia/nemotron-3.5-content-safety:free` | 128K | no | no |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | no | yes |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256K | no | yes |
| `google/gemma-4-26b-a4b-it:free` | 262K | yes | yes |
| `google/gemma-4-31b-it:free` | 262K | partial | yes |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262K | yes | yes |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 256K | no | yes |
| `nvidia/nemotron-nano-12b-v2-vl:free` | 128K | no | yes |
| `nvidia/nemotron-nano-9b-v2:free` | 128K | yes | yes |
| `openai/gpt-oss-20b:free` | 131K | yes | yes |

`meta-llama/llama-3.3-70b-instruct:free` is **not** in the live catalog. The
non-free `meta-llama/llama-3.3-70b-instruct` entry remains available, but its
input and output prices are nonzero. Do not hard-code the old free slug.

Most other exact free entries are specialized for coding, content safety,
multimodal reasoning, or long-horizon agents, or they do not advertise structured
outputs. They are weaker matches for the combined WorldMonitor workload.

## Availability, privacy, and migration risks

1. **Shared daily quota:** the 50 or 1,000 request allowance applies across free
   models, not separately to each model. A multi-stage forecast or retry chain can
   consume several requests for one logical job.
2. **No production reliability promise:** free variants have lower limits and
   variable availability. OpenRouter explicitly recommends them for low-volume
   experimentation rather than normal production workloads.
3. **Provider policy varies:** model weights and the hosting endpoint have
   separate policies. Configure OpenRouter's free-model data-policy setting and
   request-level provider filters. Recheck the endpoint inventory before release.
4. **Context is route-dependent:** use the smallest context among eligible free
   endpoints, not only the model-page headline.
5. **Structured support is not structured reliability:** a catalog parameter only
   proves that a route accepts the parameter. Keep WorldMonitor's parse,
   validation, citation, and fail-closed gates, and add a schema request where the
   caller can safely do so.
6. **No deprecation notice found:** the official free-variant and API docs had no
   sunset banner, and the shortlisted Models API entries reported no expiration
   date. Free capacity can still disappear without a migration window, so retain
   both exact IDs and monitor 404, 429, and provider-unavailable responses.

Before promoting either free model beyond fallback duty, run the default and backup against a frozen, non-sensitive
sample of each WorldMonitor call shape: extraction JSON, insight narrative,
summary, and forecast resolution. Measure parse acceptance, citation validity,
decision agreement, latency at the existing timeout, and quota consumption. Do
not send private or user-submitted data through a free endpoint without a separate
data-policy review.

## Primary sources

- [OpenRouter Models API](https://openrouter.ai/api/v1/models) — live IDs,
  pricing, contexts, supported parameters, and expiration fields.
- [OpenRouter free-variant documentation](https://openrouter.ai/docs/guides/routing/model-variants/free)
  and [free-model router documentation](https://openrouter.ai/docs/guides/routing/routers/free-router)
  — free suffix semantics, random router selection, and availability caveats.
- [OpenRouter FAQ](https://openrouter.ai/docs/faq) — 50/1,000 daily request
  limits and production-suitability warning.
- [Gemma 4 free endpoint](https://openrouter.ai/google/gemma-4-26b-a4b-it%3Afree/pricing)
  and [Google's Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)
  — endpoint policy and model capabilities.
- [gpt-oss-20b free endpoint](https://openrouter.ai/openai/gpt-oss-20b%3Afree/providers)
  and [OpenAI's gpt-oss model card](https://openai.com/index/gpt-oss-model-card/)
  — exact endpoint and model capabilities.
- [Nemotron 3 Super free endpoint](https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b%3Afree/pricing),
  [NVIDIA model card](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard),
  and [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
  — capabilities, logging notice, and production restriction.
- [OpenRouter provider logging documentation](https://openrouter.ai/docs/guides/privacy/provider-logging/)
  — training and retention policy controls.
