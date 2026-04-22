import { getCachedJson } from '../../../_shared/redis';
import { FUEL_SHORTAGES_KEY } from '../../../_shared/cache-keys';
import type {
  GetFuelShortageDetailRequest,
  GetFuelShortageDetailResponse,
  FuelShortageEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { projectFuelShortage } from './list-fuel-shortages';

interface RawRegistry {
  updatedAt?: string;
  shortages?: Record<string, unknown>;
}

/**
 * Returns one fuel shortage + its evidence bundle, loaded lazily when
 * the user opens the drawer. v1 has no separate revision log surface —
 * the classifier auto-writes revision entries as a byproduct (Week 3
 * milestone, wired later); for now the evidence bundle and timestamp
 * trail are the audit surface.
 */
export async function getFuelShortageDetail(
  _ctx: unknown,
  req: GetFuelShortageDetailRequest,
): Promise<GetFuelShortageDetailResponse> {
  if (!req.shortageId || req.shortageId.length === 0) {
    return {
      shortage: undefined,
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  const raw = (await getCachedJson(FUEL_SHORTAGES_KEY)) as RawRegistry | null;
  const entry = raw?.shortages?.[req.shortageId];
  if (!entry) {
    return {
      shortage: undefined,
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  const shortage: FuelShortageEntry | null = projectFuelShortage(entry);
  if (!shortage) {
    return {
      shortage: undefined,
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  return {
    shortage,
    fetchedAt: raw?.updatedAt ?? new Date().toISOString(),
    unavailable: false,
  };
}
