/**
 * Tunables for brief-dedup (Jaccard legacy + embedding replacement).
 *
 * Env-driven helpers are exported as functions so the orchestrator
 * reads them at call time, not at module load — Railway env-var flips
 * must take effect without a redeploy.
 *
 * See docs/plans/2026-04-19-001-feat-embedding-based-story-dedup-plan.md.
 */

// ── Jaccard (legacy path, kept as permanent fallback) ───────────────────
// Preserves origin/main behaviour byte-for-byte under MODE=jaccard.
// Threshold 0.55 matches the production implementation prior to this PR.
export const JACCARD_MERGE_THRESHOLD = 0.55;

// ── Embedding / complete-link clustering ────────────────────────────────
export const EMBED_MODEL = 'openai/text-embedding-3-small';
export const EMBED_DIMS = 512;

// Cache key prefix — version segment MUST bump on model or dimension
// change. Silent threshold drift on model upgrade is the documented
// #1 production regression; don't rely on TTL expiry to drain stale
// vectors.
export const CACHE_VERSION = 'v1:text-3-small-512';
export const CACHE_KEY_PREFIX = `brief:emb:${CACHE_VERSION}`;
export const CACHE_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

// Shadow-mode per-run archive (Sample B frame for Phase C/D).
export const SHADOW_ARCHIVE_KEY_PREFIX = 'brief:dedup:shadow:v1';
export const SHADOW_ARCHIVE_TTL_SECONDS = 21 * 24 * 60 * 60; // 14d window + 7d labelling buffer

// OpenRouter embeddings endpoint (OpenAI-compatible passthrough).
export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

// ── Env-driven runtime knobs (read at call time, not module load) ───────

export function getMode() {
  const raw = (process.env.DIGEST_DEDUP_MODE ?? 'jaccard').toLowerCase();
  return raw === 'embed' || raw === 'shadow' || raw === 'jaccard' ? raw : 'jaccard';
}

export function isRemoteEmbedEnabled() {
  return process.env.DIGEST_DEDUP_REMOTE_EMBED_ENABLED !== '0';
}

export function isEntityVetoEnabled() {
  return process.env.DIGEST_DEDUP_ENTITY_VETO_ENABLED !== '0';
}

export function getCosineThreshold() {
  const raw = Number.parseFloat(process.env.DIGEST_DEDUP_COSINE_THRESHOLD ?? '');
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.60;
}

export function getWallClockMs() {
  const raw = Number.parseInt(process.env.DIGEST_DEDUP_WALL_CLOCK_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 45_000;
}

// ── Test harness bag ────────────────────────────────────────────────────
// Exposed so tests can assert against constants without regex-extraction
// from the production source (that fragile harness is what we're killing
// in this PR).
export const __constants = Object.freeze({
  JACCARD_MERGE_THRESHOLD,
  EMBED_MODEL,
  EMBED_DIMS,
  CACHE_VERSION,
  CACHE_KEY_PREFIX,
  CACHE_TTL_SECONDS,
  SHADOW_ARCHIVE_KEY_PREFIX,
  SHADOW_ARCHIVE_TTL_SECONDS,
  OPENROUTER_EMBEDDINGS_URL,
});
