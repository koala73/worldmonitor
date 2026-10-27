import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
const entitlements = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => vi.fn());
vi.mock('../_shared/aws-marketplace', async importOriginal => ({
  ...await importOriginal<typeof import('../_shared/aws-marketplace')>(),
  callMarketplaceBackend: backend,
  resolveMarketplaceCustomer: resolve,
  getMarketplaceEntitlements: entitlements,
}));
vi.mock('../_shared/auth-session', () => ({ resolveSessionUserId: session }));

import register from '../../api/marketplace/register';
import claim from '../../api/marketplace/claim';
import account from '../../api/marketplace/account';
import keys from '../../api/marketplace/keys';

const origin = 'https://www.worldmonitor.app';
const identity = {
  productCode: 'product-1',
  customerAWSAccountId: '123456789012',
  licenseArn: 'arn:aws:license-manager:us-east-1:123456789012:license:l-abc123',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AWS_MARKETPLACE_BUYER_ORIGIN = origin;
  session.mockResolvedValue('clerk-owner');
  resolve.mockResolvedValue(identity);
  entitlements.mockResolvedValue([{ dimension: 'api_access', quantity: 1, expirationDate: Date.now() + 60_000 }]);
});

function mutation(path: string, body: unknown, extra: Record<string, string> = {}, method = 'POST'): Request {
  return new Request(`${origin}${path}`, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer clerk-jwt', ...extra },
    body: JSON.stringify(body),
  });
}

describe('Marketplace public routes', () => {
  it('resolves token, verifies AWS, stores hashes, and redirects without URL secrets', async () => {
    resolve.mockResolvedValueOnce({ ...identity, customerIdentifier: 'legacy-customer', agreementId: 'agmt-1' });
    backend.mockResolvedValueOnce({ licenseId: 'license-1', revision: 2, duplicate: false })
      .mockResolvedValueOnce({ applied: true }).mockResolvedValueOnce({ registrationId: 'registration-1' });
    const response = await register(new Request(`${origin}/api/marketplace/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'x-amzn-marketplace-token=sensitive-token',
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${origin}/marketplace?setup=1`);
    expect(response.headers.get('location')).not.toContain('sensitive-token');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(backend.mock.calls[0]?.[0]).toEqual({ operation: 'beginRefresh', ...identity });
    expect(backend.mock.calls[2]?.[0]).toMatchObject({ operation: 'stageRegistration', ...identity,
      customerIdentifier: 'legacy-customer', agreementId: 'agmt-1' });
    expect(JSON.stringify(backend.mock.calls)).not.toContain('sensitive-token');
  });

  it('requires both registration cookies and verified Clerk identity for claim', async () => {
    const request = mutation('/api/marketplace/claim', { userId: 'attacker' }, {
      Cookie: '__Secure-wm_aws_registration=' + 'a'.repeat(64) + '; __Secure-wm_aws_binding=' + 'b'.repeat(64),
    });
    backend.mockResolvedValueOnce({ licenseId: 'license-1', principalId: 'aws-marketplace:license-1' });
    expect((await claim(request)).status).toBe(200);
    expect(backend.mock.calls[0]?.[0]).toMatchObject({ operation: 'claimRegistration', userId: 'clerk-owner' });
    expect(JSON.stringify(backend.mock.calls[0]?.[0])).not.toContain('attacker');
    expect((await claim(mutation('/api/marketplace/claim', {}))).status).toBe(409);
  });

  it('rejects cross-origin key mutation before backend access', async () => {
    expect((await keys(mutation('/api/marketplace/keys', { licenseId: 'license-1', name: 'CLI' }, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });

  it('rejects malformed key JSON before backend access', async () => {
    const response = await keys(new Request(`${origin}/api/marketplace/keys`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer clerk-jwt' },
      body: '{',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BACKEND_INVALID' });
    expect(backend).not.toHaveBeenCalled();
  });

  it('returns a key once and passes only its hash to durable storage', async () => {
    backend.mockImplementationOnce(async (request: { keyPrefix: string }) => {
      if (!/^wm_[a-f0-9]{5}$/.test(request.keyPrefix)) throw new Error('Ledger rejected key prefix');
      return { keyId: 'key-1' };
    });
    const response = await keys(mutation('/api/marketplace/keys', { licenseId: 'license-1', name: 'CLI' }));
    const body = await response.json() as { keyId: string; key: string };
    expect(response.status).toBe(200);
    expect(body.key).toMatch(/^wm_[a-f0-9]{40}$/);
    expect(backend.mock.calls[0]?.[0]).toMatchObject({ operation: 'createKey', userId: 'clerk-owner', keyPrefix: body.key.slice(0, 8) });
    expect(JSON.stringify(backend.mock.calls)).not.toContain(body.key);
  });

  it('reports a pending registration from both cookies', async () => {
    backend.mockResolvedValueOnce({ licenses: [] });
    const response = await account(new Request(`${origin}/api/marketplace/account`, {
      headers: { Authorization: 'Bearer clerk-jwt', Cookie: '__Secure-wm_aws_registration=' + 'a'.repeat(64) + '; __Secure-wm_aws_binding=' + 'b'.repeat(64) },
    }));
    expect(await response.json()).toEqual({ licenses: [], pendingRegistration: true });
  });
});
