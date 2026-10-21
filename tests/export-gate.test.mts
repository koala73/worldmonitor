/**
 * U5 (plan 2026-07-25-001) — data-export gate chain.
 *
 * The resolver is a pure function over injected state so this suite needs no
 * DOM, no Convex and no Vite globals (`src/services/gates/export-resolver.ts` is a leaf
 * that imports only the zero-import `billing-state` module).
 *
 * The shape under test is KTD2's AFFIRMATIVE DENIAL chain: the gate locks only
 * on a state we affirmatively know is unentitled. Every "unknown" — auth still
 * resolving, entitlement snapshot late/failed/skipped, catalog not yet
 * probed — resolves to ALLOW. The opposite (fail-closed) shape shipped a
 * lockout bug once already (post-mortem: src/app/panel-layout.ts:710-735).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  catalogExposesProBusiness,
  isExportGateActive,
  primeExportGateActivation,
  resolveAvailableExportFormats,
  resolveExportGate,
  resolveExportLock,
  __resetExportGateActivationForTests,
  type ExportGateInputs,
} from '@/services/gates/export-resolver';

/** Signed-in free user with a loaded snapshot — the one state that must lock. */
function inputs(overrides: Partial<ExportGateInputs> = {}): ExportGateInputs {
  return {
    gateActive: true,
    desktopKeyPresent: false,
    authPending: false,
    signedIn: true,
    features: { tier: 1, dataExport: false },
    billingState: 'free',
    ...overrides,
  };
}

describe('resolveExportGate — KTD2 decision chain', () => {
  it('AE1: signed in with no entitlement snapshot yet → allowed (never over-gate)', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ features: null })),
      { locked: false, pendingActivation: false },
    );
  });

  it('AE1: auth still resolving (boot default) → allowed even before a user exists', () => {
    assert.equal(
      resolveExportGate(inputs({ authPending: true, signedIn: false, features: null })).locked,
      false,
    );
  });

  it('desktop WORLDMONITOR_API_KEY present → allowed with no snapshot and no session', () => {
    assert.equal(
      resolveExportGate(inputs({ desktopKeyPresent: true, signedIn: false, features: null })).locked,
      false,
    );
  });

  it('AE2: affirmatively signed out → locked with the anonymous reason', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ signedIn: false, features: null })),
      { locked: true, reason: 'anonymous' },
    );
  });

  it('loaded snapshot with dataExport false on a free plan → locked with the upgrade reason', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ features: { tier: 0, dataExport: false } })),
      { locked: true, reason: 'free_tier' },
    );
  });

  it('loaded snapshot with dataExport true → allowed', () => {
    assert.equal(
      resolveExportGate(inputs({ features: { tier: 1, dataExport: true } })).locked,
      false,
    );
  });

  it('AE8: dataExport undefined on a tier >= 2 row → allowed (permanent legacy fail-open)', () => {
    assert.equal(
      resolveExportGate(inputs({ features: { tier: 2 } })).locked,
      false,
    );
  });

  it('dataExport undefined on a tier 1 row → still locked (the fail-open is bounded)', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ features: { tier: 1 } })),
      { locked: true, reason: 'free_tier' },
    );
  });

  it('dataExport false on a tier >= 2 row → locked (an explicit false is never a stale row)', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ features: { tier: 2, dataExport: false } })),
      { locked: true, reason: 'free_tier' },
    );
  });
});

describe('resolveAvailableExportFormats — catalog-backed export menu', () => {
  it('uses the loaded entitlement row to expose only its declared formats', () => {
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({
        features: { tier: 1, dataExport: true, maxDashboards: 25, exportFormats: ['pdf', 'csv'] },
      })),
      ['csv', 'pdf'],
    );
  });

  it('does not turn a pre-activation or pending snapshot into an export lockout', () => {
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({ gateActive: false })),
      ['csv', 'json', 'pdf'],
    );
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({ features: null })),
      ['csv', 'json', 'pdf'],
    );
  });

  it('keeps every format for an entitled legacy row without exportFormats', () => {
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({
        features: { tier: 1, dataExport: true, maxDashboards: 25 },
      })),
      ['csv', 'json', 'pdf'],
    );
  });

  it('keeps every format for a legacy tier-2 row without dataExport', () => {
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({
        features: { tier: 2, maxDashboards: 50 },
      })),
      ['csv', 'json', 'pdf'],
    );
  });

  it('filters unsupported catalog values and cannot expose formats to a known free row', () => {
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({
        features: {
          tier: 1,
          dataExport: true,
          maxDashboards: 25,
          exportFormats: ['xlsx', 'json', 'json'],
        },
      })),
      ['json'],
    );
    assert.deepEqual(
      resolveAvailableExportFormats(inputs({
        features: { tier: 0, dataExport: false, maxDashboards: 3, exportFormats: ['csv'] },
      })),
      [],
    );
  });
});

