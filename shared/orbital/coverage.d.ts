import type { SensorProfile } from './sensor-profiles.js';

/** True when the point lies on land or within about one 0.25-degree cell of it. */
export function isLandOrCoast(lat: number, lon: number): boolean;

/** True when the mission acquires over the point, on a pass in `direction` where its plan differs by direction. */
export function acquiresAt(
  coverage: SensorProfile['coverage'],
  point: { lat: number; lon: number },
  direction?: 'ascending' | 'descending',
): boolean;
