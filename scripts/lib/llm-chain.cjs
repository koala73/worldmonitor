'use strict';

const SERVICE_UA = 'worldmonitor-llm/1.0';

const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

function stripReasoningPreamble(text) {
  const trimmed = text.trim();
  if (TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed)) {
    const lines = trimmed.split('\n').filter(l => l.trim());
    const clean = lines.filter(l => !TASK_NARRATION.test(l.trim()) && !PROMPT_ECHO.test(l.trim()));
    return clean.join('\n').trim() || trimmed;
  }
  return trimmed;
}

const LLM_PROVIDERS = [
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': SERVICE_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 25_000,
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': SERVICE_UA }),
    timeout: 15_000,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemini-2.5-flash',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': SERVICE_UA }),
    timeout: 20_000,
  },
];

/**
 * Call an LLM using the Ollama → Groq → OpenRouter provider chain.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=500]
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.timeoutMs] - Override per-provider timeout
 * @returns {Promise<string|null>} Generated text, or null if all providers fail
 */
async function callLLM(systemPrompt, userPrompt, opts = {}) {
  const { maxTokens = 500, temperature = 0.3, timeoutMs } = opts;

  for (const provider of LLM_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;
    const timeout = timeoutMs ?? provider.timeout;

    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: provider.headers(envVal),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature,
          ...provider.extraBody,
        }),
        signal: AbortSignal.timeout(timeout),
      });

      if (!resp.ok) {
        console.warn(`[llm-chain] ${provider.name} API error: ${resp.status}`);
        continue;
      }

      const json = await resp.json();
      const rawText = json.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        console.warn(`[llm-chain] ${provider.name}: empty response`);
        continue;
      }

      const text = stripReasoningPreamble(rawText);
      console.log(`[llm-chain] ${provider.name} OK (${text.length} chars)`);
      return text;
    } catch (err) {
      console.warn(`[llm-chain] ${provider.name} failed: ${err.message}`);
      continue;
    }
  }

  console.warn('[llm-chain] all providers failed');
  return null;
}

module.exports = { callLLM, stripReasoningPreamble };
