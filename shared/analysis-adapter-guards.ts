/**
 * Shared scalar guards for the analysis adapters (#5696).
 *
 * Both adapter modules map untrusted seeded-cache JSON onto the analysis
 * cores' input types, so both need the same defensive primitives. They were
 * written independently and grew two names for each concept
 * (`finiteNumber`/`num`, `nonEmptyString`/`str`); one definition removes the
 * drift risk, since a divergence in null-handling here silently empties a
 * result set rather than raising.
 *
 * Semantics are deliberately permissive on INPUT (a seeder that stores a
 * number as a string still parses) and strict on VALIDATION (a coordinate
 * must be real and in range).
 *
 * Dependency-free: importable from Vite client code, Vercel Edge bundles,
 * server handlers, and tsx tests alike.
 */

/** Narrow to a plain object; arrays and null are rejected. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Always yields an iterable — a non-array becomes empty rather than throwing. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Finite number, accepting a numeric string; anything else is null. */
export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Trimmed string, or '' for anything non-string or whitespace-only. */
export function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * A coordinate pair usable as a real position: both components present, in
 * range, and not null island — (0, 0) is overwhelmingly a missing-data
 * artifact in these feeds rather than a location in the Gulf of Guinea.
 *
 * Note the exposure adapters deliberately do NOT apply this: they enrich
 * whatever the caller asks about, and rejecting a point there would silently
 * drop an event rather than decline to place it on a grid.
 */
export function usableCoord(lat: number | null, lon: number | null): lat is number {
  return (
    lat !== null && lon !== null &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/** Read a nested `{ location: { latitude, longitude } }` pair. */
export function nestedLocation(record: Record<string, unknown>): { lat: number | null; lon: number | null } {
  const location = asRecord(record.location);
  return {
    lat: finiteNumber(location?.latitude),
    lon: finiteNumber(location?.longitude),
  };
}
