/** How much of the boot ceremony to play.
 *
 *  OpenEye is meant to be opened often, and the full sequence is ceremony:
 *  worth seeing, not worth sitting through several times a day. `full` is the
 *  whole show; `short` powers on the tube and goes straight to the title and
 *  the globe. */
export type BootMode = 'full' | 'short';

/** Bump when the sequence itself changes. The intro doubles as the release
 *  note, so a rebuilt ceremony should be shown once more even to an install
 *  that has already seen the previous one. */
export const BOOT_VERSION = '1';

export const BOOT_SEEN_KEY = 'openeye.boot.seen';

/** Only the two methods used, so tests and a Tauri webview with a partial
 *  Storage both satisfy it. */
export type BootStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface BootModeInputs {
  storage: BootStorage | null | undefined;
  /** `location.search`. */
  search?: string;
  reducedMotion?: boolean;
  version?: string;
}

function readSeen(storage: BootStorage | null | undefined, key: string): string | null {
  // Storage access throws outright in some webview privacy modes — not worth
  // taking the whole boot down over a preference.
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Decide how much of the boot to play. Pure: everything it reads is a
 *  parameter, so the precedence rules are testable without a DOM. */
export function chooseBootMode(inputs: BootModeInputs): BootMode {
  const { storage, search = '', reducedMotion = false, version = BOOT_VERSION } = inputs;

  // An explicit request wins over everything else, in both directions: it is
  // the only way back to the ceremony once an install has seen it, and the
  // only way to skip it while working on what comes after.
  const asked = new URLSearchParams(search).get('boot');
  if (asked === 'full' || asked === 'short') return asked;

  if (reducedMotion) return 'short';

  return readSeen(storage, BOOT_SEEN_KEY) === version ? 'short' : 'full';
}

/** Remember that this version's ceremony has been played. Never throws:
 *  failing to record it costs one extra intro, and that is not worth an
 *  unhandled rejection on the boot path. */
export function markBootSeen(
  storage: BootStorage | null | undefined,
  version: string = BOOT_VERSION,
): void {
  try {
    storage?.setItem(BOOT_SEEN_KEY, version);
  } catch {
    /* storage unavailable — the next launch simply plays the full sequence */
  }
}
