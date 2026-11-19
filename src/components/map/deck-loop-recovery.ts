/**
 * Restarts deck.gl after an error stops its animation loop (#9653).
 *
 * luma.gl's AnimationLoop stops for good when a frame throws (a failed GPU read
 * during hover picking, a throwing tooltip). deck then never commits another
 * layer list, while MapLibre keeps repainting the last one, so layers the user
 * turned off stay drawn. deck reports the error before the loop stops, and a
 * running loop always has its next frame requested, so a loop with no pending
 * frame once the error has unwound is dead.
 */

export interface DeckLoopRecoveryDeps {
  hasPendingFrame: () => boolean;
  isAlive: () => boolean;
  restart: (error: Error) => void;
  /** Called instead of restart once `maxRestarts` restarts fall inside `windowMs`, or when restart throws. */
  giveUp: (error: Error) => void;
  maxRestarts: number;
  windowMs: number;
  now?: () => number;
  defer?: (fn: () => void) => void;
}

export function createDeckLoopRecovery(deps: DeckLoopRecoveryDeps): (error: Error) => void {
  const now = deps.now ?? (() => performance.now());
  const defer = deps.defer ?? queueMicrotask;
  let restarts: number[] = [];
  let checkQueued = false;

  return (error) => {
    if (checkQueued) return;
    checkQueued = true;
    defer(() => {
      checkQueued = false;
      if (!deps.isAlive() || deps.hasPendingFrame()) return;
      const t = now();
      restarts = restarts.filter((at) => t - at < deps.windowMs);
      if (restarts.length >= deps.maxRestarts) {
        deps.giveUp(error);
        return;
      }
      restarts.push(t);
      try {
        deps.restart(error);
      } catch (restartError) {
        deps.giveUp(restartError instanceof Error ? restartError : error);
      }
    });
  };
}
