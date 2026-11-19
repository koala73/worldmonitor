import { ensureHydrated } from '@/services/bootstrap';
import { isGridClockSnapshot, type GridClockSnapshot } from '../../shared/grid-disruption-clock.js';

export async function fetchGridDisruptionClock(): Promise<GridClockSnapshot> {
  const snapshot = await ensureHydrated('gridDisruptionClock');
  if (!isGridClockSnapshot(snapshot)) throw new Error('Grid disruption clock data is unavailable');
  return snapshot;
}
