/**
 * T1 (#5634) — DOM-behavioral coverage for `ExportGateControl`.
 *
 * Before this file the locked export control was covered only by
 * source-extraction assertions in `tests/export-gate.test.mts`
 * ("setupExportPanel wiring"), which can go green with the rendered markup
 * broken. What is asserted here is what a locked user actually gets: the copy
 * in the menu, the ARIA the control exposes, when the gate-hit metric fires,
 * and that the CTA runs the injected action.
 *
 * The copy is compared against the real `en.json` strings via the shared
 * i18next singleton — see `helpers/i18n.mts` for why an uninitialised
 * i18next would otherwise make every one of these assertions a false pass.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ExportGateControl } from '@/components/ExportGateControl';
import { PanelGateReason } from '@/services/panel-gating';

import { initTestI18n, tt } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

/** Every reason a locked export control can be constructed with. */
const LOCKED_REASONS = [
  {
    reason: PanelGateReason.ANONYMOUS,
    desc: 'components.exportGate.signedOutDesc',
    cta: 'premium.signIn',
    icon: 'lock',
  },
  {
    reason: PanelGateReason.FREE_TIER,
    desc: 'components.exportGate.upgradeDesc',
    cta: 'components.exportGate.upgradeCta',
    icon: 'upgrade',
  },
  {
    reason: PanelGateReason.PAYMENT_ON_HOLD,
    desc: 'components.billingState.onHoldDesc',
    cta: 'components.billingState.updatePayment',
    icon: 'lock',
  },
  {
    reason: PanelGateReason.RENEWAL_PENDING,
    desc: 'components.billingState.renewalPendingDesc',
    cta: 'components.billingState.refreshStatus',
    icon: 'lock',
  },
  {
    reason: PanelGateReason.RENEWAL_FAILED,
    desc: 'components.billingState.renewalFailedDesc',
    cta: 'components.billingState.manageBilling',
    icon: 'lock',
  },
  {
    reason: PanelGateReason.LAPSED,
    desc: 'components.billingState.lapsedDesc',
    cta: 'components.billingState.resubscribe',
    icon: 'upgrade',
  },
] as const;

interface Harness {
  control: ExportGateControl;
  el: HTMLElement;
  onOpen: Mock<() => void>;
  onAction: Mock<() => void>;
}

const live: ExportGateControl[] = [];

function mount(reason: PanelGateReason): Harness {
  const onOpen = vi.fn<() => void>();
  const onAction = vi.fn<() => void>();
  const control = new ExportGateControl({ reason, onOpen, onAction });
  live.push(control);
  const el = control.getElement();
  document.body.appendChild(el);
  return { control, el, onOpen, onAction };
}

const trigger = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.export-btn')!;
const menu = (el: HTMLElement) => el.querySelector<HTMLElement>('.export-menu')!;
const ctaOf = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.export-locked-cta')!;
const descOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.export-locked-desc')!;
const iconOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.export-locked-icon')!;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  // destroy() detaches the document-level click listener; leaking one across
  // tests would let an earlier control close a later one's menu.
  while (live.length) live.pop()?.destroy();
  document.body.replaceChildren();
});

