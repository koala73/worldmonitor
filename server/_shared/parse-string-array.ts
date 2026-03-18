/**
 * Defensive parser for repeated-string query params.
 * Some codegen paths may pass comma-separated strings into string[] fields.
 */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').filter(Boolean);
  return [];
}
