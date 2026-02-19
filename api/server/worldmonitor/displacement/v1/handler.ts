/**
 * Displacement service handler -- implements the generated DisplacementServiceHandler
 * interface by proxying the UNHCR Population API.
 *
 * This is the heaviest data-processing handler in the migration series. It
 * paginates through potentially 250,000 raw records, aggregates them into
 * per-country displacement metrics from two perspectives (origin and asylum),
 * computes refugee flow corridors between country pairs, and attaches geographic
 * coordinates from hardcoded centroids. Direct port of `api/unhcr-population.js`.
 */

import type {
  DisplacementServiceHandler,
  ServerContext,
  GetDisplacementSummaryRequest,
  GetDisplacementSummaryResponse,
  GetPopulationExposureRequest,
  GetPopulationExposureResponse,
  CountryPopulationEntry,
  GeoCoordinates,
} from '../../../../../src/generated/server/worldmonitor/displacement/v1/service_server';

// ---------- Country centroids (ISO3 -> [lat, lon]) ----------

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AFG: [33.9, 67.7], SYR: [35.0, 38.0], UKR: [48.4, 31.2], SDN: [15.5, 32.5],
  SSD: [6.9, 31.3], SOM: [5.2, 46.2], COD: [-4.0, 21.8], MMR: [19.8, 96.7],
  YEM: [15.6, 48.5], ETH: [9.1, 40.5], VEN: [6.4, -66.6], IRQ: [33.2, 43.7],
  COL: [4.6, -74.1], NGA: [9.1, 7.5], PSE: [31.9, 35.2], TUR: [39.9, 32.9],
  DEU: [51.2, 10.4], PAK: [30.4, 69.3], UGA: [1.4, 32.3], BGD: [23.7, 90.4],
  KEN: [0.0, 38.0], TCD: [15.5, 19.0], JOR: [31.0, 36.0], LBN: [33.9, 35.5],
  EGY: [26.8, 30.8], IRN: [32.4, 53.7], TZA: [-6.4, 34.9], RWA: [-1.9, 29.9],
  CMR: [7.4, 12.4], MLI: [17.6, -4.0], BFA: [12.3, -1.6], NER: [17.6, 8.1],
  CAF: [6.6, 20.9], MOZ: [-18.7, 35.5], USA: [37.1, -95.7], FRA: [46.2, 2.2],
  GBR: [55.4, -3.4], IND: [20.6, 79.0], CHN: [35.9, 104.2], RUS: [61.5, 105.3],
};

// ---------- Internal UNHCR API types ----------

interface UnhcrRawItem {
  coo_iso?: string;
  coo_name?: string;
  coa_iso?: string;
  coa_name?: string;
  refugees?: number;
  asylum_seekers?: number;
  idps?: number;
  stateless?: number;
}

// ---------- Helpers ----------

/** Paginate through all UNHCR Population API pages for a given year. */
async function fetchUnhcrYearItems(year: number): Promise<UnhcrRawItem[] | null> {
  const limit = 10000;
  const maxPageGuard = 25;
  const items: UnhcrRawItem[] = [];

  for (let page = 1; page <= maxPageGuard; page++) {
    const response = await fetch(
      `https://api.unhcr.org/population/v1/population/?year=${year}&limit=${limit}&page=${page}`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) return null;

    const data = await response.json();
    const pageItems: UnhcrRawItem[] = Array.isArray(data.items) ? data.items : [];
    if (pageItems.length === 0) break;
    items.push(...pageItems);

    const maxPages = Number(data.maxPages);
    if (Number.isFinite(maxPages) && maxPages > 0) {
      if (page >= maxPages) break;
      continue;
    }

    if (pageItems.length < limit) break;
  }

  return items;
}

/** Look up centroid coordinates for an ISO3 country code. */
function getCoordinates(code: string): GeoCoordinates | undefined {
  const centroid = COUNTRY_CENTROIDS[code];
  if (!centroid) return undefined;
  return { latitude: centroid[0], longitude: centroid[1] };
}

// ---------- Aggregation types ----------

interface OriginAgg {
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
}

interface AsylumAgg {
  name: string;
  refugees: number;
  asylumSeekers: number;
}

interface FlowAgg {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;
}

interface MergedCountry {
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
}

// ---------- Population exposure data ----------

