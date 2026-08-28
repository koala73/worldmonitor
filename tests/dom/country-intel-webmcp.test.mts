import { describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';

describe('CountryIntelManager WebMCP presentation cancellation', () => {
  it('removes the loading shell and never presents after an in-flight abort', async () => {
    let visible = false;
    let activeCode = '';
    let loadingCalls = 0;
    let hideCalls = 0;
    let showCalls = 0;
    let presentedCalls = 0;
    const renderPaused: boolean[] = [];
    const toasts: string[] = [];
    const page = {
      getCode: () => activeCode,
      hide: () => {
        hideCalls += 1;
        visible = false;
      },
      isVisible: () => visible,
      show: () => {
        showCalls += 1;
        visible = true;
        activeCode = 'US';
      },
      showLoading: () => {
        loadingCalls += 1;
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

    let markSignalsRequested!: () => void;
    const signalsRequested = new Promise<void>((resolve) => {
      markSignalsRequested = resolve;
    });
    let resolveSignals!: (value: unknown) => void;
    const heldSignals = new Promise<unknown>((resolve) => {
      resolveSignals = resolve;
    });
    Reflect.set(manager, 'getCountrySignals', () => {
      markSignalsRequested();
      return heldSignals;
    });

    const controller = new AbortController();
    const pendingOpen = manager.openCountryBriefByCode('US', 'United States', {
      onPresented: () => { presentedCalls += 1; },
      signal: controller.signal,
      trackAnalytics: false,
    });
    await signalsRequested;
    controller.abort();

    await expect(pendingOpen).rejects.toBe(controller.signal.reason);
    resolveSignals({});
    await Promise.resolve();

    expect(loadingCalls).toBe(1);
    expect(hideCalls).toBe(1);
    expect(showCalls).toBe(0);
    expect(presentedCalls).toBe(0);
    expect(renderPaused).toEqual([true, false]);
    expect(toasts).toEqual([]);
  });

  it('keeps an existing country brief visible when a different country open is aborted', async () => {
    let visible = true;
    let activeCode = 'FR';
    let loadingCalls = 0;
    let hideCalls = 0;
    let showCalls = 0;
    let presentedCalls = 0;
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
      show: (_country: string, code: string) => {
        showCalls += 1;
        visible = true;
        activeCode = code;
      },
      showLoading: () => {
        loadingCalls += 1;
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

    let markSignalsRequested!: () => void;
    const signalsRequested = new Promise<void>((resolve) => {
      markSignalsRequested = resolve;
    });
    let resolveSignals!: (value: unknown) => void;
    const heldSignals = new Promise<unknown>((resolve) => {
      resolveSignals = resolve;
    });
    Reflect.set(manager, 'getCountrySignals', () => {
      markSignalsRequested();
      return heldSignals;
    });

    const controller = new AbortController();
    const pendingOpen = manager.openCountryBriefByCode('US', 'United States', {
      onPresented: () => { presentedCalls += 1; },
      signal: controller.signal,
      trackAnalytics: false,
    });
    await signalsRequested;
    controller.abort();

    await expect(pendingOpen).rejects.toBe(controller.signal.reason);
    resolveSignals({});
    await Promise.resolve();

    expect(loadingCalls).toBe(0);
    expect(hideCalls).toBe(0);
    expect(showCalls).toBe(0);
    expect(presentedCalls).toBe(0);
    expect(visible).toBe(true);
    expect(activeCode).toBe('FR');
    expect(renderPaused).toEqual([true]);
    expect(toasts).toEqual([]);
  });

  it('does not let a cancellable agent preempt a pending human country open', async () => {
    let visible = false;
    let activeCode = '';
    let stopAfterPresentation = false;
    let loadingCalls = 0;
    let hideCalls = 0;
    let agentPresentedCalls = 0;
    const shownCodes: string[] = [];
    const requestedCodes: string[] = [];
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
      show: (_country: string, code: string) => {
        shownCodes.push(code);
        visible = true;
        activeCode = code;
        stopAfterPresentation = true;
      },
      showLoading: () => {
        loadingCalls += 1;
        visible = true;
        activeCode = '__loading__';
      },
    };
    const ctx = {
      countryBriefPage: page,
      get isDestroyed() { return stopAfterPresentation; },
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
      },
    } as unknown as AppContext;
    const manager = new CountryIntelManager(ctx);
    manager.showToast = (message: string) => toasts.push(message);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);

    let markHumanSignalsRequested!: () => void;
    const humanSignalsRequested = new Promise<void>((resolve) => {
      markHumanSignalsRequested = resolve;
    });
    let resolveHumanSignals!: (value: unknown) => void;
    const heldHumanSignals = new Promise<unknown>((resolve) => {
      resolveHumanSignals = resolve;
    });
    Reflect.set(manager, 'getCountrySignals', (code: string) => {
      requestedCodes.push(code);
      if (code === 'FR') {
        markHumanSignalsRequested();
        return heldHumanSignals;
      }
      return Promise.resolve({});
    });

    const humanOpen = manager.openCountryBriefByCode('FR', 'France', {
      trackAnalytics: false,
    });
    await humanSignalsRequested;

    const controller = new AbortController();
    const agentOpen = manager.openCountryBriefByCode('US', 'United States', {
      onPresented: () => { agentPresentedCalls += 1; },
      signal: controller.signal,
      trackAnalytics: false,
    });
    controller.abort();
    await agentOpen;

    resolveHumanSignals({});
    await humanOpen;

    expect(loadingCalls).toBe(1);
    expect(hideCalls).toBe(0);
    expect(shownCodes).toEqual(['FR']);
    expect(requestedCodes).toEqual(['FR']);
    expect(agentPresentedCalls).toBe(0);
    expect(visible).toBe(true);
    expect(activeCode).toBe('FR');
    expect(renderPaused).toEqual([true]);
    expect(toasts).toEqual([]);
    expect(Reflect.get(manager, 'briefRequestToken')).toBe(1);
    expect(Reflect.get(manager, 'pendingBriefRequest')).toBeNull();
  });

  it('keeps human ownership while coordinate lookup resolves to a country', async () => {
    let visible = false;
    let activeCode = '';
    let stopAfterPresentation = false;
    let loadingCalls = 0;
    let hideCalls = 0;
    let agentPresentedCalls = 0;
    const shownCodes: string[] = [];
    const requestedCodes: string[] = [];
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
      show: (_country: string, code: string) => {
        shownCodes.push(code);
        visible = true;
        activeCode = code;
        stopAfterPresentation = true;
      },
      showLoading: () => {
        loadingCalls += 1;
        visible = true;
        activeCode = '__loading__';
      },
    };
    const ctx = {
      countryBriefPage: page,
      get isDestroyed() { return stopAfterPresentation; },
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
      },
    } as unknown as AppContext;
    const manager = new CountryIntelManager(ctx);
    manager.showToast = (message: string) => toasts.push(message);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
    Reflect.set(manager, 'getCountrySignals', (code: string) => {
      requestedCodes.push(code);
      return Promise.resolve({});
    });

    let markLookupRequested!: () => void;
    const lookupRequested = new Promise<void>((resolve) => {
      markLookupRequested = resolve;
    });
    let resolveLookup!: (response: Response) => void;
    const heldLookup = new Promise<Response>((resolve) => {
      resolveLookup = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      markLookupRequested();
      return heldLookup;
    });

    const humanOpen = manager.openCountryBrief(0.123, -140.456);
    await lookupRequested;

    const controller = new AbortController();
    const agentOpen = manager.openCountryBriefByCode('US', 'United States', {
      onPresented: () => { agentPresentedCalls += 1; },
      signal: controller.signal,
      trackAnalytics: false,
    });
    controller.abort();
    await agentOpen;

    resolveLookup(new Response(JSON.stringify({
      country: 'France',
      code: 'FR',
      displayName: 'France',
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));
    await humanOpen;

    expect(loadingCalls).toBe(1);
    expect(hideCalls).toBe(0);
    expect(shownCodes).toEqual(['FR']);
    expect(requestedCodes).toEqual(['FR']);
    expect(agentPresentedCalls).toBe(0);
    expect(visible).toBe(true);
    expect(activeCode).toBe('FR');
    expect(renderPaused).toEqual([true]);
    expect(toasts).toEqual([]);
    expect(Reflect.get(manager, 'briefRequestToken')).toBe(1);
    expect(Reflect.get(manager, 'pendingBriefRequest')).toBeNull();
  });

  it('still lets a human request preempt a pending agent open', async () => {
    let visible = false;
    let activeCode = '';
    let stopAfterHumanPresentation = false;
    let hideCalls = 0;
    const shownCodes: string[] = [];
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
      show: (_country: string, code: string) => {
        shownCodes.push(code);
        visible = true;
        activeCode = code;
        if (code === 'FR') stopAfterHumanPresentation = true;
      },
      showLoading: () => {
        visible = true;
        activeCode = '__loading__';
      },
    };
    const ctx = {
      countryBriefPage: page,
      get isDestroyed() { return stopAfterHumanPresentation; },
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
      },
    } as unknown as AppContext;
    const manager = new CountryIntelManager(ctx);
    manager.showToast = (message: string) => toasts.push(message);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);

    let markAgentSignalsRequested!: () => void;
    const agentSignalsRequested = new Promise<void>((resolve) => {
      markAgentSignalsRequested = resolve;
    });
    let resolveAgentSignals!: (value: unknown) => void;
    const heldAgentSignals = new Promise<unknown>((resolve) => {
      resolveAgentSignals = resolve;
    });
    Reflect.set(manager, 'getCountrySignals', (code: string) => {
      if (code === 'US') {
        markAgentSignalsRequested();
        return heldAgentSignals;
      }
      return Promise.resolve({});
    });

    const controller = new AbortController();
    const agentOpen = manager.openCountryBriefByCode('US', 'United States', {
      signal: controller.signal,
      trackAnalytics: false,
    });
    await agentSignalsRequested;

    await manager.openCountryBriefByCode('FR', 'France', {
      trackAnalytics: false,
    });
    controller.abort();
    await expect(agentOpen).rejects.toBe(controller.signal.reason);
    resolveAgentSignals({});
    await Promise.resolve();

    expect(hideCalls).toBe(0);
    expect(shownCodes).toEqual(['FR']);
    expect(visible).toBe(true);
    expect(activeCode).toBe('FR');
    expect(renderPaused).toEqual([true, true]);
    expect(toasts).toEqual([]);
    expect(Reflect.get(manager, 'briefRequestToken')).toBe(2);
    expect(Reflect.get(manager, 'pendingBriefRequest')).toBeNull();
  });

  it('does not let an explicit no-signal agent replace a visible human brief', async () => {
    let visible = false;
    let activeCode = '';
    let destroyedAfterHumanPresentation = false;
    let loadingCalls = 0;
    let agentPresentedCalls = 0;
    const shownCodes: string[] = [];
    const requestedCodes: string[] = [];
    const page = {
      getCode: () => activeCode,
      hide: () => { visible = false; activeCode = ''; },
      isVisible: () => visible,
      show: (_country: string, code: string) => {
        shownCodes.push(code);
        visible = true;
        activeCode = code;
        if (code === 'FR') destroyedAfterHumanPresentation = true;
      },
      showLoading: () => {
        loadingCalls += 1;
        visible = true;
        activeCode = '__loading__';
      },
    };
    const ctx = {
      countryBriefPage: page,
      get isDestroyed() { return destroyedAfterHumanPresentation; },
      map: { setRenderPaused: () => {} },
    } as unknown as AppContext;
    const manager = new CountryIntelManager(ctx);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
    Reflect.set(manager, 'getCountrySignals', async (code: string) => {
      requestedCodes.push(code);
      return {};
    });

    await manager.openCountryBriefByCode('FR', 'France', {
      owner: 'human',
      trackAnalytics: false,
    });
    destroyedAfterHumanPresentation = false;

    await manager.openCountryBriefByCode('US', 'United States', {
      onPresented: () => { agentPresentedCalls += 1; },
      owner: 'agent',
      trackAnalytics: false,
    });

    expect(loadingCalls).toBe(1);
    expect(shownCodes).toEqual(['FR']);
    expect(requestedCodes).toEqual(['FR']);
    expect(agentPresentedCalls).toBe(0);
    expect(visible).toBe(true);
    expect(activeCode).toBe('FR');
  });

  it('invalidates a held coordinate lookup before teardown can be mutated', async () => {
    let destroyed = false;
    let visible = false;
    let activeCode = '';
    let loadingCalls = 0;
    let hideCalls = 0;
    let showCalls = 0;
    const renderPaused: boolean[] = [];
    const page = {
      getCode: () => activeCode,
      hide: () => {
        hideCalls += 1;
        visible = false;
        activeCode = '';
      },
      isVisible: () => visible,
      show: () => {
        showCalls += 1;
        visible = true;
        activeCode = 'FR';
      },
      showLoading: () => {
        loadingCalls += 1;
        visible = true;
        activeCode = '__loading__';
      },
    };
    const ctx = {
      countryBriefPage: page,
      countryTimeline: null,
      get isDestroyed() { return destroyed; },
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
      },
    } as unknown as AppContext;
    const manager = new CountryIntelManager(ctx);
    Reflect.set(manager, 'ensureCountryBriefPage', async () => true);

    let markLookupRequested!: () => void;
    const lookupRequested = new Promise<void>((resolve) => {
      markLookupRequested = resolve;
    });
    let resolveLookup!: (response: Response) => void;
    const heldLookup = new Promise<Response>((resolve) => {
      resolveLookup = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      markLookupRequested();
      return heldLookup;
    });

    const pendingOpen = manager.openCountryBrief(-0.321, -141.654);
    await lookupRequested;
    expect(loadingCalls).toBe(1);
    expect(renderPaused).toEqual([true]);

    destroyed = true;
    manager.destroy();
    resolveLookup(new Response(JSON.stringify({
      country: 'France',
      code: 'FR',
      displayName: 'France',
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));
    await pendingOpen;

    expect(showCalls).toBe(0);
    expect(hideCalls).toBe(0);
    expect(loadingCalls).toBe(1);
    expect(renderPaused).toEqual([true]);
    expect(ctx.countryBriefPage).toBeNull();
    expect(Reflect.get(manager, 'briefRequestToken')).toBe(2);
    expect(Reflect.get(manager, 'pendingBriefRequest')).toBeNull();
  });
});
