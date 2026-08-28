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
const OPENROUTER_PROVIDER_ROUTING = {
  ignore: ['baidu', 'alibaba', 'deepseek', 'siliconflow', 'streamlake', 'novita'],
  sort: 'throughput',
};

module.exports = {
  GROQ_DEFAULT_MODEL,
  OPENROUTER_FREE_BACKUP_MODEL,
  OPENROUTER_FREE_PRIMARY_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
};
