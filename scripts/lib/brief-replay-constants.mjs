/**
 * Shared replay-log retention contract.
 *
 * The writer must retain at least the window that the cooldown harness
 * requires. Keeping the value here prevents the writer, reader, and tests
 * from silently drifting apart.
 */
export const REPLAY_WINDOW_DAYS = 14;
