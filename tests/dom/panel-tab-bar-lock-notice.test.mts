/**
 * T4 (#5634) — DOM regression coverage for `PanelTabBar`'s cap-locked notice.
 *
 * The stale-popover fix shipped in the Pro Business review-fix commit with
 * pure-function witnesses only: `tests/tab-cap.test.mts` proves `resolveTabCap`
 * returns the right verdict and greps panel-layout's source for the wiring,
 * but nothing exercised the notice itself. The bug it fixed is invisible to
 * both: an OPEN notice carries the reason and the `onAction` closure captured
 * when it opened, so a lock that changes underneath it (anonymous → signed-in
 * free, or free → payment-on-hold) leaves the user reading stale copy and
 * clicking into the wrong destination.
 *
 * These tests drive the notice through the real DOM and assert what survives
 * a lock change.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PanelTabBar, tabCapGateCopy, type TabAddLock } from '@/components/PanelTabBar';
import { PanelGateReason } from '@/services/panel-gating';
import type { PanelTab, TabsState } from '@/services/tab-store';

import { initTestI18n, tt } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const FREE_CAP = 3;

function tab(id: string, name: string): PanelTab {
  return { id, name, panelSettings: {}, panelOrder: [], bottomSet: [] };
}

function lockFor(reason: PanelGateReason, onAction: Mock<() => void> = vi.fn<() => void>()): TabAddLock {
  return { copy: tabCapGateCopy(reason, FREE_CAP), onAction };
}

let state: TabsState;
let bar: PanelTabBar;
let callbacks: {
  onSelect: Mock<(tabId: string) => void>;
  onAdd: Mock<() => void>;
  onRename: Mock<(tabId: string, name: string) => void>;
  onDelete: Mock<(tabId: string) => void>;
};

const addBtn = () => bar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-add')!;
const notice = () => document.querySelector<HTMLElement>('.tab-cap-notice');
const noticeDesc = () => notice()?.querySelector<HTMLElement>('.tab-cap-notice-desc') ?? null;
const noticeCta = () => notice()?.querySelector<HTMLButtonElement>('.tab-cap-notice-cta') ?? null;
const liveRegion = () => bar.getElement().querySelector<HTMLElement>('[aria-live="polite"]')!;

beforeEach(() => {
  document.body.replaceChildren();
  state = { activeTabId: 'a', tabs: [tab('a', 'Main'), tab('b', 'Markets')] };
  callbacks = {
    onSelect: vi.fn<(tabId: string) => void>(),
    onAdd: vi.fn<() => void>(),
    onRename: vi.fn<(tabId: string, name: string) => void>(),
    onDelete: vi.fn<(tabId: string) => void>(),
  };
  bar = new PanelTabBar(() => state, callbacks);
  document.body.appendChild(bar.getElement());
});

afterEach(() => {
  // destroy() must also take the body-anchored notice with it — see the
  // teardown test below.
  bar.destroy();
  document.body.replaceChildren();
});

describe('PanelTabBar — cap-locked "+" at rest', () => {
  it('stays a plain "+" when locked: only the aria-label changes', () => {
    const before = { className: addBtn().className, text: addBtn().textContent };

    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));

    expect(addBtn().className).toBe(before.className);
    expect(addBtn().textContent).toBe(before.text);
    expect(addBtn().disabled).toBe(false);
    expect(addBtn().getAttribute('aria-label')).toBe(
      tt('components.tabCap.lockedAriaLabel', {
        reason: tabCapGateCopy(PanelGateReason.FREE_TIER, FREE_CAP).desc,
      }),
    );
  });

  it('restores the neutral aria-label when the lock clears', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.setAddLock(null);

    expect(addBtn().getAttribute('aria-label')).toBe(tt('dashboardTabs.addTab'));
  });

  it('never touches existing tabs — the cap blocks creation only', () => {
    bar.setAddLock(lockFor(PanelGateReason.ANONYMOUS));

    expect(bar.getElement().querySelectorAll('.dashboard-tab')).toHaveLength(2);
    expect(bar.getElement().querySelectorAll('.dashboard-tab-close')).toHaveLength(2);
  });

  it('still routes the click to the manager, which is the single enforcement point', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));

    addBtn().click();

    expect(callbacks.onAdd).toHaveBeenCalledTimes(1);
  });
});

describe('PanelTabBar — locked notice', () => {
  it('does nothing when the control is not locked', () => {
    bar.showAddLockNotice();

    expect(notice()).toBeNull();
  });

  it('renders the reason and CTA anchored to the body, not inside the scrolling bar', () => {
    const copy = tabCapGateCopy(PanelGateReason.ANONYMOUS, FREE_CAP);
    bar.setAddLock(lockFor(PanelGateReason.ANONYMOUS));

    bar.showAddLockNotice();

    expect(noticeDesc()!.textContent).toBe(copy.desc);
    expect(noticeCta()!.textContent).toBe(copy.cta);
    // Body-anchored: an in-flow popover would be clipped by the bar's
    // overflow-x: auto.
    expect(notice()!.parentElement).toBe(document.body);
    expect(bar.getElement().contains(notice())).toBe(false);
  });

  it('ties the CTA to the reason so a screen reader hears why before the label', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    const describedBy = noticeCta()!.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(notice()!.querySelector(`#${describedBy}`)).toBe(noticeDesc());
  });

  it('moves focus to the CTA when it opens', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    expect(document.activeElement).toBe(noticeCta());
  });

  it('never stacks two notices', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));

    bar.showAddLockNotice();
    bar.showAddLockNotice();

    expect(document.querySelectorAll('.tab-cap-notice')).toHaveLength(1);
  });

  it('runs the lock action and closes on CTA click', () => {
    const onAction = vi.fn();
    bar.setAddLock(lockFor(PanelGateReason.LAPSED, onAction));
    bar.showAddLockNotice();

    noticeCta()!.click();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(notice()).toBeNull();
  });

  it('closes on an outside mousedown', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(notice()).toBeNull();
  });

  it('does not close on a mousedown inside the notice', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    noticeDesc()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(notice()).not.toBeNull();
  });

  it('does not close on a mousedown on the "+" itself', () => {
    // The "+" reopens the notice on click; closing it on mousedown first would
    // make the second click a toggle-off the user never asked for.
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    addBtn().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(notice()).not.toBeNull();
  });

  it('closes on Escape and returns focus to the "+"', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(addBtn());
  });

  it('ignores other keys', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(notice()).not.toBeNull();
  });

  it('takes the notice with it on destroy — no orphaned popover on the body', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    bar.destroy();

    expect(notice()).toBeNull();
  });
});

describe('PanelTabBar — stale notice on a lock change (the T4 regression)', () => {
  it('closes an open notice when the lock copy changes underneath it', () => {
    bar.setAddLock(lockFor(PanelGateReason.ANONYMOUS));
    bar.showAddLockNotice();
    expect(noticeDesc()!.textContent).toBe(
      tabCapGateCopy(PanelGateReason.ANONYMOUS, FREE_CAP).desc,
    );

    // Sign-in lands: same cap, different reason.
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));

    expect(notice()).toBeNull();
  });

  it('rebuilds from the NEW lock on the next open — copy and action both', () => {
    const anonAction = vi.fn();
    const holdAction = vi.fn();
    bar.setAddLock(lockFor(PanelGateReason.ANONYMOUS, anonAction));
    bar.showAddLockNotice();

    bar.setAddLock(lockFor(PanelGateReason.PAYMENT_ON_HOLD, holdAction));
    bar.showAddLockNotice();

    expect(noticeDesc()!.textContent).toBe(tt('components.billingState.onHoldDesc'));
    noticeCta()!.click();
    expect(holdAction).toHaveBeenCalledTimes(1);
    expect(anonAction).not.toHaveBeenCalled();
  });

  it('closes the notice and announces politely when the cap lifts', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    bar.setAddLock(null);

    expect(notice()).toBeNull();
    expect(liveRegion().textContent).toBe(tt('components.tabCap.unlockedAnnouncement'));
    expect(liveRegion().getAttribute('role')).toBe('status');
  });

  it('does not announce an unlock that never happened', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.setAddLock(lockFor(PanelGateReason.LAPSED));

    expect(liveRegion().textContent).toBe('');
  });

  it('leaves an open notice alone on a repeat verdict', () => {
    // Gating re-fires on every auth/entitlement/subscription emission, most
    // with an unchanged verdict. Closing on those would make the notice
    // flicker shut while the user is reading it.
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    bar.showAddLockNotice();

    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));

    expect(notice()).not.toBeNull();
  });
});

describe('tabCapGateCopy — per-reason copy', () => {
  it.each([
    [PanelGateReason.PAYMENT_ON_HOLD, 'components.billingState.onHoldDesc', 'components.billingState.updatePayment'],
    [PanelGateReason.RENEWAL_PENDING, 'components.billingState.renewalPendingDesc', 'components.billingState.refreshStatus'],
    [PanelGateReason.RENEWAL_FAILED, 'components.billingState.renewalFailedDesc', 'components.billingState.manageBilling'],
    [PanelGateReason.LAPSED, 'components.billingState.lapsedDesc', 'components.billingState.resubscribe'],
  ])('%s reuses the shared billing copy — a paying customer never sees an upsell', (reason, desc, cta) => {
    const copy = tabCapGateCopy(reason, FREE_CAP);

    expect(copy.desc).toBe(tt(desc));
    expect(copy.cta).toBe(tt(cta));
    expect(copy.cta).not.toBe(tt('components.tabCap.upgradeCta'));
  });

  it('interpolates the live cap into the signed-out and upgrade copy', () => {
    for (const reason of [PanelGateReason.ANONYMOUS, PanelGateReason.FREE_TIER]) {
      const copy = tabCapGateCopy(reason, FREE_CAP);
      expect(copy.desc).toContain(String(FREE_CAP));
      expect(copy.desc).not.toContain('{{cap}}');
    }
  });

  it('tracks the cap it is given rather than hard-coding the free tier', () => {
    expect(tabCapGateCopy(PanelGateReason.FREE_TIER, 10).desc).toContain('10');
  });
});
