/**
 * ACLED OAuth helper — auto-fetches and caches Bearer tokens.
 *
 * Reads ACLED_EMAIL + ACLED_PASSWORD from env to obtain a token via OAuth.
 * Falls back to a static ACLED_ACCESS_TOKEN if credentials aren't set.
 * Tokens are cached in memory and refreshed ~1 hour before expiry.
 */

declare const process: { env: Record<string, string | undefined> };

const TOKEN_URL = 'https://acleddata.com/oauth/token';

let cachedToken: string | null = null;
let cachedRefreshToken: string | null = null;
let expiresAt = 0; // unix ms

/**
 * Returns a valid ACLED Bearer token, or null if unconfigured.
 * Automatically refreshes via OAuth when needed.
 */
export async function getAcledToken(): Promise<string | null> {
  // If we have a cached token that isn't expiring within the next hour, reuse it
  if (cachedToken && Date.now() < expiresAt - 3_600_000) {
    return cachedToken;
  }

  const email = process.env.ACLED_EMAIL;
  const password = process.env.ACLED_PASSWORD;

  // If OAuth credentials are available, fetch a fresh token
  if (email && password) {
    // Try refresh token first if we have one
    if (cachedRefreshToken) {
      const refreshed = await requestToken({
        refresh_token: cachedRefreshToken,
        grant_type: 'refresh_token',
        client_id: 'acled',
      });
      if (refreshed) return cachedToken;
    }

    // Full credential auth
    const ok = await requestToken({
      username: email,
      password,
      grant_type: 'password',
      client_id: 'acled',
    });
    if (ok) return cachedToken;
  }

  // Fallback: static token from env (for backwards compat / desktop app)
  return process.env.ACLED_ACCESS_TOKEN || null;
}

async function requestToken(body: Record<string, string>): Promise<boolean> {
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return false;

    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) return false;

    cachedToken = data.access_token;
    cachedRefreshToken = data.refresh_token || cachedRefreshToken;
    // expires_in is in seconds; default to 24h if missing
    const ttlMs = (data.expires_in || 86400) * 1000;
    expiresAt = Date.now() + ttlMs;
    return true;
  } catch {
    return false;
  }
}
