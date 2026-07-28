/**
 * Seeder-side helper for the historical intelligence memory (#5694).
 *
 * Seeders call `appendSeedHistory` from their `afterPublish` hook to
 * embed a run's noteworthy records and append them to the Convex
 * intel-history store via the authenticated `/relay/intel-history`
 * HTTP action.
 *
 * FAIL-OPEN BY DESIGN. History is a secondary artefact of a seed run —
 * a history failure must never fail the run. Two layers enforce that:
 *
 *   1. Missing configuration is NOT an error. Any of CONVEX_SITE_URL
 *      (or CONVEX_URL), RELAY_SHARED_SECRET, OPENROUTER_API_KEY absent
 *      → one warn, `{ skipped: 'unconfigured' }`, zero network calls.
 *      Local runs and un-provisioned Railway services stay silent-ish.
 *   2. Hard runtime failures (embedder outage, relay 5xx after retries)
 *      throw a SeedHistoryError. Callers MUST wrap the call in
 *      try/catch — this module deliberately does not swallow real
 *      failures, so the seeder decides whether to log or ignore.
 *
 * Boundary rules: `scripts/**` ships to Railway via nixpacks with
 * `root_dir=scripts`, so this file may only import from within
 * `scripts/`, `node:*`, and bare packages in scripts/package.json.
 * See tests/scripts-railway-nixpacks-no-escape-import.test.mts.
 */

import { httpRetryError, resolveConvexSiteUrl } from './_seed-utils.mjs';
import { embedBatch, normalizeForEmbedding } from './lib/brief-embedding.mjs';

// Per-run cap. A seed tick that suddenly emits thousands of "historic"
// rows is a bug upstream, not a reason to spend the embedding budget —
// keep the newest slice and drop the tail.
export const HISTORY_MAX_RECORDS_PER_RUN = 150;

// Records per POST. Matches the batch sizes used by the other relay
// importers (import-bounced-emails.mjs uses 100 for a much smaller
// row); 50 × (512 floats + text) keeps a chunk body around 500KB.
export const HISTORY_CHUNK_SIZE = 50;

// Wire limits. These MUST NOT exceed what the relay route accepts
// (INTEL_HISTORY_MAX_* in convex/http.ts): a record this sanitizer lets
// through but the route rejects fails its entire chunk with a 400, so a
// single over-long field would silently cost a whole batch of history.
const DEDUPE_KEY_MAX_CHARS = 256;
const TITLE_MAX_CHARS = 500;
const SUMMARY_MAX_CHARS = 2000;
const SOURCE_URL_MAX_CHARS = 2048;

// Embedding input budget. Long summaries add noise, not signal, to a
// 512-dim vector — and the cache key is the text itself, so an
// unbounded input means an unbounded cache cell.
const EMBED_TEXT_MAX_CHARS = 300;
const EMBED_TEXT_SEPARATOR = ' — ';

const RELAY_PATH = '/relay/intel-history';
const RELAY_TIMEOUT_MS = 10_000;
const RELAY_MAX_RETRIES = 2;
const RELAY_RETRY_DELAY_MS = 1000;
// History is best-effort; a relay asking for a minute-long backoff should not
// hold the seed run's process open that long.
const RELAY_RETRY_AFTER_CAP_MS = 10_000;
const ERROR_SNIPPET_MAX_CHARS = 200;

/**
 * Aggregate wall-clock budget for the whole append, mirroring the fetch
 * phase's own deadline in _seed-utils.mjs.
 *
 * Without it, a degraded relay costs chunks x attempts x timeout — around 99s
 * for a full run — all of it spent AFTER the canonical publish but BEFORE
 * runSeed writes seed-meta. A SIGTERM landing in that window kills the process
 * before the freshness write, so the run publishes fresh data that health then
 * reads as stale: precisely the failure the fail-open try/catch exists to
 * prevent, reintroduced by stalling instead of throwing. Chunks already sent
 * stay committed; the rest are abandoned and reported.
 */