describe('resolveExportGate — billing-aware lock reasons (#4771)', () => {
  it('AE5: a covering subscription on payment hold gets the payment reason, never an upsell', () => {
    const verdict = resolveExportGate(inputs({ billingState: 'on_hold' }));
    assert.deepEqual(verdict, { locked: true, reason: 'payment_on_hold' });
    assert.notEqual(verdict.locked && verdict.reason, 'free_tier');
  });

  it('renewal verification pending → renewal_pending', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ billingState: 'renewal_verification_pending' })),
      { locked: true, reason: 'renewal_pending' },
    );
  });

  it('renewal verification failed → renewal_failed', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ billingState: 'renewal_verification_failed' })),
      { locked: true, reason: 'renewal_failed' },
    );
  });

  it('provider-confirmed end of coverage → lapsed', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ billingState: 'lapsed' })),
      { locked: true, reason: 'lapsed' },
    );
  });

  it('billing state never overrides the anonymous reason', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ signedIn: false, billingState: 'on_hold' })),
      { locked: true, reason: 'anonymous' },
    );
  });
});

describe('resolveExportGate — catalog activation (R10)', () => {
  it('gate inactive → allowed even for a signed-in free user', () => {
    const verdict = resolveExportGate(inputs({ gateActive: false }));
    assert.equal(verdict.locked, false);
  });

  it('gate inactive but the chain would lock → reports pendingActivation so the caller probes', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ gateActive: false })),
      { locked: false, pendingActivation: true },
    );
  });

  it('gate inactive and the chain allows → no probe needed', () => {
    assert.deepEqual(
      resolveExportGate(inputs({ gateActive: false, features: { tier: 1, dataExport: true } })),
      { locked: false, pendingActivation: false },
    );
  });

  it('resolveExportLock is activation-independent (the chain alone)', () => {
    assert.equal(resolveExportLock(inputs({ gateActive: false })), 'free_tier');
    assert.equal(resolveExportLock(inputs({ features: { tier: 1, dataExport: true } })), null);
  });
});

describe('catalogExposesProBusiness — served-catalog detection', () => {
  it('detects the tier by group id', () => {
    assert.equal(catalogExposesProBusiness({ tiers: [{ name: 'Pro' }, { id: 'pro_business' }] }), true);
  });

  it('detects the tier by locale key', () => {
    assert.equal(catalogExposesProBusiness({ tiers: [{ localeKey: 'proBusiness' }] }), true);
  });

  it('detects the tier by display name', () => {
    assert.equal(catalogExposesProBusiness({ tiers: [{ name: 'Pro Business' }] }), true);
  });

  it('detects the tier by plan key', () => {
    assert.equal(catalogExposesProBusiness({ tiers: [{ planKey: 'pro_business_monthly' }] }), true);
  });

  it('returns false for a catalog without the tier', () => {
    assert.equal(
      catalogExposesProBusiness({
        tiers: [
          { name: 'Free', localeKey: 'free' },
          { name: 'Pro', localeKey: 'pro' },
          { name: 'API Starter', localeKey: 'api' },
          { name: 'Enterprise', localeKey: 'enterprise' },
        ],
      }),
      false,
    );
  });

  it('does not false-positive on marketing copy that merely mentions the tier', () => {
    assert.equal(
      catalogExposesProBusiness({
        tiers: [{ name: 'Pro', localeKey: 'pro', features: ['Upgrade to Pro Business for data export'], description: 'Pro Business coming soon' }],
      }),
      false,
    );
  });

  it('returns false for malformed payloads', () => {
    assert.equal(catalogExposesProBusiness(null), false);
    assert.equal(catalogExposesProBusiness({}), false);
    assert.equal(catalogExposesProBusiness({ tiers: 'pro_business' }), false);
    assert.equal(catalogExposesProBusiness({ tiers: [null, 42, 'pro_business'] }), false);
  });
});

/**
 * Source-grep wiring guards (the project's regression pattern): the resolver is
 * only effective if the panel wiring actually consults it, subscribes to both
 * reactive sources, and keeps the heavy exporter off the locked path.
 */
