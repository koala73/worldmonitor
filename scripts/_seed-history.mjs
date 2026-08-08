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
 * Because of (1) and (2) the log stream was, until #5736, the ONLY place a
 * broken history pipeline showed up: a missing RELAY_SHARED_SECRET or a
 * systematically rejecting relay produced a healthy-looking seed run forever
 * while the store received nothing. `recordHistoryIngestHealth` closes that
 * hole by persisting a durable per-(domain, resource) ingest-health record on
 * BOTH the success and the failure path, separate from the seeder's own
 * seed-meta (which must keep reflecting canonical publication only).
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
 * The returned hook keeps runSeed's `(data, meta)` shape with both
 * injectable seams — the appender and the ingest-health recorder — in a
 * third options slot for tests.
 */
export function makeSeedHistoryAfterPublish({ domain, resource, buildRecords }) {
  return async function seedHistoryAfterPublish(data, meta, deps = {}) {
    const append = deps.append ?? appendSeedHistory;
    const recordHealth = deps.recordHealth ?? recordHistoryIngestHealth;
    const runId = String(meta?.runId ?? '');
    let result = null;
    let error = null;
    try {
      result = await append({
        domain,
        resource,
        runId,
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
      error = err;
      console.warn(
        `  [intel-history] ${domain}/${resource} append failed (non-fatal): ${err?.message || err}`,
      );
    }

    // #5736. The outcome above — including "the relay refused every chunk" and
    // "this deployment has no relay credentials" — is otherwise visible only in
    // the log stream. Persist it so an operator surface can see it. Fail-open
    // for the same reason as the append itself: runSeed's freshness write is
    // still ahead of us and must not be skipped.
    try {
      await recordHealth({ domain, resource, runId, result, error });
    } catch (err) {
      console.warn(
        `  [intel-history] ${domain}/${resource} ingest-health record failed (non-fatal): ${err?.message || err}`,
      );
    }
  };
}

// ── History-ingest health (#5736) ────────────────────────────────────────────
//
// The seeder's own `seed-meta:<domain>:<resource>` describes canonical
// publication and MUST NOT move because history failed — that conflation is the
// scripts/seed-gdelt-intel.mjs:286 hazard. So ingest health gets its own pair of
// keys per (domain, resource):
//
//   intel-history:ingest-health:<domain>:<resource>:v1
//       the durable record: current state, last success, last error, and the
//       consecutive-failure count. Registered as a /api/health data key.
//   seed-meta:intel-history:<domain>:<resource>
//       the freshness projection /api/health + /api/seed-health classify. Its
//       `fetchedAt` is the last HEALTHY observation, never the last attempt, so
//       "no successful append in N intervals" ages into STALE_SEED on its own.
//
// Both surfaces read `sourceState` for the three states the issue asks for:
//   'unavailable' → NOT_CONFIGURED / not_configured (visible, never an alarm —
//                   no operator action clears it except opting in)
//   'degraded'    → SEED_ERROR / error (warn)
//   'ok'          → OK, subject to the ordinary staleness budget

export const HISTORY_INGEST_SOURCE_VERSION = 'intel-history-ingest-v1';

// Matches writeFreshnessMetadata's 7-day seed-meta floor so a record outlives
// any single missed run of even the slowest history collector (6h cron).
export const HISTORY_INGEST_TTL_SECONDS = 86_400 * 7;

/**
 * Consecutive failed runs before `sourceState` escalates to 'degraded'.
 *
 * The record flips to `state: 'failing'` on the FIRST failure — that is simply
 * what happened — but one failed run is already 3 relay attempts inside a
 * single seed tick, and escalating on it would let one bad tick warn for a
 * whole cron interval (6h for energy/intelligence). Two consecutive runs is
 * the "prolonged" the issue asks to alarm on. Staleness is the independent
 * second alarm: `fetchedAt` stops advancing from the first failure onward.
 */
export const HISTORY_INGEST_ALARM_AFTER_FAILURES = 2;

// Deliberately tighter than the module's other timeouts and without retries:
// these two round-trips sit AFTER the canonical publish and BEFORE runSeed's
// freshness write, the same window HISTORY_TOTAL_BUDGET_MS exists to bound.
const HISTORY_INGEST_REDIS_TIMEOUT_MS = 2_000;
const HISTORY_INGEST_REASON_MAX_CHARS = 200;
const HISTORY_INGEST_CODE_MAX_CHARS = 64;

export function historyIngestHealthKey(domain, resource) {
  return `intel-history:ingest-health:${domain}:${resource}:v1`;
}

export function historyIngestMetaKey(domain, resource) {
  return `seed-meta:intel-history:${domain}:${resource}`;
}

/**
 * Durable "this ingest has reported at least once" marker, written with NO TTL.
 * Both health surfaces soften an absent record while the marker is missing, so
 * a Vercel deploy that lands before the first Railway tick does not alarm; once
 * the marker exists the softening is revoked forever (#4927 convention).
 */
export function historyIngestActivationKey(domain, resource) {
  return `seed-activated:intel-history:${domain}:${resource}`;
}

/**
 * Short, groupable code for the failure. Prefers the transport-level facts the
 * relay/embedder attach (`status`, `budgetExhausted`) because those are what an
 * operator acts on; falls back to the error class name so an unfamiliar failure
 * still gets a stable code rather than a free-text blob.
 */
export function historyIngestErrorCode(error) {
  if (!error) return null;
  if (error.budgetExhausted) return 'budget_exhausted';
  if (Number.isFinite(error.status)) return `http_${error.status}`;
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  // Clamped because this one IS echoed by /api/seed-health (unlike the free-text
  // `lastErrorReason`, which carries a relay-controlled body snippet and stays
  // in Redis only). Every current producer sets a fixed class name, but an
  // unbounded code would be a bounded-response-shape regression waiting for the
  // first caller that throws something exotic.
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().slice(0, HISTORY_INGEST_CODE_MAX_CHARS);
}

/**
 * Reduce one append attempt — the resolved value or the thrown error — to the
 * outcome the projection consumes. Pure.
 */
export function describeHistoryAppendOutcome(result, error) {
  if (error) {
    return {
      state: 'failing',
      errorCode: historyIngestErrorCode(error),
      errorReason: trimmedString(
        String(error?.message ?? error ?? ''),
        HISTORY_INGEST_REASON_MAX_CHARS,
      ),
    };
  }
  if (result?.skipped === 'unconfigured') {
    return {
      state: 'unconfigured',
      missing: Array.isArray(result.missing) ? result.missing : [],
    };
  }

  const chunks = Number(result?.chunks) || 0;
  const abandoned = Number(result?.abandoned) || 0;
  const failedChunks = Number(result?.failedChunks) || 0;

  // `appendSeedHistory` RESOLVES rather than throws when its wall-clock budget
  // dies before a single chunk is POSTed — the embedding phase overran, or the
  // relay was slow enough that the first attempt ate the budget. It only throws
  // on `chunks === 0 && failedChunks > 0`. Records were offered and none
  // arrived, so folding that into `healthy` would advance `fetchedAt` on a run
  // that delivered nothing: exactly the silent-pass this record exists to close
  // (a permanently degraded relay would report OK forever).
  //
  // A run with NO candidate records is a different thing and stays healthy —
  // nothing was offered, so nothing was lost.
  if (chunks === 0 && (abandoned > 0 || failedChunks > 0)) {
    return {
      state: 'failing',
      errorCode: abandoned > 0 ? 'budget_exhausted' : 'all_chunks_failed',
      errorReason: `no chunk reached the relay (abandoned ${abandoned}, failed ${failedChunks})`,
    };
  }

  return {
    state: 'healthy',
    inserted: Number(result?.inserted) || 0,
    deduped: Number(result?.skipped) || 0,
    // Relay-side tombstone hits (#5743). Not part of `lastAcceptedRecords` —
    // a retraction REMOVES a row rather than accepting one — but a nonzero
    // count belongs in the durable record for the same reason it is logged:
    // it means a retraction is still fighting a feed that keeps re-serving
    // the item.
    retracted: Number(result?.retracted) || 0,
    chunks,
    abandoned,
    failedChunks,
  };
}

function finiteOr(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Fold one outcome into the previous record. Pure — no clock, no network — so
 * the state machine is testable without Redis.
 *
 * `lastHealthyAt` (mirrored to the meta's `fetchedAt`) advances on a successful
 * append AND on an unconfigured run of a deployment that never succeeded. The
 * second case matters: a genuinely un-provisioned deployment must read as
 * NOT_CONFIGURED forever rather than decaying into an eternal staleness warn
 * nobody can clear. Losing the credential AFTER a success is the opposite —
 * see `regressedToUnconfigured` below.
 *
 * @param {object|null} previous  last persisted record, or null on first write
 * @param {{domain: string, resource: string, runId?: string, at: number,
 *   outcome: ReturnType<typeof describeHistoryAppendOutcome>}} observation
 * @returns {{record: object, meta: object}}
 */
export function projectHistoryIngestHealth(previous, { domain, resource, runId, at, outcome }) {
  const prev = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null;
  const failing = outcome.state === 'failing';
  const healthy = outcome.state === 'healthy';

  // A deployment that has appended before is PROVISIONED. Losing the relay
  // credential afterwards is a regression, not an opt-out — and it is the
  // issue's own headline scenario ("a missing RELAY_SHARED_SECRET produces a
  // healthy-looking seed run forever"). Without this branch, `unconfigured`
  // short-circuits to NOT_CONFIGURED — an `ok` bucket — while `fetchedAt` keeps
  // advancing, so neither alarm can fire and the fix would relocate the bug
  // rather than close it. `lastSuccessAt` is what distinguishes the two: a
  // never-provisioned deployment has none and keeps the silent path.
  const regressedToUnconfigured =
    outcome.state === 'unconfigured' && finiteOr(prev?.lastSuccessAt) != null;

  // A run that reached the relay but still lost records to failed or abandoned
  // chunks counts toward the streak. It is NOT a clean run: a collector losing
  // chunks on every tick is losing history just as surely as one that cannot
  // reach the relay at all, and only counting total failures would leave that
  // at zero forever. `fetchedAt` still advances — the relay demonstrably works,
  // so the honest report is "reachable, but dropping records", not "stale".
  const lossy = healthy && (outcome.failedChunks > 0 || outcome.abandoned > 0);

  const alarming = failing || regressedToUnconfigured;
  const priorFailures = finiteOr(prev?.consecutiveFailures, 0);
  const consecutiveFailures = alarming || lossy ? priorFailures + 1 : 0;
  const lastHealthyAt = alarming ? finiteOr(prev?.lastHealthyAt) : at;
  const lastSuccessAt = healthy ? at : finiteOr(prev?.lastSuccessAt);
  // Held across failures so /api/health keeps reporting the last known good
  // volume instead of flipping to a contradictory zero while the relay is down.
  const lastAcceptedRecords = healthy
    ? outcome.inserted + outcome.deduped
    : finiteOr(prev?.lastAcceptedRecords, 0);

  const record = {
    state: outcome.state,
    domain,
    resource,
    lastAttemptAt: at,
    lastRunId: runId || null,
    lastHealthyAt,
    lastSuccessAt,
    lastAcceptedRecords,
    lastInserted: healthy ? outcome.inserted : finiteOr(prev?.lastInserted),
    lastDeduped: healthy ? outcome.deduped : finiteOr(prev?.lastDeduped),
    lastRetracted: healthy ? outcome.retracted : finiteOr(prev?.lastRetracted),
    lastChunks: healthy ? outcome.chunks : finiteOr(prev?.lastChunks),
    lastAbandoned: healthy ? outcome.abandoned : finiteOr(prev?.lastAbandoned),
    lastFailedChunks: healthy ? outcome.failedChunks : finiteOr(prev?.lastFailedChunks),
    consecutiveFailures,
    // Retained after recovery: knowing WHAT broke is the whole point of a
    // post-mortem, and a success only proves the failure stopped.
    lastErrorAt: alarming ? at : finiteOr(prev?.lastErrorAt),
    lastErrorCode: failing
      ? outcome.errorCode
      : regressedToUnconfigured
        ? 'config_removed'
        : (prev?.lastErrorCode ?? null),
    lastErrorReason: failing
      ? outcome.errorReason
      : regressedToUnconfigured
        ? `relay configuration removed after a successful append (missing: ${outcome.missing.join(', ')})`
        : (prev?.lastErrorReason ?? null),
    // Only meaningful while unconfigured; carrying it further would name
    // variables that are now present.
    missingConfig: outcome.state === 'unconfigured' ? outcome.missing : null,
    updatedAt: at,
  };

  const meta = {
    // Bare shape, not an envelope: every seed-meta reader parses top-level
    // (see shouldEnvelopeKey in scripts/_seed-utils.mjs).
    fetchedAt: lastHealthyAt,
    recordCount: lastAcceptedRecords,
    sourceVersion: HISTORY_INGEST_SOURCE_VERSION,
    // A removed credential escalates on the FIRST tick, with no threshold: the
    // failure threshold exists to absorb a transient relay blip, and there is
    // no transient class here — the variable is either configured or it is not.
    sourceState: regressedToUnconfigured
      ? 'degraded'
      : outcome.state === 'unconfigured'
        ? 'unavailable'
        : consecutiveFailures >= HISTORY_INGEST_ALARM_AFTER_FAILURES
          ? 'degraded'
          : 'ok',
    consecutiveFailures,
    lastSuccessAt,
    lastErrorCode: record.lastErrorCode,
  };

  return { record, meta };
}

/**
 * Read the previous record. Throws on a failed read so the caller skips the
 * write entirely: rebuilding the record from a lost `previous` would silently
 * reset the consecutive-failure count and drop `lastSuccessAt` — turning an
 * Upstash blip into "the relay looks fine again".
 */
async function readHistoryIngestRecord({ fetchImpl, url, token, domain, resource }) {
  const key = historyIngestHealthKey(domain, resource);
  const resp = await fetchImpl(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(HISTORY_INGEST_REDIS_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`ingest-health GET ${key} failed: HTTP ${resp.status}`);
  const body = await resp.json();
  if (!body?.result) return null;
  try {
    return JSON.parse(body.result);
  } catch {
    // A corrupt record is recoverable — the next write replaces it wholesale.
    return null;
  }
}

async function writeHistoryIngestRecord({ fetchImpl, url, token, domain, resource, record, meta }) {
  const resp = await fetchImpl(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['SET', historyIngestHealthKey(domain, resource), JSON.stringify(record), 'EX', HISTORY_INGEST_TTL_SECONDS],
      ['SET', historyIngestMetaKey(domain, resource), JSON.stringify(meta), 'EX', HISTORY_INGEST_TTL_SECONDS],
      // No TTL: "has ever reported" must outlive the 7-day record.
      ['SET', historyIngestActivationKey(domain, resource), '1'],
    ]),
    signal: AbortSignal.timeout(HISTORY_INGEST_REDIS_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`ingest-health pipeline failed: HTTP ${resp.status}`);
  const results = await resp.json();
  const failed = Array.isArray(results) ? results.find((entry) => entry?.error) : null;
  if (failed) throw new Error(`ingest-health pipeline command failed: ${failed.error}`);
  // The pipeline is not transactional, so a per-command failure can land the
  // record without the meta. That degrades the DIAGNOSTIC, never the alarm:
  // a skipped meta write leaves the PREVIOUS meta in place, and `fetchedAt`
  // there can only ever be an earlier healthy observation — nothing on this
  // path can advance it. So the staleness backstop keeps counting on schedule
  // and only the faster `degraded` signal waits for the next tick. Pinned by
  // "a meta write that never lands cannot hide a stalled ingest".
}

/**
 * Persist one run's history-ingest health. Never throws and never rejects —
 * this runs inside a fail-open hook, and losing the health record must not cost
 * the seeder its freshness write.
 *
 * @param {{domain: string, resource: string, runId?: string, result?: unknown,
 *   error?: unknown}} observation
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [deps]
 * @returns {Promise<object|null>} the persisted record, or null when skipped
 */
export async function recordHistoryIngestHealth({ domain, resource, runId, result, error }, deps = {}) {
  const env = deps.env ?? process.env;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // Not an error: a local run without Upstash credentials never published a
    // canonical key either. Warn once so it is not silent.
    console.warn(
      `[seed-history] ${domain}/${resource} ingest-health not recorded — no Upstash credentials`,
    );
    return null;
  }

  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const at = (deps.now ?? (() => Date.now()))();
  const outcome = describeHistoryAppendOutcome(result, error);

  try {
    const previous = await readHistoryIngestRecord({ fetchImpl, url, token, domain, resource });
    const { record, meta } = projectHistoryIngestHealth(previous, {
      domain,
      resource,
      runId,
      at,
      outcome,
    });
    await writeHistoryIngestRecord({ fetchImpl, url, token, domain, resource, record, meta });
    return record;
  } catch (err) {
    console.warn(
      `[seed-history] ${domain}/${resource} ingest-health write failed (non-fatal): ${err?.message || err}`,
    );
    return null;
  }
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
 *   | {skipped: 'unconfigured', missing: string[]}>}
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
    // `missing` rides along so the ingest-health record can name the absent
    // variables (#5736) instead of leaving an operator to grep Railway logs.
    return { skipped: 'unconfigured', missing: config.missing };
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