const HISTORY_TOTAL_BUDGET_MS = 30_000;

/**
 * Names this module's failures in the message and in any Sentry grouping.
 * NOT exported: every caller catches generically (the hooks are fail-open by
 * contract), so an exported type nothing imports would be speculative surface.
 */
class SeedHistoryError extends Error {
  constructor(message, { status, cause, budgetExhausted } = {}) {
    super(message);
    this.name = 'SeedHistoryError';
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
    if (budgetExhausted !== undefined) this.budgetExhausted = budgetExhausted;
  }
}

/**
 * Keep only http(s) links. The MCP outputSchema documents `sourceUrl` as a
 * canonical link and the three retrieval tools hand it to agents and UIs, so a
 * `javascript:` or `data:` value from a poisoned feed would be a stored XSS
 * vector — and because history is durable it would persist for the full
 * retention window rather than one seed cycle. Dropped, not rejected: a
 * source-less history row is still worth keeping.
 *
 * Parsed rather than prefix-matched, so `\tjavascript:` and other
 * whitespace/case tricks that fool a `startsWith` are normalized away first.
 * A protocol-relative `//host/path` has no scheme and fails to parse, which is
 * the outcome we want — it is not a usable absolute link either.
 */
function safeSourceUrl(value) {
  if (!value) return '';
  try {
    const scheme = new URL(value).protocol;
    return scheme === 'https:' || scheme === 'http:' ? value : '';
  } catch {
    return '';
  }
}

function trimmedString(value, maxChars) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Validate + sanitize a run's candidate records. Pure — no env, no clock.
 *
 * Drops anything missing the three required fields (`dedupeKey`,
 * a nonblank `title`, a finite `occurredAt`) or exceeding a wire limit,
 * whitelists the wire shape, and keeps only the newest
 * HISTORY_MAX_RECORDS_PER_RUN by `occurredAt`. Output is sorted
 * newest-first with a `dedupeKey` tiebreak so a run that re-emits the
 * same records chunks them identically.
 *
 * Accepted `title` and `summary` values are preserved exactly. They are
 * evidence fields exposed to agents, so trimming or truncating them would
 * silently rewrite the source record. Limits are validation boundaries:
 * over-long records are dropped rather than altered.
 *
 * `dedupeKey` is the caller's responsibility — the convention is
 * `${domain}:${resource}:${stableId}`. This helper never fabricates an
 * id, because a fabricated one would defeat the store's dedupe and
 * re-insert the same event on every tick.
 *
 * @param {unknown} records
 * @returns {Array<{dedupeKey: string, title: string, occurredAt: number,
 *   country?: string, category?: string, summary?: string, sourceUrl?: string}>}
 */
export function normalizeHistoryRecords(records) {
  if (!Array.isArray(records)) return [];

  const sanitized = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;

    // NOT truncated: dedupeKey is an identity, and clipping one would let two
    // distinct events collapse into a single stored row. Over-long keys are a
    // caller bug, so drop the record (below) rather than corrupt the identity.
    const dedupeKey = trimmedString(raw.dedupeKey, Number.POSITIVE_INFINITY);
    const title = typeof raw.title === 'string' ? raw.title : '';
    const summary = typeof raw.summary === 'string' ? raw.summary : undefined;
    const occurredAt = typeof raw.occurredAt === 'number' ? raw.occurredAt : Number.NaN;
    if (!dedupeKey || !title.trim() || !Number.isFinite(occurredAt)) continue;
    if (dedupeKey.length > DEDUPE_KEY_MAX_CHARS) continue;
    if (title.length > TITLE_MAX_CHARS) continue;
    if (summary !== undefined && summary.length > SUMMARY_MAX_CHARS) continue;

    const record = { dedupeKey, title, occurredAt };
    if (summary) record.summary = summary;
    const country = trimmedString(raw.country, 8);
    if (country) record.country = country;
    const category = trimmedString(raw.category, 64);
    if (category) record.category = category;
    const sourceUrl = safeSourceUrl(trimmedString(raw.sourceUrl, SOURCE_URL_MAX_CHARS));
    if (sourceUrl) record.sourceUrl = sourceUrl;

    sanitized.push(record);
  }

  sanitized.sort(
    (a, b) =>
      b.occurredAt - a.occurredAt ||
      (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0),
  );
  return sanitized.slice(0, HISTORY_MAX_RECORDS_PER_RUN);
}

