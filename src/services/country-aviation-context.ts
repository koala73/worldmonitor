import type { AirportDelayAlert } from '@/services/aviation';

/** Disruptions a country brief counts: closures, and severe or major delays or restrictions. */
export function isBriefAviationDisruption(alert: AirportDelayAlert): boolean {
  return alert.delayType === 'closure' || alert.severity === 'severe' || alert.severity === 'major';
}
