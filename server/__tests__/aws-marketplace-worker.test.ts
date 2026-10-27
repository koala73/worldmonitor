import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
const entitlements = vi.hoisted(() => vi.fn());
vi.mock('../_shared/aws-marketplace', () => ({
  callMarketplaceBackend: backend,
  getMarketplaceEntitlements: entitlements,
}));

import { handler, parseNotification, reconcileDue, refreshLicense } from '../../workers/aws-marketplace/index';

const identity = {
  productCode: 'product-1',
  customerAWSAccountId: '123456789012',
  licenseArn: 'arn:aws:license-manager:us-east-1:123456789012:license:l-abc123',
};
const notification = JSON.stringify({
  id: 'event-1', source: 'aws.agreement-marketplace', 'detail-type': 'License Updated - Manufacturer',
  account: '999999999999', region: 'us-east-1', time: '2026-10-26T12:00:00Z',
  detail: { product: { code: 'product-1' }, license: { arn: identity.licenseArn }, acceptor: { accountId: identity.customerAWSAccountId } },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AWS_MARKETPLACE_REGION = 'us-east-1';
  process.env.AWS_MARKETPLACE_PRODUCT_CODES = 'product-1';
  process.env.AWS_MARKETPLACE_SELLER_ACCOUNT_ID = '999999999999';
  entitlements.mockResolvedValue([]);
});

describe('Marketplace worker', () => {
  it('validates seller, region, product, and event identity', () => {
    expect(parseNotification(notification)?.identity).toEqual(identity);
    expect(() => parseNotification(notification.replace('999999999999', '888888888888'))).toThrow();
    expect(parseNotification(notification.replace('product-1', 'other-product'))).toBeNull();
  });

  it('rechecks AWS and applies only the current revision', async () => {
    backend.mockResolvedValueOnce({ licenseId: 'license-1', revision: 4, duplicate: false }).mockResolvedValueOnce({ applied: true });
    await refreshLicense(identity, 'event-1');
    expect(entitlements).toHaveBeenCalledWith(identity);
    expect(backend.mock.calls[1]?.[0]).toMatchObject({ operation: 'applyRefresh', licenseId: 'license-1', revision: 4, entitlements: [] });
  });

  it('leaves a conflicting record in SQS for retry', async () => {
    backend.mockResolvedValueOnce({ licenseId: 'license-1', revision: 4, duplicate: false }).mockResolvedValueOnce({ applied: false });
    expect(await handler({ Records: [{ messageId: 'message-1', body: notification }] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
  });

  it('acknowledges duplicate completed events without AWS reads', async () => {
    backend.mockResolvedValueOnce({ licenseId: 'license-1', revision: 4, duplicate: true });
    expect(await handler({ Records: [{ messageId: 'message-1', body: notification }] })).toEqual({ batchItemFailures: [] });
    expect(entitlements).not.toHaveBeenCalled();
  });

  it('reconciles all due pages after missed notifications', async () => {
    backend.mockResolvedValueOnce({ licenses: [{ ...identity, id: 'license-1', customerIdentifier: 'legacy', agreementId: 'agmt-1' }], cursor: 'next' })
      .mockResolvedValueOnce({ licenseId: 'license-1', revision: 1, duplicate: false })
      .mockResolvedValueOnce({ applied: true })
      .mockResolvedValueOnce({ licenses: [] });
    await reconcileDue();
    expect(backend.mock.calls[1]?.[0]).toEqual({ operation: 'beginRefresh', ...identity });
    expect(backend.mock.calls[3]?.[0]).toMatchObject({ operation: 'listDue', cursor: 'next' });
  });

  it('continues past a failed due license and refreshes another license', async () => {
    const second = { ...identity, licenseArn: 'arn:aws:license-manager:us-east-1:123456789012:license:l-second' };
    backend.mockImplementation(async (request: { operation: string; licenseArn?: string; licenseId?: string }) => {
      if (request.operation === 'listDue') return { licenses: [{ ...identity, id: 'bad' }, { ...second, id: 'good' }] };
      if (request.operation === 'beginRefresh' && request.licenseArn === identity.licenseArn) throw new Error('AWS dependency failed');
      if (request.operation === 'beginRefresh') return { licenseId: 'good', revision: 2, duplicate: false };
      if (request.operation === 'applyRefresh') return { applied: true };
      throw new Error('unexpected operation');
    });
    await expect(reconcileDue()).rejects.toThrow('failed for 1 licenses');
    expect(backend.mock.calls.some(([request]) => request.operation === 'applyRefresh' && request.licenseId === 'good')).toBe(true);
  });

  it('returns remaining SQS records as failures before Lambda timeout', async () => {
    const result = await handler({ Records: [
      { messageId: 'first', body: notification }, { messageId: 'second', body: notification },
    ] }, { getRemainingTimeInMillis: () => 20_000 });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'first' }, { itemIdentifier: 'second' }]);
    expect(backend).not.toHaveBeenCalled();
  });
});
