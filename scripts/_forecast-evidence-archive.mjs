/**
 * Dedicated forecast evidence archive (#7082).
 *
 * Forecast judging needs evidence for up to 14 days after publication, but
 * the digest accumulator it used to read carries a 48-hour TTL: a story
 * older than two days is silently absent, and judging could not tell a
 * genuinely quiet window from a truncated one. The accumulator also never
 * pruned members, so production carried millions of expired tombstones.
 *
 * This archive is the separate retention contract from the issue:
 *   - index key      forecast:evidence:v1        ZSet, score = lastSeen_ms,
 *                    member = stable story hash
 *   - record key     forecast:evidence:record:v1:<hash>, compact JSON and
 *                    self-contained (no story:track dependency — those rows
 *                    expire after 7 days and must not gate 14-day judging)
 *   - TTL            15 days: the 14-day reader contract plus a one-day
 *                    cleanup guard band, applied per write
 *
 * Pure helpers only — Redis I/O stays with the callers so tests can exercise
 * the record shapes and budget math directly.
 */

export const FORECAST_EVIDENCE_KEY = 'forecast:evidence:v1';
export const FORECAST_EVIDENCE_RECORD_KEY_PREFIX = 'forecast:evidence:record:v1:';
export const FORECAST_EVIDENCE_COVERAGE_KEY = 'forecast:evidence:coverage:v1';
export const FORECAST_EVIDENCE_SOURCE_KEY = 'digest:accumulator:v1:full:en';
export const FORECAST_EVIDENCE_VERSION = 1;
export const FORECAST_EVIDENCE_COVERAGE_VERSION = 1;

/** 14-day reader contract + 1-day cleanup guard band. */
export const FORECAST_EVIDENCE_TTL_S = 15 * 24 * 60 * 60;
/** Reader-side maximum lookback (matches JUDGED_EVIDENCE_MAX_LOOKBACK_MS). */
export const FORECAST_EVIDENCE_MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Member-level retention for `digest:accumulator:v1:<variant>:<lang>`.
 *
 * The issue's plan said 48 hours, reasoning from `DIGEST_ACCUMULATOR_TTL`. That
 * is the *key* TTL, not the widest *reader* lookback, and the reader inventory
 * the plan asked for (and that this constant now records) does not fit in it:
 *
 *   reader                                          lookback
 *   ----------------------------------------------  ------------------------
 *   seed-digest-notifications buildDigest()          `lastSentAt`-anchored:
 *                                                    24h default, ~12h twice-
 *                                                    daily, ~6.5-7d WEEKLY,
 *                                                    older after missed ticks
 *   scripts/lib/watchlist-story-scan.mjs             24h
 *   api/mcp/registry/nlp-tools.ts keyword spikes     48h
 *   seed-forecast-resolutions (judged)               14d -> migrating to the
 *                                                    dedicated archive below
 *
 * A 48-hour member prune silently truncates every weekly digest to two days of
 * stories, so retention is sized to the widest surviving reader instead. Seven
 * days matches `STORY_TTL` — `buildDigest` HGETALLs a `story:track:v1` row for
 * every hash it reads here, so an accumulator member that outlives its story
 * row is unusable anyway — plus a one-day guard band, mirroring how the
 * evidence archive's own retention is sized. This still bounds a key that
 * previously grew without limit; it bounds it at the real contract.
 */
export const ACCUMULATOR_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * How stale the coverage marker may be and still count as covering "now".
 *
 * `coverageEndMs` records the last confirmed digest publication. The resolver
 * is a separate process reading at a later instant, so requiring the marker to
 * reach the reader's live clock is a race no deployment can win — the archive
 * would never be readable at all. The honest statement is narrower: evidence
 * that would have been published between the last publication and now does not
 * exist in ANY store yet, so a marker inside this budget has no hole behind it.
 *
 * Sized against the digest's own 900s (15 min) `cachedFetchJson` TTL, which
 * bounds how often `writeStoryTracking` can advance the marker. 6h is 24x that
 * interval — enough to absorb low-traffic gaps, degraded periods where the
 * digest caches a negative sentinel instead of publishing, and a deploy — while
 * a marker staler than that means the writer is genuinely down and judging
 * SHOULD fail closed rather than judge against a hole.
 */
