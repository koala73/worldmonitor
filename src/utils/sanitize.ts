/**
 * HTML sanitization utilities for World Monitor
 * Provides safe escaping for HTML content and URLs
 * @module utils/sanitize
 */

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes HTML special characters to prevent XSS attacks
 * Converts characters like <, >, &, " to their HTML entities
 * 
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML insertion
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Sanitizes a URL to ensure it only uses safe protocols
 * Validates http:// and https:// protocols, rejects javascript:, data:, etc.
 * Also handles relative URLs safely
 * 
 * @param {string} url - The URL to sanitize
 * @returns {string} The sanitized URL or empty string if invalid
 * @example
 * sanitizeUrl('https://example.com')
 * // Returns: 'https://example.com'
 * 
 * sanitizeUrl('javascript:alert(1)')
 * // Returns: ''
 */
export function sanitizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (!trimmed) return '';

  const isAllowedProtocol = (protocol: string) => protocol === 'http:' || protocol === 'https:';

  try {
    const parsed = new URL(trimmed);
    if (isAllowedProtocol(parsed.protocol)) {
      return escapeAttr(parsed.toString());
    }
  } catch {
    // Not an absolute URL, continue and validate as relative.
  }

  if (!/^(\/|\\.\/|\.\.\/|\?|#)/.test(trimmed)) {
    return '';
  }

  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://example.com';
    const resolved = new URL(trimmed, base);
    if (!isAllowedProtocol(resolved.protocol)) {
      return '';
    }
    return escapeAttr(trimmed);
  } catch {
    return '';
  }
}

/**
 * Escapes a string for safe use in HTML attributes
 * Alias for escapeHtml() with semantic naming for attribute context
 * 
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML attributes
 * @see escapeHtml
 */
export function escapeAttr(str: string): string {
  return escapeHtml(str);
}
