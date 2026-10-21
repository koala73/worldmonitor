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
 *                                                    (but see story rows below)
 *   seed-market-alert-ledger readStories()           full:en, emission - 24h
 *                                                    for due rows <= 6d past
 *                                                    deadline: <= 7d6h; its
 *                                                    oldest-member coverage
 *                                                    proof needs <= 6d6h
 *   seed-forecast-bets.mjs:295 ensemble news         full:en, 3d (via
 *                                                    readDigestAccumulatorArchive)
 *   scripts/lib/watchlist-story-scan.mjs             24h
 *   api/mcp/registry/nlp-tools.ts keyword spikes     48h
 *   seed-forecast-resolutions (judged)               none since #8995: judging
 *                                                    reads only the archive
 *   backfill-forecast-evidence-archive.mjs           14d, operator repair tool
 *                                                    only; members past the 7d
 *                                                    story row are unrecoverable
 *
 * A 48-hour member prune silently truncates every weekly digest to two days of
 * stories, so retention is sized to the widest surviving reader instead. Seven
 * days matches `STORY_TTL` — `buildDigest` HGETALLs a `story:track:v1` row for
 * every hash it reads here, so an accumulator member that outlives its story
 * row is unusable anyway — plus a one-day guard band, mirroring how the
 * evidence archive's own retention is sized. This still bounds a key that
 * previously grew without limit; it bounds it at the real contract. Every
 * reader above fits inside it, so `full:en` is pruned to the same 8 days once
 * FORECAST_EVIDENCE_CUTOVER_ENABLED is set (#7082).
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
export const FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS = 6 * 60 * 60 * 1000;

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
 * A backfill or a complete archive continuity scan creates the start. A digest publication
 * advances the end. Readers accept the archive only when both bound the
 * complete requested window.
 *
 * @param {unknown} raw
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
  const continuity = metadata.v === 2 && metadata.sourceKey === FORECAST_EVIDENCE_KEY;
  const oldestHash = continuity ? metadata.archiveOldestHash : metadata.legacyOldestHash;
  const oldestScore = continuity ? metadata.archiveOldestScoreMs : metadata.legacyOldestScoreMs;
  const timeFields = [
    metadata.coverageStartMs,
    metadata.coverageEndMs,
    metadata.cutoverVerifiedAtMs,
    metadata.sourceDigestAtMs,
    oldestScore,
  ];
  if (
    (!continuity && metadata.v !== FORECAST_EVIDENCE_COVERAGE_VERSION)
    || !timeFields.every(value => Number.isSafeInteger(value) && Number(value) >= 0)
    || metadata.maxLookbackMs !== FORECAST_EVIDENCE_MAX_LOOKBACK_MS
    || metadata.retentionSeconds !== FORECAST_EVIDENCE_TTL_S
    || (!continuity && metadata.sourceKey !== FORECAST_EVIDENCE_SOURCE_KEY)
    || (continuity && metadata.continuityBucketMs !== FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS)
    || !isForecastEvidenceHash(oldestHash)
    || Number(metadata.coverageStartMs) > Number(metadata.coverageEndMs)
    || Number(metadata.coverageEndMs) - Number(metadata.coverageStartMs) < FORECAST_EVIDENCE_MAX_LOOKBACK_MS
    || Number(metadata.sourceDigestAtMs) !== Number(metadata.coverageEndMs)
    || Number(metadata.cutoverVerifiedAtMs) < Number(metadata.coverageStartMs)
    || Number(metadata.cutoverVerifiedAtMs) > Number(metadata.coverageEndMs)
    || Number(oldestScore) > Number(metadata.coverageStartMs)
  ) return null;
  return {
    v: continuity ? 2 : FORECAST_EVIDENCE_COVERAGE_VERSION,
    coverageStartMs: Math.floor(Number(metadata.coverageStartMs)),
    coverageEndMs: Math.floor(Number(metadata.coverageEndMs)),
    cutoverVerifiedAtMs: Math.floor(Number(metadata.cutoverVerifiedAtMs)),
    sourceDigestAtMs: Math.floor(Number(metadata.sourceDigestAtMs)),
    maxLookbackMs: FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
    retentionSeconds: FORECAST_EVIDENCE_TTL_S,
    ...(continuity ? {
      sourceKey: FORECAST_EVIDENCE_KEY,
      continuityBucketMs: FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS,
      archiveOldestHash: oldestHash,
      archiveOldestScoreMs: Number(oldestScore),
    } : {
      sourceKey: FORECAST_EVIDENCE_SOURCE_KEY,
      legacyOldestHash: oldestHash,
      legacyOldestScoreMs: Number(oldestScore),
    }),
  };
}

/**
 * `maxLagMs` is the staleness budget described on
 * FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS. It defaults to 0: the backfill tool
 * verifies the marker it just wrote against the instant it reasons about, and
 * only the read path opts into a budget.
 *
 * No accumulator prune consults this marker any more. Since #7082 (owner
 * decision 2026-10-08) the digest prune and the sweep tool are gated by
 * FORECAST_EVIDENCE_CUTOVER_ENABLED alone, because judging stopped reading the
 * accumulator in #8995. Do not re-add a marker gate to either: production
 * carries only the v2 continuity marker, which the default rejects.
 *
 * @param {unknown} raw
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} [maxLagMs]
 * @param {boolean} [allowContinuity] Accept the v2 continuity attestation; the
 *   judging read path sets it, backfill certification does not.
 */
