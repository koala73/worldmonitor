import type { Hotspot, ConflictZone, StrategicWaterway } from '@/types';
import {
  CONFLICT_ZONES as SHARED_CONFLICT_ZONES,
  INTEL_HOTSPOTS as SHARED_INTEL_HOTSPOTS,
  STRATEGIC_WATERWAYS as SHARED_STRATEGIC_WATERWAYS,
} from '../../shared/geo-data';

// The curated data lives in shared/geo-data.ts so server-side (Edge/MCP) code can
// read it too. Re-exported here under the client `@/types` interfaces — the
// annotations below are the structural-compatibility check between the two.

// Hotspot levels are NOT hardcoded - they are dynamically calculated based on news activity
// All hotspots start at 'low' and rise to 'elevated' or 'high' based on matching news items
// Escalation scores: 1=stable, 2=watchlist, 3=elevated, 4=high tension, 5=critical/active conflict
export const INTEL_HOTSPOTS: Hotspot[] = SHARED_INTEL_HOTSPOTS;

export const STRATEGIC_WATERWAYS: StrategicWaterway[] = SHARED_STRATEGIC_WATERWAYS;

export const CONFLICT_ZONES: ConflictZone[] = SHARED_CONFLICT_ZONES;
