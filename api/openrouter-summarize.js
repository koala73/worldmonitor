/**
 * OpenRouter API Summarization Endpoint with Redis Caching
 * Fallback when Groq is rate-limited
 * Uses OpenRouter auto-routed free model
 * Free tier: 50 requests/day (20/min)
 * Server-side Redis cache for cross-user deduplication
 */

import { createSummarizeHandler } from './_summarize-handler.js';

export const config = {
  runtime: 'edge',
};

export default createSummarizeHandler({
  name: 'openrouter',
  logTag: '[OpenRouter]',
  skipReason: 'OPENROUTER_API_KEY not configured',
  getCredentials() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'WorldMonitor',
      },
    };
  },
});
