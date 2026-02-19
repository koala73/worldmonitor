/**
 * Ollama OpenAI-compatible Summarization Endpoint with Redis Caching
 * Sends requests to a local (or remote) Ollama instance via its
 * OpenAI-compatible /v1/chat/completions endpoint.
 * Shares the Redis cache key strategy with Groq and OpenRouter handlers.
 */

import { createSummarizeHandler } from './_summarize-handler.js';

export const config = {
  runtime: 'edge',
};

const DEFAULT_MODEL = 'llama3.1:8b';

export default createSummarizeHandler({
  name: 'ollama',
  logTag: '[Ollama]',
  skipReason: 'OLLAMA_API_URL not configured',
  getCredentials() {
    const baseUrl = process.env.OLLAMA_API_URL;
    if (!baseUrl) return null;
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return {
      apiUrl: new URL('/v1/chat/completions', baseUrl).toString(),
      model: process.env.OLLAMA_MODEL || DEFAULT_MODEL,
      headers,
      extraBody: { think: false },
    };
  },
});
