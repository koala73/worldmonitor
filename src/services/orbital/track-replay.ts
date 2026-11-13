import { trackPositionAt, type PassTrack, type TrackPoint } from './track-geometry';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const REPLAY_DURATION_MS = 8_000;

export interface TrackReplayDeps {
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (handle: number) => void;
  prefersReducedMotion: () => boolean;
  durationMs?: number;
}

export interface TrackReplay {
  /** Flies the marker along the whole track, then leaves it at closest approach. Reduced motion places it there at once. */
  play(): void;
  stop(): void;
}

export function browserReplayDeps(): TrackReplayDeps {
  return {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    prefersReducedMotion: () => typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION_QUERY).matches,
  };
}

export function createTrackReplay(track: PassTrack, onPosition: (point: TrackPoint) => void, deps: TrackReplayDeps): TrackReplay {
  const durationMs = deps.durationMs ?? REPLAY_DURATION_MS;
  let frame: number | null = null;
  const stop = () => {
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
  };
  return {
    play() {
      stop();
      if (deps.prefersReducedMotion()) {
        onPosition(track.closest);
        return;
      }
      let startedAt: number | null = null;
      const step = (now: number) => {
        startedAt ??= now;
        const progress = Math.min(1, (now - startedAt) / durationMs);
        if (progress >= 1) {
          frame = null;
          onPosition(track.closest);
          return;
        }
        onPosition(trackPositionAt(track, track.startMs + (track.endMs - track.startMs) * progress));
        frame = deps.requestFrame(step);
      };
      frame = deps.requestFrame(step);
    },
    stop,
  };
}
