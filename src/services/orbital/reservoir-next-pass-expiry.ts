// Kept apart from the orbit maths so cards that only check expiry don't pull pass geometry into their chunk.
/**
 * A predicted ICESat-2 crossing, never a measurement: `pass` gives the first time the
 * ground track crosses the lake in the window, `none` is the normal answer when the
 * track misses it (ICESat-2 repeats each track every 91 days).
 */
export type ReservoirNextPass =
  | { status: 'pass'; timeMs: number; windowEndMs: number; elementsEpochMs: number }
  | { status: 'none'; windowEndMs: number; elementsEpochMs: number };

/** When a prediction stops being the next one: its crossing time, or the end of a no-crossing window. */
export function reservoirNextPassExpiresAt(pass: ReservoirNextPass): number {
  return pass.status === 'pass' ? pass.timeMs : pass.windowEndMs;
}