/**
 * Compose the string that gets embedded for one record.
 *
 * Title carries the event; the summary disambiguates near-identical
 * titles ("Airstrike in Gaza" ×40/day). Both go through
 * normalizeForEmbedding — the single normalisation function shared with
 * brief-dedup, so the same text always maps to the same cache cell.
 *
 * Exported because query-time search embeds a user query and compares
 * it against these vectors: any drift between the two compositions
 * degrades recall silently, with no failing request to point at. A
 * parity test needs both sides callable.
 *
 * Caveat inherited from that contract: normalizeForEmbedding strips
 * wire-service suffixes, so a summary ending in an outlet name or a
 * bare domain loses that tail. Harmless for similarity, worth knowing
 * if you ever diff the embedded text against the stored summary.
 */
export function buildHistoryEmbeddingText(record) {
  let text = record.title;
  if (record.summary) {
    const remaining = EMBED_TEXT_MAX_CHARS - text.length - EMBED_TEXT_SEPARATOR.length;
    if (remaining > 0) text += EMBED_TEXT_SEPARATOR + record.summary.slice(0, remaining);
  }
  return normalizeForEmbedding(text.slice(0, EMBED_TEXT_MAX_CHARS));
}

/** Best-effort body snippet for an error message; never throws. */
async function readErrorSnippet(response) {
  try {
    const body = await response.text();
    return typeof body === 'string' ? body.slice(0, ERROR_SNIPPET_MAX_CHARS) : '';
  } catch {
    return '';
  }
}

/**
 * Resolve the relay config from an env bag. Returns `null` plus the
 * list of missing names so the caller can emit exactly one warn.
 */
function resolveRelayConfig(env) {
  const siteUrl = resolveConvexSiteUrl(env);
  const secret = env.RELAY_SHARED_SECRET ?? '';
  const openrouterKey = env.OPENROUTER_API_KEY ?? '';

  const missing = [];
  if (!siteUrl) missing.push('CONVEX_SITE_URL (or CONVEX_URL)');
  if (!secret) missing.push('RELAY_SHARED_SECRET');
  if (!openrouterKey) missing.push('OPENROUTER_API_KEY');
  if (missing.length > 0) return { missing };

  return { siteUrl, secret, openrouterKey, missing };
}

/**
 * POST one chunk, with deadline-aware retry. HTTP classification comes from
 * `httpRetryError`, the convention every other retrying POST in scripts/ uses: permanent
 * statuses (4xx that aren't 408/429) are tagged `nonRetryable` so a
 * misconfigured secret fails in ~10ms instead of burning 3s of the
 * seeder's budget, and a `Retry-After` header is honored rather than
 * overridden by bare exponential backoff. The cap keeps a long
 * server-suggested delay from eating the run's remaining budget.
 */
