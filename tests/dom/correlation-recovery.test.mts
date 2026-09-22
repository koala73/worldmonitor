import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvergenceCard, CorrelationDomain } from '@/services/correlation-engine';
import type { CorrelationSnapshotState } from '@/services/correlation-snapshots';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), hydrate: vi.fn(), slowTier: vi.fn(), read: vi.fn(), write: vi.fn(),
  deduct: vi.fn(), premium: vi.fn(), sentry: vi.fn(),
}));
vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: mocks.sentry }));
vi.mock('@/services/generated-rpc-clients', () => ({
  IntelligenceServiceClient: class { deductSituation = mocks.deduct; },
}));
vi.mock('@/services/panel-gating', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: mocks.premium,
}));
vi.mock('@/services/bootstrap', () => ({
  ensureHydrated: mocks.fetch,
  getHydratedData: mocks.hydrate,
  waitForBootstrapSlowTier: mocks.slowTier,
}));
vi.mock('@/services/persistent-cache', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/persistent-cache')>(),
  getPersistentCache: mocks.read,
  setPersistentCache: mocks.write,
}));

const NOW = Date.parse('2026-09-14T03:00:00Z');
const MINUTE = 60_000;
let service: typeof import('@/services/correlation-snapshots');
let stops: Array<() => void>;

function card(domain: CorrelationDomain = 'economic', title = 'Sanctions activity'): ConvergenceCard {
  return {
    id: domain, domain, title, score: 42, timestamp: NOW - MINUTE,
    countries: ['US'], trend: 'stable',
    signals: [{ type: 'sanctions', source: 'fixture', severity: 40, timestamp: NOW - MINUTE, label: 'Test signal' }],
  };
}

function payload(economic: unknown = [card()], computedAt = NOW - MINUTE) {
  return { computedAt, military: [], escalation: [], economic, disaster: [] };
}

function saved(cards: ConvergenceCard[] = [card()], computedAt = NOW - 10 * MINUTE) {
  return { data: { economic: { cards, computedAt, origin: 'seed' } }, updatedAt: NOW };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function watch(domain: CorrelationDomain = 'economic') {
  const states: CorrelationSnapshotState[] = [];
  const stop = service.subscribeCorrelationSnapshot(domain, state => states.push(state));
  stops.push(stop);
  return { states, stop, latest: () => states[states.length - 1]! };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(25);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  // Happy DOM's frame scheduling is independent of the fake timeout clock.
  // Route paints through that clock so suite load cannot delay the assertion.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 1)));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.setSystemTime(NOW);
  stops = [];
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.fetch.mockResolvedValue(payload());
  mocks.hydrate.mockReturnValue(undefined);
  mocks.slowTier.mockResolvedValue(true);
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(undefined);
  mocks.premium.mockReturnValue(true);
  mocks.deduct.mockResolvedValue({ analysis: 'Premium narrative for displayed evidence' });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  service = await import('@/services/correlation-snapshots');
});

