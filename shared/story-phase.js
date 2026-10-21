/**
 * Shared StoryPhase derivation for the feed digest and notification seeder.
 *
 * Core mention-count/age rules are identical across both surfaces. The
 * notification cron may additionally label >24h of silence as `fading`
 * because it reads the accumulator population, not just the current cycle.
 */

/** @typedef {'breaking' | 'developing' | 'sustained' | 'fading'} StoryPhase */

export const STORY_PHASES = Object.freeze(
  /** @type {readonly StoryPhase[]} */ ([
    'breaking',
    'developing',
    'sustained',
    'fading',
  ]),
);

export const PHASE_COLOR = Object.freeze({
  breaking: '#ef4444',
  developing: '#f97316',
  sustained: '#60a5fa',
  fading: '#555',
});

const HOUR_MS = 60 * 60 * 1000;
const DEVELOPING_MAX_AGE_MS = 2 * HOUR_MS;
const FADING_SILENCE_MS = 24 * HOUR_MS;

/**
 * @param {unknown} phase
 * @returns {phase is StoryPhase}
 */
export function isStoryPhase(phase) {
  return typeof phase === 'string' && Object.hasOwn(PHASE_COLOR, phase);
}

/**
 * Core lifecycle phase from mention count and story age.
 *
 * @param {{ mentionCount?: number; firstSeen: number }} track
 * @param {number} [nowMs]
 * @returns {'breaking' | 'developing' | 'sustained'}
 */
export function deriveCoreStoryPhase(track, nowMs = Date.now()) {
  const mentionCount = track.mentionCount ?? 1;
  const ageMs = nowMs - track.firstSeen;
  if (mentionCount <= 1) return 'breaking';
  if (mentionCount <= 5 && ageMs < DEVELOPING_MAX_AGE_MS) return 'developing';
  return 'sustained';
}

/**
 * Notification-path phase: silence-aware wrapper around the shared core rules.
 *
 * @param {{ mentionCount?: number; firstSeen: number; lastSeen: number }} track
 * @param {number} [nowMs]
 * @returns {StoryPhase}
 */
export function deriveNotificationStoryPhase(track, nowMs = Date.now()) {
  const silenceMs = nowMs - track.lastSeen;
  if (silenceMs > FADING_SILENCE_MS) return 'fading';
  return deriveCoreStoryPhase(track, nowMs);
}

/**
 * @param {unknown} phase
 * @param {{ strict?: boolean }} [options]
 * @returns {{ label: string; color: string } | null}
 */
export function formatStoryPhaseBadge(phase, options = {}) {
  if (!phase) return null;
  if (!isStoryPhase(phase)) {
    if (options.strict) {
      throw new Error(`unmodelled story phase: ${String(phase)}`);
    }
    return null;
  }
  return {
    label: phase.charAt(0).toUpperCase() + phase.slice(1),
    color: PHASE_COLOR[phase],
  };
}
