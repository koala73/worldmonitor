import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';

it('discards an old trade batch after the panel principal is reset', async () => {
  const source = readFileSync(new URL('../src/app/data-loader.ts', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('  async loadTradePolicy()'), source.indexOf('  async loadSupplyChain()'))
    .replace("await import('@/services/trade')", 'await getTradeModule()');
  const emitted = transpileModule(`const loader = { ${method} };`, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
  }).outputText;
  let generation = 0;
  const received: unknown[] = [];
  const panel = {
    beginDataLoad: () => ++generation,
    acceptsDataLoad: (token: number) => token === generation,
    ...Object.fromEntries(['Restrictions', 'Tariffs', 'Flows', 'Barriers', 'Revenue', 'ComtradeFlows']
      .map((name) => [`update${name}`, (data: unknown) => received.push(data)])),
  };
  let resolveOld!: (value: unknown) => void;
  const pending = new Promise((resolve) => { resolveOld = resolve; });
  let next: Promise<unknown> = pending;
  let starts = 0;
  const trade = Object.fromEntries(['TradeRestrictions', 'TariffTrends', 'TradeFlows', 'TradeBarriers', 'CustomsRevenue', 'ComtradeFlows']
    .map((name) => [`fetch${name}`, () => { starts += 1; return next; }]));
  const loader = new Function('hasPremiumAccess', 'getTradeModule', 'dataFreshness', `${emitted}; return loader;`)(
    () => true, async () => trade, { recordUpdate() {}, recordError() {} },
  ) as { loadTradePolicy: (this: unknown) => Promise<void> };
  const host = { ctx: { panels: { 'trade-policy': panel } } };
  const oldRequest = loader.loadTradePolicy.call(host);
  await Promise.resolve();
  assert.equal(starts, 6);
  generation += 1; // clearSensitiveContent invalidates the panel's previous loads.
  next = Promise.resolve({ account: 'B' });
  await loader.loadTradePolicy.call(host);
  assert.equal(received.length, 6);
  resolveOld({ account: 'A' });
  await oldRequest;
  assert.deepEqual(received, Array(6).fill({ account: 'B' }));
});
