import type { MilitaryVessel } from '@/types';

/**
 * Display label for a military vessel's class.
 *
 * AIS ship type 35 reports generic "Military Ops" activity, not a hull class
 * (#8611), so a vessel known only from AIS is stored as `vesselType: 'unknown'`
 * unless a known-vessel record names it. Showing a bare "unknown" would throw
 * away the one supported fact, so the AIS ship type name wins for that case.
 *
 * `labels` stays per-surface: the map popup translates, the globe uses its own
 * wording, and callers that want the raw enum pass nothing. The lookup is
 * own-property only — `vesselType` is a closed union in TypeScript but arrives
 * from the RPC layer as a bare string, so a value like `constructor` must not
 * reach through the prototype chain.
 */
export function vesselTypeLabel(
  vessel: Pick<MilitaryVessel, 'vesselType' | 'aisShipType'>,
  labels: Record<string, string> = {},
): string {
  if (vessel.vesselType === 'unknown' && vessel.aisShipType) return vessel.aisShipType;
  const label = Object.prototype.hasOwnProperty.call(labels, vessel.vesselType)
    ? labels[vessel.vesselType]
    : undefined;
  return label || vessel.vesselType;
}
