/**
 * #7154: shared, testable home for the digest-notification seeder's story
 * phase derivation and its badge color map. Both were previously inline in
 * seed-digest-notifications.mjs, which unconditionally runs main() at
 * import time (a real cron job hitting Redis) -- extracting them here lets
 * the derivation logic be unit tested without spawning that script.
 *
 * derivePhase's branches intentionally differ from the feed digest's
 * derivePhase (server/worldmonitor/news/v1/list-feed-digest.ts) for
 * `sustained` vs `developing` -- that divergence predates this file and is
 * tracked separately in #7154; this extraction does not change it.
 */

/** @typedef {'breaking' | 'developing' | 'sustained' | 'fading'} DigestPhase */

/** @type {ReadonlyArray<DigestPhase>} */
export const DIGEST_PHASES = ['breaking', 'developing', 'sustained', 'fading'];

/** @type {Readonly<Record<DigestPhase, string>>} */
export const PHASE_COLOR = {
  breaking: '#ef4444',
  developing: '#f97316',
  sustained: '#60a5fa',
  fading: '#555',
};

/**
 * @param {{ mentionCount?: string | number; firstSeen?: string | number; lastSeen?: string | number }} track
 * @returns {DigestPhase}
 */
export function derivePhase(track) {
  const mentionCount = parseInt(track.mentionCount ?? '1', 10);
  const firstSeen = parseInt(track.firstSeen ?? '0', 10);
  const lastSeen = parseInt(track.lastSeen ?? String(Date.now()), 10);
  const now = Date.now();
  const ageH = (now - firstSeen) / 3600000;
  const silenceH = (now - lastSeen) / 3600000;
  if (silenceH > 24) return 'fading';
  if (mentionCount >= 3 && ageH >= 12) return 'sustained';
  if (mentionCount >= 2) return 'developing';
  // mentionCount <= 1 falls through here regardless of age once the silence
  // and mention-count gates above are cleared. The feed digest treats every
  // mentionCount <= 1 story as 'breaking' unconditionally, so match that
  // instead of falling through to an off-enum 'unknown' (#7154).
  return 'breaking';
}
