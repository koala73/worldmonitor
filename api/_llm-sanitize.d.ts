/**
 * Type declarations for api/_llm-sanitize.js
 */

/**
 * Sanitize a single string for safe inclusion in an LLM prompt.
 * Strips injection patterns, control characters, role markers, and
 * model-specific delimiter tokens.
 */
export function sanitizeForPrompt(input: unknown): string;

/**
 * Sanitize an array of headline strings, dropping any that become empty
 * after sanitization.
 */
export function sanitizeHeadlines(headlines: unknown[]): string[];
