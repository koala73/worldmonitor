import { ensureHydrated } from '@/services/bootstrap';
import { readUkmtoSnapshot } from '../../shared/ukmto-incidents';
import type { ListUkmtoIncidentsResponse } from '@/generated/client/worldmonitor/maritime/v1/service_client';

let lastValid: ListUkmtoIncidentsResponse | undefined;

export async function fetchUkmtoIncidents(): Promise<ListUkmtoIncidentsResponse> {
  const result = readUkmtoSnapshot(await ensureHydrated('ukmtoIncidents'), Date.now(), Infinity);
  if (result.dataAvailable) lastValid = result;
  return result.dataAvailable ? result : readUkmtoSnapshot(lastValid, Date.now(), Infinity);
}