afterEach(() => {
  stops.forEach(stop => stop());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('correlation snapshot recovery', () => {
  it('shares one request across domains and treats a valid empty domain as success', async () => {
    const economic = watch();
    const military = watch('military');
    watch('disaster');
    watch('escalation');
    await settle();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('correlationCards');
    expect(economic.latest().snapshot?.cards).toHaveLength(1);
    expect(military.latest()).toEqual({ status: 'current', offline: false, snapshot: { cards: [], computedAt: NOW - MINUTE, origin: 'seed' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps saved cards on a failed first request and replaces them after automatic recovery', async () => {
    mocks.read.mockResolvedValue(saved());
    mocks.fetch.mockResolvedValueOnce(undefined).mockResolvedValueOnce(payload([], NOW + 15_000));
    const result = watch();
    await settle();
    expect(result.latest().status).toBe('updating');
    expect(result.latest().snapshot?.computedAt).toBe(NOW - 10 * MINUTE);
    expect(result.latest().snapshot?.cards).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(result.latest().status).toBe('current');
    expect(result.latest().snapshot?.cards).toEqual([]);
    expect(mocks.write.mock.calls[mocks.write.mock.calls.length - 1]?.[1].economic.cards).toEqual([]);
  });

  it('restores a confirmed empty result without reviving old activity', async () => {
    mocks.read.mockResolvedValue(saved([]));
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.cards).toEqual([]);
    expect(result.latest().status).toBe('updating');
  });

  it.each([
    undefined,
    payload(null),
    payload([{}]),
    payload([{ ...card(), signals: [null] }]),
    payload([{ ...card(), location: { lat: NaN, lon: 0, label: 'Invalid' } }]),
    payload([card()], NOW + 16 * MINUTE),
  ])('retains last known data when a response is missing or malformed: %j', async bad => {
    const result = watch();
    await settle();
    const original = result.latest().snapshot;
    mocks.fetch.mockResolvedValue(bad);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(result.latest().snapshot).toBe(original);
    expect(result.latest().status).toBe('updating');
    expect(console.warn).toHaveBeenCalled();
  });

  it('does not let a malformed sibling remove valid domain data', async () => {
    mocks.fetch.mockResolvedValue({ ...payload(), military: [null] });
    const economic = watch();
    const military = watch('military');
    await settle();
    expect(economic.latest().snapshot?.cards).toHaveLength(1);
    expect(military.latest()).toEqual({ status: 'waiting', snapshot: null, offline: false });
  });

  it('starts network recovery without waiting for a stuck cache read', async () => {
    mocks.read.mockReturnValue(new Promise(() => {}));
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.cards).toHaveLength(1);
  });

  it('remains usable when persistent reads and writes reject', async () => {
    mocks.read.mockRejectedValue(new Error('storage blocked'));
    mocks.write.mockRejectedValue(new Error('storage full'));
    const result = watch();
    await settle();
    expect(result.latest().status).toBe('current');
    expect(result.latest().snapshot?.cards).toHaveLength(1);
  });

  it('rejects expired or corrupt cache without turning missing data into zero', async () => {
    mocks.read.mockResolvedValue(saved([card()], NOW - 61 * MINUTE));
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null, offline: false });
  });

  it('ages out retained cards while mounted and preserves their computation timestamp', async () => {
    mocks.read.mockResolvedValue(saved([card()], NOW - 59 * MINUTE));
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.computedAt).toBe(NOW - 59 * MINUTE);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null, offline: false });
  });

  it('does not let delayed stale seed data replace a newer local computation', async () => {
    const cache = deferred<ReturnType<typeof saved>>();
    const network = deferred<ReturnType<typeof payload>>();
    mocks.read.mockReturnValue(cache.promise);
    mocks.fetch.mockReturnValue(network.promise);
    const result = watch();
    await settle();
    service.publishLocalCorrelationCards('economic', [card('economic', 'New local analysis')]);
    network.resolve(payload([card()], NOW - 20 * MINUTE));
    cache.resolve(saved([card()], NOW - 25 * MINUTE));
    await settle();
    expect(result.latest().snapshot?.cards[0]?.title).toBe('New local analysis');
    expect(result.latest().snapshot?.origin).toBe('local');
    expect(result.latest().snapshot?.computedAt).toBe(NOW + 25);
  });

  it('replays a local result to a late subscriber and keeps raw source objects out of storage', async () => {
    mocks.fetch.mockResolvedValue(undefined);
    const local = card();
    local.assessment = 'Session-specific premium assessment';
    local.signals[0]!.rawData = { bulky: 'source payload' };
    service.publishLocalCorrelationCards('economic', [local]);
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.origin).toBe('local');
    expect(mocks.write.mock.calls[0]?.[1].economic.cards[0].signals[0]).not.toHaveProperty('rawData');
    expect(mocks.write.mock.calls[0]?.[1].economic.cards[0].assessment).toBeUndefined();
  });

  it('does not clear known activity when the local engine has no loaded inputs', async () => {
    const result = watch();
    await settle();
    const known = result.latest().snapshot;
    service.publishLocalCorrelationCards('economic', []);
    expect(result.latest().snapshot).toBe(known);
    mocks.fetch.mockResolvedValue(payload([], NOW + 5 * MINUTE));
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 25);
    expect(result.latest().snapshot?.cards).toEqual([]);
  });

  it('does not call an empty local result a confirmed empty on cold start', async () => {
    mocks.fetch.mockResolvedValue(undefined);
    service.publishLocalCorrelationCards('economic', []);
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null, offline: false });
  });

  it('lets a fresh confirmed-empty seed clear newer local cards and prevents local revival', async () => {
    const request = deferred<ReturnType<typeof payload>>();
    mocks.fetch.mockReturnValueOnce(request.promise);
    const result = watch();
    await settle();
    service.publishLocalCorrelationCards('economic', [card()]);
    expect(result.latest().snapshot?.origin).toBe('local');
    request.resolve(payload([]));
    await settle();
    expect(result.latest().snapshot).toEqual({ cards: [], computedAt: NOW - MINUTE, origin: 'seed' });
    service.publishLocalCorrelationCards('economic', [card('economic', 'Partial local inputs')]);
    expect(result.latest().snapshot?.cards).toEqual([]);
    expect(mocks.write.mock.calls[mocks.write.mock.calls.length - 1]?.[1].economic.cards).toEqual([]);

    mocks.fetch.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    service.publishLocalCorrelationCards('economic', [card('economic', 'Local fallback')]);
    expect(result.latest().snapshot?.origin).toBe('local');
    expect(result.latest().snapshot?.cards[0]?.title).toBe('Local fallback');
  });

  it('keeps recovery and other subscribers running when a listener throws', async () => {
    mocks.fetch.mockResolvedValueOnce(undefined).mockResolvedValue(payload([]));
    stops.push(service.subscribeCorrelationSnapshot('economic', () => { throw new Error('broken listener'); }));
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null, offline: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(result.latest().status).toBe('current');
    expect(result.latest().snapshot?.cards).toEqual([]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith('[CorrelationSnapshot] Listener failed', expect.any(Error));
  });

  it('spaces failed offline probes and recovers immediately on reconnect', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null, offline: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.sentry).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(payload());
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(result.latest().snapshot?.cards).toHaveLength(1);
  });

  it('recovers within one minute even when the browser keeps reporting offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const result = watch();
    await vi.advanceTimersByTimeAsync(MINUTE + 25);
    expect(result.latest().status).toBe('current');
    expect(result.latest().offline).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('moves a healthy five-minute deadline forward when an offline event arrives', async () => {
    watch();
    await settle();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(MINUTE + 25);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts healthy generations with seven minutes of clock skew without resetting source time', async () => {
    mocks.fetch.mockImplementation(() => payload([], Date.now() + 7 * MINUTE));
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.computedAt).toBe(NOW + 7 * MINUTE);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect(result.latest().status).toBe('current');
    expect(result.latest().snapshot?.computedAt).toBe(NOW + 27 * MINUTE);
    mocks.fetch.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(68 * MINUTE);
    expect(result.latest().snapshot).toBeNull();
  });

  it('pauses hidden polling and rechecks expired data on return', async () => {
    const result = watch();
    await settle();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(70 * MINUTE);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValue(undefined);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.latest().snapshot).toBeNull();
  });

  it('reports a sustained online failure once per episode and survives telemetry failure', async () => {
    mocks.fetch.mockResolvedValue(payload(null));
    mocks.sentry.mockImplementation(() => { throw new Error('telemetry unavailable'); });
    const result = watch();
    await vi.advanceTimersByTimeAsync(40_525);
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
    const captureMessage = vi.fn();
    mocks.sentry.mock.calls[0]![0]({ captureMessage });
    expect(captureMessage).toHaveBeenCalledWith('Correlation snapshot recovery stalled', {
      level: 'warning', tags: { component: 'correlation-snapshots' }, extra: { domains: ['economic'] },
    });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValue(payload([], Date.now()));
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(result.latest().status).toBe('current');
    mocks.fetch.mockResolvedValue(undefined);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(40_525);
    expect(mocks.sentry).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])('bounds retry jitter with random value %s', async random => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    mocks.fetch.mockResolvedValue(undefined);
    watch();
    await settle();
    const delay = 15_000 * (0.8 + 0.2 * random);
    await vi.advanceTimersByTimeAsync(delay - 26);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { id: 1 }, { domain: 'other' }, { title: null }, { score: -1 }, { score: 101 },
    { score: Infinity }, { timestamp: NaN }, { trend: 'unknown' }, { countries: [1] },
    { assessment: {} }, { location: { lat: 0, lon: 181, label: 'Invalid' } },
    ...[{ type: null }, { source: 1 }, { label: null }, { severity: NaN }, { timestamp: Infinity }]
      .map(signal => ({ signals: [{ ...card().signals[0], ...signal }] })),
  ])('rejects malformed nested fields from network and storage: %j', async invalid => {
    const malformed = { ...card(), ...invalid };
    mocks.read.mockResolvedValue(saved([malformed as ConvergenceCard]));
    mocks.fetch.mockResolvedValue(payload([malformed]));
    const result = watch();
    await settle();
    expect(result.latest().snapshot).toBeNull();
    expect(mocks.write.mock.calls.every(([, data]) => data.economic === undefined)).toBe(true);
  });

  it('ignores an old request after a new subscription generation has loaded', async () => {
    const old = deferred<ReturnType<typeof payload>>();
    mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(payload([card('economic', 'New generation')], NOW));
    const first = watch();
    await settle();
    first.stop();
    const second = watch();
    await settle();
    old.resolve(payload([card('economic', 'Old generation')], NOW + MINUTE));
    await settle();
    expect(second.latest().snapshot?.cards[0]?.title).toBe('New generation');
  });

  it('removes all recovery listeners on final cleanup', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const documentAdded = vi.spyOn(document, 'addEventListener');
    const documentRemoved = vi.spyOn(document, 'removeEventListener');
    const result = watch();
    result.stop();
    for (const event of ['online', 'offline']) {
      const listener = added.mock.calls.find(([type]) => type === event)![1];
      expect(removed).toHaveBeenCalledWith(event, listener);
    }
    const listener = documentAdded.mock.calls.find(([type]) => type === 'visibilitychange')![1];
    expect(documentRemoved).toHaveBeenCalledWith('visibilitychange', listener);
  });

  it('stops polling and ignores a late result after the final unsubscribe', async () => {
    const request = deferred<ReturnType<typeof payload>>();
    mocks.fetch.mockReturnValue(request.promise);
    const result = watch();
    await settle();
    result.stop();
    const stateCount = result.states.length;
    request.resolve(payload());
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    window.dispatchEvent(new Event('online'));
    expect(result.states).toHaveLength(stateCount);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('keeps a remounted panel subscribed if the old cleanup runs twice', async () => {
    mocks.fetch.mockResolvedValue(undefined);
    const first = watch();
    await settle();
    first.stop();
    const second = watch();
    first.stop();
    await settle();
    service.publishLocalCorrelationCards('economic', [card('economic', 'After remount')]);
    expect(second.latest().snapshot?.cards[0]?.title).toBe('After remount');
  });
});

