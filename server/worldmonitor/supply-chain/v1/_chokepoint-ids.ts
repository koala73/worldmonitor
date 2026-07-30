/**
 * Server-side chokepoint ID utilities.
 * Canonical data lives in src/config/chokepoint-registry.ts.
 * This file re-exports a server-compatible view and provides name-to-ID
 * lookup helpers used by the relay/PortWatch ingestion pipeline.
 */
import { CHOKEPOINT_REGISTRY, type ChokepointRegistryEntry } from '../../../../src/config/chokepoint-registry';

export interface CanonicalChokepoint {
  id: string;
  relayName: string;
  portwatchName: string;
  corridorRiskName: string | null;
  /** EIA chokepoint baseline ID (energy:chokepoint-baselines:v1). Null = no EIA baseline. */
  baselineId: string | null;
}

export const CANONICAL_CHOKEPOINTS: readonly CanonicalChokepoint[] = CHOKEPOINT_REGISTRY.map(
  (c: ChokepointRegistryEntry): CanonicalChokepoint => ({
    id: c.id,
    relayName: c.relayName,
    portwatchName: c.portwatchName,
    corridorRiskName: c.corridorRiskName,
    baselineId: c.baselineId,
  }),
);

export function relayNameToId(relayName: string): string | undefined {
  return CANONICAL_CHOKEPOINTS.find(c => c.relayName === relayName)?.id;
}

export function portwatchNameToId(portwatchName: string): string | undefined {
  if (!portwatchName) return undefined;
  return CANONICAL_CHOKEPOINTS.find(
    c => c.portwatchName && c.portwatchName.toLowerCase() === portwatchName.toLowerCase(),
  )?.id;
}

export function corridorRiskNameToId(crName: string): string | undefined {
  return CANONICAL_CHOKEPOINTS.find(
    c => c.corridorRiskName?.toLowerCase() === crName.toLowerCase(),
  )?.id;
}
