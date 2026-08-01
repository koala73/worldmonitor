// Pure opinion-stamp policy for digest story:track rows.
//
// Ingest is authoritative for explicit "1" and "0" verdicts. Reclassifying
// only rows with no stamp keeps legacy residue covered without allowing the
// same stored row to change category as wall-clock time advances.

import { classifyOpinion } from '../../server/_shared/opinion-classifier.js';

function isMissingStamp(value) {
  return typeof value !== 'string' || value.length === 0;
}

/**
 * @param {{ isOpinion?: unknown; title?: unknown; link?: unknown; description?: unknown; publishedAt?: unknown } | null | undefined} track
 * @returns {boolean} true when the track must be excluded from the digest
 */
export function shouldDropOpinionTrack(track) {
  if (track?.isOpinion === '1') return true;
  if (!isMissingStamp(track?.isOpinion)) return false;

  return classifyOpinion({
    title: track?.title,
    link: track?.link,
    description: track?.description,
    publishedAt: track?.publishedAt,
  });
}
