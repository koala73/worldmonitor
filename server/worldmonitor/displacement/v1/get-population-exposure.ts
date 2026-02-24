/**
 * GetPopulationExposure RPC -- provides population data for priority countries
 * and computes population exposure estimates within a given radius of a
 * geographic point using population density approximations.
 */

import type {
  ServerContext,
  GetPopulationExposureRequest,
  GetPopulationExposureResponse,
  CountryPopulationEntry,
} from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';

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

// ---------- RPC handler ----------

export async function getPopulationExposure(
  _ctx: ServerContext,
  req: GetPopulationExposureRequest,
): Promise<GetPopulationExposureResponse> {
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

    const info = bestMatch ? PRIORITY_COUNTRIES[bestMatch]! : { pop: 50000000, area: 500000 };
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
