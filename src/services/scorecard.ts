import type { GetFiveFactorScorecardResponse } from '@/generated/client/worldmonitor/scorecard/v1/service_client';
import { ScorecardServiceClient } from '@/services/generated-rpc-clients';
import { premiumFetch } from '@/services/premium-fetch';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { combineAbortSignals, createTimeoutSignal } from '@/services/timeout-signal';

export const SCORECARD_REQUEST_TIMEOUT_MS = 8_000;

let client: InstanceType<typeof ScorecardServiceClient> | null = null;

function getClient(): InstanceType<typeof ScorecardServiceClient> {
  client ||= new ScorecardServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
  return client;
}

export async function withScorecardDeadline<T>(
  startRequest: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = SCORECARD_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const timeoutSignal = createTimeoutSignal(timeoutMs);
  const requestSignal = signal ? combineAbortSignals([signal, timeoutSignal]) : timeoutSignal;
  if (requestSignal.aborted) throw requestSignal.reason;
  return new Promise((resolve, reject) => {
    const cleanup = (): void => requestSignal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(requestSignal.reason);
    };
    requestSignal.addEventListener('abort', onAbort, { once: true });
    if (requestSignal.aborted) {
      onAbort();
      return;
    }
    let request: Promise<T>;
    try {
      request = startRequest(requestSignal);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    void request.then(resolve, reject).finally(cleanup);
  });
}

export async function getFiveFactorScorecard(countryCode: string, signal?: AbortSignal): Promise<GetFiveFactorScorecardResponse> {
  return withScorecardDeadline((requestSignal) => getClient().getFiveFactorScorecard(
    { countryCode: countryCode.trim().toUpperCase() },
    { signal: requestSignal },
  ), signal);
}
