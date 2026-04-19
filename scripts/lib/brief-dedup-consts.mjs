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

// Active dedup classifier config (Railway → Upstash). The digest cron
// writes the resolved env values here on every tick; the nightly
// golden-pair canary reads this key to decide what to validate, so
// Railway stays the single source of truth and the GH-Actions canary
// doesn't need parallel repo variables. TTL is longer than the cron
// gap so a healthy cron always leaves the key populated; a stale
// (missing / expired) key signals "cron hasn't run" and the canary
// skips accordingly.
export const ACTIVE_CONFIG_KEY = 'brief:dedup:config:v1';
export const ACTIVE_CONFIG_TTL_SECONDS = 2 * 60 * 60; // 2 hours — covers the 30min cron cadence with margin

// OpenRouter embeddings endpoint (OpenAI-compatible passthrough).
export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

// Env-driven runtime knobs live in brief-dedup.mjs:readOrchestratorConfig
// — a single source of truth, read at call entry so Railway env flips
// take effect on the next tick. An earlier version exported getter
// helpers here too; they had zero callers and were deleted.

// An earlier iteration exposed an `__constants` bag so tests could
// assert against tunables in one deepEqual. Once the regex-extraction
// harness was removed, named imports became cleaner — the bag got
// deleted. If you need to assert a constant, import it directly.
