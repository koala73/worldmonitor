import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import {
  ScenarioServiceClient,
  type RunScenarioRequest,
  type RunScenarioResponse,
  type GetScenarioStatusResponse,
  type ListScenarioTemplatesResponse,
  type ScenarioResult,
  type ScenarioImpactCountry,
  type ScenarioResultTemplate,
  type ScenarioTemplate,
} from '@/generated/client/worldmonitor/scenario/v1/service_client';

export type {
  RunScenarioRequest,
  RunScenarioResponse,
  GetScenarioStatusResponse,
  ListScenarioTemplatesResponse,
  ScenarioResult,
  ScenarioImpactCountry,
  ScenarioResultTemplate,
  ScenarioTemplate,
};

// RunScenario + GetScenarioStatus are PRO-gated — premiumFetch injects the
// Clerk Bearer token / API key. ListScenarioTemplates is public but harmless
// to route through the same fetch wrapper.
const client = new ScenarioServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

/**
 * Enqueue a scenario job and return the resulting job id. Server validates
 * scenarioId against the template registry (400 on unknown) and enforces
 * per-IP 10/min rate limiting at the gateway.
 */
export async function runScenario(
  req: RunScenarioRequest,
  options?: { signal?: AbortSignal },
): Promise<RunScenarioResponse> {
  return client.runScenario(req, { signal: options?.signal });
}

/**
 * Poll a scenario job's lifecycle state. Returns status ∈
 * {pending, processing, done, failed}; result is populated only when done.
 */
export async function getScenarioStatus(
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<GetScenarioStatusResponse> {
  return client.getScenarioStatus({ jobId }, { signal: options?.signal });
}

export async function listScenarioTemplates(): Promise<ListScenarioTemplatesResponse> {
  return client.listScenarioTemplates({});
}
