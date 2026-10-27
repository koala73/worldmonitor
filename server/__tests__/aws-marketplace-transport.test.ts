import { describe, expect, it, vi } from 'vitest';
import { callMarketplaceBackend, createAwsMarketplaceCall, getMarketplaceEntitlements, MarketplaceError, resolveMarketplaceCustomer } from '../_shared/aws-marketplace';
import { errorResponse } from '../../api/marketplace/_common';

const env = {
  AWS_MARKETPLACE_REGION: 'us-east-1',
  AWS_MARKETPLACE_PRODUCT_CODES: 'product-1',
  AWS_MARKETPLACE_DIMENSION_PLAN_MAP: '{"api_access":"pro"}',
};
const identity = {
  productCode: 'product-1',
  customerAWSAccountId: '123456789012',
  licenseArn: 'arn:aws:license-manager:us-east-1:123456789012:license:l-abc123',
};
const entitlement = {
  ProductCode: identity.productCode,
  CustomerAWSAccountId: identity.customerAWSAccountId,
  LicenseArn: identity.licenseArn,
  Dimension: 'api_access',
  Value: { IntegerValue: 2 },
  ExpirationDate: 1_800_000_000,
};

describe('AWS Marketplace transport validation', () => {
  it('accepts new ResolveCustomer responses without CustomerIdentifier', async () => {
    const result = await resolveMarketplaceCustomer('token', env, async () => ({
      ProductCode: identity.productCode,
      CustomerAWSAccountId: identity.customerAWSAccountId,
      LicenseArn: identity.licenseArn,
    }));
    expect(result).toEqual(identity);
  });

  it('accepts a regionless License Manager ARN and preserves an agreement ID', async () => {
    const licenseArn = 'arn:aws:license-manager::123456789012:license:l-abc123';
    const result = await resolveMarketplaceCustomer('token', env, async () => ({
      ProductCode: identity.productCode,
      CustomerAWSAccountId: identity.customerAWSAccountId,
      LicenseArn: licenseArn,
      Metadata: { AgreementId: 'agmt-123' },
    }));
    expect(result).toEqual({ ...identity, licenseArn, agreementId: 'agmt-123' });
  });

  it('follows NextToken even when a page is empty', async () => {
    const bodies: unknown[] = [];
    const result = await getMarketplaceEntitlements(identity, env, async (_service, _target, body) => {
      bodies.push(body);
      return bodies.length === 1 ? { Entitlements: [], NextToken: 'next' } : { Entitlements: [entitlement] };
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ Filter: { LICENSE_ARN: [identity.licenseArn] } });
    expect(bodies[1]).toMatchObject({ NextToken: 'next' });
    expect(result).toEqual([{ dimension: 'api_access', quantity: 2, expirationDate: 1_800_000_000_000 }]);
  });

  it.each([
    { ...entitlement, CustomerAWSAccountId: '999999999999' },
    { ...entitlement, LicenseArn: 'arn:aws:license-manager:us-east-1:999999999999:license:l-other' },
    { ...entitlement, Dimension: 'unconfigured' },
    { ...entitlement, Value: { IntegerValue: 0 } },
    { ...entitlement, Value: { DoubleValue: 2.5 } },
    { ...entitlement, ExpirationDate: null },
  ])('rejects a malformed or foreign entitlement row', async row => {
    await expect(getMarketplaceEntitlements(identity, env, async () => ({ Entitlements: [row] }))).rejects.toMatchObject({ code: 'AWS_INVALID' } satisfies Partial<MarketplaceError>);
  });

  it('rejects a repeated pagination token', async () => {
    await expect(getMarketplaceEntitlements(identity, env, async () => ({ Entitlements: [], NextToken: 'loop' }))).rejects.toMatchObject({ code: 'AWS_INVALID' });
  });

  it('retries throttling with bounded attempts and signs the AWS request', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ __type: 'ThrottlingException' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Entitlements: [] }), { status: 200 }));
    const call = createAwsMarketplaceCall({
      ...env, AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE12345678', AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_SESSION_TOKEN: 'test-session',
    }, fetcher);
    expect(await call('entitlement', 'AWSMPEntitlementService.GetEntitlements', { ProductCode: 'product-1' })).toEqual({ Entitlements: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toContain('Credential=AKIAEXAMPLE12345678');
    expect(new Headers(init.headers).get('x-amz-security-token')).toBe('test-session');
  });

  it.each([
    [400, 'REGISTRATION_EXPIRED', 'REGISTRATION_EXPIRED'],
    [404, 'REGISTRATION_NOT_FOUND', 'REGISTRATION_REQUIRED'],
  ])('keeps failed claim setup recoverable after backend status %i', async (status, backendCode, publicCode) => {
    const result = callMarketplaceBackend({
      operation: 'claimRegistration', registrationHash: 'a'.repeat(64), browserBindingHash: 'b'.repeat(64), userId: 'clerk-owner',
    }, { CONVEX_SITE_URL: 'https://convex.example', CONVEX_SERVER_SHARED_SECRET: 'test-secret' },
    async () => new Response(JSON.stringify({ error: backendCode }), { status }));
    const error = await result.catch(caught => caught);
    expect(error).toMatchObject({ code: publicCode });
    const response = errorResponse(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: publicCode });
  });
});