describe('ExportGateControl — rendered locked state', () => {
  it.each(LOCKED_REASONS)(
    '$reason renders its own reason copy and CTA',
    ({ reason, desc, cta, icon }) => {
      const { el } = mount(reason);

      expect(descOf(el).textContent).toBe(tt(desc));
      expect(ctaOf(el).textContent).toBe(tt(cta));

      // lockSvg is a padlock (<rect> body), upgradeSvg is a circled arrow.
      const iconEl = iconOf(el);
      expect(iconEl.querySelector('svg')).not.toBeNull();
      expect(iconEl.querySelector('rect') !== null).toBe(icon === 'lock');
      expect(iconEl.querySelector('circle') !== null).toBe(icon === 'upgrade');
    },
  );

  it('gives each reason distinct, non-empty copy', () => {
    // Guards the failure mode this suite exists to catch: if the dictionary
    // silently stops resolving, every desc collapses to the same value and
    // the per-reason assertions above all still "pass".
    const descs = LOCKED_REASONS.map(({ reason }) => descOf(mount(reason).el).textContent);
    const ctas = LOCKED_REASONS.map(({ reason }) => ctaOf(mount(reason).el).textContent);

    for (const value of [...descs, ...ctas]) {
      expect(value).toBeTruthy();
      expect(value).not.toMatch(/^components\./);
    }
    expect(new Set(descs).size).toBe(LOCKED_REASONS.length);
  });

  it('renders exactly one locked row — never the format options a locked user must not get', () => {
    const { el } = mount(PanelGateReason.FREE_TIER);

    expect(menu(el).querySelectorAll('.export-locked-state')).toHaveLength(1);
    expect(menu(el).querySelectorAll('.export-option')).toHaveLength(0);
  });

  it('starts closed, with the menu hidden', () => {
    const { el } = mount(PanelGateReason.FREE_TIER);

    expect(menu(el).classList.contains('hidden')).toBe(true);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ExportGateControl — ARIA contract', () => {
  it('announces the lock reason on the trigger rather than hiding the control', () => {
    const { el } = mount(PanelGateReason.PAYMENT_ON_HOLD);

    expect(trigger(el).getAttribute('aria-label')).toBe(
      tt('components.exportGate.lockedAriaLabel', {
        reason: tt('components.billingState.onHoldDesc'),
      }),
    );
    // The reason must be IN the label, not just adjacent to it.
    expect(trigger(el).getAttribute('aria-label')).toContain(
      tt('components.billingState.onHoldDesc'),
    );
  });

  it('marks the trigger as a dialog opener and tracks expansion', () => {
    const { el } = mount(PanelGateReason.FREE_TIER);

    expect(trigger(el).getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');

    trigger(el).click();
    expect(trigger(el).getAttribute('aria-expanded')).toBe('true');

    trigger(el).click();
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('re-labels the trigger when the reason changes mid-session', () => {
    const { control, el } = mount(PanelGateReason.FREE_TIER);

    control.update(PanelGateReason.LAPSED);

    expect(trigger(el).getAttribute('aria-label')).toContain(
      tt('components.billingState.lapsedDesc'),
    );
  });
});

describe('ExportGateControl — gate-hit metric', () => {
  it('does not fire on render: a control nobody reached for is not a gate hit', () => {
    const { onOpen } = mount(PanelGateReason.FREE_TIER);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('fires once per open, and never on close', () => {
    const { el, onOpen } = mount(PanelGateReason.FREE_TIER);

    trigger(el).click();
    expect(onOpen).toHaveBeenCalledTimes(1);

    trigger(el).click(); // close
    expect(onOpen).toHaveBeenCalledTimes(1);

    trigger(el).click(); // re-open
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('does not fire when a re-render happens while the menu is open', () => {
    const { control, el, onOpen } = mount(PanelGateReason.FREE_TIER);

    trigger(el).click();
    control.update(PanelGateReason.LAPSED);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('ExportGateControl — CTA routing', () => {
  it('runs the injected action and closes the menu', () => {
    const { el, onAction } = mount(PanelGateReason.ANONYMOUS);
    trigger(el).click();

    ctaOf(el).click();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(menu(el).classList.contains('hidden')).toBe(true);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('routes through the CTA rebuilt by update(), not the reason captured at construction', () => {
    // The control is long-lived: billing state can flip under an open menu.
    // A CTA still wired to the old row would send an on-hold customer to the
    // pricing page instead of the billing portal.
    const { control, el, onAction } = mount(PanelGateReason.ANONYMOUS);
    control.update(PanelGateReason.RENEWAL_FAILED);
    trigger(el).click();

    expect(ctaOf(el).textContent).toBe(tt('components.billingState.manageBilling'));
    ctaOf(el).click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('ExportGateControl — open/close behaviour', () => {
  it('closes on a click outside the control', () => {
    const { el } = mount(PanelGateReason.FREE_TIER);
    trigger(el).click();
    expect(menu(el).classList.contains('hidden')).toBe(false);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.click();

    expect(menu(el).classList.contains('hidden')).toBe(true);
  });

  it('stays open when the click lands inside the menu', () => {
    const { el } = mount(PanelGateReason.FREE_TIER);
    trigger(el).click();

    descOf(el).click();

    expect(menu(el).classList.contains('hidden')).toBe(false);
  });

  it('update() to the same reason does not rebuild the menu', () => {
    const { control, el } = mount(PanelGateReason.FREE_TIER);
    const before = ctaOf(el);

    control.update(PanelGateReason.FREE_TIER);

    expect(ctaOf(el)).toBe(before);
  });

  it('update() to a new reason swaps the copy in place', () => {
    const { control, el } = mount(PanelGateReason.FREE_TIER);
    const before = ctaOf(el);

    control.update(PanelGateReason.PAYMENT_ON_HOLD);

    expect(ctaOf(el)).not.toBe(before);
    expect(descOf(el).textContent).toBe(tt('components.billingState.onHoldDesc'));
  });
});

describe('ExportGateControl — teardown', () => {
  it('removes its element and the document listener it registered', () => {
    type Listener = EventListenerOrEventListenerObject;
    const added: Array<[string, Listener]> = [];
    const removed: Array<[string, Listener]> = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);

    const addSpy = vi.spyOn(document, 'addEventListener').mockImplementation(((
      type: string,
      handler: Listener,
      options?: boolean | AddEventListenerOptions,
    ) => {
      added.push([type, handler]);
      realAdd(type, handler, options);
    }) as typeof document.addEventListener);
    const removeSpy = vi.spyOn(document, 'removeEventListener').mockImplementation(((
      type: string,
      handler: Listener,
      options?: boolean | EventListenerOptions,
    ) => {
      removed.push([type, handler]);
      realRemove(type, handler, options);
    }) as typeof document.removeEventListener);

    const { control, el } = mount(PanelGateReason.FREE_TIER);
    const registered = added.filter(([type]) => type === 'click');
    expect(registered).toHaveLength(1);

    control.destroy();

    expect(el.isConnected).toBe(false);
    // Reference identity, not shape: removeEventListener with a re-bound copy
    // of the handler silently leaves the original attached, which is the
    // classic listener leak this assertion exists to catch.
    const removedClickHandlers = removed.filter(([type]) => type === 'click').map(([, fn]) => fn);
    expect(removedClickHandlers).toContain(registered[0]![1]);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('a destroyed control no longer reacts to outside clicks', () => {
    const { control, el } = mount(PanelGateReason.FREE_TIER);
    trigger(el).click();

    control.destroy();
    // Re-attach the (now inert) element so contains() still resolves — this
    // isolates "the listener is gone" from "the node left the tree".
    document.body.appendChild(el);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.click();

    // Still open: the listener is gone, so nothing closed it.
    expect(menu(el).classList.contains('hidden')).toBe(false);
  });
});
