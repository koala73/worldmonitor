import type { GetTorontoSafetyResponse } from '@/generated/client/worldmonitor/safety/v1/service_client';
import { SafetyServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { TORONTO_SAFETY_SEMANTICS } from '../../shared/toronto-safety.js';

export type TorontoSafetyDataset =
  | typeof TORONTO_SAFETY_SEMANTICS.reportedOccurrence
  | typeof TORONTO_SAFETY_SEMANTICS.annualAggregate;

let client: InstanceType<typeof SafetyServiceClient> | null = null;

function safetyClient(): InstanceType<typeof SafetyServiceClient> {
  if (!client) {
    client = new SafetyServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
  }
  return client;
}

export function fetchTorontoSafetyDataset(
  dataset: TorontoSafetyDataset,
  signal?: AbortSignal,
): Promise<GetTorontoSafetyResponse> {
  return safetyClient().getTorontoSafety({
    dataset,
    limit: 50,
    division: '',
    neighbourhood: '',
    offence: '',
    year: 0,
  }, { signal });
}