async function postHistoryChunk({
  fetchImpl,
  url,
  secret,
  payload,
  deadline,
  now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let lastError;
  for (let attempt = 0; attempt <= RELAY_MAX_RETRIES; attempt++) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new SeedHistoryError('intel-history relay budget exhausted', {
        cause: lastError,
        budgetExhausted: true,
      });
    }

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, Math.min(RELAY_TIMEOUT_MS, remainingMs))),
      });

      if (!response.ok) {
        const snippet = await readErrorSnippet(response);
        const retry = httpRetryError(response, { capMs: RELAY_RETRY_AFTER_CAP_MS });
        const error = new SeedHistoryError(
          `intel-history relay returned HTTP ${response.status}: ${snippet}`,
          { status: response.status },
        );
        error.nonRetryable = retry.nonRetryable;
        if (retry.retryAfterMs != null) error.retryAfterMs = retry.retryAfterMs;
        throw error;
      }

      return await response.json();
    } catch (err) {
      lastError = err;
      if (err?.nonRetryable || attempt >= RELAY_MAX_RETRIES) throw err;

      const baseWait = RELAY_RETRY_DELAY_MS * 2 ** attempt;
      const requestedWait = err?.retryAfterMs
        ? Math.max(baseWait, err.retryAfterMs)
        : baseWait;
      const wait = Math.min(requestedWait, Math.max(0, deadline - now()));
      if (wait <= 0) {
        throw new SeedHistoryError('intel-history relay budget exhausted before retry', {
          cause: err,
          budgetExhausted: true,
        });
      }
      console.warn(
        `  Retry ${attempt + 1}/${RELAY_MAX_RETRIES} in ${wait}ms: ${err?.message || err}`,
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

/**
 * Build a seeder's `afterPublish` hook.
 *
 * Every collector wires history the same way and must fail the same way:
 * the canonical publish has already committed by the time runSeed invokes
 * this, so a history failure logs and returns. A throw would skip
 * `writeFreshnessMetadataSafely` and age seed-meta out on fresh data —
 * the hazard documented at scripts/seed-gdelt-intel.mjs.
 *
 * Only the domain/resource pair and the record projection differ per
 * seeder, so those are the parameters; the failure semantics are not
 * per-seeder policy and are deliberately not overridable.
 *
 * The returned hook keeps runSeed's `(data, meta)` shape with the
 * appender in a third, injectable slot for tests.
 */
export function makeSeedHistoryAfterPublish({ domain, resource, buildRecords }) {
  return async function seedHistoryAfterPublish(data, meta, append = appendSeedHistory) {
    try {
      const result = await append({
        domain,
        resource,
        runId: String(meta?.runId ?? ''),
        records: buildRecords(data),
      });
      if (result?.skipped !== 'unconfigured') {
        // `retracted` only appears once an operator has tombstoned something
        // this run would otherwise have re-added (#5743), so it is appended
        // rather than always printed: a nonzero count in a Railway log is the
        // signal that a retraction is still doing work against a feed that
        // has not stopped serving the item.
        const retracted = result?.retracted ?? 0;
        console.log(
          `  [intel-history] ${domain}/${resource} appended ${result?.inserted ?? 0}, deduped ${result?.skipped ?? 0}` +
            (retracted > 0 ? `, retracted ${retracted}` : ''),
        );
      }
    } catch (err) {
      console.warn(
        `  [intel-history] ${domain}/${resource} append failed (non-fatal): ${err?.message || err}`,
      );
    }
  };
}

/**
 * Embed and append one seed run's history records.
 *
 * @param {object} args
 * @param {string} args.domain     top-level domain key, e.g. 'conflict'
 * @param {string} args.resource   seeder resource key, e.g. 'acled'
 * @param {string} [args.runId]    seed run identifier, echoed to the store
 * @param {unknown[]} args.records candidate records (see normalizeHistoryRecords)
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(texts: string[], budget: {deadline: number, now: () => number,
 *   wallClockMs: number}) => Promise<number[][]>} [deps.embed]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {() => number} [deps.now]        clock seam for the budget
 * @param {(ms: number) => Promise<void>} [deps.sleep] retry-delay seam
 * @param {number} [deps.budgetMs]         aggregate wall-clock budget override
 * @returns {Promise<{inserted: number, skipped: number, retracted: number,
 *   chunks: number, abandoned: number, failedChunks: number}
 *   | {skipped: 'unconfigured'}>}
 *
 * Throws SeedHistoryError on a hard runtime failure; propagates the
 * embedder's own EmbeddingProviderError / EmbeddingTimeoutError. Never
 * throws for missing configuration.
 */
export async function appendSeedHistory({ domain, resource, runId, records }, deps = {}) {
  const env = deps.env ?? process.env;

  const config = resolveRelayConfig(env);
  if (config.missing.length > 0) {
    console.warn(
      `[seed-history] not configured — skipping history append (missing: ${config.missing.join(', ')})`,
    );
    return { skipped: 'unconfigured' };
  }

  if (typeof domain !== 'string' || !domain.trim()) {
    throw new SeedHistoryError('appendSeedHistory: domain is required');
  }
  if (typeof resource !== 'string' || !resource.trim()) {
    throw new SeedHistoryError('appendSeedHistory: resource is required');
  }

  const sanitized = normalizeHistoryRecords(records);
  if (sanitized.length === 0) {
    return { inserted: 0, skipped: 0, retracted: 0, chunks: 0, abandoned: 0, failedChunks: 0 };
  }

  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (deps.budgetMs ?? HISTORY_TOTAL_BUDGET_MS);

  // Wrap rather than capture: a bare `fetch` default would bind the
  // global at module load and miss later instrumentation shims.
  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const embed =
    deps.embed ??
    ((texts, options) =>
      embedBatch(texts, {
        _apiKey: config.openrouterKey,
        now,
        wallClockMs: options.wallClockMs,
      }));

  const vectors = await embed(sanitized.map(buildHistoryEmbeddingText), {
    deadline,
    now,
    wallClockMs: Math.max(1, deadline - now()),
  });
  if (!Array.isArray(vectors) || vectors.length !== sanitized.length) {
    throw new SeedHistoryError(
      `appendSeedHistory: expected ${sanitized.length} embeddings, got ${
        Array.isArray(vectors) ? vectors.length : 'none'
      }`,
    );
  }

  if (now() >= deadline) {
    console.warn(
      `[seed-history] budget exhausted during embedding; abandoning ${sanitized.length} record(s)`,
    );
    return {
      inserted: 0,
      skipped: 0,
      retracted: 0,
      chunks: 0,
      abandoned: sanitized.length,
      failedChunks: 0,
    };
  }

  const url = `${config.siteUrl}${RELAY_PATH}`;
  let inserted = 0;
  let skipped = 0;
  let retracted = 0;
  let chunks = 0;
  let abandoned = 0;
  let failedChunks = 0;
  let lastError = null;

  for (let start = 0; start < sanitized.length; start += HISTORY_CHUNK_SIZE) {
    const chunk = sanitized
      .slice(start, start + HISTORY_CHUNK_SIZE)
      .map((record, i) => ({ ...record, embedding: vectors[start + i] }));

    if (now() >= deadline) {
      abandoned = sanitized.length - start;
      console.warn(
        `[seed-history] budget exhausted after ${chunks} chunk(s); abandoning ${abandoned} record(s)`,
      );
      break;
    }

    // Chunks are independent POSTs, and the slice is ordered newest-first, so
    // letting one rejection unwind the loop would discard the OLDER history
    // that a later chunk would have stored fine. Isolate the failure and keep
    // going; if every chunk fails the error still surfaces below, because a
    // systemic outage must not be reported as a successful no-op run.
    try {
      const body = await postHistoryChunk({
        fetchImpl,
        url,
        secret: config.secret,
        payload: { domain, resource, runId, records: chunk },
        deadline,
        now,
        sleep: deps.sleep,
      });
      inserted += Number(body?.inserted) || 0;
      skipped += Number(body?.skipped) || 0;
      retracted += Number(body?.retracted) || 0;
      chunks += 1;
    } catch (err) {
      if (err?.budgetExhausted || now() >= deadline) {
        abandoned = sanitized.length - start;
        console.warn(
          `[seed-history] budget exhausted during relay; abandoning ${abandoned} record(s)`,
        );
        break;
      }
      failedChunks += 1;
      lastError = err;
      console.warn(`[seed-history] chunk ${chunks + failedChunks} failed: ${err?.message || err}`);
    }
  }

  if (chunks === 0 && failedChunks > 0) throw lastError;

  return { inserted, skipped, retracted, chunks, abandoned, failedChunks };
}
