// @vitest-environment node

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schema from '../../convex/schema';
import { internal } from '../../convex/_generated/api';

const backend = vi.hoisted(() => vi.fn());
vi.mock('../_shared/aws-marketplace', () => ({ callMarketplaceBackend: backend }));
vi.mock('../_shared/auth-session', () => ({ resolveSessionUserId: vi.fn().mockResolvedValue('clerk-owner') }));

import keys from '../../api/marketplace/keys';

const modules = import.meta.glob('../../convex/**/*.ts');
const aws = (internal as any).awsMarketplace;
const NOW = 1_800_000_000_000;
const identity = {
  productCode: 'configured-product',
  customerAWSAccountId: '123456789012',
  licenseArn: 'arn:aws:license-manager::123456789012:license:l-abc123',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('AWS_MARKETPLACE_BUYER_ORIGIN', 'https://www.worldmonitor.app');
  vi.stubEnv('AWS_MARKETPLACE_PRODUCT_CODES', identity.productCode);
  vi.stubEnv('AWS_MARKETPLACE_DIMENSION_PLAN_MAP', '{"api_mcp":"api_starter"}');
  backend.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

test('public key issuer writes a canonical credential accepted by the real license ledger', async () => {
  const t = convexTest(schema, modules);
  const begun = await t.mutation(aws.beginRefresh, identity);
  await t.mutation(aws.applyRefresh, {
    licenseId: begun.licenseId, revision: begun.revision, checkedAt: NOW,
    entitlements: [{ dimension: 'api_mcp', quantity: 1, expirationDate: NOW + 86_400_000 }],
  });
  await t.mutation(aws.stageRegistration, {
    ...identity, registrationHash: 'a'.repeat(64), browserBindingHash: 'b'.repeat(64), expiresAt: NOW + 600_000,
  });
  const claimed = await t.mutation(aws.claimRegistration, {
    registrationHash: 'a'.repeat(64), browserBindingHash: 'b'.repeat(64), userId: 'clerk-owner',
  });
  backend.mockImplementation(async (request: { operation: string; [key: string]: unknown }) => {
    expect(request.operation).toBe('createKey');
    const { operation: _operation, ...args } = request;
    return t.mutation(aws.createKey, args);
  });
  const response = await keys(new Request('https://www.worldmonitor.app/api/marketplace/keys', {
    method: 'POST',
    headers: { Origin: 'https://www.worldmonitor.app', 'Content-Type': 'application/json', Authorization: 'Bearer verified-Clerk-token' },
    body: JSON.stringify({ licenseId: claimed.licenseId, name: 'MCP client' }),
  }));
  expect(response.status).toBe(200);
  const issued = await response.json() as { keyId: string; key: string };
  expect(issued.key).toMatch(/^wm_[a-f0-9]{40}$/);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issued.key))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: hash })).toMatchObject({
    id: issued.keyId, userId: claimed.principalId, keyKind: 'api',
  });
});
