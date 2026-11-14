import { trackPositionAt, type PassTrack, type TrackPoint } from './track-geometry';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const REPLAY_DURATION_MS = 8_000;

export interface TrackReplayDeps {
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (handle: number) => void;
  prefersReducedMotion: () => boolean;
  durationMs?: number;
}

/** One moment of a replay: where the satellite was, how far through the replay it is, and whether it is playing. */
export interface ReplayFrame {
  point: TrackPoint;
  progress: number;
  playing: boolean;
}

export interface TrackReplay {
  /** Plays from the current moment to acquisition, restarting when already there. Reduced motion jumps to acquisition. */
  play(): void;
  pause(): void;
  /** Moves to a moment between the start of the swath (0) and acquisition (1), without playing. */
  seek(progress: number): void;
  stop(): void;
  readonly reducedMotion: boolean;
}

export function browserReplayDeps(): TrackReplayDeps {
  return {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    prefersReducedMotion: () => typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION_QUERY).matches,
  };
}

/** The replay runs over the swath window up to closest approach, the moment the point was imaged. */
export function replayWindow(track: PassTrack): { fromMs: number; toMs: number } {
  const times = track.swath[0]?.timesMs;
  const fromMs = Math.min(times?.[0] ?? track.startMs, track.closest.timeMs);
  return { fromMs, toMs: track.closest.timeMs };
}

export function createTrackReplay(track: PassTrack, onFrame: (frame: ReplayFrame) => void, deps: TrackReplayDeps): TrackReplay {
  const durationMs = deps.durationMs ?? REPLAY_DURATION_MS;
  const { fromMs, toMs } = replayWindow(track);
  const reducedMotion = deps.prefersReducedMotion();
  let frame: number | null = null;
  let progress = 1;
  const emit = (playing: boolean) => {
    const point = progress >= 1 ? track.closest : trackPositionAt(track, fromMs + (toMs - fromMs) * progress);
    onFrame({ point, progress, playing });
  };
  const cancel = () => {
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
  };
  return {
    reducedMotion,
    play() {
      cancel();
      if (reducedMotion) {
        progress = 1;
        emit(false);
        return;
      }
      if (progress >= 1) progress = 0;
      const from = progress;
      let startedAt: number | null = null;
      const step = (now: number) => {
        startedAt ??= now;
        progress = Math.min(1, from + (now - startedAt) / durationMs);
        const playing = progress < 1;
        frame = playing ? deps.requestFrame(step) : null;
        emit(playing);
      };
      frame = deps.requestFrame(step);
      emit(true);
    },
    pause() {
      if (frame === null) return;
      cancel();
      emit(false);
    },
    seek(to) {
      cancel();
      progress = Math.min(1, Math.max(0, to));
      emit(false);
    },
    stop: cancel,
  };
}
