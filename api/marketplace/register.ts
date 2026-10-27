export const config = { runtime: 'edge' };

import { callMarketplaceBackend, getMarketplaceEntitlements, resolveMarketplaceCustomer } from '../../server/_shared/aws-marketplace';
import { BASE_HEADERS, COOKIE_BINDING, COOKIE_REGISTRATION, cookieHeader, errorResponse, json, randomSecret, readSmallText, sha256 } from './_common';
import { checkEndpointRateLimit } from '../../server/_shared/rate-limit';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return json({ error: 'INVALID_REQUEST' }, 400);
  try {
    const limited = await checkEndpointRateLimit(request, '/api/marketplace/register', BASE_HEADERS);
    if (limited) return limited;
    const form = new URLSearchParams(await readSmallText(request, 8192));
    const values = form.getAll('x-amzn-marketplace-token');
    if (values.length !== 1 || !values[0] || values[0].length > 4096) return json({ error: 'INVALID_REQUEST' }, 400);
    const identity = await resolveMarketplaceCustomer(values[0]);
    const begun = await callMarketplaceBackend<{ licenseId: string; revision: number; duplicate: boolean }>({
      operation: 'beginRefresh',
      productCode: identity.productCode,
      customerAWSAccountId: identity.customerAWSAccountId,
      licenseArn: identity.licenseArn,
    });
    const entitlements = await getMarketplaceEntitlements(identity);
    const applied = await callMarketplaceBackend<{ applied: boolean }>({
      operation: 'applyRefresh', licenseId: begun.licenseId, revision: begun.revision, checkedAt: Date.now(), entitlements,
    });
    if (!applied.applied) return json({ error: 'VERIFY_CONFLICT' }, 503);
    const registration = randomSecret();
    const binding = randomSecret();
    await callMarketplaceBackend({
      operation: 'stageRegistration', ...identity,
      registrationHash: await sha256(registration), browserBindingHash: await sha256(binding),
      expiresAt: Date.now() + 10 * 60_000,
    });
    const buyerOrigin = process.env.AWS_MARKETPLACE_BUYER_ORIGIN;
    if (!buyerOrigin || new URL(buyerOrigin).protocol !== 'https:') return json({ error: 'CONFIG' }, 503);
    const response = new Response(null, {
      status: 303,
      headers: { ...BASE_HEADERS, Location: new URL('/marketplace?setup=1', buyerOrigin).toString() },
    });
    response.headers.append('Set-Cookie', cookieHeader(COOKIE_REGISTRATION, registration));
    response.headers.append('Set-Cookie', cookieHeader(COOKIE_BINDING, binding));
    return response;
  } catch (error) { return errorResponse(error); }
}
