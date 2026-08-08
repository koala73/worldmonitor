// Declaration file for brief-dedup-consts.mjs so TS callers (currently
// server/_shared/intel-history-client.ts, which shares the embedding model and
// dimensions with the seed writer) don't need `// @ts-expect-error`. Kept
// hand-written, same as scripts/_simulation-queue-constants.d.mts: the module
// is a flat const-export shim with no runtime behaviour to mirror.

export const JACCARD_MERGE_THRESHOLD: number;

export const EMBED_MODEL: string;
export const EMBED_DIMS: number;

export const CACHE_VERSION: string;
export const CACHE_KEY_PREFIX: string;
export const CACHE_TTL_SECONDS: number;

export const OPENROUTER_EMBEDDINGS_URL: string;
