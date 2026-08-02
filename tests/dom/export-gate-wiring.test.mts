/**
 * T1 continued (#5634) — the two export-gate behaviours the component itself
 * does not own.
 *
 * `tests/dom/export-gate-control.test.mts` proves what `ExportGateControl`
 * renders and that it calls its injected `onAction`. But the issue also names
 * "CTA click routing through resolveGateAction" and "aria-live announcements",
 * and neither lives in the component:
 *
 *   - the CTA's real destination is decided by the `onAction` closure that
 *     `setupExportPanel` passes in, which reads `lockedReason` at CLICK time;
 *   - the unlock announcement lives in a live region `setupExportPanel` owns.
 *
 * Covered only by `tests/export-gate.test.mts`'s source greps until now
 * ("routes the verdict through the shared resolver and gate action" is an
 * `assert.match` on the function body). So this file drives the real
 * `setupExportPanel` against a minimal AppContext and asserts the composed
 * result: which URL a CTA click opens, and what the live region says.
 *
 * Only the reactive edges are stubbed — the gate verdict, the auth /
 * entitlement emitters, and `openBillingPortal` (whose real body fetches a
 * portal session). `exportLockToGateReason`, `resolveGateAction` and
 * `ExportGateControl` all run for real.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { initTestI18n, tt } from './helpers/i18n.mts';

type Verdict =
  | { locked: false; pendingActivation: boolean }
  | { locked: true; reason: string };

const verdict = vi.fn<() => Verdict>(() => ({ locked: false, pendingActivation: false }));
const availableFormats = vi.fn<() => Array<'csv' | 'json' | 'pdf'>>(() => ['csv', 'json', 'pdf']);
const trackGateHit = vi.fn<(feature: string) => void>();
/** Auth/entitlement listeners registered by setupExportPanel. */
const emitters: Array<() => void> = [];

vi.mock('@/services/gates/export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/gates/export')>()),
  evaluateExportGate: () => verdict(),
  evaluateAvailableExportFormats: () => availableFormats(),
}));

// Partial, like the others: a full replacement would silently turn any other
// auth-state export used elsewhere in the event-handlers import graph into
// `undefined`, failing later with an unrelated-looking error.
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => ({ isPending: false, user: null }),
  subscribeAuthState: (fn: () => void) => {
    emitters.push(fn);
    return () => {};
  },
}));

vi.mock('@/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/entitlements')>()),
  onEntitlementChange: (fn: () => void) => {
    emitters.push(fn);
    return () => {};
  },
}));

vi.mock('@/services/gates/export-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/gates/export-resolver')>()),
  primeExportGateActivation: async () => false,
}));

vi.mock('@/services/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/analytics')>()),
  trackGateHit: (feature: string) => trackGateHit(feature),
}));

// `resolveGateAction` runs for real here, and its PAYMENT_ON_HOLD /
// RENEWAL_FAILED branches call openBillingPortal — whose real body fetches a
// portal session. The cases below never reach those branches, but leaving the
// real function in place would arm a live network call for whoever adds them.
vi.mock('@/services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing')>()),
  openBillingPortal: async () => ({ outcome: 'opened' as const, url: 'https://portal' }),
}));

const { EventHandlerManager } = await import('@/app/event-handlers');

const PRO_ORIGIN = 'https://worldmonitor.app';

let container: HTMLElement;
let manager: InstanceType<typeof EventHandlerManager>;
let openSpy: MockInstance<typeof window.open>;
let authModalOpen: Mock<() => void>;

// `.export-panel-container` is the class of BOTH the locked gate control and
// the real ExportPanel, so the locked row is what distinguishes them — and
// `.export-option` (the format buttons) is what only the unlocked panel has.
const lockedRow = () => container.querySelector<HTMLElement>('.export-locked-state');
const lockedControl = () => lockedRow()?.closest<HTMLElement>('.export-panel-container') ?? null;
const formatOptions = () => container.querySelectorAll('.export-option');
const trigger = () => lockedControl()!.querySelector<HTMLButtonElement>('.export-btn')!;
const cta = () => lockedControl()!.querySelector<HTMLButtonElement>('.export-locked-cta')!;
const desc = () => lockedControl()!.querySelector<HTMLElement>('.export-locked-desc')!;
const liveRegion = () => container.querySelector<HTMLElement>('[aria-live="polite"]')!;

/** Push a new verdict through the auth/entitlement emitters, as production does. */
function emit(next: Verdict): void {
  verdict.mockReturnValue(next);
  for (const fn of [...emitters]) fn();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  emitters.length = 0;
  trackGateHit.mockClear();
  availableFormats.mockReset().mockReturnValue(['csv', 'json', 'pdf']);
  verdict.mockReset().mockReturnValue({ locked: false, pendingActivation: false });
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  authModalOpen = vi.fn<() => void>();

  container = document.createElement('div');
  const headerRight = document.createElement('div');
  headerRight.className = 'header-right';
  container.appendChild(headerRight);
  document.body.appendChild(container);

  const ctx = {
    container,
    isDestroyed: false,
    exportPanel: null,
    monitors: [],
    authModal: { open: authModalOpen },
  } as unknown as ConstructorParameters<typeof EventHandlerManager>[0];

  manager = new EventHandlerManager(ctx, {} as never);
});

