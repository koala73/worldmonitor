import { getConfiguredWebApiBaseUrl } from '@/services/runtime';

export function getRpcBaseUrl(): string {
  // Desktop keeps a relative base so installRuntimeFetchPatch() can resolve the
  // latest sidecar port per request instead of freezing a stale module-load port.
  return getConfiguredWebApiBaseUrl() || '';
}