const PRIORITY_COUNTRIES: Record<string, { name: string; pop: number; area: number }> = {
  UKR: { name: 'Ukraine', pop: 37000000, area: 603550 },
  RUS: { name: 'Russia', pop: 144100000, area: 17098242 },
  ISR: { name: 'Israel', pop: 9800000, area: 22072 },
  PSE: { name: 'Palestine', pop: 5400000, area: 6020 },
  SYR: { name: 'Syria', pop: 22100000, area: 185180 },
  IRN: { name: 'Iran', pop: 88600000, area: 1648195 },
  TWN: { name: 'Taiwan', pop: 23600000, area: 36193 },
  ETH: { name: 'Ethiopia', pop: 126500000, area: 1104300 },
  SDN: { name: 'Sudan', pop: 48100000, area: 1861484 },
  SSD: { name: 'South Sudan', pop: 11400000, area: 619745 },
  SOM: { name: 'Somalia', pop: 18100000, area: 637657 },
  YEM: { name: 'Yemen', pop: 34400000, area: 527968 },
  AFG: { name: 'Afghanistan', pop: 42200000, area: 652230 },
  PAK: { name: 'Pakistan', pop: 240500000, area: 881913 },
  IND: { name: 'India', pop: 1428600000, area: 3287263 },
  MMR: { name: 'Myanmar', pop: 54200000, area: 676578 },
  COD: { name: 'DR Congo', pop: 102300000, area: 2344858 },
  NGA: { name: 'Nigeria', pop: 223800000, area: 923768 },
  MLI: { name: 'Mali', pop: 22600000, area: 1240192 },
  BFA: { name: 'Burkina Faso', pop: 22700000, area: 274200 },
};

const EXPOSURE_CENTROIDS: Record<string, [number, number]> = {
  UKR: [48.4, 31.2], RUS: [61.5, 105.3], ISR: [31.0, 34.8], PSE: [31.9, 35.2],
  SYR: [35.0, 38.0], IRN: [32.4, 53.7], TWN: [23.7, 121.0], ETH: [9.1, 40.5],
  SDN: [15.5, 32.5], SSD: [6.9, 31.3], SOM: [5.2, 46.2], YEM: [15.6, 48.5],
  AFG: [33.9, 67.7], PAK: [30.4, 69.3], IND: [20.6, 79.0], MMR: [19.8, 96.7],
  COD: [-4.0, 21.8], NGA: [9.1, 7.5], MLI: [17.6, -4.0], BFA: [12.3, -1.6],
};

function handlePopulationExposure(req: GetPopulationExposureRequest): GetPopulationExposureResponse {
  if (req.mode === 'exposure') {
    const { lat, lon } = req;
    const radius = req.radius || 50;

    let bestMatch: string | null = null;
    let bestDist = Infinity;

    for (const [code, [cLat, cLon]] of Object.entries(EXPOSURE_CENTROIDS)) {
      const dist = Math.sqrt(Math.pow(lat - cLat, 2) + Math.pow(lon - cLon, 2));
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = code;
      }
    }

    const info = bestMatch ? PRIORITY_COUNTRIES[bestMatch] : { pop: 50000000, area: 500000 };
    const density = info.pop / info.area;
    const areaKm2 = Math.PI * radius * radius;
    const exposed = Math.round(density * areaKm2);

    return {
      success: true,
      countries: [],
      exposure: {
        exposedPopulation: exposed,
        exposureRadiusKm: radius,
        nearestCountry: bestMatch || '',
        densityPerKm2: Math.round(density),
      },
    };
  }

  // Default: countries mode
  const countries: CountryPopulationEntry[] = Object.entries(PRIORITY_COUNTRIES).map(([code, info]) => ({
    code,
    name: info.name,
    population: info.pop,
    densityPerKm2: Math.round(info.pop / info.area),
  }));

  return { success: true, countries };
}

// ---------- Handler ----------

