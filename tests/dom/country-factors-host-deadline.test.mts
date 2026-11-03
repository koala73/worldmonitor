import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostCountryBriefSource, createWebsiteCountryBriefSource } from '@/services/country-brief-source';
import norwayFactors from '../../e2e/fixtures/country-factors-no.json';

const website = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/services/premium-fetch', () => ({ premiumFetch: website.fetch }));

const value = norwayFactors;
type CallArgs = { section: string; arguments: object };

async function harness(queueMs = 11_000, serviceMs = 1_730) {
  const events: Array<{ section: string; at: number; signal: AbortSignal }> = [];
  let active = 0;
  let maximum = 0;
  const source = await createHostCountryBriefSource(async (_name, args, signal) => {
    const { section } = args as CallArgs;
    events.push({ section, at: Date.now(), signal });
    active++;
    maximum = Math.max(maximum, active);
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    signal.addEventListener('abort', release, { once: true });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        release();
        reject(new Error('WorldMonitor host request timed out.'));
      }, 30_000);
      signal.addEventListener('abort', () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
      setTimeout(() => {
        clearTimeout(timeout);
        release();
        resolve({ state: 'ready', section, value: section === 'factors' ? value : { countryCode: 'NO' }, retrievedAt: '2026-10-09T00:00:00Z' });
      }, section === 'factors' ? serviceMs : queueMs);
    });
  });
  const occupy = () => ['facts', 'energy-profile', 'risk'].map(route => source.fetch(
    `https://www.worldmonitor.app/api/intelligence/v1/get-country-${route}?country_code=NO`,
  ));
  return { source, events, occupy, maximum: () => maximum };
}

function observe<T>(promise: Promise<T>) {
  const result: { value?: T; error?: Error } = {};
  void promise.then(value => { result.value = value; }, error => { result.error = error; });
  return result;
}

describe('native factors queue and dispatched response budgets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    website.fetch.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([0, 9_000, 11_000])('returns all five pillars after %i ms queued and 1.73 seconds dispatched', async queueMs => {
    const hostHarness = await harness(queueMs);
    const blockers = queueMs ? hostHarness.occupy() : [];
    const factors = hostHarness.source.factors('NO', new AbortController().signal);
    const outcome = observe(factors);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(queueMs);
    expect(hostHarness.events.filter(event => event.section === 'factors').map(event => event.at)).toEqual([queueMs]);
    await vi.advanceTimersByTimeAsync(1_730);
    expect(outcome.error).toBeUndefined();
    expect(await factors).toEqual(value);
    await Promise.all(blockers);
    expect(hostHarness.maximum()).toBe(queueMs ? 3 : 1);
  });

  it('dispatches queued factors when preceding host requests hit their existing bound', async () => {
    const hostHarness = await harness(31_000);
    const blockers = hostHarness.occupy().map(promise => promise.catch(error => error));
    const factors = hostHarness.source.factors('NO', new AbortController().signal);
    const outcome = observe(factors);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(hostHarness.events.filter(event => event.section === 'factors').map(event => event.at)).toEqual([30_000]);
    await vi.advanceTimersByTimeAsync(1_730);
    expect(await factors).toEqual(value);
    expect((await Promise.all(blockers)).map(error => error.message)).toEqual(Array(3).fill('WorldMonitor host request timed out.'));
    expect(hostHarness.maximum()).toBe(3);
  });

  it('retains host timeout errors and discards an ignored-abort late value', async () => {
    const hostHarness = await harness(11_000, 30_001);
    const blockers = hostHarness.occupy();
    const factors = hostHarness.source.factors('NO', new AbortController().signal);
    const outcome = observe(factors);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(40_999);
    expect(outcome.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error?.message).toContain('WorldMonitor host request timed out.');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toBeUndefined();
    const retry = hostHarness.source.factors('NO', new AbortController().signal);
    observe(retry);
    await vi.dynamicImportSettled();
    expect(hostHarness.events.filter(event => event.section === 'factors')).toHaveLength(2);
    hostHarness.source.clearLoadedData();
    await Promise.all(blockers);
  });

  it.each([0, 11_000])('keeps a duplicate subscriber alive when another cancels at %i ms', async cancelAt => {
    const hostHarness = await harness();
    const blockers = hostHarness.occupy();
    const controller = new AbortController();
    const first = observe(hostHarness.source.factors('NO', controller.signal));
    const second = hostHarness.source.factors('NO', new AbortController().signal);
    observe(second);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(cancelAt);
    controller.abort(new DOMException('caller cancelled', 'AbortError'));
    await vi.advanceTimersByTimeAsync(12_730 - cancelAt);
    expect(first.error?.name).toBe('AbortError');
    expect(await second).toEqual(value);
    expect(hostHarness.events.filter(event => event.section === 'factors')).toHaveLength(1);
    expect(hostHarness.events.find(event => event.section === 'factors')?.signal.aborted).toBe(false);
    await Promise.all(blockers);
  });

  it('removes a last cancelled queued factors request without occupying a slot', async () => {
    const hostHarness = await harness();
    const blockers = hostHarness.occupy();
    const controller = new AbortController();
    const outcome = observe(hostHarness.source.factors('NO', controller.signal));
    await vi.dynamicImportSettled();
    controller.abort(new DOMException('caller cancelled', 'AbortError'));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(outcome.error?.name).toBe('AbortError');
    expect(hostHarness.events.filter(event => event.section === 'factors')).toHaveLength(0);
    await Promise.all(blockers);
  });

  it('keeps the website scorecard deadline at 12 seconds when fetch ignores abort', async () => {
    website.fetch.mockImplementation(() => new Promise(() => {}));
    const source = createWebsiteCountryBriefSource();
    const outcome = observe(source.factors('NO', new AbortController().signal));
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(outcome.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error?.name).toBe('TimeoutError');
    expect(website.fetch).toHaveBeenCalledOnce();
  });
});
