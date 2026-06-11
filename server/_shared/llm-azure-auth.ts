// server/_shared/llm-azure-auth.ts
// Entra ID (Azure AD) client-credentials auth for Azure OpenAI.
//
// Azure OpenAI deployments that disable key-based auth require an Entra ID
// bearer token (scope https://cognitiveservices.azure.com/.default). This
// module performs the OAuth2 client-credentials flow against the tenant token
// endpoint and caches the resulting token until shortly before it expires.
//
// Configure via env (operator-supplied service principal):
//   AZURE_OPENAI_TENANT_ID
//   AZURE_OPENAI_CLIENT_ID
//   AZURE_OPENAI_CLIENT_SECRET
//   AZURE_OPENAI_SCOPE        (optional; defaults to the Cognitive Services scope)

export interface AzureEntraCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

const DEFAULT_SCOPE = 'https://cognitiveservices.azure.com/.default';
// Refresh this many ms before the token's stated expiry to avoid using a token
// that expires mid-request.
const EXPIRY_SKEW_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();

function env(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

/**
 * Read Entra ID service-principal credentials from the environment.
 * Returns null unless tenant id, client id, AND client secret are all set.
 */
export function getAzureEntraCredentials(): AzureEntraCredentials | null {
  const tenantId = env('AZURE_OPENAI_TENANT_ID');
  const clientId = env('AZURE_OPENAI_CLIENT_ID');
  const clientSecret = env('AZURE_OPENAI_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) return null;
  const scope = env('AZURE_OPENAI_SCOPE') || DEFAULT_SCOPE;
  return { tenantId, clientId, clientSecret, scope };
}

function cacheKey(creds: AzureEntraCredentials): string {
  return `${creds.tenantId}|${creds.clientId}|${creds.scope}`;
}

async function requestToken(creds: AzureEntraCredentials): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: creds.scope,
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Entra token request failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Entra token response missing access_token');
  }

  const expiresInMs = (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000;
  tokenCache.set(cacheKey(creds), {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs - EXPIRY_SKEW_MS, 0),
  });
  return data.access_token;
}

/**
 * Get a valid Entra ID bearer token for Azure OpenAI, using a cached token
 * when one is still fresh. Concurrent callers share a single in-flight request.
 */
export async function getAzureEntraToken(creds: AzureEntraCredentials): Promise<string> {
  const key = cacheKey(creds);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = requestToken(creds).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: clear cached tokens and in-flight requests. */
export function __resetAzureTokenCacheForTests(): void {
  tokenCache.clear();
  inFlight.clear();
}
