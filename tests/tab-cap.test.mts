/**
 * U6 (plan 2026-07-25-001, KTD8) — dashboard tab cap.
 *
 * `resolveTabCap` is a pure function over injected state, so this suite needs
 * no DOM, no Convex and no Vite globals — it shares the `src/services/gates/
 * export-resolver.ts` leaf with U5 (which imports only the zero-import
 * `billing-state` module).
 *
 * The cap follows KTD2's AFFIRMATIVE DENIAL chain verbatim: only a state we
 * affirmatively know is capped blocks creation. Auth still resolving, a late /
 * failed / skipped entitlement snapshot, or a catalog that has not yet exposed
 * a purchasable Pro Business group all resolve to UNCAPPED.
 *
 * The cap is also CREATION-ONLY. Nothing here — and nothing in `addTab` — may
 * prune or hide a tab that already exists: a user who accumulated 14 tabs on a
 * 10-dashboard plan keeps all 14 (AE4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FREE_TAB_CAP,
  resolveTabCap,
  type ExportGateInputs,
} from '@/services/gates/export-resolver';

/** Signed-in free user with a loaded snapshot — the baseline capped state. */
function inputs(overrides: Partial<ExportGateInputs> = {}): ExportGateInputs {
  return {
    gateActive: true,
    desktopKeyPresent: false,
    authPending: false,
    signedIn: true,
    features: { tier: 0, dataExport: false, maxDashboards: 3 },
    billingState: 'free',
    ...overrides,
  };
}

const PRO = { tier: 1, dataExport: false, maxDashboards: 10 };
const PRO_BUSINESS = { tier: 1, dataExport: true, maxDashboards: 25 };

describe('resolveTabCap — KTD8 cap resolution', () => {
  it('AE3: free snapshot at 3 tabs → blocked with the upgrade reason', () => {
    assert.deepEqual(
      resolveTabCap(inputs(), 3),
      { allowed: false, cap: 3, reason: 'free_tier' },
    );
  });

  it('AE3: free snapshot below the cap → allowed', () => {
    assert.deepEqual(
      resolveTabCap(inputs(), 2),
      { allowed: true, cap: 3, pendingActivation: false },
    );
  });

  it('AE4: pro snapshot with 14 existing tabs → blocked, and the verdict never asks for a prune', () => {
    const verdict = resolveTabCap(inputs({ features: PRO }), 14);
    assert.deepEqual(verdict, { allowed: false, cap: 10, reason: 'free_tier' });
    // Creation-only: the verdict carries no removal instruction of any kind.
    assert.deepEqual(
      Object.keys(verdict).sort(),
      ['allowed', 'cap', 'reason'],
      'a prune/trim field would let a caller retroactively delete a user\'s tabs',
    );
  });

  it('AE4: the 10th tab is still creatable on pro (the cap is a ceiling, not an off-by-one)', () => {
    assert.equal(resolveTabCap(inputs({ features: PRO }), 9).allowed, true);
    assert.equal(resolveTabCap(inputs({ features: PRO }), 10).allowed, false);
  });

  it('pro_business snapshot → cap 25', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ features: PRO_BUSINESS }), 24),
      { allowed: true, cap: 25, pendingActivation: false },
    );
    assert.deepEqual(
      resolveTabCap(inputs({ features: PRO_BUSINESS }), 25),
      { allowed: false, cap: 25, reason: 'free_tier' },
    );
  });

  it('auth still resolving (the boot default) → uncapped, whatever the tab count', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ authPending: true, signedIn: false, features: null }), 99),
      { allowed: true, cap: null, pendingActivation: false },
    );
  });

  it('affirmatively signed out → the free cap of 3, with the anonymous reason', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ signedIn: false, features: null }), 3),
      { allowed: false, cap: 3, reason: 'anonymous' },
    );
    assert.equal(
      resolveTabCap(inputs({ signedIn: false, features: null }), 2).allowed,
      true,
    );
  });

  it('signed in with no entitlement snapshot yet → uncapped (never over-gate on a late snapshot)', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ features: null }), 40),
      { allowed: true, cap: null, pendingActivation: false },
    );
  });

  it('desktop WORLDMONITOR_API_KEY present → uncapped with no session and no snapshot', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ desktopKeyPresent: true, signedIn: false, features: null }), 99),
      { allowed: true, cap: null, pendingActivation: false },
    );
  });

  it('the unlimited sentinel (-1, Enterprise) → uncapped', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ features: { tier: 3, dataExport: true, maxDashboards: -1 } }), 500),
      { allowed: true, cap: null, pendingActivation: false },
    );
  });

  it('a malformed row with no numeric allowance → uncapped (an unknown is never locked)', () => {
    assert.equal(
      resolveTabCap(
        inputs({ features: { tier: 1, dataExport: true } as never }),
        99,
      ).allowed,
      true,
    );
  });

  it('stored-but-stale cap: the cap tracks the ROW, not the current catalog value', () => {
    // A Pro row written before the catalog raised the allowance. The read-time
    // merge does not backfill (KTD5), so the stored value is authoritative.
    const stale = { tier: 1, dataExport: false, maxDashboards: 5 };
    assert.deepEqual(
      resolveTabCap(inputs({ features: stale }), 5),
      { allowed: false, cap: 5, reason: 'free_tier' },
    );
    assert.equal(resolveTabCap(inputs({ features: stale }), 4).allowed, true);
  });
});

