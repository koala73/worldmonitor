import { getCachedJson } from '../../../_shared/redis';
import { STORAGE_FACILITIES_KEY } from '../../../_shared/cache-keys';
import type {
  GetStorageFacilityDetailRequest,
  GetStorageFacilityDetailResponse,
  StorageFacilityEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { projectStorageFacility } from './list-storage-facilities';

interface RawRegistry {
  updatedAt?: string;
  facilities?: Record<string, unknown>;
}

/**
 * Returns one storage facility + its revision log, loaded lazily when the
 * user opens the asset-detail drawer. Revisions come from the auto-revision
 * log wired in Week 3 — empty array until then.
 */
export async function getStorageFacilityDetail(
  _ctx: unknown,
  req: GetStorageFacilityDetailRequest,
): Promise<GetStorageFacilityDetailResponse> {
  if (!req.facilityId || req.facilityId.length === 0) {
    return {
      facility: undefined,
      revisions: [],
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  const raw = (await getCachedJson(STORAGE_FACILITIES_KEY)) as RawRegistry | null;
  const entry = raw?.facilities?.[req.facilityId];
  if (!entry) {
    return {
      facility: undefined,
      revisions: [],
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  const facility: StorageFacilityEntry | null = projectStorageFacility(entry);
  if (!facility) {
    return {
      facility: undefined,
      revisions: [],
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  return {
    facility,
    revisions: [],
    fetchedAt: raw?.updatedAt ?? new Date().toISOString(),
    unavailable: false,
  };
}
