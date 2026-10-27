export const config = { runtime: 'edge' };

import { callMarketplaceBackend } from '../../server/_shared/aws-marketplace';
import { COOKIE_BINDING, COOKIE_REGISTRATION, authenticatedUser, cookieHeader, cookieValue, errorResponse, json, sameOriginMutation, sha256 } from './_common';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
  if (!sameOriginMutation(request)) return json({ error: 'FORBIDDEN_ORIGIN' }, 403);
  const userId = await authenticatedUser(request);
  if (userId instanceof Response) return userId;
  const registration = cookieValue(request, COOKIE_REGISTRATION);
  const binding = cookieValue(request, COOKIE_BINDING);
  if (!registration || !binding) return json({ error: 'REGISTRATION_REQUIRED' }, 409);
  try {
    const result = await callMarketplaceBackend<{ licenseId: string; principalId: string }>({
      operation: 'claimRegistration', registrationHash: await sha256(registration), browserBindingHash: await sha256(binding), userId,
    });
    const response = json(result);
    response.headers.append('Set-Cookie', cookieHeader(COOKIE_REGISTRATION, '', 0));
    response.headers.append('Set-Cookie', cookieHeader(COOKIE_BINDING, '', 0));
    return response;
  } catch (error) { return errorResponse(error); }
}
