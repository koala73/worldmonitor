import type { MaritimeServiceHandler } from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { readUkmtoSnapshot } from '../../../../shared/ukmto-incidents';

export const listUkmtoIncidents: MaritimeServiceHandler['listUkmtoIncidents'] = async () => {
  const data = await getCachedJson('maritime:ukmto-incidents:v1', true);
  return readUkmtoSnapshot(data);
};
