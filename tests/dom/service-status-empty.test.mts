import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import { fetchServiceStatuses } from '@/services/infrastructure';
import { initTestI18n, tt } from './helpers/i18n.mts';
vi.mock('@/services/infrastructure', () => ({ fetchServiceStatuses: vi.fn() }));
beforeAll(initTestI18n);
let panel: ServiceStatusPanel;
afterEach(() => { panel?.destroy(); document.body.replaceChildren(); });
it('shows unavailable, then observed operational status, retains last-good, then neutral empty category', async () => {
  panel = new ServiceStatusPanel(); document.body.append(panel.getElement());
  vi.mocked(fetchServiceStatuses).mockResolvedValue({success:true,timestamp:'',summary:{operational:0,degraded:0,outage:0,unknown:0},services:[]});
  await panel.fetchStatus();
  expect(document.body.textContent).toContain(tt('common.failedToLoad'));
  expect(document.querySelector('.all-operational')).toBeNull();
  vi.mocked(fetchServiceStatuses).mockResolvedValue({success:true,timestamp:'',summary:{operational:1,degraded:0,outage:0,unknown:0},services:[{id:'aws',name:'AWS',category:'cloud',status:'operational',description:''}]});
  await panel.fetchStatus();
  expect(document.querySelector('.all-operational')).not.toBeNull();
  vi.mocked(fetchServiceStatuses).mockResolvedValue({success:true,timestamp:'',summary:{operational:0,degraded:0,outage:0,unknown:0},services:[]});
  await panel.fetchStatus();
  expect(document.querySelector('.all-operational')).not.toBeNull();
  expect(document.body.textContent).toContain('AWS');
  (document.querySelector('[data-filter="ai"]') as HTMLButtonElement).click();
  expect(document.querySelector('.all-operational')).toBeNull();
  expect(document.body.textContent).toContain(tt('common.noDataAvailable'));
});

it('leaves rendered services untouched and logs nothing when a refresh signal aborts', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    panel = new ServiceStatusPanel(); document.body.append(panel.getElement());
    vi.mocked(fetchServiceStatuses).mockResolvedValueOnce({
      success: true, timestamp: '', summary: { operational: 1, degraded: 0, outage: 0, unknown: 0 },
      services: [{ id: 'aws', name: 'AWS', category: 'cloud', status: 'operational', description: '' }],
    });
    await panel.fetchStatus();
    expect(document.body.textContent).toContain('AWS');

    const controller = new AbortController();
    vi.mocked(fetchServiceStatuses).mockImplementationOnce((sig?: AbortSignal) => new Promise((_resolve, reject) => {
      sig?.addEventListener('abort', () => reject(sig.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = panel.fetchStatus(controller.signal);
    controller.abort(new DOMException('Refresh lane lease expired', 'AbortError'));
    const changed = await pending;

    expect(changed).toBe(false);
    expect(document.body.textContent).toContain('AWS');
    expect(document.body.textContent).not.toContain(tt('common.failedToLoad'));
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

it('removes abort listeners on settlement and still aborts mid-flight on caller abort or panel destroy', async () => {
  const originalAny = AbortSignal.any;
  Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const trackAbortListeners = (sig: AbortSignal) => {
      const active = new Set<EventListenerOrEventListenerObject>();
      const origAdd = sig.addEventListener.bind(sig);
      const origRemove = sig.removeEventListener.bind(sig);
      let added = 0;
      vi.spyOn(sig, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'abort' && listener) {
          added += 1;
          active.add(listener);
        }
        return origAdd(type, listener, options);
      });
      vi.spyOn(sig, 'removeEventListener').mockImplementation((type, listener, options) => {
        if (type === 'abort' && listener) {
          active.delete(listener);
        }
        return origRemove(type, listener, options);
      });
      return { active, getAdded: () => added };
    };

    panel = new ServiceStatusPanel();
    document.body.append(panel.getElement());
    const panelSignal = (panel as unknown as { signal: AbortSignal }).signal;
    const panelTracker = trackAbortListeners(panelSignal);

    const okPayload = {
      success: true,
      timestamp: '',
      summary: { operational: 1, degraded: 0, outage: 0, unknown: 0 },
      services: [{ id: 'aws', name: 'AWS', category: 'cloud' as const, status: 'operational' as const, description: '' }],
    };

    // Repeated successful refreshes must clean up listeners on both signals.
    const callerController = new AbortController();
    const callerTracker = trackAbortListeners(callerController.signal);
    vi.mocked(fetchServiceStatuses).mockResolvedValue(okPayload);
    for (let i = 0; i < 3; i++) {
      await panel.fetchStatus(callerController.signal);
    }
    expect(panelTracker.getAdded()).toBe(3);
    expect(callerTracker.getAdded()).toBe(3);
    expect(panelTracker.active.size).toBe(0);
    expect(callerTracker.active.size).toBe(0);

    // Mid-flight caller abort propagates reason and removes the panel signal listener.
    const abortReason = new DOMException('Scheduler cancelled', 'AbortError');
    let observedCallerReason: unknown;
    vi.mocked(fetchServiceStatuses).mockImplementationOnce((sig?: AbortSignal) => new Promise((_resolve, reject) => {
      sig?.addEventListener('abort', () => {
        observedCallerReason = sig.reason;
        reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const pendingCallerAbort = panel.fetchStatus(callerController.signal);
    callerController.abort(abortReason);
    expect(await pendingCallerAbort).toBe(false);
    expect(observedCallerReason).toBe(abortReason);
    expect(panelTracker.active.size).toBe(0);

    // Mid-flight panel.destroy() aborts the request and removes the caller signal listener.
    const destroyCallerController = new AbortController();
    const destroyCallerTracker = trackAbortListeners(destroyCallerController.signal);
    let destroyedAborted = false;
    vi.mocked(fetchServiceStatuses).mockImplementationOnce((sig?: AbortSignal) => new Promise((_resolve, reject) => {
      sig?.addEventListener('abort', () => {
        destroyedAborted = true;
        reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const pendingDestroy = panel.fetchStatus(destroyCallerController.signal);
    panel.destroy();
    expect(await pendingDestroy).toBe(false);
    expect(destroyedAborted).toBe(true);
    expect(destroyCallerTracker.active.size).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(AbortSignal, 'any', { value: originalAny, configurable: true, writable: true });
    errorSpy.mockRestore();
  }
});
