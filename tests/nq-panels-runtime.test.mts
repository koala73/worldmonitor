import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const forward = (signal: AbortSignal): void => controller.abort(signal.reason);
  for (const signal of signals) {
    if (signal.aborted) {
      forward(signal);
      break;
    }
    signal.addEventListener('abort', () => forward(signal), { once: true });
  }
  return controller.signal;
}

function pendingUntilAbort<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

const PANEL_STUB = `
  export class Panel {
    constructor() {
      this.abortController = new AbortController();
      this.signal = this.abortController.signal;
      this.testState = { loading: [], content: [], errors: [] };
    }
    showLoading(message = '') { this.testState.loading.push(message); }
    setSafeContent(html) { this.testState.content.push(String(html)); }
    showError(message) { this.testState.errors.push(String(message)); }
    isAbortError(error) { return error?.name === 'AbortError'; }
    destroy() { this.abortController.abort(new DOMException('destroyed', 'AbortError')); }
  }
`;

async function bundlePanel(
  entryFile: string,
  exportName: string,
  stubs: Map<string, string>,
  aliases: Map<string, string>,
): Promise<any> {
  const entryPath = resolve(root, entryFile).replaceAll('\\', '/');
  const modules = new Map(stubs);
  modules.set('virtual-entry', `export { ${exportName} } from '${entryPath}';`);
  const result = await build({
    entryPoints: ['virtual-entry'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'nq-panel-runtime-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^virtual-entry$/ }, () => ({ path: 'virtual-entry', namespace: 'stub' }));
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: modules.get(args.path),
          loader: 'ts',
          resolveDir: root,
        }));
      },
    }],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  return (await import(url))[exportName];
}

let NqPulsePanel: any;
let NqCatalystsPanel: any;

before(async () => {
  NqPulsePanel = await bundlePanel(
    'src/components/NqPulsePanel.ts',
    'NqPulsePanel',
    new Map([
      ['panel-stub', PANEL_STUB],
      ['sanitize-stub', `export const unsafeRawHtml = (value) => value;`],
      ['market-stub', `export async function fetchMultipleStocks() { throw new Error('test dependency required'); }`],
      ['timeout-stub', `
        export const createTimeoutSignal = () => new AbortController().signal;
        export const combineAbortSignals = (signals) => signals[0];
      `],
      ['config-stub', `
        export const NQ_PULSE_DISCLOSURE = 'disclosure';
        export const NQ_PULSE_BASKET = [{ symbol: 'NQ=F', name: 'NQ', display: 'NQ', unit: 'points' }];
      `],
      ['pulse-content-stub', `
        export const freshnessLabelForAsOf = () => 'Current';
        export const nqPulseAsOfLabel = (asOf) => 'As of ' + asOf;
        export const orderNqPulseRows = (quotes) => quotes;
        export const composeNqPulseHtml = (input) => JSON.stringify(input);
      `],
    ]),
    new Map([
      ['./Panel', 'panel-stub'],
      ['@/utils/sanitize', 'sanitize-stub'],
      ['@/services/market', 'market-stub'],
      ['@/services/timeout-signal', 'timeout-stub'],
      ['@/config/nq-context', 'config-stub'],
      ['./nq-pulse-content', 'pulse-content-stub'],
    ]),
  );

  NqCatalystsPanel = await bundlePanel(
    'src/components/NqCatalystsPanel.ts',
    'NqCatalystsPanel',
    new Map([
      ['panel-stub', PANEL_STUB],
      ['sanitize-stub', `export const unsafeRawHtml = (value) => value;`],
      ['rpc-stub', `export const getRpcBaseUrl = () => 'https://example.test';`],
      ['timeout-stub', `
        export const createTimeoutSignal = () => new AbortController().signal;
        export const combineAbortSignals = (signals) => signals[0];
      `],
      ['config-stub', `
        export const NQ_EARNINGS_WINDOW_DAYS = 14;
        export const NQ_MACRO_WINDOW_DAYS = 7;
        export const NQ_PULSE_DISCLOSURE = 'disclosure';
      `],
      ['catalysts-content-stub', `
        export const filterNqMacroEvents = (events) => events;
        export const filterNqEarnings = (earnings) => earnings;
        export const composeNqCatalystsHtml = (input) => JSON.stringify(input);
      `],
      ['economic-client-stub', `export class EconomicServiceClient {}`],
      ['market-client-stub', `export class MarketServiceClient {}`],
    ]),
    new Map([
      ['./Panel', 'panel-stub'],
      ['@/utils/sanitize', 'sanitize-stub'],
      ['@/services/rpc-client', 'rpc-stub'],
      ['@/services/timeout-signal', 'timeout-stub'],
      ['@/config/nq-context', 'config-stub'],
      ['./nq-catalysts-content', 'catalysts-content-stub'],
      ['@/generated/client/worldmonitor/economic/v1/service_client', 'economic-client-stub'],
      ['@/generated/client/worldmonitor/market/v1/service_client', 'market-client-stub'],
    ]),
  );
});

