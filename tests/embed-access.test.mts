import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasAccountEmbedAccess, type EmbedAccessEntitlement } from '../shared/embed-access';

const NOW = 1_800_000_000_000;
const paid: EmbedAccessEntitlement = {
  features: { tier: 1, embedAccess: true },
  validUntil: NOW + 1,
};

describe('account embed access', () => {
  it('allows Clerk PRO without Convex coverage', () => {
    for (const entitlement of [undefined, null, { ...paid, validUntil: NOW - 1 }]) {
      assert.equal(hasAccountEmbedAccess('pro', entitlement, NOW), true);
    }
  });

  it('allows current Convex coverage with a free or absent Clerk role', () => {
    for (const role of ['free', undefined] as const) {
      assert.equal(hasAccountEmbedAccess(role, paid, NOW), true);
      assert.equal(hasAccountEmbedAccess(role, { ...paid, validUntil: NOW }, NOW), true);
    }
  });

  it('denies absent, free, expired, and unmerged Convex coverage without Clerk PRO', () => {
    const denied = [
      undefined,
      null,
      { ...paid, validUntil: NOW - 1 },
      { ...paid, features: { tier: 0, embedAccess: true } },
      { ...paid, features: { tier: 1, embedAccess: false } },
      { ...paid, features: { tier: 1 } },
    ];
    for (const entitlement of denied) {
      for (const role of ['free', undefined] as const) {
        assert.equal(hasAccountEmbedAccess(role, entitlement, NOW), false);
      }
    }
  });

  it('does not interpret other premium authorities as Clerk PRO', () => {
    for (const role of [true, 1, 'PRO', 'tester', 'wm_123', { plan: 'pro' }, ['pro']]) {
      // @ts-expect-error Deliberate untrusted runtime input to the typed policy.
      assert.equal(hasAccountEmbedAccess(role, null, NOW), false);
    }
  });
});
