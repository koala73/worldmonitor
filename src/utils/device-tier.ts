/**
 * Low-end device tier for interaction responsiveness.
 *
 * DebugBear RUM, Android /dashboard, 2026-09-26..10-24, p75 INP by
 * `navigator.deviceMemory`: 8 GB 232 ms, 4 GB 656 ms, 2 GB 1,704 ms. The gap is
 * presentation delay (paint after the handler), not handler time, so these
 * devices get less continuous rendering work: no marker pulses and a smaller
 * map marker budget.
 *
 * Only `deviceMemory` is read. Safari does not expose it and iOS dashboard INP
 * is already 88 ms at p75, so an absent value is never treated as low-end.
 */

export type DeviceTier = 'low' | 'standard' | 'unknown';

/** Chrome buckets deviceMemory to 0.25, 0.5, 1, 2, 4 or 8. */
export const LOW_END_DEVICE_MEMORY_GB = 4;

/** Root class main.css keys the low-end rules on. */
export const LOW_END_DEVICE_CLASS = 'low-end-device';

export function classifyDeviceTier(nav: { deviceMemory?: unknown } | undefined): DeviceTier {
  const memory = nav?.deviceMemory;
  if (typeof memory !== 'number' || !Number.isFinite(memory) || memory <= 0) return 'unknown';
  return memory <= LOW_END_DEVICE_MEMORY_GB ? 'low' : 'standard';
}

let cachedTier: DeviceTier | null = null;

export function getDeviceTier(): DeviceTier {
  if (cachedTier === null) {
    cachedTier = classifyDeviceTier(typeof navigator === 'undefined' ? undefined : navigator as { deviceMemory?: unknown });
  }
  return cachedTier;
}

export function isLowEndDevice(): boolean {
  return getDeviceTier() === 'low';
}

export function applyDeviceTierClass(root: { classList: { toggle(token: string, force?: boolean): unknown } }): void {
  root.classList.toggle(LOW_END_DEVICE_CLASS, isLowEndDevice());
}

export function resetDeviceTierForTesting(): void {
  cachedTier = null;
}