describe('resolveTabCap — catalog activation (R10)', () => {
  it('gate inactive → always allowed, whatever the count', () => {
    assert.equal(resolveTabCap(inputs({ gateActive: false }), 3).allowed, true);
    assert.equal(resolveTabCap(inputs({ gateActive: false, features: PRO }), 99).allowed, true);
  });

  it('gate inactive at the cap → reports pendingActivation so the caller probes the catalog', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ gateActive: false }), 3),
      { allowed: true, cap: 3, pendingActivation: true },
    );
  });

  it('gate inactive below the cap → no probe needed', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ gateActive: false }), 1),
      { allowed: true, cap: 3, pendingActivation: false },
    );
  });
});

describe('resolveTabCap — billing-aware lock reasons (#4771)', () => {
  it('a covering subscription on payment hold gets the payment reason, never an upsell', () => {
    const verdict = resolveTabCap(inputs({ features: PRO, billingState: 'on_hold' }), 10);
    assert.deepEqual(verdict, { allowed: false, cap: 10, reason: 'payment_on_hold' });
    assert.notEqual(verdict.allowed === false && verdict.reason, 'free_tier');
  });

  it('renewal verification pending → renewal_pending', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ billingState: 'renewal_verification_pending' }), 3),
      { allowed: false, cap: 3, reason: 'renewal_pending' },
    );
  });

  it('renewal verification failed → renewal_failed', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ billingState: 'renewal_verification_failed' }), 3),
      { allowed: false, cap: 3, reason: 'renewal_failed' },
    );
  });

  it('provider-confirmed end of coverage → lapsed', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ billingState: 'lapsed' }), 3),
      { allowed: false, cap: 3, reason: 'lapsed' },
    );
  });

  it('billing state never overrides the anonymous reason', () => {
    assert.deepEqual(
      resolveTabCap(inputs({ signedIn: false, features: null, billingState: 'on_hold' }), 3),
      { allowed: false, cap: 3, reason: 'anonymous' },
    );
  });
});

describe('FREE_TAB_CAP — catalog drift guard', () => {
  it('matches FREE_FEATURES.maxDashboards in the product catalog', () => {
    const catalog = readFileSync(resolve(process.cwd(), 'convex/config/productCatalog.ts'), 'utf8');
    const freeBlock = catalog.slice(
      catalog.indexOf('const FREE_FEATURES'),
      catalog.indexOf('const PRO_FEATURES'),
    );
    const match = /maxDashboards:\s*(\d+)/.exec(freeBlock);
    assert.ok(match, 'FREE_FEATURES should declare maxDashboards');
    assert.equal(
      FREE_TAB_CAP,
      Number(match![1]),
      'the signed-out cap must track the catalog free allowance',
    );
  });
});

