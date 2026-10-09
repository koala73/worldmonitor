import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CountrySectionError } from '@/services/country-brief-error';
import { CountryBriefController } from '@/components/CountryBriefController';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type { CountryBriefPanel } from '@/components/CountryBriefPanel';

vi.mock('@/services/imf-country-data', () => ({}));
vi.mock('@/services/defense-industrial', () => ({}));
vi.mock('@/services/prediction', () => ({}));
vi.mock('@/utils/country-codes', () => ({ iso2ToIso3: () => 'CHN' }));
vi.mock('@/services/runtime', () => ({}));

type Read = (section: 'debt' | 'stock' | 'trade', load: (signal: AbortSignal) => Promise<unknown>, apply: (value: unknown) => void, premium?: boolean) => Promise<unknown>;
function fixture() {
  let code = 'CN';
  const panelAbort = new AbortController();
  const failure = vi.fn();
  const changed = vi.fn();
  const controller = new CountryBriefController({ mode: 'host' } as CountryBriefSource, { signal: panelAbort.signal, getCode: () => code, setSectionFailure: failure } as unknown as CountryBriefPanel, changed);
  const internals = controller as unknown as { read: Read; snapshot: { countryCode: string; revision: number }; request: AbortController; premiumRequest: AbortController };
  internals.snapshot.countryCode = 'CN';
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { controller, internals, read: internals.read.bind(controller), panelAbort, failure, changed, warning, changeCode: () => { code = 'US'; } };
}
const sentinel = 'Bearer secret-panel-token https://private.example/?token=SECRET <script>payload</script>';

