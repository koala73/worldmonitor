/**
 * Chunked HGETALL reader for story:track:v1:<hash> rows used by
 * scripts/seed-digest-notifications.mjs::buildDigest.
 *
 * Extracted so the index-alignment-on-partial-failure contract can be
 * unit-tested without dragging the cron's top-level side effects
 * (Upstash creds check, main() entry-point) into the test runtime.
 *
 * Why chunked:
 *   Per-language `digest:accumulator:v1:full:<lang>` ZSETs hold
 *   17K-21K hashes today, bounded only by ingest volume ×
 *   DIGEST_ACCUMULATOR_TTL. Each story:track:v1 hash averages ~380B
 *   but reaches ~1.2KB. An unbatched pipeline RESPONSE for the
 *   largest accumulator already crosses 7MB and grows linearly with
 *   ingest. 500 commands × ~1.2KB = ~600KB per chunk keeps each
 *   /pipeline call's response well under Upstash's per-request
 *   limit (50MB on our plan) and inside the 10-15s pipeline timeout.
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
 *   So we return `null` on any chunk failure. Callers MUST treat
 *   null as "skip this digest tick — Upstash partial outage" rather
 *   than as empty-but-successful. Stops iterating so an outage
 *   doesn't burn the full pipeline budget on N × per-chunk timeouts.
 */

export const STORY_TRACK_HGETALL_BATCH = 500;

export async function readStoryTracksChunked(
  hashes,
  pipelineFn,
  { batchSize = STORY_TRACK_HGETALL_BATCH, log = console.warn } = {},
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
    log(
      `[digest] readStoryTracksChunked: chunk ${failedAt} returned ${got} of ${chunk.length} expected — aborting and returning null so caller skips this digest tick`,
    );
    return null;
  }
  return out;
}