/**
 * Source-grep wiring guards (the project's regression pattern): a correct
 * resolver only bites if the tab bar actually consults it, re-evaluates on
 * BOTH reactive sources, and never removes an existing tab.
 *
 * KNOWN WEAKNESS — these are source greps, and a source grep goes green on a
 * name existing in a file; it never drives the decision (see docs/solutions/
 * logic-errors/playback-control-gated-on-a-clerk-role-field-with-no-writer.md).
 * The `addTab` and re-evaluation guards below survive only because replacing
 * them needs a live `PanelLayoutManager`, and nothing can mount one today: its
 * constructor pulls 49 imports and runs checkout-return handling plus
 * ProActivationController on the way up, so a DOM harness for it is its own
 * piece of work rather than a line-item in a refactor. Tracked in #5892.
 *
 * Do NOT re-point these at a new path if the code moves — build the harness
 * and delete them, the way #5813 replaced the allowance-forwarding greps with
 * tests/dom/gate-reader-forwarding.test.mts.
 */
describe('tab-cap wiring', () => {
  const panelLayout = readFileSync(resolve(process.cwd(), 'src/app/panel-layout.ts'), 'utf8');

  const addTabBody = panelLayout.slice(
    panelLayout.indexOf('private addTab(): void {'),
    panelLayout.indexOf('private renameTab('),
  );
  const gatingBody = panelLayout.slice(
    panelLayout.indexOf('private updatePanelGating(state: AuthSession): void {'),
    panelLayout.indexOf('private static isMobileMapCollapsedPreferred()'),
  );

  it('extracts non-empty function bodies', () => {
    assert.ok(addTabBody.length > 200, 'guard needs the real addTab body');
    assert.ok(gatingBody.length > 500, 'guard needs the real updatePanelGating body');
  });

  it('addTab resolves the cap and returns before creating anything', () => {
    assert.match(addTabBody, /updateTabCapLock\(\)/);
    assert.match(addTabBody, /if \(!verdict\.allowed\)/);
    assert.match(addTabBody, /showAddLockNotice\(\)/);
    assert.match(addTabBody, /trackGateHit\('dashboard-tab'\)/);
  });

  it('addTab never prunes or trims existing tabs', () => {
    for (const forbidden of ['splice(', '.slice(0,', '.pop()', '.shift()']) {
      assert.ok(
        !addTabBody.includes(forbidden),
        `addTab must not ${forbidden} — the cap is creation-only (AE4)`,
      );
    }
  });

  it('the cap re-evaluates on BOTH auth and entitlement emissions', () => {
    // updatePanelGating is the single gating pass; it is driven by
    // subscribeAuthState AND onEntitlementChange (the auth-only-subscription
    // bug is documented in this file at the proBlock wiring). Entitlement
    // emissions now flow through the reload controller so a null auth-handoff
    // snapshot is not collapsed to a false entitlement transition.
    assert.match(gatingBody, /this\.updateTabCapLock\(\)/);
    assert.match(panelLayout, /subscribeAuthState\(\(state\) => \{\s*this\.updatePanelGating\(state\);/);
    assert.match(
      panelLayout,
      /onSnapshot:\s*\(\) => this\.updatePanelGating\(getAuthState\(\)\)/,
    );
    assert.match(
      panelLayout,
      /onEntitlementChange\(\(state\) => \{[\s\S]*?entitlementReloadController\.handleSnapshot\(/,
    );
  });

  // The allowance-forwarding guard that used to live here was two greps over
  // panel-gating.ts's source text. #5813 moved the reader into
  // `src/services/gates/export.ts` and made it module-private; the guarantee is
  // now proven behaviourally, by calling the real `evaluateTabCap` against a
  // stubbed entitlement snapshot — see tests/dom/gate-reader-forwarding.test.mts.

  // The two PanelTabBar greps that used to close this block are gone (#5813).
  // They asserted that `components.tabCap.lockedAriaLabel`,
  // `components.tabCap.unlockedAnnouncement`, `aria-live'/'polite'`,
  // `setAddLock(` and `showAddLockNotice(` appear somewhere in the component's
  // source. tests/dom/panel-tab-bar-lock-notice.test.mts already proves all
  // five behaviourally and strictly more strongly — it asserts the rendered
  // aria-label VALUE, the live region's actual announcement text and
  // role="status", selects the region by [aria-live="polite"], and calls both
  // methods for real. A grep that a name exists adds nothing on top of a test
  // that drives it.
});
