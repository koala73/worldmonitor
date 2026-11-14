import type { Pass } from './pass-geometry.js';
import type { SensorProfile } from './sensor-profiles.js';

export type PassTier =
  | { kind: 'confirmed-image' }
  | { kind: 'likely-imaged' }
  | { kind: 'within-reach' }
  | { kind: 'capability-overhead' }
  /** A wide-swath weather sensor whose evidence is its daily mosaic, not a per-pass image. */
  | { kind: 'daily-mosaic' }
  | { kind: 'passed-overhead'; note?: 'not-in-archive' }
  /** A future pass: a chance to image, never an image. */
  | { kind: 'opportunity' };

export type ArchiveAnswer =
  | { status: 'match'; itemId: string }
  | { status: 'no-match' }
  | { status: 'unanswered' };

export function decidePassTier(
  pass: Pass,
  profile: SensorProfile,
  archive: ArchiveAnswer | null | undefined,
  now: Date | number,
): PassTier;
