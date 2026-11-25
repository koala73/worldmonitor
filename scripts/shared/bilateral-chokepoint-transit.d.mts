// Types for scripts/shared/bilateral-chokepoint-transit.mjs so server/*.ts consumers
// stay covered by `npm run typecheck:api`.

export declare const CORRIDOR_REGIONS: Readonly<Record<string, readonly [string, string]>>;
export declare const ENCLOSED_CHOKEPOINT_SIDES: Readonly<Record<string, ReadonlySet<string>>>;
export declare function bilateralTransitChokepointIds(
  importerIso2: string,
  exporterIso2: string,
  context: {
    clusters: Record<string, unknown>;
    regions: Record<string, string>;
    chokepoints: ReadonlyArray<{ id: string; routeIds: readonly string[] }>;
  },
): Set<string>;
