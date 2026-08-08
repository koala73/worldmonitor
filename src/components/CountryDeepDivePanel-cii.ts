import type { CountryScore } from '@/services/country-instability';

export type CiiBand = 'stable' | 'elevated' | 'high' | 'critical';

/** Map the canonical CII level to the deep-dive panel's existing visual bands. */
export function ciiBandForLevel(level: CountryScore['level']): CiiBand {
  if (level === 'critical') return 'critical';
  if (level === 'high') return 'high';
  if (level === 'elevated') return 'elevated';
  return 'stable';
}
