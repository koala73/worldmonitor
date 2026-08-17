/**
 * LLM prompt injection sanitizer — type declarations for llm-sanitize.js
 */

/** Sanitize a single string for safe inclusion in an LLM prompt. */
export function sanitizeForPrompt(input: unknown): string;

/**
 * Sanitize a string for safe inclusion in a *single line* of an LLM prompt —
 * sanitizeForPrompt plus a collapse of every whitespace run (lone newlines,
 * carriage returns and tabs included) to a single space.
 */
export function sanitizeForPromptLine(input: unknown): string;

/** Sanitize an array of headline strings, dropping any that become empty after sanitization. */
export function sanitizeHeadlines(headlines: unknown[]): string[];

/**
 * Structural-only sanitization for a single headline — strips model delimiters
 * and control characters but preserves semantic phrases (e.g. quoted injection
 * phrases that are the subject of a news story).
 */
export function sanitizeHeadline(input: unknown): string;

/** Apply sanitizeHeadline() over an array, dropping empties. */
export function sanitizeHeadlinesLight(headlines: unknown[]): string[];
