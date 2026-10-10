// IOM DTM internal displacement, mapped for the map layer and panel. Kept free
// of browser-only imports so tests can load it directly.
import type { GetInternalDisplacementResponse as ProtoInternalResponse } from '@/generated/client/worldmonitor/displacement/v1/service_client';

export interface InternalDisplacementOperation {
  countryCode: string;
  countryName: string;
  operation: string;
  reportingDate: string;
  totalIdps: number;
  topReason: string;
  /** Point of the operation's largest located region, for map focus. */
  lat?: number;
  lon?: number;
}

/** IDPs present in one region, from the operation that reports the most there. */
export interface InternalDisplacementRegion {
  pcode: string;
  name: string;
  countryName: string;
  operation: string;
  reportingDate: string;
  idps: number;
  lat: number;
  lon: number;
}

/** IDPs who moved from one region to another. */
export interface InternalDisplacementRoute {
  originName: string;
  destinationName: string;
  countryName: string;
  operation: string;
  reportingDate: string;
  idps: number;
  originLat: number;
  originLon: number;
  destinationLat: number;
  destinationLon: number;
}

export interface InternalDisplacementData {
  operations: InternalDisplacementOperation[];
  regions: InternalDisplacementRegion[];
  routes: InternalDisplacementRoute[];
}

export const EMPTY_INTERNAL_DISPLACEMENT: InternalDisplacementData = { operations: [], regions: [], routes: [] };

// DTM operations in one country overlap (DRC countrywide monitoring also covers
// Ituri), so a region or route reported by several operations keeps the
// largest count instead of the sum.
export function toInternalDisplacementData(proto: ProtoInternalResponse): InternalDisplacementData {
  if (!proto.dataAvailable) return EMPTY_INTERNAL_DISPLACEMENT;
  const regions = new Map<string, InternalDisplacementRegion>();
  const routes = new Map<string, InternalDisplacementRoute>();
  const operations: InternalDisplacementOperation[] = [];

  for (const op of proto.operations ?? []) {
    const context = { countryName: op.countryName, operation: op.operation, reportingDate: op.reportingDate };
    const focus = op.regions?.find((region) => region.location)?.location;
    operations.push({
      countryCode: op.countryCode,
      countryName: op.countryName,
      operation: op.operation,
      reportingDate: op.reportingDate,
      totalIdps: Number(op.totalIdps || 0),
      topReason: op.reasons?.[0]?.reason ?? '',
      lat: focus?.latitude,
      lon: focus?.longitude,
    });
    for (const region of op.regions ?? []) {
      const idps = Number(region.idps || 0);
      if (!region.pcode || !region.location || idps <= 0) continue;
      const existing = regions.get(region.pcode);
      if (existing && existing.idps >= idps) continue;
      regions.set(region.pcode, {
        ...context,
        pcode: region.pcode,
        name: region.name,
        idps,
        lat: region.location.latitude,
        lon: region.location.longitude,
      });
    }
    for (const flow of op.flows ?? []) {
      const idps = Number(flow.idps || 0);
      if (!flow.originLocation || !flow.destinationLocation || idps <= 0) continue;
      const key = `${flow.originPcode}>${flow.destinationPcode}`;
      const existing = routes.get(key);
      if (existing && existing.idps >= idps) continue;
      routes.set(key, {
        ...context,
        originName: flow.originName,
        destinationName: flow.destinationName,
        idps,
        originLat: flow.originLocation.latitude,
        originLon: flow.originLocation.longitude,
        destinationLat: flow.destinationLocation.latitude,
        destinationLon: flow.destinationLocation.longitude,
      });
    }
  }

  return {
    operations,
    regions: [...regions.values()].sort((a, b) => b.idps - a.idps),
    routes: [...routes.values()].sort((a, b) => b.idps - a.idps),
  };
}
