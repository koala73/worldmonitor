import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryScore } from '@/services/country-instability';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

afterEach(() => {
  document.getElementById('deep-dive-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.getElementById('country-deep-dive-panel')?.remove();
});

function scoreThatThrowsWhileRendering(): CountryScore {
  return {
    code: 'IT',
    name: 'Italy',
    score: 42,
    level: 'elevated',
    trend: 'stable',
    change24h: 0,
    lastUpdated: new Date('2026-10-26T12:00:00Z'),
    get components(): CountryScore['components'] {
      throw new Error('skeleton failed after clear');
    },
  };
}

function content(): HTMLElement {
  const node = document.getElementById('deep-dive-content');
  if (!node) throw new Error('deep-dive content missing');
  return node;
}

describe('Country deep-dive open failure (#9710)', () => {
  it('renders Italy and the shell close button dismisses it', () => {
    const panel = new CountryDeepDivePanel();
    panel.show('Italy', 'IT', null, null);
    expect(panel.isVisible()).toBe(true);
    expect(panel.getCode()).toBe('IT');
    expect(content().textContent).toContain('Italy');
    expect(content().childElementCount).toBeGreaterThan(0);
    document.getElementById('deep-dive-close')!.click();
    expect(panel.isVisible()).toBe(false);
  });

  it('does not leave a blank visible panel when skeleton rendering throws after clear', () => {
    const panel = new CountryDeepDivePanel();
    panel.showLoading();
    expect(panel.isVisible()).toBe(true);
    expect(content().childElementCount).toBeGreaterThan(0);

    expect(() => panel.show('Italy', 'IT', scoreThatThrowsWhileRendering(), null)).toThrow(/skeleton failed after clear/);

    const visible = panel.isVisible();
    const blankOverlay = visible && content().childElementCount === 0;
    expect(blankOverlay).toBe(false);
    if (visible) {
      expect(content().textContent).toMatch(/failed to open/i);
      expect(panel.getCode()).toBe('__error__');
      document.getElementById('deep-dive-close')!.click();
      expect(panel.isVisible()).toBe(false);
    }
    expect(panel.isVisible() && panel.getCode() === 'IT').toBe(false);
  });
});

describe('Country brief open failure recovery (#9710)', () => {
  function openThatClearsThenThrows(initial?: { visible: boolean; code: string }) {
    let visible = initial?.visible ?? false;
    let activeCode = initial?.code ?? '';
    let hideCalls = 0;
    const renderPaused: boolean[] = [];
    const toasts: string[] = [];
    const page = {
      getCode: () => activeCode,
      hide: () => {
        hideCalls += 1;
        visible = false;
        activeCode = '';
      },
      isVisible: () => visible,
      show: () => {
        visible = true;
        activeCode = 'IT';
        throw new Error('skeleton failed after clear');
      },
      showLoading: () => {
        visible = true;
        activeCode = '__loading__';
      },
    };
    const ctx = {
      countryBriefPage: page,
      isDestroyed: false,
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
      },
    } as unknown as AppContext;
    const manager = new CountryIntelManager(ctx);
    manager.showToast = (message: string) => toasts.push(message);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
    Reflect.set(manager, 'getCountrySignals', async () => ({}));
    return { manager, renderPaused, toasts, hideCalls: () => hideCalls, isVisible: () => visible, getCode: () => activeCode };
  }

  it('closes a panel that show() left blank under the real country code and resumes the map', async () => {
    const harness = openThatClearsThenThrows();
    await harness.manager.openCountryBriefByCode('IT', 'Italy', { trackAnalytics: false });

    expect(harness.hideCalls()).toBe(1);
    expect(harness.isVisible()).toBe(false);
    expect(harness.getCode()).not.toBe('IT');
    expect(harness.renderPaused[0]).toBe(true);
    expect(harness.renderPaused[harness.renderPaused.length - 1]).toBe(false);
    expect(harness.toasts).toEqual(['Country brief failed to open. Please try again.']);
  });

  it('closes a same-country reopen that clears the open panel and throws', async () => {
    const harness = openThatClearsThenThrows({ visible: true, code: 'IT' });
    await harness.manager.openCountryBriefByCode('IT', 'Italy', { trackAnalytics: false });

    expect(harness.hideCalls()).toBe(1);
    expect(harness.isVisible()).toBe(false);
    expect(harness.renderPaused[harness.renderPaused.length - 1]).toBe(false);
    expect(harness.toasts).toEqual(['Country brief failed to open. Please try again.']);
  });

  it('closes the real panel and resumes the map when Italy skeleton rendering throws after clear', async () => {
    const panel = new CountryDeepDivePanel();
    const renderSkeleton = Reflect.get(panel, 'renderSkeleton') as (
      this: CountryDeepDivePanel,
      country: string,
      code: string,
      score: CountryScore | null,
      signals: null,
    ) => void;
    Reflect.set(panel, 'renderSkeleton', function (this: CountryDeepDivePanel, ...args: Parameters<typeof renderSkeleton>) {
      const node = document.getElementById('deep-dive-content');
      if (!node) throw new Error('deep-dive content missing');
      const original = node.replaceChildren.bind(node);
      node.replaceChildren = ((...children: Node[]) => {
        node.replaceChildren = original;
        original(...children);
        throw new Error('skeleton failed after clear');
      }) as typeof node.replaceChildren;
      renderSkeleton.apply(this, args);
    });

    const renderPaused: boolean[] = [];
    const toasts: string[] = [];
    const manager = new CountryIntelManager({
      countryBriefPage: panel,
      isDestroyed: false,
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
        clearCountryHighlight: () => {},
      },
    } as unknown as AppContext);
    manager.showToast = (message: string) => toasts.push(message);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
    Reflect.set(manager, 'getCountrySignals', async () => ({}));

    await manager.openCountryBriefByCode('IT', 'Italy', { trackAnalytics: false });

    expect(panel.isVisible()).toBe(false);
    expect(panel.getCode()).toBeNull();
    expect(document.getElementById('country-deep-dive-panel')?.classList.contains('active')).toBe(false);
    expect(renderPaused[0]).toBe(true);
    expect(renderPaused[renderPaused.length - 1]).toBe(false);
    expect(toasts).toEqual(['Country brief failed to open. Please try again.']);
  });

  it('keeps an already visible brief when a different open fails before presentation', async () => {
    let visible = true;
    let activeCode = 'FR';
    let hideCalls = 0;
    const renderPaused: boolean[] = [];
    const toasts: string[] = [];
    const page = {
      getCode: () => activeCode,
      hide: () => {
        hideCalls += 1;
        visible = false;
        activeCode = '';
      },
      isVisible: () => visible,
      show: vi.fn(),
      showLoading: () => {
        visible = true;
        activeCode = '__loading__';
      },
    };
    const manager = new CountryIntelManager({
      countryBriefPage: page,
      isDestroyed: false,
      map: { setRenderPaused: (paused: boolean) => renderPaused.push(paused) },
    } as unknown as AppContext);
    manager.showToast = (message: string) => toasts.push(message);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
    Reflect.set(manager, 'getCountrySignals', async () => {
      throw new Error('signals unavailable');
    });

    // An agent open must not replace a visible brief while it is still loading.
    await manager.openCountryBriefByCode('US', 'United States', { trackAnalytics: false, owner: 'agent' });

    expect(hideCalls).toBe(0);
    expect(visible).toBe(true);
    expect(activeCode).toBe('FR');
    expect(page.show).not.toHaveBeenCalled();
    expect(renderPaused[renderPaused.length - 1]).toBe(true);
    expect(toasts).toEqual(['Country brief failed to open. Please try again.']);
  });
});
