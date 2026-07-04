import { getConfiguredWebApiBaseUrl } from '@/services/runtime';

export function getRpcBaseUrl(): string {
  // Desktop keeps a relative base so installRuntimeFetchPatch() can resolve the
  // latest sidecar port per request instead of freezing a stale module-load port.
  return getConfiguredWebApiBaseUrl() || '';
}

export function rpcFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  return globalThis.fetch(...args);
}

export function createLazyClient<T>(factory: () => T): () => T {
  let client: T | undefined;
  return () => {
    client ??= factory();
    return client;
  };
}

export function getRpcErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