describe('setupExportPanel wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/event-handlers.ts'), 'utf8');
  const exportPanelBody = source.slice(
    source.indexOf('setupExportPanel(): void {'),
    source.indexOf('setupUnifiedSettings(): void {'),
  );

  it('extracts a non-empty setupExportPanel body', () => {
    assert.ok(exportPanelBody.length > 500, 'guard needs the real function body');
  });

  it('no longer gates on the never-written Clerk role', () => {
    assert.ok(
      !exportPanelBody.includes(`role === 'pro'`),
      'the role check hid the export button from every paying subscriber',
    );
  });

  it('routes the verdict through the shared resolver and gate action', () => {
    assert.match(exportPanelBody, /evaluateExportGate\(authState\)/);
    assert.match(exportPanelBody, /evaluateAvailableExportFormats\(authState\)/);
    assert.match(exportPanelBody, /currentExportFormats = formats/);
    assert.match(exportPanelBody, /setAvailableFormats\(currentExportFormats\)/);
    assert.match(exportPanelBody, /exportLockToGateReason\(verdict\.reason\)/);
    assert.match(exportPanelBody, /resolveGateAction\(/);
  });

  it('subscribes to BOTH auth state and entitlement changes', () => {
    assert.match(exportPanelBody, /subscribeAuthState\(\(\) => applyGate\(\)\)/);
    assert.match(exportPanelBody, /onEntitlementChange\(\(\) => applyGate\(\)\)/);
  });

  it('fires the gate metric on a locked click, not on render', () => {
    assert.match(exportPanelBody, /onOpen: \(\) => trackGateHit\('export'\)/);
  });

  it('keeps the exporter chunk lazy — locked users never fetch it', () => {
    assert.match(exportPanelBody, /import\('@\/utils\/export'\)/);
    assert.ok(
      !/^import .*from '@\/utils\/export'/m.test(source),
      'a static import would pull the exporter into the eager dashboard chunk',
    );
  });
});

describe('primeExportGateActivation — single-flight probe', () => {
  beforeEach(() => {
    __resetExportGateActivationForTests();
  });

  it('starts inactive so the gate can never lock before the catalog answers', () => {
    assert.equal(isExportGateActive(), false);
  });

  it('activates when the served catalog exposes the tier', async () => {
    const active = await primeExportGateActivation(async () => ({
      ok: true,
      json: async () => ({ tiers: [{ id: 'pro_business' }] }),
    }) as never);
    assert.equal(active, true);
    assert.equal(isExportGateActive(), true);
  });

  it('requests the public catalog without browser credentials', async () => {
    let requestInit: RequestInit | undefined;
    await primeExportGateActivation(async (_input, init) => {
      requestInit = init;
      return {
        ok: true,
        json: async () => ({ tiers: [{ id: 'pro_business' }] }),
      } as never;
    });

    assert.equal(requestInit?.credentials, 'omit');
    assert.ok(requestInit?.signal, 'the catalog timeout signal must be preserved');
  });

  it('stays inactive when the catalog lacks the tier', async () => {
    await primeExportGateActivation(async () => ({
      ok: true,
      json: async () => ({ tiers: [{ id: 'pro' }] }),
    }) as never);
    assert.equal(isExportGateActive(), false);
  });

  it('stays inactive when the probe throws (fail-open)', async () => {
    const active = await primeExportGateActivation(async () => {
      throw new Error('offline');
    });
    assert.equal(active, false);
    assert.equal(isExportGateActive(), false);
  });

  it('stays inactive on a non-ok response', async () => {
    await primeExportGateActivation(async () => ({ ok: false, json: async () => ({ tiers: [{ id: 'pro_business' }] }) }) as never);
    assert.equal(isExportGateActive(), false);
  });

  it('fetches at most once per session', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ tiers: [{ id: 'pro_business' }] }) } as never;
    };
    await Promise.all([primeExportGateActivation(probe), primeExportGateActivation(probe)]);
    await primeExportGateActivation(probe);
    assert.equal(calls, 1);
  });

  it('a transient failure is NOT cached: the next prime retries and can activate', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('startup blip');
      return { ok: true, json: async () => ({ tiers: [{ id: 'pro_business' }] }) } as never;
    };
    assert.equal(await primeExportGateActivation(flaky), false);
    assert.equal(await primeExportGateActivation(flaky), true, 'a session-long dead gate from one startup blip is the bug');
    assert.equal(isExportGateActive(), true);
    assert.equal(calls, 2);
  });

  it('a non-ok response is NOT cached either', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return (calls === 1
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ tiers: [{ id: 'pro_business' }] }) }) as never;
    };
    assert.equal(await primeExportGateActivation(probe), false);
    assert.equal(await primeExportGateActivation(probe), true);
  });

  it('a definitive "tier not served" verdict IS cached — one fetch per session', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ tiers: [{ id: 'pro' }] }) } as never;
    };
    await primeExportGateActivation(probe);
    await primeExportGateActivation(probe);
    assert.equal(calls, 1);
    assert.equal(isExportGateActive(), false);
  });
});