afterEach(() => {
  // Spies are restored by `restoreMocks: true` in vitest.dom.config.mts.
  document.body.replaceChildren();
});

describe('setupExportPanel — CTA routing through resolveGateAction', () => {
  it('sends a signed-out user to the auth modal, not the pricing page', () => {
    verdict.mockReturnValue({ locked: true, reason: 'anonymous' });
    manager.setupExportPanel();

    trigger().click();
    cta().click();

    expect(authModalOpen).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('sends a free user to the pricing page', () => {
    verdict.mockReturnValue({ locked: true, reason: 'free_tier' });
    manager.setupExportPanel();

    trigger().click();
    cta().click();

    expect(openSpy).toHaveBeenCalledWith(`${PRO_ORIGIN}/pro`, '_blank', 'noopener,noreferrer');
    expect(authModalOpen).not.toHaveBeenCalled();
  });

  it('routes a lapsed subscriber to the reactivation anchor, never a bare upsell', () => {
    verdict.mockReturnValue({ locked: true, reason: 'lapsed' });
    manager.setupExportPanel();

    trigger().click();
    cta().click();

    expect(openSpy).toHaveBeenCalledWith(
      `${PRO_ORIGIN}/pro#pricing`,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('uses the reason live at CLICK time, not the one captured when the control was built', () => {
    // The control is long-lived and `onAction` closes over `lockedReason`, so a
    // billing state that resolves while the menu sits open must change where
    // the CTA goes. Getting this wrong sends a lapsed subscriber into the
    // sign-in modal they are already past.
    verdict.mockReturnValue({ locked: true, reason: 'anonymous' });
    manager.setupExportPanel();
    trigger().click();

    emit({ locked: true, reason: 'lapsed' });
    expect(desc().textContent).toBe(tt('components.billingState.lapsedDesc'));

    cta().click();

    expect(openSpy).toHaveBeenCalledWith(
      `${PRO_ORIGIN}/pro#pricing`,
      '_blank',
      'noopener,noreferrer',
    );
    expect(authModalOpen).not.toHaveBeenCalled();
  });

  it('fires the gate-hit metric on a locked open, never on render', () => {
    verdict.mockReturnValue({ locked: true, reason: 'free_tier' });
    manager.setupExportPanel();
    expect(trackGateHit).not.toHaveBeenCalled();

    trigger().click();

    expect(trackGateHit).toHaveBeenCalledWith('export');
  });
});

describe('setupExportPanel — aria-live announcements', () => {
  it('uses the newest entitlement formats when the exporter chunk resolves after an update', async () => {
    manager.setupExportPanel();
    availableFormats.mockReturnValue(['json']);
    emit({ locked: false, pendingActivation: false });

    await vi.waitFor(() => expect(formatOptions().length).toBeGreaterThan(0), { timeout: 5000 });

    expect(container.querySelector<HTMLButtonElement>('[data-format="json"]')!.hidden).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-format="csv"]')!.hidden).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-format="pdf"]')!.hidden).toBe(true);
  });

  it('updates formats after an unlocked exporter is already attached', async () => {
    manager.setupExportPanel();
    await vi.waitFor(() => expect(formatOptions().length).toBeGreaterThan(0), { timeout: 5000 });

    availableFormats.mockReturnValue(['json']);
    emit({ locked: false, pendingActivation: false });

    expect(container.querySelector<HTMLButtonElement>('[data-format="json"]')!.hidden).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-format="csv"]')!.hidden).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-format="pdf"]')!.hidden).toBe(true);
  });

  it('puts the live region in the accessibility tree empty, before anything is announced', () => {
    // An aria-live region only announces content injected AFTER it is in the
    // tree — creating it together with its message announces nothing.
    manager.setupExportPanel();

    expect(liveRegion()).not.toBeNull();
    expect(liveRegion().textContent).toBe('');
    expect(liveRegion().getAttribute('role')).toBe('status');
    expect(liveRegion().isConnected).toBe(true);
  });

  it('announces the unlock when a locked session becomes entitled', async () => {
    verdict.mockReturnValue({ locked: true, reason: 'free_tier' });
    manager.setupExportPanel();
    expect(lockedRow()).not.toBeNull();

    emit({ locked: false, pendingActivation: false });
    // The unlock path lazy-imports the exporter chunk before announcing.
    // Explicit timeout: the default is ~1s, and this awaits a lazy
    // import('@/utils/export') whose first Vite transform on a cold CI runner
    // can approach it. A flake here blocks every PR in the repo, because
    // dom-tests is in deploy-gate's required list.
    await vi.waitFor(() => expect(liveRegion().textContent).not.toBe(''), { timeout: 5000 });

    expect(liveRegion().textContent).toBe(tt('components.exportGate.unlockedAnnouncement'));
    // The locked row is gone and the real format options took its place.
    expect(lockedRow()).toBeNull();
    expect(formatOptions().length).toBeGreaterThan(0);
  });

  it('stays silent for a session that was never locked', async () => {
    // Announcing on every entitlement emission would interrupt a screen-reader
    // user who never hit the gate at all.
    manager.setupExportPanel();

    emit({ locked: false, pendingActivation: false });
    await vi.waitFor(() => expect(formatOptions().length).toBeGreaterThan(0), { timeout: 5000 });

    expect(liveRegion().textContent).toBe('');
  });
});
