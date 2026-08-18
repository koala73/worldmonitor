import type { EmbedPanelId } from '../../shared/embed-panels';

export interface EmbedEntitlementResponse {
  allowed: boolean;
  panel?: EmbedPanelId;
  public?: boolean;
  accountId?: string;
  error?: string;
}

/**
 * Fetch wrapper for keyed embed RPCs. Always omits cookies so a logged-in
 * World Monitor viewer cannot authenticate the partner's embed as themselves.
 */
export function createKeyedEmbedFetch(apiKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    headers.set('X-WorldMonitor-Key', apiKey);
    return globalThis.fetch(input, { ...init, headers, credentials: 'omit' });
  };
}

export async function fetchEmbedEntitlement(
  panel: EmbedPanelId,
  apiKey: string | null,
): Promise<{ ok: boolean; status: number; body: EmbedEntitlementResponse }> {
  const url = new URL('/api/embed/entitlement', window.location.origin);
  url.searchParams.set('panel', panel);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-WorldMonitor-Key'] = apiKey;
  const resp = await globalThis.fetch(url.toString(), {
    method: 'GET',
    headers,
    credentials: 'omit',
  });
  let body: EmbedEntitlementResponse = { allowed: false };
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === 'object') {
      body = parsed as EmbedEntitlementResponse;
    }
  } catch {
    body = { allowed: false, error: 'invalid_entitlement_response' };
  }
  return { ok: resp.ok && body.allowed === true, status: resp.status, body };
}
