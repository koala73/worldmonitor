/**
 * bloom.js — Bloom intensity normalization and version migration.
 *
 * The bloom slider was rescaled from 0–100 (v1) to 0–200 (v2) to provide
 * finer control. Share links and saved scene projects may carry either scale,
 * so all ingestion paths pass through {@link decodeBloomIntensity} which
 * detects the version and converts to the v2 range.
 */

/** Current bloom scale version. Persisted in share links / scene projects. */
export const BLOOM_SCALE_VERSION = 2;

/** Maximum bloom intensity on the v2 scale. */
export const BLOOM_INTENSITY_MAX = 200;

/** Default bloom intensity (off). */
export const BLOOM_INTENSITY_DEFAULT = 0;

/** Maximum intensity on the legacy v1 scale (used for migration). */
const LEGACY_BLOOM_INTENSITY_MAX = 100;

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp a raw bloom value to the valid v2 range [0, 200].
 * @param {number} value — raw intensity (may be out of range or NaN)
 * @returns {number} integer in [0, BLOOM_INTENSITY_MAX]
 */
export function clampBloomIntensity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return BLOOM_INTENSITY_DEFAULT;
  return clamp(Math.round(num), 0, BLOOM_INTENSITY_MAX);
}

/**
 * Convert a v1 (0–100) bloom value to the v2 (0–200) scale.
 * The v1 scale was inverted (100 = no bloom, 0 = max bloom),
 * so this also un-inverts.
 * @param {number} value — legacy v1 intensity
 * @returns {number} equivalent v2 intensity
 */
export function legacyBloomToV2(value) {
  const legacy = clamp(Math.round(Number(value) || 0), 0, LEGACY_BLOOM_INTENSITY_MAX);
  return clampBloomIntensity((LEGACY_BLOOM_INTENSITY_MAX - legacy) * 2);
}

/**
 * Decode a bloom intensity from a share link or saved project.
 * Handles both v1 (0–100, inverted) and v2 (0–200) scales.
 * @param {number} value — persisted intensity
 * @param {number} [version=1] — bloom scale version from the saved state
 * @returns {number} v2-scale intensity in [0, 200]
 */
export function decodeBloomIntensity(value, version = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return BLOOM_INTENSITY_DEFAULT;

  const normalizedVersion = Number(version);
  if (Number.isFinite(normalizedVersion) && normalizedVersion >= BLOOM_SCALE_VERSION) {
    return clampBloomIntensity(num);
  }

  // Tolerate unversioned links/projects that already use the new 0..200 scale.
  if (num > LEGACY_BLOOM_INTENSITY_MAX) {
    return clampBloomIntensity(num);
  }

  return legacyBloomToV2(num);
}

/**
 * Convert a bloom intensity (0–200) to a normalized strength (0.0–1.0)
 * suitable for passing to the CesiumJS bloom post-process stage.
 * @param {number} value — v2-scale intensity
 * @returns {number} normalized strength in [0, 1]
 */
export function bloomStrengthFromIntensity(value) {
  return clampBloomIntensity(value) / BLOOM_INTENSITY_MAX;
}
