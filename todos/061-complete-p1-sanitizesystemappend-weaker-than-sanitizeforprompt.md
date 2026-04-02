---
status: complete
priority: p1
issue_id: "061"
tags: [code-review, security, prompt-injection, analytical-frameworks]
dependencies: []
---

# `sanitizeSystemAppend` in `llm.ts` is weaker than `sanitizeForPrompt` — intel handlers exposed

## Problem Statement
PR #2386 introduced `sanitizeSystemAppend()` as a private function in `server/_shared/llm.ts` to filter prompt injection phrases before LLM injection. However, it is weaker than the existing `sanitizeForPrompt()` in `server/_shared/llm-sanitize.js`:

- `sanitizeSystemAppend`: 12 hardcoded string-contains phrases, no regex, no control-char stripping, no model delimiter tokens
- `sanitizeForPrompt`: compiled regex patterns covering model delimiters (`<|im_start|>`, `[INST]`, `<system>`), role prefix injection, Unicode separators, control chars U+0000-U+001F

`deduct-situation.ts` and `get-country-intel-brief.ts` pass `framework` directly to `callLlm({ systemAppend: frameworkRaw })`, which applies only `sanitizeSystemAppend`. A PRO user (or any user if todo 060 is not fixed) can inject model delimiter tokens that bypass the weaker filter. Only `summarize-article.ts` calls `sanitizeForPrompt` explicitly — creating an inconsistent defense surface.

Additionally, `sanitizeSystemAppend` strips the phrase `'system:'` anywhere in the text, which mangles legitimate PMESII-PT framework content like "Political system: governance legitimacy".

## Findings
- **`server/_shared/llm.ts:125-140`** — `sanitizeSystemAppend` blocklist; misses delimiter tokens
- **`server/worldmonitor/intelligence/v1/deduct-situation.ts:52`** — `systemAppend: framework || undefined` → goes through weak filter
- **`server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:99`** — same issue
- **`server/worldmonitor/news/v1/summarize-article.ts:127`** — correctly uses `sanitizeForPrompt(systemAppend)` before prompt build
- Confirmed by: security-sentinel, agent-native-reviewer, architecture-strategist, code-simplicity-reviewer

## Proposed Solutions

### Option A: Use `sanitizeForPrompt` inside `callLlm()` (Recommended)
In `server/_shared/llm.ts`, import `sanitizeForPrompt` from `llm-sanitize.js` and replace the `sanitizeSystemAppend` call in `callLlm()` with it:
```ts
// @ts-expect-error — JS module
import { sanitizeForPrompt } from './llm-sanitize.js';
// ... inside callLlm, where systemAppend is appended:
const sanitized = sanitizeForPrompt(systemAppend);
```
**Pros:** All `callLlm` callers get the stronger filter automatically | **Effort:** Small | **Risk:** Low

### Option B: Pre-sanitize in each intel handler before calling `callLlm`
In `deduct-situation.ts` and `get-country-intel-brief.ts`, call `sanitizeForPrompt(frameworkRaw)` before passing to `callLlm`:
```ts
// @ts-expect-error
import { sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
const framework = sanitizeForPrompt(frameworkRaw);
await callLlm({ ..., systemAppend: framework });
```
**Pros:** Explicit, mirrors `summarize-article.ts` pattern | **Cons:** Must be repeated in every new handler | **Effort:** Small | **Risk:** Low

## Technical Details
- Files: `server/_shared/llm.ts`, `server/_shared/llm-sanitize.js`, `server/worldmonitor/intelligence/v1/deduct-situation.ts:52`, `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:99`
- PR: koala73/worldmonitor#2386

## Acceptance Criteria
- [ ] All three LLM handlers apply `sanitizeForPrompt`-level sanitization to `framework`/`systemAppend`
- [ ] Model delimiter tokens (`<|im_start|>`, `[INST]`, etc.) are stripped from framework text
- [ ] `sanitizeSystemAppend` removed or merged into `sanitizeForPrompt` — no parallel paths
- [ ] Word "system:" alone does NOT get stripped from legitimate framework content

## Work Log
- 2026-03-28: Identified during PR #2386 review by 4 independent agents