describe('country section failure diagnostics', () => {
  it.each([
    [new CountrySectionError('unavailable', sentinel), 'unavailable_response'],
    [new DOMException(sentinel, 'TimeoutError'), 'timeout'],
    [new SyntaxError(sentinel), 'invalid_response'],
    [new TypeError(sentinel), 'unknown_load_failure'],
    [z.object({ field: z.string() }).safeParse({ field: 1 }).error, 'invalid_response'],
    [new Error(sentinel), 'unknown_load_failure'],
    [{ name: sentinel, message: sentinel, stack: sentinel, cause: sentinel }, 'unknown_load_failure'],
  ])('reports a bounded load classification for %s', async (error, category) => {
    const fixtureState = fixture();
    const apply = vi.fn();
    await fixtureState.read('debt', async () => { throw error; }, apply);
    expect(fixtureState.warning).toHaveBeenCalledExactlyOnceWith('[CountryBriefController] section failed', { section: 'debt', phase: 'load', category });
    expect(apply).not.toHaveBeenCalled();
    expect(fixtureState.failure).toHaveBeenCalledExactlyOnceWith('debt', 'unavailable', 'This section could not be loaded. Retry to refresh it.');
    expect(JSON.stringify([fixtureState.warning.mock.calls, fixtureState.failure.mock.calls, fixtureState.changed.mock.calls])).not.toContain(sentinel);
  });

  it.each([new TypeError(sentinel), new DOMException(sentinel, 'TimeoutError'), new SyntaxError(sentinel)])('labels every apply failure as display failure', async error => {
    const fixtureState = fixture();
    await fixtureState.read('debt', async () => ({ entries: [] }), () => { throw error; });
    expect(fixtureState.warning.mock.calls[0]?.[1]).toEqual({ section: 'debt', phase: 'apply', category: 'display_failure' });
    expect(fixtureState.failure).toHaveBeenCalledOnce();
  });

  it('preserves typed locked notice without exposing its reason', async () => {
    const fixtureState = fixture();
    await fixtureState.read('debt', async () => { throw new CountrySectionError('locked', sentinel); }, vi.fn());
    expect(fixtureState.failure).toHaveBeenCalledExactlyOnceWith('debt', 'locked', 'This section is not authorized by the current connection.');
    expect(fixtureState.warning.mock.calls[0]?.[1]).toEqual({ section: 'debt', phase: 'load', category: 'locked' });
  });

  it.each(['request', 'panel', 'premium', 'dispose', 'revision', 'country'] as const)('silences resolved and rejected abandoned %s work', async abandon => {
    for (const rejects of [false, true]) {
      const fixtureState = fixture();
      let settle!: (value?: unknown) => void;
      const pending = new Promise((resolve, reject) => { settle = rejects ? reject : resolve; });
      const apply = vi.fn();
      const read = fixtureState.read('debt', () => pending, apply, true);
      if (abandon === 'request') fixtureState.internals.request.abort();
      if (abandon === 'panel') fixtureState.panelAbort.abort();
      if (abandon === 'premium') fixtureState.internals.premiumRequest.abort();
      if (abandon === 'dispose') fixtureState.controller.dispose();
      if (abandon === 'revision') fixtureState.internals.snapshot.revision++;
      if (abandon === 'country') fixtureState.changeCode();
      settle(new Error(sentinel));
      await read;
      expect(apply).not.toHaveBeenCalled();
      expect(fixtureState.failure).not.toHaveBeenCalled();
      expect(fixtureState.warning).not.toHaveBeenCalled();
      expect(fixtureState.changed).toHaveBeenCalledTimes(1);
    }
  });

  it('never reads arbitrary error text properties', async () => {
    const fixtureState = fixture();
    const error = Object.fromEntries(['name', 'message', 'stack', 'cause'].map(key => [key, sentinel]));
    for (const key of Object.keys(error)) Object.defineProperty(error, key, { get() { throw new Error(sentinel); } });
    await fixtureState.read('debt', async () => { throw error; }, vi.fn());
    expect(fixtureState.warning).toHaveBeenCalledExactlyOnceWith('[CountryBriefController] section failed', { section: 'debt', phase: 'load', category: 'unknown_load_failure' });
    expect(fixtureState.failure).toHaveBeenCalledOnce();
  });

  it('keeps current AbortError failures observable when ownership is still current', async () => {
    const fixtureState = fixture();
    await fixtureState.read('debt', async () => { throw new DOMException(sentinel, 'AbortError'); }, vi.fn());
    expect(fixtureState.failure).toHaveBeenCalledOnce();
    expect(fixtureState.warning.mock.calls[0]?.[1]).toMatchObject({ category: 'unknown_load_failure', phase: 'load' });
  });

  it('keeps notices intact when the diagnostic sink throws', async () => {
    const fixtureState = fixture();
    fixtureState.warning.mockImplementation(() => { throw new Error(sentinel); });
    await expect(fixtureState.read('debt', async () => { throw new Error(sentinel); }, vi.fn())).resolves.toBeNull();
    expect(fixtureState.failure).toHaveBeenCalledOnce();
    expect(fixtureState.changed).toHaveBeenCalledTimes(2);
  });

  it('preserves stock dispatch omission and trade scenario notice', async () => {
    const fixtureState = fixture();
    const fail = async () => { throw new Error(sentinel); };
    await fixtureState.read('stock', fail, vi.fn());
    expect(fixtureState.failure).not.toHaveBeenCalled();
    await fixtureState.read('trade', fail, vi.fn());
    expect(fixtureState.failure.mock.calls.map(call => call[0])).toEqual(['trade', 'scenario']);
    expect(fixtureState.warning).toHaveBeenCalledTimes(2);
  });

  it('leaves successful values unchanged and emits no diagnostic', async () => {
    const fixtureState = fixture();
    const value = { entries: [{ iso3: 'CHN', debtToGdp: 88 }] };
    const apply = vi.fn();
    expect(await fixtureState.read('debt', async () => value, apply)).toBe(value);
    expect(apply).toHaveBeenCalledExactlyOnceWith(value);
    expect(fixtureState.warning).not.toHaveBeenCalled();
    expect(fixtureState.failure).not.toHaveBeenCalled();
  });
});
