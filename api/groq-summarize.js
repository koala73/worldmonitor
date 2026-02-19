/**
 * Groq API Summarization Endpoint with Redis Caching
 * Uses Llama 3.1 8B Instant for high-throughput summarization
 * Free tier: 14,400 requests/day (14x more than 70B model)
 * Server-side Redis cache for cross-user deduplication
 */

import { createSummarizeHandler } from './_summarize-handler.js';

export const config = {
  runtime: 'edge',
};

export default createSummarizeHandler({
  name: 'groq',
  logTag: '[Groq]',
  skipReason: 'GROQ_API_KEY not configured',
  getCredentials() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
  },
});
