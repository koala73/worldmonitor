'use strict';

const OPENROUTER_FREE_PRIMARY_MODEL = 'google/gemma-4-26b-a4b-it:free';
// openai/gpt-oss-20b:free was delisted by OpenRouter — every call returned
// HTTP 404, so the "backup" leg of the free chain had been dead weight for an
// unknown span (observed during the 2026-08-28 newsInsights incident: the
// chain walked primary 429 -> backup 404 -> nothing). Verified against the
// live /models listing and with a real completion on 2026-08-28:
// minimax-m3:free answered 200 with clean instruction-following, and it is a
// different family from the gemma primary, so one vendor's quota exhaustion
// does not take out both free legs at once. (nemotron replied with a
// reasoning preamble — the exact shape stripReasoningPreamble exists to
// scrub — and the glm/gemma-31b candidates were themselves 429 at probe time.)
// The Groq constant below is NOT the same model id: Groq still hosts
// gpt-oss-20b natively; only OpenRouter's :free listing died.
const OPENROUTER_FREE_BACKUP_MODEL = 'minimax/minimax-m3:free';
const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';

// Groq's `openai/gpt-oss-*` are REASONING models. Left at their defaults they
// spend the request's `max_tokens` budget on hidden reasoning tokens and return
// a truncated fragment — or nothing — which is the `empty`/`length` half of
// Groq's 27.6% success rate over the 7 days to 2026-08-28 (543 calls, 393
// failures; the rest are quota `http_429`).
//
// Measured against the live API that day, one prompt at `max_tokens: 150`:
//
//   sent as production did   finish=length  content=38ch   reasoning=672ch  150 tokens
//   reasoning_effort:'low'   finish=stop    content=190ch  reasoning=26ch    52 tokens
//
// Every other provider in every chain already declares reasoning off — Ollama
// `think: false`, all three OpenRouter rungs `reasoning: { enabled: false }`.
// Groq was the only one sending nothing, identically at all seven call sites,
// which is why it went unnoticed. Exported as ONE constant so a new Groq entry
// inherits it instead of re-opening the same gap;
// `tests/groq-reasoning-effort.test.mjs` fails if a call site drops it.
//
// `low`, not `none`: Groq rejects `none` with HTTP 400 — the parameter accepts
// only `low`, `medium`, `high`. `low` is the floor, and for a fallback whose
// job is to return usable prose when the primary is down, reasoning depth is
// not what it is being asked for.
const GROQ_REASONING_EXTRA_BODY = Object.freeze({ reasoning_effort: 'low' });
const OPENROUTER_PROVIDER_ROUTING = {
  ignore: ['baidu', 'alibaba', 'deepseek', 'siliconflow', 'streamlake', 'novita'],
  sort: 'throughput',
};

module.exports = {
  GROQ_DEFAULT_MODEL,
  GROQ_REASONING_EXTRA_BODY,
  OPENROUTER_FREE_BACKUP_MODEL,
  OPENROUTER_FREE_PRIMARY_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
};
