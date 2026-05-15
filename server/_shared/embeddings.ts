/**
 * Gemini text-embedding-004 client — used by the RSS dedup pipeline to
 * cluster near-duplicate stories without an LLM classifier call.
 *
 * # Why this exists
 *
 * The legacy RSS dedup runs two stages:
 *   1. Title-fingerprint hash (cheap, deterministic).
 *   2. Gemini Flash JSON classifier on borderline pairs (the expensive
 *      part — ~$1-2/mo, slow, and prone to over- or under-grouping on
 *      rare topics).
 *
 * Replacing stage 2 with embedding cosine similarity gives us:
 *   • ~100x cheaper (free tier of text-embedding-004 covers our volume)
 *   • ~10x faster per pass (one batched HTTP call instead of N LLM calls)
 *   • Deterministic — same input always produces same clusters
 *   • Works on raw RSS data (title + description) — no need to wait for
 *     summary/country enrichment first
 *
 * # Cost / limits
 *
 *   • Free tier: 1,500 requests per minute (batched). Our peak is
 *     ~5-10 batches per refresh cycle, well under cap.
 *   • Output: 768-dim Float32 vectors. ~3 KB each, stored base64
 *     alongside items in Redis.
 *
 * # Edge-runtime compatibility
 *
 * Uses fetch + atob/btoa + Uint8Array only. No Node-only `Buffer`
 * references; safe to import from the live-news Edge handlers.
 */

const EMBED_MODEL = 'text-embedding-004';
const EMBED_DIM = 768;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
const MAX_BATCH = 100;
const TIMEOUT_MS = 15_000;

/** Task-type hint to the model — `CLUSTERING` optimises for finding
 *  near-duplicate stories grouped by semantic meaning, which is exactly
 *  what we're doing here. */
const TASK_TYPE = 'CLUSTERING';

function getApiKey(): string | null {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    console.warn('[embeddings] GEMINI_API_KEY env var not set — embedding calls will be skipped');
    return null;
  }
  return k;
}

/**
 * Embed a batch of text inputs. Returns parallel array of `Float32Array | null`
 * — `null` slots map to texts the API couldn't embed (rate-limit, empty
 * string, malformed response). Caller treats null as "this item can't be
 * clustered semantically; fall back to title-fingerprint only".
 *
 * Internally chunks at MAX_BATCH so the caller doesn't have to think
 * about batching. Order of the output matches order of the input.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  const out: (Float32Array | null)[] = new Array(texts.length).fill(null);
  if (texts.length === 0) return out;

  const apiKey = getApiKey();
  if (!apiKey) return out;

  for (let start = 0; start < texts.length; start += MAX_BATCH) {
    const slice = texts.slice(start, start + MAX_BATCH);
    const body = {
      requests: slice.map((text) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: text.slice(0, 8000) }] }, // hard cap on input length
        taskType: TASK_TYPE,
      })),
    };

    try {
      const resp = await fetch(`${ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        console.warn(`[embeddings] HTTP ${resp.status} on batch of ${slice.length}: ${t.slice(0, 200)}`);
        continue;
      }
      const data = (await resp.json()) as { embeddings?: Array<{ values?: number[] }> };
      const embeds = data.embeddings ?? [];
      for (let i = 0; i < slice.length; i++) {
        const values = embeds[i]?.values;
        if (Array.isArray(values) && values.length === EMBED_DIM) {
          out[start + i] = new Float32Array(values);
        }
      }
    } catch (err) {
      console.warn('[embeddings] batch threw:', err instanceof Error ? err.message : err);
      // leave slice as null — caller falls back to title-fingerprint dedup
    }
  }

  return out;
}

/**
 * Cosine similarity, robust to non-normalized vectors. Both inputs must
 * have the same length (768 for text-embedding-004). Returns 1.0 for
 * identical direction, 0 for orthogonal, negative for opposite — though
 * for text embeddings the value is virtually always in [0, 1].
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Pack a Float32Array as base64-encoded raw bytes. Stable across Edge
 * (no `Buffer`) — uses Uint8Array views over the same backing buffer.
 *
 * 768 × 4 = 3072 raw bytes → ~4 KB base64. Negligible per-item overhead.
 */
export function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/**
 * Reverse of `float32ToBase64`. Returns `null` on malformed input
 * (invalid base64, wrong length) so the caller can fall back gracefully.
 */
export function base64ToFloat32(b64: string): Float32Array | null {
  try {
    const binary = atob(b64);
    if (binary.length % 4 !== 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Float32Array view over an aligned copy — atob's output is byte-aligned,
    // but we make a fresh buffer to keep the typed-array semantics clean.
    const aligned = new ArrayBuffer(bytes.length);
    new Uint8Array(aligned).set(bytes);
    return new Float32Array(aligned);
  } catch {
    return null;
  }
}
