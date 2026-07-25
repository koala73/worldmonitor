import type {
  GetChinaCorridorControlTowersRequest,
  GetChinaCorridorControlTowersResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import {
  validateChinaCorridorProvenanceForSurface,
  type ChinaCorridorControlTowerResponse,
} from '../../../../shared/china-corridor-control-towers';
import { CHINA_CORRIDOR_CONTROL_TOWERS_KEY } from '../../../_shared/cache-keys';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
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
  read: ChinaCorridorCacheReader = getCachedJson,
): Promise<ChinaCorridorRawSnapshots> {
  const entries = await Promise.all(
    Object.entries(CHINA_CORRIDOR_SOURCE_KEYS).map(async ([field, key]) =>
      [field, await readIsolated(read, key)] as const),
  );
  return Object.fromEntries(entries) as ChinaCorridorRawSnapshots;
}

export async function composeChinaCorridorSnapshot(
  assessedAt: string,
  read: ChinaCorridorCacheReader = getCachedJson,
): Promise<ChinaCorridorControlTowerResponse> {
  const raw = await loadChinaCorridorRawSnapshots(read);
  const response = composeChinaCorridorControlTowers(
    buildChinaCorridorSourceBundle(raw, assessedAt),
  );
  return validateChinaCorridorProvenanceForSurface(response, 'cache_storage');
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

export async function getChinaCorridorControlTowers(
  _ctx: ServerContext,
  _req: GetChinaCorridorControlTowersRequest,
): Promise<GetChinaCorridorControlTowersResponse> {
  const assessedAt = new Date().toISOString();
  try {
    const response = await cachedFetchJson<ChinaCorridorControlTowerResponse>(
      CHINA_CORRIDOR_CONTROL_TOWERS_KEY,
      300,
      () => composeChinaCorridorSnapshot(assessedAt),
    );
    return projectChinaCorridorWireResponse(
      response ?? await composeChinaCorridorSnapshot(assessedAt, async () => null),
    );
  } catch {
    return projectChinaCorridorWireResponse(
      await composeChinaCorridorSnapshot(assessedAt, async () => null),
    );
  }
}
