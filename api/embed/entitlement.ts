/**
 * GET /api/embed/entitlement?panel=
 *
 * Auth bootstrap for the partner /embed iframe. Entitlement is keyed to the
 * embedding account's API key header, never to the viewer's cookies or
 * anonymous session token.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../_crypto.js';
import { checkEndpointRateLimit } from '../../server/_shared/rate-limit';
import { getEntitlements, isEntitlementBackendConfigured } from '../../server/_shared/entitlement-check';
import { validateUserApiKey } from '../../server/_shared/user-api-key';
import {
  evaluateEmbedEntitlement,
  parseEnterpriseApiKeys,
} from '../../server/_shared/embed-entitlement';

const ENTITLEMENT_PATH = '/api/embed/entitlement';

function requestWithoutCookies(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.delete('cookie');
  return new Request(req, { headers });
}

function embeddingApiKeyFromHeaders(headers: Headers): string | null {
  const key = (headers.get('X-WorldMonitor-Key') ?? headers.get('X-Api-Key') ?? '').trim();
  return key || null;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ allowed: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'GET, OPTIONS' },
    });
  }

  const limited = await checkEndpointRateLimit(req, ENTITLEMENT_PATH, cors);
  if (limited) return limited;

  const stripped = requestWithoutCookies(req);
  const url = new URL(stripped.url);
  const result = await evaluateEmbedEntitlement(
    url.searchParams.get('panel'),
    embeddingApiKeyFromHeaders(stripped.headers),
    {
      getValidEnterpriseKeys: () => parseEnterpriseApiKeys(process.env.WORLDMONITOR_VALID_KEYS),
      timingSafeIncludes,
      validateUserApiKey,
      getEntitlements,
      isEntitlementBackendConfigured,
    },
  );

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: jsonHeaders,
  });
}
