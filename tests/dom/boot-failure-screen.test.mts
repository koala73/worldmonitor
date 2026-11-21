// Runtime proof of the fatal boot-failure screen (src/bootstrap/boot-failure.ts):
// rendered by the main.ts boot .catch when app.init() rejects, over whatever
// half-initialised DOM the failed boot left behind. The screen must be
// self-contained (no app code, no i18n, no stylesheet), must render the error
// message as text (never markup), must reload on its one action, and must be
// idempotent so a re-entered boot path cannot stack overlays.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderBootFailureScreen } from '@/bootstrap/boot-failure';

const screen = () => document.getElementById('wm-boot-failure');

describe('renderBootFailureScreen', () => {
  let reloadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The pre-render skeleton a failed boot typically leaves in place.
    document.body.innerHTML = '<div id="app"><div class="skeleton-shell">Dashboard is loading</div></div>';
    reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  });

  afterEach(() => {
    reloadSpy.mockRestore();
    document.body.replaceChildren();
  });

  it('covers the page with a branded alert and a working Reload button', () => {
    renderBootFailureScreen(new Error('bootstrap fetch failed'));

    const overlay = screen();
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('role')).toBe('alert');
    // Full-viewport cover over the dead skeleton, opaque and dark.
    expect(overlay!.style.position).toBe('fixed');
    expect(overlay!.style.inset).toMatch(/^0(px)?$/);
    expect(overlay!.style.background).toContain('#050807');

    expect(overlay!.textContent).toContain('The dashboard couldn’t start');
    expect(overlay!.textContent).toContain('bootstrap fetch failed');

    const reload = overlay!.querySelector('button');
    expect(reload?.textContent).toBe('Reload the dashboard');
    reload!.click();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('renders the error detail as text, never as markup', () => {
    renderBootFailureScreen(new Error('<img src=x onerror=alert(1)> boom'));

    expect(screen()!.querySelector('img')).toBeNull();
    expect(screen()!.textContent).toContain('<img src=x onerror=alert(1)> boom');
  });

  it('describes non-Error rejection values and truncates runaway messages', () => {
    renderBootFailureScreen('plain string rejection');
    expect(screen()!.textContent).toContain('plain string rejection');
    screen()!.remove();

    renderBootFailureScreen(new Error('x'.repeat(500)));
    const detail = screen()!.textContent ?? '';
    expect(detail).toContain(`${'x'.repeat(239)}…`);
    expect(detail).not.toContain('x'.repeat(241));
  });

  it('makes the dead dashboard underneath inert so keyboard focus stays on the screen', () => {
    // A failure after layout render leaves header controls in place; teardown
    // does not remove them.
    document.body.innerHTML = '<div id="app"><header><button id="leftover">Settings</button></header></div><div id="toast-root"></div>';

    renderBootFailureScreen(new Error('late init failure'));

    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true);
    expect(document.getElementById('toast-root')!.hasAttribute('inert')).toBe(true);
    expect(screen()!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(screen()!.querySelector('button'));
  });

  it('is idempotent: a second render leaves the first screen in place', () => {
    renderBootFailureScreen(new Error('first failure'));
    renderBootFailureScreen(new Error('second failure'));

    expect(document.querySelectorAll('#wm-boot-failure')).toHaveLength(1);
    expect(screen()!.textContent).toContain('first failure');
    expect(screen()!.textContent).not.toContain('second failure');
  });
});
