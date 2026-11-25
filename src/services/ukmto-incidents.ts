import { ensureHydrated } from '@/services/bootstrap';
import { readUkmtoSnapshot } from '../../shared/ukmto-incidents';
import type { ListUkmtoIncidentsResponse } from '@/generated/client/worldmonitor/maritime/v1/service_client';

let lastValid: ListUkmtoIncidentsResponse | undefined;

function toAbortError(signal: AbortSignal): Error | DOMException {
  if (signal.reason instanceof DOMException && signal.reason.name === 'AbortError') {
    return signal.reason;
  }
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') {
    return signal.reason;
  }
  return new DOMException('Aborted', 'AbortError');
}

export async function fetchUkmtoIncidents(signal?: AbortSignal): Promise<ListUkmtoIncidentsResponse> {
  if (signal?.aborted) throw toAbortError(signal);
  const raw = await ensureHydrated('ukmtoIncidents', signal);
  if (signal?.aborted) throw toAbortError(signal);
  const result = readUkmtoSnapshot(raw, Date.now(), Infinity);
  if (result.dataAvailable) lastValid = result;
  return result.dataAvailable ? result : readUkmtoSnapshot(lastValid, Date.now(), Infinity);
}
