import {
  DisplacementServiceClient,
  type GetDisplacementSummaryResponse as ProtoResponse,
  type CountryDisplacement as ProtoCountry,
  type DisplacementFlow as ProtoFlow,
} from '@/generated/client/worldmonitor/displacement/v1/service_client';
import { createCircuitBreaker, getCSSColor } from '@/utils';

// ─── Consumer-friendly types (matching legacy shape exactly) ───

export interface DisplacementFlow {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;        // number, NOT string
  originLat?: number;      // flat, NOT GeoCoordinates
  originLon?: number;
  asylumLat?: number;
  asylumLon?: number;
}

export interface CountryDisplacement {
  code: string;
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
  lat?: number;
  lon?: number;
}

export interface UnhcrSummary {
  year: number;
  globalTotals: {
    refugees: number;
    asylumSeekers: number;
    idps: number;
    stateless: number;
    total: number;
  };
  countries: CountryDisplacement[];
  topFlows: DisplacementFlow[];
}

export interface UnhcrFetchResult {
  ok: boolean;
  data: UnhcrSummary;
  cachedAt?: string;
}

// ─── Internal: proto -> legacy mapping ───

function toDisplaySummary(proto: ProtoResponse): UnhcrSummary {
  const s = proto.summary!;
  const gt = s.globalTotals!;
  return {
    year: s.year,
    globalTotals: {
      refugees: Number(gt.refugees),
      asylumSeekers: Number(gt.asylumSeekers),
      idps: Number(gt.idps),
      stateless: Number(gt.stateless),
      total: Number(gt.total),
    },
    countries: s.countries.map(toDisplayCountry),
    topFlows: s.topFlows.map(toDisplayFlow),
  };
}

function toDisplayCountry(proto: ProtoCountry): CountryDisplacement {
  return {
    code: proto.code,
    name: proto.name,
    refugees: Number(proto.refugees),
    asylumSeekers: Number(proto.asylumSeekers),
    idps: Number(proto.idps),
    stateless: Number(proto.stateless),
    totalDisplaced: Number(proto.totalDisplaced),
    hostRefugees: Number(proto.hostRefugees),
    hostAsylumSeekers: Number(proto.hostAsylumSeekers),
    hostTotal: Number(proto.hostTotal),
    lat: proto.location?.latitude,
    lon: proto.location?.longitude,
  };
}

function toDisplayFlow(proto: ProtoFlow): DisplacementFlow {
  return {
    originCode: proto.originCode,
    originName: proto.originName,
    asylumCode: proto.asylumCode,
    asylumName: proto.asylumName,
    refugees: Number(proto.refugees),
    originLat: proto.originLocation?.latitude,
    originLon: proto.originLocation?.longitude,
    asylumLat: proto.asylumLocation?.latitude,
    asylumLon: proto.asylumLocation?.longitude,
  };
}

// ─── Client + circuit breaker ───

const client = new DisplacementServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const emptyResult: UnhcrSummary = {
  year: new Date().getFullYear(),
  globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
  countries: [],
  topFlows: [],
};

const breaker = createCircuitBreaker<UnhcrSummary>({
  name: 'UNHCR Displacement',
});

// ─── Main fetch (public API) ───

export async function fetchUnhcrPopulation(): Promise<UnhcrFetchResult> {
  const data = await breaker.execute(async () => {
    const response = await client.getDisplacementSummary({
      year: 0,          // 0 = handler uses year fallback
      countryLimit: 0,  // 0 = all countries
      flowLimit: 50,    // top 50 flows (matching legacy)
    });
    return toDisplaySummary(response);
  }, emptyResult);

  return {
    ok: data !== emptyResult && data.countries.length > 0,
    data,
  };
}

// ─── Presentation helpers (copied verbatim from legacy src/services/unhcr.ts) ───

export function getDisplacementColor(totalDisplaced: number): [number, number, number, number] {
  if (totalDisplaced >= 1_000_000) return [255, 50, 50, 200];
  if (totalDisplaced >= 500_000) return [255, 150, 0, 200];
  if (totalDisplaced >= 100_000) return [255, 220, 0, 180];
  return [100, 200, 100, 150];
}

export function getDisplacementBadge(totalDisplaced: number): { label: string; color: string } {
  if (totalDisplaced >= 1_000_000) return { label: 'CRISIS', color: getCSSColor('--semantic-critical') };
  if (totalDisplaced >= 500_000) return { label: 'HIGH', color: getCSSColor('--semantic-high') };
  if (totalDisplaced >= 100_000) return { label: 'ELEVATED', color: getCSSColor('--semantic-elevated') };
  return { label: '', color: '' };
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function getOriginCountries(data: UnhcrSummary): CountryDisplacement[] {
  return [...data.countries]
    .filter(c => c.refugees + c.asylumSeekers > 0)
    .sort((a, b) => (b.refugees + b.asylumSeekers) - (a.refugees + a.asylumSeekers));
}

export function getHostCountries(data: UnhcrSummary): CountryDisplacement[] {
  return [...data.countries]
    .filter(c => (c.hostTotal || 0) > 0)
    .sort((a, b) => (b.hostTotal || 0) - (a.hostTotal || 0));
}
