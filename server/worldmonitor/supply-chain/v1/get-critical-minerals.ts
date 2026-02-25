import type {
  ServerContext,
  GetCriticalMineralsRequest,
  GetCriticalMineralsResponse,
  CriticalMineral,
  MineralProducer,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { MINERAL_PRODUCTION_2024 } from './_minerals-data';
// @ts-expect-error — .mjs module, no declaration file
import { computeHHI, riskRating } from './_scoring.mjs';

const REDIS_CACHE_KEY = 'supply_chain:minerals:v1';
const REDIS_CACHE_TTL = 86400;

function buildMineralsData(): CriticalMineral[] {
  const byMineral = new Map<string, typeof MINERAL_PRODUCTION_2024>();
  for (const entry of MINERAL_PRODUCTION_2024) {
    const existing = byMineral.get(entry.mineral) || [];
    existing.push(entry);
    byMineral.set(entry.mineral, existing);
  }

  const minerals: CriticalMineral[] = [];

  for (const [mineral, entries] of byMineral) {
    const globalProduction = entries.reduce((sum, e) => sum + e.productionTonnes, 0);
    const unit = entries[0]?.unit || 'tonnes';

    const producers: MineralProducer[] = entries
      .sort((a, b) => b.productionTonnes - a.productionTonnes)
      .slice(0, 5)
      .map(e => ({
        country: e.country,
        countryCode: e.countryCode,
        productionTonnes: e.productionTonnes,
        sharePct: globalProduction > 0 ? (e.productionTonnes / globalProduction) * 100 : 0,
      }));

    const shares = entries.map(e => globalProduction > 0 ? (e.productionTonnes / globalProduction) * 100 : 0);
    const hhi = computeHHI(shares);

    minerals.push({
      mineral,
      topProducers: producers,
      hhi,
      riskRating: riskRating(hhi),
      globalProduction,
      unit,
    });
  }

  return minerals.sort((a, b) => b.hhi - a.hhi);
}

export async function getCriticalMinerals(
  _ctx: ServerContext,
  _req: GetCriticalMineralsRequest,
): Promise<GetCriticalMineralsResponse> {
  try {
    const result = await cachedFetchJson<GetCriticalMineralsResponse>(
      REDIS_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const minerals = buildMineralsData();
        return { minerals, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
      },
    );

    return result ?? { minerals: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return { minerals: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