export const FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS = 6 * 60 * 60 * 1000;

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function resolveForecastEvidenceCoverageMaxLagMs(env = process.env) {
  const raw = Number(env.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS;
}

/**
 * Per-member byte budget. A member carries fixed fields plus a title and a
 * URL; anything beyond this is a malformed upstream we refuse to archive
 * rather than bloat the ZSet with (the writer drops the record and counts
 * it, mirroring how the digest ledger counts dropped items).
 */
export const FORECAST_EVIDENCE_MEMBER_MAX_BYTES = 2048;

const utf8Encoder = new TextEncoder();
const FORECAST_EVIDENCE_HASH_RE = /^[a-f0-9]{64}$/i;

/** @param {string} value */
export function utf8ByteLength(value) {
  return utf8Encoder.encode(value).byteLength;
}

/** @param {unknown} value */
export function isForecastEvidenceHash(value) {
  return typeof value === 'string' && FORECAST_EVIDENCE_HASH_RE.test(value);
}

/** @param {string} hash */
export function forecastEvidenceRecordKey(hash) {
  return `${FORECAST_EVIDENCE_RECORD_KEY_PREFIX}${hash}`;
}

/**
 * Coverage is operational evidence, not an inference from retention policy.
 * A backfill creates the verified start and a confirmed digest publication
 * advances the end. Readers accept the archive only when both bound the
 * complete requested window.
 *
 * @param {unknown} raw
 * @returns {{v: number, coverageStartMs: number, coverageEndMs: number, cutoverVerifiedAtMs: number, sourceDigestAtMs: number, maxLookbackMs: number, retentionSeconds: number, sourceKey: string, legacyOldestHash: string, legacyOldestScoreMs: number}|null}
 */
export function parseForecastEvidenceCoverage(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const metadata = /** @type {Record<string, unknown>} */ (value);
  const timeFields = [
    metadata.coverageStartMs,
    metadata.coverageEndMs,
    metadata.cutoverVerifiedAtMs,
    metadata.sourceDigestAtMs,
    metadata.legacyOldestScoreMs,
  ];
  if (
    metadata.v !== FORECAST_EVIDENCE_COVERAGE_VERSION
    || !timeFields.every(value => Number.isSafeInteger(value) && Number(value) >= 0)
    || metadata.maxLookbackMs !== FORECAST_EVIDENCE_MAX_LOOKBACK_MS
    || metadata.retentionSeconds !== FORECAST_EVIDENCE_TTL_S
    || metadata.sourceKey !== FORECAST_EVIDENCE_SOURCE_KEY
    || !isForecastEvidenceHash(metadata.legacyOldestHash)
    || Number(metadata.coverageStartMs) > Number(metadata.coverageEndMs)
    || Number(metadata.coverageEndMs) - Number(metadata.coverageStartMs) < FORECAST_EVIDENCE_MAX_LOOKBACK_MS
    || Number(metadata.sourceDigestAtMs) !== Number(metadata.coverageEndMs)
    || Number(metadata.cutoverVerifiedAtMs) < Number(metadata.coverageStartMs)
    || Number(metadata.cutoverVerifiedAtMs) > Number(metadata.coverageEndMs)
    || Number(metadata.legacyOldestScoreMs) > Number(metadata.coverageStartMs)
  ) return null;
  return {
    v: FORECAST_EVIDENCE_COVERAGE_VERSION,
    coverageStartMs: Math.floor(Number(metadata.coverageStartMs)),
    coverageEndMs: Math.floor(Number(metadata.coverageEndMs)),
    cutoverVerifiedAtMs: Math.floor(Number(metadata.cutoverVerifiedAtMs)),
    sourceDigestAtMs: Math.floor(Number(metadata.sourceDigestAtMs)),
    maxLookbackMs: FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
    retentionSeconds: FORECAST_EVIDENCE_TTL_S,
    sourceKey: FORECAST_EVIDENCE_SOURCE_KEY,
    legacyOldestHash: metadata.legacyOldestHash,
    legacyOldestScoreMs: Math.floor(Number(metadata.legacyOldestScoreMs)),
  };
}

/**
 * `maxLagMs` is the staleness budget described on
 * FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS. It defaults to 0 — a caller that
 * authorizes destruction (the accumulator prune gate, the sweep tool) must
 * demand a marker that already reaches the instant it is reasoning about, and
 * only the read path opts into a budget.
 *
 * @param {unknown} raw
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} [maxLagMs]
 */
export function forecastEvidenceCoversWindow(raw, startMs, endMs, maxLagMs = 0) {
  const metadata = parseForecastEvidenceCoverage(raw);
  const lag = Number.isFinite(maxLagMs) && maxLagMs > 0 ? Math.floor(maxLagMs) : 0;
  return Boolean(
    metadata
    && metadata.coverageStartMs <= startMs
    && metadata.coverageEndMs >= endMs - lag,
  );
}

/**
 * Advance a verified marker to a newer confirmed publication.
 *
 * The marker's invariants (`sourceDigestAtMs === coverageEndMs`, the >= 14-day
 * span, `cutoverVerifiedAtMs` inside the window) are enforced by
 * `parseForecastEvidenceCoverage` on the way back in, so the one place that
 * moves the window lives here rather than being hand-reconstructed at each
 * write site. Returns null when the input is not a valid marker.
 *
 * @param {unknown} raw
 * @param {number} nowMs
 * @returns {ReturnType<typeof parseForecastEvidenceCoverage>}
 */
export function advanceForecastEvidenceCoverage(raw, nowMs) {
  const metadata = parseForecastEvidenceCoverage(raw);
  if (!metadata || !Number.isFinite(nowMs)) return null;
  const coverageEndMs = Math.max(metadata.coverageEndMs, Math.floor(nowMs));
  return {
    ...metadata,
    coverageEndMs,
    // Invariant: the parser requires these two to be equal.
    sourceDigestAtMs: coverageEndMs,
  };
}

/**
 * Fields the judged path needs; everything else is deliberately dropped.
 *
 * @typedef {object} ForecastEvidenceRecord
 * @property {number} v
 * @property {string} hash
 * @property {string} title
 * @property {string} link
 * @property {string} description
 * @property {number} publishedAt
 * @property {number} lastSeen epoch ms of the digest publication that wrote this record
 *
 * @typedef {object} ForecastEvidenceParseResult
 * @property {ForecastEvidenceRecord|null} record
 * @property {boolean} malformed
 * @property {boolean} oversized set when the member parsed but was dropped by the byte budget
 */

/**
 * Eligibility gate for dual publication: the judged archive only ever read
 * the full/English accumulator, so only that scope is archived.
 *
 * @param {string} variant
 * @param {string} lang
 * @returns {boolean}
 */
export function isEligibleForecastEvidence(variant, lang) {
  return variant === 'full' && lang === 'en';
}

/**
 * Build the self-contained archive member for one story.
 *
 * A record whose *description* pushes it past the byte budget is trimmed, not
 * dropped: the description is judge grounding, while hash/title/link/
 * publishedAt are the evidence itself. Dropping the whole member over a verbose
 * wire summary loses evidence AND (because the caller counts the drop) stalls
 * the coverage marker, so the budget is enforced by shrinking the one
 * expendable field first.
 *
 * Returns null only when a required field is missing or when the record is
 * still over budget with no description at all — a genuinely malformed
 * upstream the caller should count.
 *
 * @param {{hash?: unknown, title?: unknown, link?: unknown, description?: unknown, publishedAt?: unknown}} track
 * @param {number} lastSeen
 * @returns {string|null}
 */
export function buildForecastEvidenceMember(track, lastSeen) {
  const hash = typeof track.hash === 'string' ? track.hash : '';
  const title = typeof track.title === 'string' ? track.title : '';
  const link = typeof track.link === 'string' ? track.link : '';
  const description = typeof track.description === 'string' ? track.description : '';
  const publishedAt = Number(track.publishedAt);

  if (!isForecastEvidenceHash(hash) || !title || !link || !Number.isFinite(publishedAt) || !Number.isFinite(lastSeen)) {
    return null;
  }

  const serialize = (/** @type {string} */ text) => JSON.stringify({
    v: FORECAST_EVIDENCE_VERSION,
    hash,
    title,
    link,
    description: text,
    publishedAt: Math.floor(publishedAt),
    lastSeen: Math.floor(lastSeen),
  });

  // `slice` counts UTF-16 code units and the budget counts UTF-8 bytes, so a
  // 512-"character" CJK or emoji description can still be ~2KB on its own.
  // Halve until it fits rather than giving up on the story.
  let text = description.slice(0, 512);
  let member = serialize(text);
  while (utf8ByteLength(member) > FORECAST_EVIDENCE_MEMBER_MAX_BYTES && text.length > 0) {
    text = text.slice(0, Math.floor(text.length / 2));
    member = serialize(text);
  }
  return utf8ByteLength(member) <= FORECAST_EVIDENCE_MEMBER_MAX_BYTES ? member : null;
}

/**
 * Parse one archived member. Malformed members are reported (counted as
 * tombstones by the caller) instead of silently omitted — the issue's
 * backfill rule, applied to steady-state reads too.
 *
 * @param {unknown} raw
 * @returns {ForecastEvidenceParseResult}
 */
export function parseForecastEvidenceMember(raw) {
  if (typeof raw !== 'string') {
    return { record: null, malformed: true, oversized: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, malformed: true, oversized: false };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { record: null, malformed: true, oversized: false };
  }
  const record = /** @type {Partial<ForecastEvidenceRecord>} */ (parsed);
  if (
    record.v !== FORECAST_EVIDENCE_VERSION ||
    !isForecastEvidenceHash(record.hash) ||
    typeof record.title !== 'string' || !record.title ||
    typeof record.link !== 'string' ||
    typeof record.description !== 'string' ||
    !Number.isFinite(record.publishedAt) ||
    !Number.isFinite(record.lastSeen)
  ) {
    return { record: null, malformed: true, oversized: false };
  }
  if (utf8ByteLength(raw) > FORECAST_EVIDENCE_MEMBER_MAX_BYTES) {
    return { record: null, malformed: false, oversized: true };
  }
  return {
    record: {
      v: record.v,
      hash: record.hash,
      title: record.title,
      link: record.link,
      description: record.description,
      publishedAt: Math.floor(/** @type {number} */ (record.publishedAt)),
      lastSeen: Math.floor(/** @type {number} */ (record.lastSeen)),
    },
    malformed: false,
    oversized: false,
  };
}

/**
 * Score bounds for member-level retention on the digest accumulator
 * (#7082 plan §4): prune everything strictly older than ACCUMULATOR_RETENTION_MS
 * during normal publication. The key TTL stays as abandoned-key cleanup —
 * member retention is no longer the TTL's job.
 *
 * See ACCUMULATOR_RETENTION_MS for why this is 8 days and not the plan's 48h.
 *
 * @param {number} nowMs
 * @param {number} [retentionMs]
 * @returns {{min: string, max: string}}
 */
export function accumulatorPruneBounds(nowMs, retentionMs = ACCUMULATOR_RETENTION_MS) {
  if (!Number.isFinite(nowMs)) {
    throw new Error('accumulatorPruneBounds requires a finite nowMs');
  }
  return { min: '-inf', max: `(${Math.floor(nowMs - retentionMs)}` };
}

/**
 * Score bounds for archiving retention: everything strictly older than the
 * 14-day reader contract plus guard band is out of contract even before the
 * key TTL collects it.
 *
 * @param {number} nowMs
 * @returns {{min: string, max: string}}
 */
export function evidencePruneBounds(nowMs) {
  if (!Number.isFinite(nowMs)) {
    throw new Error('evidencePruneBounds requires a finite nowMs');
  }
  return { min: '-inf', max: `(${Math.floor(nowMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS - 24 * 60 * 60 * 1000)}` };
}
