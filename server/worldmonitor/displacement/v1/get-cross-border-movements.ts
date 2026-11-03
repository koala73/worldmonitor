import type { ServerContext, GetCrossBorderMovementsRequest, GetCrossBorderMovementsResponse } from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { readCachedEnvelopeJson } from '../../../_shared/redis';
import { CROSS_BORDER_SOURCES, projectCrossBorderSnapshots, filterCrossBorderMovements } from './cross-border-data';

export async function getCrossBorderMovements(_ctx: ServerContext, req: GetCrossBorderMovementsRequest): Promise<GetCrossBorderMovementsResponse> {
  const countryCode = (req.countryCode ?? '').trim().toUpperCase();
  const route = (req.route ?? '').trim();
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new ValidationError([{ field: 'countryCode', description: 'country_code must contain two letters' }]);
  if (route.length > 120) throw new ValidationError([{ field: 'route', description: 'route must be at most 120 characters' }]);
  return filterCrossBorderMovements(await readCrossBorderMovements(), countryCode, route);
}

export async function readCrossBorderMovements(): Promise<GetCrossBorderMovementsResponse> {
  const results = await Promise.allSettled(CROSS_BORDER_SOURCES.map(async source => {
    const read = await readCachedEnvelopeJson(source.key, true);
    return [source.id, read.status === 'hit' ? read.value : null] as const;
  }));
  const snapshots = Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
  return projectCrossBorderSnapshots(snapshots);
}