function quoteResult(marker: string) {
  return {
    data: [{ symbol: 'NQ=F', name: marker, display: 'NQ', price: 21_000, change: 0 }],
    asOf: '2026-08-31T18:00:00.000Z',
  };
}

function macroResponse(marker: string) {
  return {
    events: [{ event: marker, country: 'US', date: '2026-09-01', impact: 'High' }],
    fromDate: '2026-08-31',
    toDate: '2026-09-06',
    total: 1,
    unavailable: false,
    asOf: '2026-08-31T18:00:00.000Z',
  };
}

function earningsResponse(marker: string) {
  return {
    earnings: [{ symbol: 'AAPL', company: marker, date: '2026-09-01', hour: 'amc' }],
    fromDate: '2026-08-31',
    toDate: '2026-09-13',
    total: 1,
    unavailable: false,
    asOf: '2026-08-31T18:00:00.000Z',
  };
}

describe('NQ panel request lifecycle', () => {
  it('lets only the newest NQ Pulse request write success or error state', async () => {
    const firstResult = deferred<any>();
    const secondResult = deferred<any>();
    const calls = [firstResult, secondResult];
    const deadlineMs: number[] = [];
    const panel = new NqPulsePanel({
      fetchStocks: () => calls.shift()!.promise,
      nowMs: () => Date.parse('2026-08-31T18:00:00.000Z'),
      createTimeoutSignal: (ms: number) => {
        deadlineMs.push(ms);
        return new AbortController().signal;
      },
      combineAbortSignals: combineSignals,
    });

    const first = panel.fetchData();
    const second = panel.fetchData();
    secondResult.resolve(quoteResult('newer'));
    assert.equal(await second, true);
    const rendered = panel.testState.content.at(-1);
    assert.match(rendered, /newer/);

    firstResult.reject(new Error('older request failed'));
    assert.equal(await first, false);
    assert.equal(panel.testState.content.at(-1), rendered);
    assert.deepEqual(deadlineMs, [15_000, 15_000]);
    assert.equal(panel.testState.errors.length, 0);
  });

  it('passes Pulse lifecycle cancellation and a 15-second deadline to its request', async () => {
    const timeoutControllers: AbortController[] = [];
    let requestSignal: AbortSignal | undefined;
    const panel = new NqPulsePanel({
      fetchStocks: (_symbols: unknown, options: { signal: AbortSignal }) => {
        requestSignal = options.signal;
        return pendingUntilAbort(options.signal);
      },
      nowMs: () => 0,
      createTimeoutSignal: (ms: number) => {
        assert.equal(ms, 15_000);
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      },
      combineAbortSignals: combineSignals,
    });

    const fetch = panel.fetchData();
    timeoutControllers[0]!.abort(new DOMException('deadline', 'TimeoutError'));
    assert.equal(await fetch, false);
    assert.equal(requestSignal?.aborted, true);

    const lifecyclePanel = new NqPulsePanel({
      fetchStocks: (_symbols: unknown, options: { signal: AbortSignal }) => {
        requestSignal = options.signal;
        return pendingUntilAbort(options.signal);
      },
      nowMs: () => 0,
      createTimeoutSignal: () => new AbortController().signal,
      combineAbortSignals: combineSignals,
    });
    const lifecycleFetch = lifecyclePanel.fetchData();
    lifecyclePanel.destroy();
    assert.equal(requestSignal?.aborted, true);
    assert.equal(await lifecycleFetch, false);
    assert.equal(lifecyclePanel.testState.content.length, 0);
  });

  it('renders either catalyst leg when the other independent deadline fires', async () => {
    for (const timedOutLeg of ['macro', 'earnings'] as const) {
      const timeoutControllers: AbortController[] = [];
      const combinedSignals: AbortSignal[] = [];
      const windows: Array<{ kind: string; from: string; to: string }> = [];
      const panel = new NqCatalystsPanel({
        now: () => new Date(2026, 7, 31, 12),
        createTimeoutSignal: (ms: number) => {
          assert.equal(ms, 15_000);
          const controller = new AbortController();
          timeoutControllers.push(controller);
          return controller.signal;
        },
        combineAbortSignals: (signals: AbortSignal[]) => {
          const combined = combineSignals(signals);
          combinedSignals.push(combined);
          return combined;
        },
        fetchMacro: (window: { from: string; to: string }, signal: AbortSignal) => {
          windows.push({ kind: 'macro', ...window });
          return timedOutLeg === 'macro' ? pendingUntilAbort(signal) : Promise.resolve(macroResponse('CPI'));
        },
        fetchEarnings: (window: { from: string; to: string }, signal: AbortSignal) => {
          windows.push({ kind: 'earnings', ...window });
          return timedOutLeg === 'earnings' ? pendingUntilAbort(signal) : Promise.resolve(earningsResponse('Apple'));
        },
      });

      const fetch = panel.fetchData();
      timeoutControllers[timedOutLeg === 'macro' ? 0 : 1]!
        .abort(new DOMException('deadline', 'TimeoutError'));
      assert.equal(await fetch, true);
      assert.equal(combinedSignals.length, 2);
      assert.notEqual(combinedSignals[0], combinedSignals[1]);
      assert.deepEqual(windows, [
        { kind: 'macro', from: '2026-08-31', to: '2026-09-06' },
        { kind: 'earnings', from: '2026-08-31', to: '2026-09-13' },
      ]);
      const rendered = JSON.parse(panel.testState.content.at(-1));
      assert.equal(rendered.macroUnavailable, timedOutLeg === 'macro');
      assert.equal(rendered.earningsUnavailable, timedOutLeg === 'earnings');
      assert.equal(rendered.macro.length, timedOutLeg === 'macro' ? 0 : 1);
      assert.equal(rendered.earnings.length, timedOutLeg === 'earnings' ? 0 : 1);
    }
  });

  it('fences late catalyst settlement and aborts both legs on panel destroy', async () => {
    const macroCalls = [deferred<any>(), deferred<any>()];
    const earningsCalls = [deferred<any>(), deferred<any>()];
    const firstMacro = macroCalls[0]!;
    const firstEarnings = earningsCalls[0]!;
    const secondMacro = macroCalls[1]!;
    const secondEarnings = earningsCalls[1]!;
    const panel = new NqCatalystsPanel({
      now: () => new Date(2026, 7, 31, 12),
      createTimeoutSignal: () => new AbortController().signal,
      combineAbortSignals: combineSignals,
      fetchMacro: () => macroCalls.shift()!.promise,
      fetchEarnings: () => earningsCalls.shift()!.promise,
    });

    const first = panel.fetchData();
    const second = panel.fetchData();
    secondMacro.resolve(macroResponse('newer macro'));
    secondEarnings.resolve(earningsResponse('newer earnings'));
    assert.equal(await second, true);
    const rendered = panel.testState.content.at(-1);
    assert.match(rendered, /newer macro/);
    assert.match(rendered, /newer earnings/);

    firstMacro.reject(new Error('older macro error'));
    firstEarnings.resolve(earningsResponse('older earnings'));
    assert.equal(await first, false);
    assert.equal(panel.testState.content.at(-1), rendered);
    assert.equal(panel.testState.errors.length, 0);

    const lifecycleSignals: AbortSignal[] = [];
    const lifecyclePanel = new NqCatalystsPanel({
      now: () => new Date(2026, 7, 31, 12),
      createTimeoutSignal: () => new AbortController().signal,
      combineAbortSignals: (signals: AbortSignal[]) => {
        const combined = combineSignals(signals);
        lifecycleSignals.push(combined);
        return combined;
      },
      fetchMacro: (_window: unknown, signal: AbortSignal) => pendingUntilAbort(signal),
      fetchEarnings: (_window: unknown, signal: AbortSignal) => pendingUntilAbort(signal),
    });
    const lifecycleFetch = lifecyclePanel.fetchData();
    lifecyclePanel.destroy();
    assert.deepEqual(lifecycleSignals.map((signal) => signal.aborted), [true, true]);
    assert.equal(await lifecycleFetch, false);
    assert.equal(lifecyclePanel.testState.content.length, 0);
  });
});
