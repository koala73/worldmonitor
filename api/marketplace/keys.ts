export const config = { runtime: 'edge' };

import { callMarketplaceBackend } from '../../server/_shared/aws-marketplace';
import { authenticatedUser, errorResponse, json, randomSecret, readJsonObject, sameOriginMutation, sha256 } from './_common';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST, DELETE' });
  if (!sameOriginMutation(request)) return json({ error: 'FORBIDDEN_ORIGIN' }, 403);
  const userId = await authenticatedUser(request);
  if (userId instanceof Response) return userId;
  try {
    const body = await readJsonObject(request);
    if (typeof body.licenseId !== 'string' || !body.licenseId || body.licenseId.length > 128) return json({ error: 'INVALID_REQUEST' }, 400);
    if (request.method === 'DELETE') {
      if (typeof body.keyId !== 'string' || !body.keyId || body.keyId.length > 128) return json({ error: 'INVALID_REQUEST' }, 400);
      const result = await callMarketplaceBackend<{ ok: boolean }>({ operation: 'revokeKey', userId, licenseId: body.licenseId, keyId: body.keyId });
      return json({ ok: result.ok === true });
    }
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) return json({ error: 'INVALID_REQUEST' }, 400);
    const key = `wm_${randomSecret(20)}`;
    const issued = await callMarketplaceBackend<{ keyId: string }>({
      operation: 'createKey', userId, licenseId: body.licenseId, name: body.name.trim(), keyHash: await sha256(key), keyPrefix: key.slice(0, 8),
    });
    return json({ keyId: issued.keyId, key });
  } catch (error) { return errorResponse(error); }
}
