/**
 * How the tracked-satellite layer treats a Yaogan object, by its published name.
 *
 * - `imaging`: a numbered payload (YAOGAN-35, YAOGAN-30 01, RSS-1 (YAOGAN-1)); it may
 *   still fail the sensor-profile match, which alone decides imaging.
 * - `signals`: a lettered triplet member (YAOGAN-9 01A, YAOGAN-32 A, YAOGAN-43 02F),
 *   which carries no imager. Shown under its own signals label, never as imaging.
 * - `unidentified`: anything else named Yaogan (YAOGAN OBJECT A, YAOGAN-51 OBJECT B,
 *   debris). Left out everywhere.
 */
export type YaoganClass = 'imaging' | 'signals' | 'unidentified';

const YAOGAN = /YAOGAN/i;
const IMAGING = /^YAOGAN-\d+( \d+)?$|\(YAOGAN-\d+( \d+)?\)$/i;
const SIGNALS = /^YAOGAN-\d+ (\d+)?[A-Z]$/i;

export function classifyYaogan(name: string | null | undefined): YaoganClass | null {
  const n = (name ?? '').trim();
  if (!YAOGAN.test(n)) return null;
  if (SIGNALS.test(n)) return 'signals';
  if (IMAGING.test(n)) return 'imaging';
  return 'unidentified';
}

/** The layer type for a tracked object, or null when the object stays off the layer. */
export function trackedSatelliteType(name: string, type: string): string | null {
  const yaogan = classifyYaogan(name);
  if (yaogan === 'unidentified') return null;
  if (yaogan === 'signals') return 'signals';
  return type;
}
