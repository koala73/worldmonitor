import { CyberServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';

// Separate from marker loading: no lookup or client construction until expansion.
export async function fetchCyberNetworkInfo(ip: string) {
  const client = new CyberServiceClient(getRpcBaseUrl(), {
    fetch: (input, init) => globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
  });
  return client.getNetworkInfo({ ip });
}
