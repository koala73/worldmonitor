/**
 * Edge API re-export for shared LLM prompt sanitization utilities.
 * Keeps existing api/_llm-sanitize.js imports stable while implementation
 * lives in server/_shared to avoid server->api boundary crossing.
 */

export {
  sanitizeForPrompt,
  sanitizeHeadlines,
} from '../server/_shared/llm-sanitize.js';
