export const config = { runtime: 'edge' };

const TOKEN_TTL_SECONDS = 3600;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function invalidClient() {
  return jsonResp({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401);
}

function validateSecret(secret) {
  if (!secret) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(secret);
}

async function storeToken(uuid, apiKey, clientId) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  const key = `oauth:token:${uuid}`;
  const value = JSON.stringify({ apiKey, clientId, issuedAt: Date.now() });
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, value, 'EX', TOKEN_TTL_SECONDS]]),
    signal: AbortSignal.timeout(3_000),
  });
  return resp.ok;
}

function parseBasicAuth(req) {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Basic ')) return null;
  try {
    const decoded = atob(authHeader.slice(6));
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return { clientId: decoded.slice(0, colon), clientSecret: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

async function parseBody(req) {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return {
      grantType: params.get('grant_type'),
      clientId: params.get('client_id'),
      clientSecret: params.get('client_secret'),
    };
  }
  if (ct.includes('application/json')) {
    const json = await req.json().catch(() => ({}));
    return {
      grantType: json.grant_type,
      clientId: json.client_id,
      clientSecret: json.client_secret,
    };
  }
  return { grantType: null, clientId: null, clientSecret: null };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  let grantType, clientId, clientSecret;

  // HTTP Basic auth overrides body params
  const basic = parseBasicAuth(req);
  if (basic) {
    clientId = basic.clientId;
    clientSecret = basic.clientSecret;
    const body = await parseBody(req).catch(() => ({}));
    grantType = body.grantType || 'client_credentials';
  } else {
    const body = await parseBody(req);
    grantType = body.grantType;
    clientId = body.clientId;
    clientSecret = body.clientSecret;
  }

  if (grantType !== 'client_credentials') {
    return jsonResp({ error: 'unsupported_grant_type' }, 400);
  }

  if (!validateSecret(clientSecret)) {
    return invalidClient();
  }

  const uuid = crypto.randomUUID();
  const stored = await storeToken(uuid, clientSecret, clientId || '');
  if (!stored) {
    return jsonResp({ error: 'server_error', error_description: 'Token storage failed' }, 500);
  }

  return jsonResp({
    access_token: uuid,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    scope: 'mcp',
  });
}
