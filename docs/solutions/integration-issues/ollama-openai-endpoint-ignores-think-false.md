---
title: "Ollama's OpenAI-compatible endpoint ignores think false, and the sidecar idle timer cut silent completions"
date: 2026-10-25
category: integration-issues
module: ollama-llm-provider
problem_type: integration_issue
component: assistant
symptoms:
  - "Desktop headline translation shows 'Translation unavailable. Check your AI provider settings and try again.' with a local qwen3:8b"
  - "summarize-article returns HTTP 200 with status SUMMARIZE_STATUS_ERROR and statusDetail Error after about 12 seconds"
  - "local-api.log shows '[SummarizeArticle:ollama] Error: Error upstream request idle-timed out'"
  - "A direct /v1/chat/completions call with no reasoning control returns empty content, finish_reason length, and a reasoning field"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components: [testing_framework]
tags: [ollama, qwen3, reasoning, think, reasoning-effort, sidecar, idle-timeout, desktop-translation]
---

# Ollama's OpenAI-compatible endpoint ignores think false, and the sidecar idle timer cut silent completions

## Problem

Desktop headline translation with a local reasoning model failed on v2.11.4, after #9477 fixed the cloud routing from issue #9476. Two separate faults stacked. Ollama never received the instruction to stop reasoning, and the desktop sidecar killed the silent completion at 12 seconds.

## Symptoms

- The translate button shows "Translation unavailable" while `/api/llm-health` returns 200 and the Ollama CLI translates fine.
- `POST /api/news/v1/summarize-article` with `provider: 'ollama'` and `mode: 'translate'` returns HTTP 200 carrying `SUMMARIZE_STATUS_ERROR` and `statusDetail: "Error"` after 12.01 seconds.
- `local-api.log` repeats `[SummarizeArticle:ollama] Error: Error upstream request idle-timed out`.
- The reporter's direct `/v1/chat/completions` call with no reasoning control took 81 seconds and returned `content: ""`, `finish_reason: "length"`, and a 409-character `reasoning` field. The same call with `reasoning_effort: "none"` returned the German translation in 2 seconds.

## What Didn't Work

- The original fix for #9137 (PR #9430) and the routing fix (PR #9477) both assumed the request only had to reach the local handler. Their tests used a fake Ollama that answered instantly and ignored reasoning fields, so neither could see either fault below.
- `extraBody: { think: false }` looked correct because `think` is a real field on Ollama's native `/api/chat`. It is not a field on the OpenAI-compatible endpoint that every World Monitor Ollama config targets.

## Solution

Send the reasoning control the OpenAI-compatible endpoint reads. All four Ollama provider configs changed in PR #9674:

```js
// Before
extraBody: { think: false },
// After
extraBody: { reasoning_effort: 'none' },
```

The four sites are `server/_shared/llm.ts:150`, `scripts/lib/llm-chain.cjs:86`, `scripts/ais-relay.cjs:5078` and `scripts/seed-insights.mjs:428`.

Give the configured Ollama origin its own finite idle bound in the sidecar's patched fetch (`src-tauri/sidecar/local-api-server.mjs:107` and `:321`):

```js
let _ollamaIdleTimeoutMs = 90000;
// ...
const idleTimeoutMs = isConfiguredOllamaOrigin(url) ? _ollamaIdleTimeoutMs : _upstreamIdleTimeoutMs;
req.setTimeout(idleTimeoutMs, () => { /* destroy and reject */ });
```

## Why This Works

Ollama's [`middleware/openai.go`](https://github.com/ollama/ollama/blob/v0.40.11/middleware/openai.go) binds the request with Gin's `ShouldBindJSON` into `openai.ChatCompletionRequest`, which has `reasoning` and `reasoning_effort` fields but no `think` field. The unknown field is dropped without an error. With no thinking value, Ollama's `ChatHandler` in [`server/routes.go`](https://github.com/ollama/ollama/blob/v0.40.11/server/routes.go) sets thinking on for any model with the thinking capability. Qwen3 then spends the handler's `max_tokens: 100` (`server/worldmonitor/news/v1/summarize-article.ts:362`) on reasoning and returns empty content. `ThinkingFromReasoningEffort` maps `"none"` to think false, which reaches the model. These Ollama source details were read at release v0.40.11.

`reasoning_effort: "none"` is safe for models that cannot reason. Ollama only rejects a request that asks a non-thinking model to think. Releases from v0.12.4 (2025-10-03) accept `"none"` explicitly. In v0.12.3 the string evaluates to thinking off and the chat handler does not validate it.

The sidecar's `ipv4Fetch` sets a socket idle timer (PR #5489) that fires after a span with no bytes, to free an upstream slot from a peer that goes silent. A non-streaming Ollama completion sends nothing until inference ends, so the 12s timer (`local-api-server.mjs:102`) fired before the handler's own `AbortSignal.timeout(25_000)` (`summarize-article.ts:366`). The 90s Ollama bound outlasts the longest server LLM deadline (60s), so the caller's deadline ends a slow completion and the idle timer only reclaims a slot from a server that truly hangs.

A first version skipped the idle timer whenever the caller passed a signal. Review on PR #9674 caught that a signal without a deadline would then leave a request unbounded and leak its slot. A finite per-origin bound avoids that without depending on the caller.

## Prevention

- Send `reasoning_effort: 'none'` to Ollama's `/v1/chat/completions`. Use `think` only with the native `/api/chat` endpoint. `tests/ollama-reasoning-control.test.mjs` scans the four call sites and fails if `think: false` returns.
- Make a fake LLM server behave like the real one. A fake that returns content regardless of the reasoning field, or answers instantly, cannot catch either fault. `tests/desktop-ollama-reasoning-translation.test.mts` returns empty content unless it receives `reasoning_effort: 'none'` and stays silent longer than a shrunk sidecar idle timeout.
- Importing `src-tauri/sidecar/local-api-server.mjs` replaces `globalThis.fetch` with `ipv4Fetch` once. A test that restores the native fetch afterward makes every later test in the same file bypass the sidecar's fetch, because the cached module never reinstalls it. A test that needs the patched fetch belongs in its own file, which `scripts/run-data-tests.mjs` runs in its own process. Prove such a test by reverting the fix and watching it fail.
- Before adding an idle or socket timer in front of an LLM call, check whether the upstream streams. A non-streaming completion is silent for its whole duration.

## Related

- Issue #9476 and its follow-up comment with the reporter's measurements
- PR #9477, which kept Ollama translation on the local handler
- PR #9674, which carries this fix
- PR #5489, which added the sidecar idle timer