describe('CorrelationPanel presentation', () => {
  async function panel(activate = true) {
    const { initTestI18n } = await import('./helpers/i18n.mts');
    await initTestI18n();
    const { Panel } = await import('@/components/Panel');
    vi.spyOn(Panel.prototype, 'observeNearViewport').mockImplementation(callback => { if (activate) queueMicrotask(callback); });
    const { CorrelationPanel } = await import('@/components/CorrelationPanel');
    const result = new CorrelationPanel('economic-correlation', 'Economic Warfare', 'economic');
    document.body.appendChild(result.getElement());
    stops.push(() => result.destroy());
    await settle();
    return result;
  }

  function expectNoError(element: HTMLElement) {
    expect(element.querySelector('.panel-error-state')).toBeNull();
    expect(element.querySelector('.panel-error-countdown')).toBeNull();
    expect(element.querySelector('.panel-header-error')).toBeNull();
  }

  it('shows a distinct loading label before demand starts the request', async () => {
    const result = await panel(false);
    expect(result.getElement().textContent).toContain('Waiting for data...');
    expect(result.getElement().textContent).not.toContain('This panel updates automatically');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('labels offline data honestly, saved=%s', async hasSaved => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    if (hasSaved) mocks.read.mockResolvedValue(saved());
    const result = await panel();
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain(hasSaved ? 'Last known update 10m ago · Offline' : 'Waiting for a connection');
    expect(result.getElement().querySelector<HTMLElement>('.panel-count')?.hidden).toBe(!hasSaved);
    await vi.advanceTimersByTimeAsync(MINUTE + 25);
    expect(result.getElement().textContent).toContain('Updated');
    expect(result.getElement().textContent).not.toContain('Offline');
  });

  it('preserves expansion, focus, and card identity through minute and failed-refresh updates', async () => {
    mocks.fetch.mockResolvedValue(payload([{ ...card(), location: { lat: 1, lon: 2, label: 'Fixture' } }]));
    const result = await panel();
    const element = result.getElement();
    element.querySelector<HTMLElement>('.correlation-card-header')!.click();
    const detail = element.querySelector<HTMLElement>('.correlation-card-detail')!;
    const button = detail.querySelector('button')!;
    button.focus();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(element.querySelector('.correlation-card-detail')).toBe(detail);
    expect(detail.style.display).toBe('block');
    mocks.fetch.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(document.activeElement).toBe(button);
    expect(element.textContent).toContain('Last known update');
  });

  it('assesses displayed seed evidence and does not buy assessments for discarded local cards', async () => {
    const seed = { ...card(), score: 75 };
    mocks.fetch.mockResolvedValue(payload([seed]));
    const result = await panel();
    const { CorrelationEngine } = await import('@/services/correlation-engine/engine');
    const engine = new CorrelationEngine();
    engine.registerAdapter({
      domain: 'economic', label: 'Fixture', clusterMode: 'country', spatialRadius: 0,
      timeWindow: 24, threshold: 20, weights: { sanctions: 0.5, trade: 0.5 },
      collectSignals: () => ['sanctions', 'trade'].map(type => ({
        type, source: 'fixture', severity: 100, timestamp: NOW, country: 'US', label: 'Different local evidence',
      })),
      generateTitle: () => 'Local high-score card',
    });
    await engine.run({} as never);
    expect(mocks.deduct).not.toHaveBeenCalled();
    result.setAssessmentHandler(cards => engine.assessCards('economic', cards));
    result.updateCards(engine.getCards('economic'));
    await settle();
    expect(mocks.deduct).toHaveBeenCalledTimes(1);
    expect(mocks.deduct.mock.calls[0]![0].query).toContain('Test signal');
    expect(mocks.deduct.mock.calls[0]![0].query).not.toContain('Different local evidence');
    result.getElement().querySelector<HTMLElement>('.correlation-card-header')!.click();
    expect(result.getElement().textContent).toContain('Premium narrative for displayed evidence');
    expect(engine.getCards('economic')[0]?.assessment).toBeUndefined();
    // A valid sibling update persists the retained, now-annotated economic seed.
    mocks.fetch.mockResolvedValue({ ...payload(null, NOW), military: [card('military')] });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.write.mock.calls[mocks.write.mock.calls.length - 1]![1].economic.cards[0].assessment).toBeUndefined();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(mocks.deduct).toHaveBeenCalledTimes(1);
  });

  it('connects a deferred panel mounted after the engine already exists', async () => {
    const { CorrelationEngine } = await import('@/services/correlation-engine/engine');
    const engine = new CorrelationEngine();
    mocks.fetch.mockResolvedValue(payload([{ ...card(), score: 75 }]));
    const result = await panel();
    expect(mocks.deduct).not.toHaveBeenCalled();
    const { PanelLayoutManager } = await import('@/app/panel-layout');
    // Exercise the real mount handoff without starting the unrelated billing/map constructor.
    const mount = Reflect.get(PanelLayoutManager.prototype, 'afterPanelMounted');
    mount.call({
      ctx: { correlationEngine: engine, panelSettings: {} },
      observePanelForHydration: vi.fn(),
    }, 'economic-correlation', result);
    await settle();
    result.getElement().querySelector<HTMLElement>('.correlation-card-header')!.click();
    expect(result.getElement().textContent).toContain('Premium narrative for displayed evidence');
    expect(mocks.deduct).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight assessment only across identical evidence and respects premium access', async () => {
    const { CorrelationEngine } = await import('@/services/correlation-engine/engine');
    const engine = new CorrelationEngine();
    const first = { ...card(), score: 75, countries: ['US', 'CA'] };
    const next = structuredClone(first);
    mocks.premium.mockReturnValue(false);
    engine.assessCards('economic', [first]);
    expect(mocks.deduct).not.toHaveBeenCalled();
    mocks.premium.mockReturnValue(true);
    const response = deferred<{ analysis: string }>();
    mocks.deduct.mockReturnValueOnce(response.promise);
    engine.assessCards('economic', [first]);
    engine.assessCards('economic', [next]);
    expect(mocks.deduct).toHaveBeenCalledTimes(1);
    response.resolve({ analysis: 'Shared evidence narrative' });
    await settle();
    expect(first.assessment).toBeUndefined();
    expect(next.assessment).toBe('Shared evidence narrative');
    expect(first.countries).toEqual(['US', 'CA']);
    const cached = structuredClone(first);
    delete cached.assessment;
    engine.assessCards('economic', [cached]);
    expect(cached.assessment).toBe('Shared evidence narrative');
    expect(mocks.deduct).toHaveBeenCalledTimes(1);
    const changed = structuredClone(first);
    changed.signals[0]!.label = 'New evidence in same cluster';
    delete changed.assessment;
    engine.assessCards('economic', [changed]);
    await settle();
    expect(mocks.deduct).toHaveBeenCalledTimes(2);
    expect(changed.assessment).toBe('Premium narrative for displayed evidence');
  });

  it('drains all selected cards through the concurrency cap without looping on a failed assessment', async () => {
    const { CorrelationEngine } = await import('@/services/correlation-engine/engine');
    const engine = new CorrelationEngine();
    const cards = Array.from({ length: 5 }, (_, index) => ({ ...card(), score: 70 + index }));
    const responses: Array<ReturnType<typeof deferred<{ analysis: string }>>> = [];
    mocks.deduct.mockImplementation(() => {
      const response = deferred<{ analysis: string }>();
      responses.push(response);
      return response.promise;
    });
    engine.assessCards('economic', cards);
    expect(mocks.deduct).toHaveBeenCalledTimes(3);
    responses[0]!.resolve({ analysis: '' });
    await settle();
    expect(mocks.deduct).toHaveBeenCalledTimes(4);
    responses[1]!.resolve({ analysis: 'Second' });
    await settle();
    expect(mocks.deduct).toHaveBeenCalledTimes(5);
    for (const response of responses.slice(2)) response.resolve({ analysis: 'Completed' });
    await settle();
    expect(cards[0]!.assessment).toBeUndefined();
    expect(cards.slice(1).every(card => !!card.assessment)).toBe(true);
    expect(mocks.deduct).toHaveBeenCalledTimes(5);
  });

  it('drops queued work when a panel stops displaying its cards', async () => {
    const { CorrelationEngine } = await import('@/services/correlation-engine/engine');
    const engine = new CorrelationEngine();
    const response = deferred<{ analysis: string }>();
    mocks.deduct.mockReturnValue(response.promise);
    engine.assessCards('economic', Array.from({ length: 4 }, (_, index) => ({ ...card(), score: 70 + index })));
    expect(mocks.deduct).toHaveBeenCalledTimes(3);
    engine.assessCards('economic', []);
    response.resolve({ analysis: 'Old work' });
    await settle();
    expect(mocks.deduct).toHaveBeenCalledTimes(3);
  });

  it('clears visible premium assessments on access loss and rejects an old in-flight result', async () => {
    const seed = { ...card(), score: 75 };
    mocks.fetch.mockResolvedValue(payload([seed]));
    const result = await panel();
    const { CorrelationEngine } = await import('@/services/correlation-engine/engine');
    const engine = new CorrelationEngine();
    result.setAssessmentHandler(cards => engine.assessCards('economic', cards));
    await settle();
    result.getElement().querySelector<HTMLElement>('.correlation-card-header')!.click();
    expect(result.getElement().textContent).toContain('Premium narrative for displayed evidence');
    mocks.premium.mockReturnValue(false);
    engine.clearAssessments();
    await settle();
    expect(seed.assessment).toBeUndefined();
    expect(result.getElement().textContent).not.toContain('Premium narrative for displayed evidence');

    const old = deferred<{ analysis: string }>();
    mocks.deduct.mockReturnValueOnce(old.promise);
    mocks.premium.mockReturnValue(true);
    result.setAssessmentHandler(cards => engine.assessCards('economic', cards));
    engine.clearAssessments();
    result.setAssessmentHandler(cards => engine.assessCards('economic', cards));
    old.resolve({ analysis: 'Previous entitlement generation' });
    await settle();
    expect(result.getElement().textContent).not.toContain('Previous entitlement generation');
    expect(result.getElement().textContent).toContain('Premium narrative for displayed evidence');
    expect(mocks.deduct).toHaveBeenCalledTimes(3);
  });

  it('renders confirmed empty as content, with a known count', async () => {
    mocks.fetch.mockResolvedValue(payload([]));
    const result = await panel();
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('No active convergence detected');
    expect(result.getElement().querySelector<HTMLElement>('.panel-count')?.hidden).toBe(false);
  });

  it('uses a neutral waiting state without a false zero on cold failure', async () => {
    mocks.fetch.mockResolvedValue(undefined);
    const result = await panel();
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('Waiting for the next data update');
    expect(result.getElement().textContent).not.toContain('No active convergence detected');
    expect(result.getElement().querySelector<HTMLElement>('.panel-count')?.hidden).toBe(true);
  });

  it('retains interactive cards during failure and clears stale status on recovery', async () => {
    const result = await panel();
    mocks.fetch.mockResolvedValueOnce(undefined).mockResolvedValue(payload([], NOW + 5 * MINUTE));
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 25);
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('Sanctions activity');
    expect(result.getElement().textContent).toContain('Last known update');
    result.getElement().querySelector<HTMLElement>('.correlation-card-header')!.click();
    expect(result.getElement().textContent).toContain('Test signal');
    await vi.advanceTimersByTimeAsync(15_000 + 25);
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('No active convergence detected');
    expect(result.getElement().textContent).not.toContain('Last known update');
  });
});
