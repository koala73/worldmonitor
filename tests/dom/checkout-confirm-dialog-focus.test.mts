/**
 * The checkout confirm dialog says aria-modal="true", so Tab and Shift+Tab
 * must stay on its buttons. Opened from Settings (the Pro Business upgrade,
 * Pro Yearly and API Starter switches), focus escaping it lands on Settings
 * controls behind the backdrop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showCheckoutConfirmDialog } from '@/services/checkout-dialog-factory';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

function pressTab(shiftKey = false): void {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(event);
  // jsdom has no default Tab action: emulate the browser moving focus when the trap did not.
  if (event.defaultPrevented) return;
  const all = [...document.querySelectorAll<HTMLElement>('button')];
  const i = all.indexOf(document.activeElement as HTMLElement);
  all[(i + (shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
}

async function openDialog(onDismiss = () => {}) {
  const behind = document.createElement('button');
  behind.textContent = 'Settings control';
  document.body.appendChild(behind);
  behind.focus();
  showCheckoutConfirmDialog({
    id: 'focus-test-dialog',
    title: 'Upgrade to Pro Business',
    body: 'Quote',
    confirmLabel: 'Upgrade now',
    dismissLabel: 'Not now',
    onConfirm: () => {},
    onDismiss,
  });
  await nextFrame();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const button = (label: string) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === label)!;
  return { behind, dialog, confirm: button('Upgrade now'), dismiss: button('Not now') };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('showCheckoutConfirmDialog focus', () => {
  it('opens with focus on the confirm button', async () => {
    const { confirm } = await openDialog();
    expect(document.activeElement).toBe(confirm);
  });

  it('keeps Tab and Shift+Tab on the dialog buttons', async () => {
    const { dialog } = await openDialog();
    for (let i = 0; i < 4; i++) {
      pressTab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      pressTab(true);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('still dismisses on Escape, once', async () => {
    const onDismiss = vi.fn();
    await openDialog(onDismiss);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('releases Tab once dismissed, and the caller may move focus after', async () => {
    let focusedByCaller: Element | null = null;
    const target = document.createElement('button');
    const { behind, dismiss } = await openDialog(() => { target.focus(); focusedByCaller = document.activeElement; });
    document.body.appendChild(target);
    dismiss.click();
    expect(focusedByCaller).toBe(target);
    expect(document.activeElement).toBe(target);
    behind.focus();
    pressTab();
    expect(document.activeElement).not.toBe(behind);
  });
});
