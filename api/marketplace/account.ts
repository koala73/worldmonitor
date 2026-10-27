export const config = { runtime: 'edge' };

import { callMarketplaceBackend } from '../../server/_shared/aws-marketplace';
import { COOKIE_BINDING, COOKIE_REGISTRATION, authenticatedUser, cookieValue, errorResponse, json } from './_common';
import type { AwsMarketplaceLicenseView } from '../../shared/aws-marketplace';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET' });
  const userId = await authenticatedUser(request);
  if (userId instanceof Response) return userId;
  try {
    const account = await callMarketplaceBackend<{ licenses: AwsMarketplaceLicenseView[] }>({ operation: 'account', userId });
    return json({ licenses: account.licenses, pendingRegistration: Boolean(cookieValue(request, COOKIE_REGISTRATION) && cookieValue(request, COOKIE_BINDING)) });
  } catch (error) { return errorResponse(error); }
}
