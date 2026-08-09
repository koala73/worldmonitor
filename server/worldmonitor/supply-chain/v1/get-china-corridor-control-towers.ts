import type {
  GetChinaCorridorControlTowersRequest,
  GetChinaCorridorControlTowersResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import {
  createUnavailableChinaCorridorControlTowerResponse,
  validateChinaCorridorProvenanceForSurface,
  type ChinaCorridorControlTowerResponse,
} from '../../../../shared/china-corridor-control-towers';
import { CHINA_CORRIDOR_CONTROL_TOWERS_KEY } from '../../../_shared/cache-keys';
import { cachedFetchJson, getCachedJsonBatch } from '../../../_shared/redis';
import { composeChinaCorridorControlTowers } from './china-corridor-control-towers';
import {
  buildChinaCorridorSourceBundle,
  type ChinaCorridorRawSnapshots,
} from './china-corridor-source-adapters';

export const CHINA_CORRIDOR_SOURCE_KEYS: Readonly<
  Record<keyof ChinaCorridorRawSnapshots, string>
> = Object.freeze({
  portwatchChina: 'supply_chain:portwatch-ports:v1:CN',
  portwatchHongKong: 'supply_chain:portwatch-ports:v1:HK',
  portwatchMeta: 'seed-meta:supply_chain:portwatch-ports',
  aviation: 'aviation:delays-bootstrap:v2',
  aviationMeta: 'seed-meta:aviation:intl',
  westernPacificCyclones: 'natural:western-pacific-cyclones:v1',
  westernPacificCyclonesMeta: 'seed-meta:natural:western-pacific-cyclones',
  hkoWarnings: 'weather:hko-warnings:v1',
  hkoWarningsMeta: 'seed-meta:weather:hko-warnings',
  energySpine: 'energy:spine:v1:CN',
  energySpineMeta: 'seed-meta:energy:spine',
  comtrade: 'comtrade:flows:v1',
  comtradeMeta: 'seed-meta:trade:comtrade-flows',
  shipping: 'supply_chain:shipping:v2',
  shippingMeta: 'seed-meta:supply_chain:shipping',
});

export type ChinaCorridorCacheReader = (
  key: string,
  raw?: boolean,
) => Promise<unknown | null>;

export type ChinaCorridorBatchCacheReader = (
  keys: string[],
  raw?: boolean,
) => Promise<Map<string, unknown>>;

function allCorridorsUnavailable(
  response: ChinaCorridorControlTowerResponse,
): boolean {
  return response.corridors.every((corridor) => corridor.availability === 'unavailable');
}

async function readIsolated(
  read: ChinaCorridorCacheReader,
  key: string,
): Promise<unknown | null> {
  try {
    return await read(key, true);
  } catch {
    return null;
  }
}

export async function loadChinaCorridorRawSnapshots(
  read?: ChinaCorridorCacheReader,
  readBatch: ChinaCorridorBatchCacheReader = getCachedJsonBatch,
): Promise<ChinaCorridorRawSnapshots> {
  if (read === undefined) {
    let cached = new Map<string, unknown>();
    try {
      cached = await readBatch(Object.values(CHINA_CORRIDOR_SOURCE_KEYS), true);
    } catch {
      // Batch failure is represented as an all-missing source bundle.
    }
    return Object.fromEntries(
      Object.entries(CHINA_CORRIDOR_SOURCE_KEYS).map(([field, key]) =>
        [field, cached.get(key) ?? null]),
    ) as ChinaCorridorRawSnapshots;
  }
  const entries = await Promise.all(
    Object.entries(CHINA_CORRIDOR_SOURCE_KEYS).map(async ([field, key]) =>
      [field, await readIsolated(read, key)] as const),
  );
  return Object.fromEntries(entries) as ChinaCorridorRawSnapshots;
}

async function buildChinaCorridorSnapshot(
  assessedAt: string,
  read?: ChinaCorridorCacheReader,
  readBatch: ChinaCorridorBatchCacheReader = getCachedJsonBatch,
): Promise<ChinaCorridorControlTowerResponse> {
  const raw = await loadChinaCorridorRawSnapshots(read, readBatch);
  const response = composeChinaCorridorControlTowers(
    buildChinaCorridorSourceBundle(raw, assessedAt),
  );
  return validateChinaCorridorProvenanceForSurface(response, 'cache_storage');
}

export async function composeChinaCorridorSnapshot(
  assessedAt: string,
  read?: ChinaCorridorCacheReader,
  readBatch: ChinaCorridorBatchCacheReader = getCachedJsonBatch,
): Promise<ChinaCorridorControlTowerResponse | null> {
  const validated = await buildChinaCorridorSnapshot(assessedAt, read, readBatch);
  return allCorridorsUnavailable(validated)
    ? null
    : validated;
}

export function composeUnavailableChinaCorridorSnapshot(
  assessedAt: string,
): ChinaCorridorControlTowerResponse {
  return validateChinaCorridorProvenanceForSurface(
    composeChinaCorridorControlTowers(buildChinaCorridorSourceBundle({}, assessedAt)),
    'cache_storage',
  );
}

export function projectChinaCorridorWireResponse(
  response: ChinaCorridorControlTowerResponse,
): GetChinaCorridorControlTowersResponse {
  const apiResponse = validateChinaCorridorProvenanceForSurface(response, 'api');
  return {
    payloadJson: JSON.stringify(apiResponse),
    generatedAt: apiResponse.generatedAt,
    upstreamUnavailable: apiResponse.corridors.every((corridor) =>
      corridor.availability === 'unavailable'),
  };
}

export type ChinaCorridorSnapshotCache = (
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<ChinaCorridorControlTowerResponse | null>,
) => Promise<ChinaCorridorControlTowerResponse | null>;

const defaultChinaCorridorSnapshotCache: ChinaCorridorSnapshotCache =
  (key, ttlSeconds, fetcher) => cachedFetchJson(key, ttlSeconds, fetcher);

let inFlightResolution: {
  assessedAt: string;
  cache: ChinaCorridorSnapshotCache;
  read: ChinaCorridorCacheReader | undefined;
  readBatch: ChinaCorridorBatchCacheReader;
  promise: Promise<ChinaCorridorControlTowerResponse>;
} | null = null;

async function resolveChinaCorridorSnapshotUncoalesced(
  assessedAt: string,
  cache: ChinaCorridorSnapshotCache,
  read?: ChinaCorridorCacheReader,
  readBatch: ChinaCorridorBatchCacheReader = getCachedJsonBatch,
): Promise<ChinaCorridorControlTowerResponse> {
  let response: ChinaCorridorControlTowerResponse | null = null;
  let unavailableCacheMiss: ChinaCorridorControlTowerResponse | null = null;
  try {
    response = await cache(
      CHINA_CORRIDOR_CONTROL_TOWERS_KEY,
      300,
      async () => {
        const composed = await buildChinaCorridorSnapshot(assessedAt, read, readBatch);
        if (allCorridorsUnavailable(composed)) {
          unavailableCacheMiss = composed;
          return null;
        }
        return composed;
      },
    );
  } catch {
    // Re-read the current source seeds below; do not manufacture an empty cache hit.
  }
  if (response !== null && !allCorridorsUnavailable(response)) return response;
  if (unavailableCacheMiss !== null) return unavailableCacheMiss;

  try {
    response = await composeChinaCorridorSnapshot(assessedAt, read, readBatch);
  } catch {
    response = null;
  }
  return response ?? composeUnavailableChinaCorridorSnapshot(assessedAt);
}

export function resolveChinaCorridorSnapshot(
  assessedAt: string,
  cache: ChinaCorridorSnapshotCache = defaultChinaCorridorSnapshotCache,
  read?: ChinaCorridorCacheReader,
  readBatch: ChinaCorridorBatchCacheReader = getCachedJsonBatch,
): Promise<ChinaCorridorControlTowerResponse> {
  if (
    inFlightResolution?.assessedAt === assessedAt
    && inFlightResolution.cache === cache
    && inFlightResolution.read === read
    && inFlightResolution.readBatch === readBatch
  ) {
    return inFlightResolution.promise;
  }
  const promise = resolveChinaCorridorSnapshotUncoalesced(
    assessedAt,
    cache,
    read,
    readBatch,
  );
  const resolution = { assessedAt, cache, read, readBatch, promise };
  inFlightResolution = resolution;
  const clear = () => {
    if (inFlightResolution === resolution) inFlightResolution = null;
  };
  void promise.then(clear, clear);
  return promise;
}

export async function getChinaCorridorControlTowers(
  _ctx: ServerContext,
  _req: GetChinaCorridorControlTowersRequest,
): Promise<GetChinaCorridorControlTowersResponse> {
  const assessedAt = new Date().toISOString();
  try {
    return projectChinaCorridorWireResponse(await resolveChinaCorridorSnapshot(assessedAt));
  } catch {
    return projectChinaCorridorWireResponse(
      createUnavailableChinaCorridorControlTowerResponse(assessedAt),
    );
  }
}
