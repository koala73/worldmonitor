/**
 * Pure-resolver tests for buildUsageIdentity().
 *
 * The resolver maps gateway-internal auth state to the four telemetry identity
 * fields (auth_kind, principal_id, customer_id, tier). It is intentionally
 * pure — no JWT verification, no key hashing of secrets, no I/O — so the
 * branch matrix is trivially testable here.
 */

import { describe, expect, test } from 'vitest';

import { buildUsageIdentity, type UsageIdentityInput } from '../_shared/usage-identity';

function baseInput(overrides: Partial<UsageIdentityInput> = {}): UsageIdentityInput {
  return {
    sessionUserId: null,
    isUserApiKey: false,
    enterpriseApiKey: null,
    widgetKey: null,
    clerkOrgId: null,
    userApiKeyCustomerRef: null,
    tier: null,
    ...overrides,
  };
}

describe('buildUsageIdentity — auth_kind branches', () => {
  test('user_api_key takes precedence over every other signal', () => {
    const ident = buildUsageIdentity(baseInput({
      isUserApiKey: true,
      sessionUserId: 'user_123',
      userApiKeyCustomerRef: 'customer_abc',
      enterpriseApiKey: 'should-be-ignored',
      widgetKey: 'should-be-ignored',
      tier: 2,
    }));
    expect(ident.auth_kind).toBe('user_api_key');
    expect(ident.principal_id).toBe('user_123');
    expect(ident.customer_id).toBe('customer_abc');
    expect(ident.tier).toBe(2);
  });

  test('user_api_key falls back to sessionUserId for customer_id when no explicit ref', () => {
    const ident = buildUsageIdentity(baseInput({
      isUserApiKey: true,
      sessionUserId: 'user_123',
      tier: 1,
    }));
    expect(ident.customer_id).toBe('user_123');
  });

  test('clerk_jwt: customer_id prefers org over user when org is present', () => {
    const ident = buildUsageIdentity(baseInput({
      sessionUserId: 'user_123',
      clerkOrgId: 'org_acme',
      tier: 1,
    }));
    expect(ident.auth_kind).toBe('clerk_jwt');
    expect(ident.principal_id).toBe('user_123');
    expect(ident.customer_id).toBe('org_acme');
    expect(ident.tier).toBe(1);
  });

  test('clerk_jwt: customer_id falls back to user when no org', () => {
    const ident = buildUsageIdentity(baseInput({
      sessionUserId: 'user_123',
    }));
    expect(ident.customer_id).toBe('user_123');
    expect(ident.tier).toBe(0);
  });

  test('enterprise_api_key: principal_id is hashed, not raw', () => {
    const ident = buildUsageIdentity(baseInput({
      enterpriseApiKey: 'wm_super_secret_key',
      tier: 3,
    }));
    expect(ident.auth_kind).toBe('enterprise_api_key');
    expect(ident.principal_id).not.toBe('wm_super_secret_key');
    expect(ident.principal_id).toMatch(/^[0-9a-z]+$/);
    // Customer is the unmapped sentinel until a real entry is added to ENTERPRISE_KEY_TO_CUSTOMER
    expect(ident.customer_id).toBe('enterprise-unmapped');
    expect(ident.tier).toBe(3);
  });

  test('widget_key: customer_id is the widget key itself, principal_id is hashed', () => {
    const ident = buildUsageIdentity(baseInput({
      widgetKey: 'widget_pub_xyz',
    }));
    expect(ident.auth_kind).toBe('widget_key');
    expect(ident.customer_id).toBe('widget_pub_xyz');
    expect(ident.principal_id).not.toBe('widget_pub_xyz');
    expect(ident.principal_id).toMatch(/^[0-9a-z]+$/);
    expect(ident.tier).toBe(0);
  });

  test('anon: every field null, tier always zero', () => {
    const ident = buildUsageIdentity(baseInput());
    expect(ident.auth_kind).toBe('anon');
    expect(ident.principal_id).toBeNull();
    expect(ident.customer_id).toBeNull();
    expect(ident.tier).toBe(0);
  });

  test('anon: tier coerces to 0 even if input.tier was set (defensive)', () => {
    // No identity signal but a leftover tier value should not show up as a mystery free row.
    const ident = buildUsageIdentity(baseInput({ tier: 99 }));
    expect(ident.tier).toBe(0);
  });
});

describe('buildUsageIdentity — tier handling', () => {
  test('null tier coerces to 0 for non-anon kinds', () => {
    const ident = buildUsageIdentity(baseInput({ sessionUserId: 'u', tier: null }));
    expect(ident.tier).toBe(0);
  });

  test('zero tier is preserved (not promoted)', () => {
    const ident = buildUsageIdentity(baseInput({ sessionUserId: 'u', tier: 0 }));
    expect(ident.tier).toBe(0);
  });

  test('integer tiers pass through unchanged', () => {
    for (const t of [0, 1, 2, 3]) {
      const ident = buildUsageIdentity(baseInput({ sessionUserId: 'u', tier: t }));
      expect(ident.tier).toBe(t);
    }
  });
});

describe('buildUsageIdentity — secret handling', () => {
  test('enterprise key never appears verbatim in any output field', () => {
    const secret = 'wm_ent_LEAKY_VALUE_DO_NOT_LOG';
    const ident = buildUsageIdentity(baseInput({ enterpriseApiKey: secret }));
    expect(JSON.stringify(ident)).not.toContain(secret);
  });

  test('widget key appears as customer_id (intentional — widget keys are public)', () => {
    // Widget keys are embeds installed on third-party sites; treating them as
    // customer attribution is the contract documented in usage-identity.ts:73-79.
    const ident = buildUsageIdentity(baseInput({ widgetKey: 'widget_public_xyz' }));
    expect(ident.customer_id).toBe('widget_public_xyz');
  });
});