export function forecastEvidenceCoversWindow(raw, startMs, endMs, maxLagMs = 0, allowContinuity = false) {
  const metadata = parseForecastEvidenceCoverage(raw);
  const lag = Number.isFinite(maxLagMs) && maxLagMs > 0 ? Math.floor(maxLagMs) : 0;
  return Boolean(
    metadata
    && (metadata.v !== 2 || allowContinuity)
    && metadata.coverageStartMs <= startMs
    && metadata.coverageEndMs >= endMs - lag,
  );
}

/** Build a read-only continuity attestation from a complete validated scan. */
export function recoverForecastEvidenceCoverage(records, nowMs) {
  if (!Number.isSafeInteger(nowMs) || !records.length) return null;
  const ordered = [...records].sort((a, b) => b.score - a.score);
  const endMs = ordered[0].score;
  const startMs = endMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS;
  let previous = nowMs;
  for (const { record, score } of ordered) {
    if (!Number.isSafeInteger(score) || score !== record.lastSeen || score > previous
      || previous - score > FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS) return null;
    previous = score;
  }
  const oldest = ordered.at(-1);
  if (oldest.score > startMs) return null;
  return parseForecastEvidenceCoverage({
    v: 2,
    coverageStartMs: startMs,
    coverageEndMs: endMs,
    cutoverVerifiedAtMs: endMs,
    sourceDigestAtMs: endMs,
    maxLookbackMs: FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
    retentionSeconds: FORECAST_EVIDENCE_TTL_S,
    sourceKey: FORECAST_EVIDENCE_KEY,
    continuityBucketMs: FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS,
    archiveOldestHash: oldest.record.hash,
    archiveOldestScoreMs: oldest.score,
  });
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
  // A publication cannot prove continuity across an earlier outage.
  if (metadata.v === 2 && nowMs - metadata.coverageEndMs > FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS) return null;
  const coverageEndMs = Math.max(metadata.coverageEndMs, Math.floor(nowMs));
  return {
    ...metadata,
    coverageEndMs,
    // Invariant: the parser requires these two to be equal.
    sourceDigestAtMs: coverageEndMs,
  };
}

/**
 * Keeps a stored link when a later sighting of the same story arrives with its
 * link blanked by the publisher gate (#8990). The stored record is reused with
 * only `lastSeen` replaced, so the index score and the record still agree for
 * coverage recovery, and the member stays within its byte budget (no JSON
 * re-encoding). Otherwise the new member is written as a plain SET would.
 *
 * Gate-policy changes: a link kept here was allowed when it was stored. If its
 * host later leaves the allowed list, the next sighting from that host is
 * blanked by the gate and passes the host as ARGV[4]; a stored link on that
 * host is then dropped, not kept. A stored link whose story is never seen
 * again from that host keeps its link until the 15-day record TTL expires.
 *
 * KEYS[1] record key; ARGV[1] new member, ARGV[2] TTL seconds, ARGV[3]
 * lastSeen, ARGV[4] the blanked link's host without `www.` ('' if none).
 */
export const FORECAST_EVIDENCE_KEEP_LINK_SCRIPT = [
  "local old = redis.call('GET', KEYS[1])",
  'if old then',
  '  local ok, rec = pcall(cjson.decode, old)',
  "  if ok and type(rec) == 'table' and type(rec.link) == 'string' and rec.link ~= '' then",
  "    local host = string.match(rec.link, '^%a[%w+.-]*://([^/:?#]+)')",
  "    if host then host = string.gsub(string.lower(host), '^www%.', '') end",
  "    if ARGV[4] == '' or host ~= ARGV[4] then",
  "      local kept, n = string.gsub(old, '\"lastSeen\":%d+}$', '\"lastSeen\":' .. ARGV[3] .. '}')",
  "      if n == 1 then return redis.call('SET', KEYS[1], kept, 'EX', ARGV[2]) end",
  '    end',
  '  end',
  'end',
  "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
].join('\n');

/** Lowercase host without a leading `www.`, or '' when the link does not parse. */
export function forecastEvidenceLinkHost(link) {
  try {
    return new URL(String(link || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The Redis command that stores one evidence record. A member whose link was
 * blanked goes through FORECAST_EVIDENCE_KEEP_LINK_SCRIPT so it never replaces
 * an earlier record of the story that carried a valid link.
 *
 * @param {string} key
 * @param {string} member
 * @param {string} link the link stored in `member` ('' when the gate blanked it)
 * @param {number} ttlSeconds
 * @param {number} lastSeen
 * @param {string} [blankedHost] host of the link the gate blanked, from forecastEvidenceLinkHost
 * @returns {Array<string|number>}
 */
export function buildForecastEvidenceRecordWrite(key, member, link, ttlSeconds, lastSeen, blankedHost = '') {
  if (link || !Number.isSafeInteger(Math.floor(lastSeen))) return ['SET', key, member, 'EX', ttlSeconds];
  return ['EVAL', FORECAST_EVIDENCE_KEEP_LINK_SCRIPT, '1', key, member, String(ttlSeconds), String(Math.floor(lastSeen)), blankedHost];
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
 * upstream the caller should count. An empty link is not missing: the digest's
 * publisher-link gate blanks links it will not store (#8398), and the story is
 * still evidence. Counting those as drops froze the coverage marker (#8990).
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

  if (!isForecastEvidenceHash(hash) || !title || !Number.isFinite(publishedAt) || !Number.isFinite(lastSeen)) {
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