export const displacementHandler: DisplacementServiceHandler = {
  async getDisplacementSummary(
    _ctx: ServerContext,
    req: GetDisplacementSummaryRequest,
  ): Promise<GetDisplacementSummaryResponse> {
    try {
      // 1. Determine year with fallback
      const currentYear = new Date().getFullYear();
      const requestYear = req.year > 0 ? req.year : 0;
      let rawItems: UnhcrRawItem[] = [];
      let dataYearUsed = currentYear;

      if (requestYear > 0) {
        const items = await fetchUnhcrYearItems(requestYear);
        if (items && items.length > 0) {
          rawItems = items;
          dataYearUsed = requestYear;
        }
      } else {
        for (let year = currentYear; year >= currentYear - 2; year--) {
          const items = await fetchUnhcrYearItems(year);
          if (!items) continue;
          if (items.length > 0) {
            rawItems = items;
            dataYearUsed = year;
            break;
          }
        }
      }

      // 2. Aggregate by origin and asylum
      const byOrigin: Record<string, OriginAgg> = {};
      const byAsylum: Record<string, AsylumAgg> = {};
      const flowMap: Record<string, FlowAgg> = {};
      let totalRefugees = 0;
      let totalAsylumSeekers = 0;
      let totalIdps = 0;
      let totalStateless = 0;

      for (const item of rawItems) {
        const originCode = item.coo_iso || '';
        const asylumCode = item.coa_iso || '';
        const refugees = Number(item.refugees) || 0;
        const asylumSeekers = Number(item.asylum_seekers) || 0;
        const idps = Number(item.idps) || 0;
        const stateless = Number(item.stateless) || 0;

        totalRefugees += refugees;
        totalAsylumSeekers += asylumSeekers;
        totalIdps += idps;
        totalStateless += stateless;

        if (originCode) {
          if (!byOrigin[originCode]) {
            byOrigin[originCode] = {
              name: item.coo_name || originCode,
              refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0,
            };
          }
          byOrigin[originCode].refugees += refugees;
          byOrigin[originCode].asylumSeekers += asylumSeekers;
          byOrigin[originCode].idps += idps;
          byOrigin[originCode].stateless += stateless;
        }

        if (asylumCode) {
          if (!byAsylum[asylumCode]) {
            byAsylum[asylumCode] = {
              name: item.coa_name || asylumCode,
              refugees: 0, asylumSeekers: 0,
            };
          }
          byAsylum[asylumCode].refugees += refugees;
          byAsylum[asylumCode].asylumSeekers += asylumSeekers;
        }

        if (originCode && asylumCode && refugees > 0) {
          const flowKey = `${originCode}->${asylumCode}`;
          if (!flowMap[flowKey]) {
            flowMap[flowKey] = {
              originCode,
              originName: item.coo_name || originCode,
              asylumCode,
              asylumName: item.coa_name || asylumCode,
              refugees: 0,
            };
          }
          flowMap[flowKey].refugees += refugees;
        }
      }

      // 3. Merge into unified country records
      const countries: Record<string, MergedCountry> = {};

      for (const [code, data] of Object.entries(byOrigin)) {
        countries[code] = {
          code,
          name: data.name,
          refugees: data.refugees,
          asylumSeekers: data.asylumSeekers,
          idps: data.idps,
          stateless: data.stateless,
          totalDisplaced: data.refugees + data.asylumSeekers + data.idps + data.stateless,
          hostRefugees: 0,
          hostAsylumSeekers: 0,
          hostTotal: 0,
        };
      }

      for (const [code, data] of Object.entries(byAsylum)) {
        const hostRefugees = data.refugees;
        const hostAsylumSeekers = data.asylumSeekers;
        const hostTotal = hostRefugees + hostAsylumSeekers;

        if (!countries[code]) {
          countries[code] = {
            code,
            name: data.name,
            refugees: 0,
            asylumSeekers: 0,
            idps: 0,
            stateless: 0,
            totalDisplaced: 0,
            hostRefugees,
            hostAsylumSeekers,
            hostTotal,
          };
        } else {
          countries[code].hostRefugees = hostRefugees;
          countries[code].hostAsylumSeekers = hostAsylumSeekers;
          countries[code].hostTotal = hostTotal;
        }
      }

      // 4. Sort countries by max(totalDisplaced, hostTotal) descending
      const sortedCountries = Object.values(countries).sort((a, b) => {
        const aSize = Math.max(a.totalDisplaced, a.hostTotal);
        const bSize = Math.max(b.totalDisplaced, b.hostTotal);
        return bSize - aSize;
      });

      // 5. Apply countryLimit
      const limitedCountries = req.countryLimit > 0
        ? sortedCountries.slice(0, req.countryLimit)
        : sortedCountries;

      // 6. Build proto-shaped countries with GeoCoordinates
      const protoCountries = limitedCountries.map((d) => ({
        code: d.code,
        name: d.name,
        refugees: String(d.refugees),
        asylumSeekers: String(d.asylumSeekers),
        idps: String(d.idps),
        stateless: String(d.stateless),
        totalDisplaced: String(d.totalDisplaced),
        hostRefugees: String(d.hostRefugees),
        hostAsylumSeekers: String(d.hostAsylumSeekers),
        hostTotal: String(d.hostTotal),
        location: getCoordinates(d.code),
      }));

      // 7. Build flows sorted by refugees descending, capped by flowLimit
      const flowLimit = req.flowLimit > 0 ? req.flowLimit : 50;
      const protoFlows = Object.values(flowMap)
        .sort((a, b) => b.refugees - a.refugees)
        .slice(0, flowLimit)
        .map((f) => ({
          originCode: f.originCode,
          originName: f.originName,
          asylumCode: f.asylumCode,
          asylumName: f.asylumName,
          refugees: String(f.refugees),
          originLocation: getCoordinates(f.originCode),
          asylumLocation: getCoordinates(f.asylumCode),
        }));

      // 8. Return proto-shaped response
      return {
        summary: {
          year: dataYearUsed,
          globalTotals: {
            refugees: String(totalRefugees),
            asylumSeekers: String(totalAsylumSeekers),
            idps: String(totalIdps),
            stateless: String(totalStateless),
            total: String(totalRefugees + totalAsylumSeekers + totalIdps + totalStateless),
          },
          countries: protoCountries,
          topFlows: protoFlows,
        },
      };
    } catch {
      // Graceful degradation: return empty summary on ANY failure
      return {
        summary: {
          year: req.year > 0 ? req.year : new Date().getFullYear(),
          globalTotals: {
            refugees: '0',
            asylumSeekers: '0',
            idps: '0',
            stateless: '0',
            total: '0',
          },
          countries: [],
          topFlows: [],
        },
      };
    }
  },

  async getPopulationExposure(
    _ctx: ServerContext,
    req: GetPopulationExposureRequest,
  ): Promise<GetPopulationExposureResponse> {
    return handlePopulationExposure(req);
  },
};
