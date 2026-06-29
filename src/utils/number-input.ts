export function parseIntegerInputValue(
  rawValue: string | number | null | undefined,
  options: { min: number; max: number; fallback?: number },
): number {
  const fallback = options.fallback ?? options.min;
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
  if (!trimmed) return fallback;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(options.max, Math.max(options.min, parsed));
}
