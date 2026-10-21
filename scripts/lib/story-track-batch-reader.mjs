/**
 * Chunked HGETALL reader for story:track:v1:<hash> rows used by
 * scripts/seed-digest-notifications.mjs::buildDigest and
 * scripts/seed-forecast-resolutions.mjs::readDigestAccumulatorArchive.
 *
 * Extracted so the index-alignment-on-partial-failure contract can be
 * unit-tested without dragging the cron's top-level side effects
 * (Upstash creds check, main() entry-point) into the test runtime.
 *
 * Why chunked — timeout and memory, NOT Upstash's size limit:
 *   Per-language `digest:accumulator:v1:full:<lang>` ZSETs hold
 *   17K-21K hashes today, bounded only by ingest volume ×
 *   DIGEST_ACCUMULATOR_TTL. Each story:track:v1 hash averages ~380B
 *   but reaches ~1.2KB. An unbatched pipeline response for the
 *   largest accumulator already crosses 7MB and grows linearly with
 *   ingest, which is a latency and heap problem well before it is
 *   anything else: 500 commands × ~1.2KB = ~600KB per chunk keeps
 *   each call inside the 10-15s pipeline timeout.
 *
 *   This comment used to justify the chunking with Upstash's 50MiB
 *   max-request-size. That reason was WRONG and is corrected here so
 *   the next reader doesn't inherit it. Measured against production
 *   2026-08-02: the limit applies PER COMMAND, in both directions,
 *   and never to a pipeline's aggregate. A pipeline of 8 GETs
 *   returning 71.7MB in total succeeds; a pipeline of 60 commands
 *   totalling a 60MB request body succeeds; only an individual
 *   command whose own request or result crosses 50MiB is rejected.
 *   No single HGETALL here returns more than ~1.2KB, so the limit
 *   cannot bind on this path at any chunk size. See
 *   docs/solutions/integration-issues/upstash-max-request-size-counts-one-command-and-answers-http-200.md
 *
 * Why bail-on-failure (return null):
 *   The caller pairs `trackResults[i]` with `hashes[i]` (see
 *   seed-digest-notifications.mjs buildDigest's stories.push hash
 *   field). `pipelineFn` is allowed to return `[]` (or `null` /
 *   undefined / a short array) on HTTP error; naive `out.push(...partial)`
 *   on a short result would shift every later position onto the wrong
 *   hash and publish stories with wrong source-set / embedding-cache
 *   linkage.
 *
 *   We could pad the remaining positions with `{result: null}`
 *   placeholders to keep length === hashes.length, but that would
 *   regress the legacy semantic: pre-chunking, a single pipeline
 *   failure returned [] from upstashPipeline → every row skipped →
 *   buildDigest returned null → the cron skipped sending that user/
 *   variant. With placeholders, a partial failure would now ship a
 *   digest built from chunks 0..N-1, mark `digest:last-sent:v1` as
 *   sent, and the user would never see the dropped stories on the
 *   next tick. Worse: dropped stories would be silent — no operator
 *   signal that the digest was incomplete.
 *
 *   So we return `null` on any chunk failure. Callers MUST treat null
 *   as an incomplete read rather than empty-but-successful: digest
 *   skips the tick, while forecast resolution fails the archive read
 *   closed so judged entries remain pending. Stops iterating so an
 *   outage doesn't burn the full pipeline budget on N × per-chunk
 *   timeouts.
 */

export const STORY_TRACK_HGETALL_BATCH = 500;

export async function readStoryTracksChunked(
  hashes,
  pipelineFn,
  { batchSize = STORY_TRACK_HGETALL_BATCH, log = console.warn, context = 'digest' } = {},
) {
  const out = [];
  for (let i = 0; i < hashes.length; i += batchSize) {
    const chunk = hashes.slice(i, i + batchSize);
    const partial = await pipelineFn(
      chunk.map((h) => ['HGETALL', `story:track:v1:${h}`]),
    );
    if (Array.isArray(partial) && partial.length === chunk.length) {
      out.push(...partial);
      continue;
    }
    const failedAt = Math.floor(i / batchSize);
    const got = Array.isArray(partial) ? partial.length : 'non-array';
    const failureConsequence = context === 'digest'
      ? 'skips this digest tick'
      : 'treats the archive read as failed';
    log(
      `[${context}] readStoryTracksChunked: chunk ${failedAt} returned ${got} of ${chunk.length} expected — aborting and returning null so caller ${failureConsequence}`,
    );
    return null;
  }
  return out;
}
