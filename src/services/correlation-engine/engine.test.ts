import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => false,
}));
vi.mock('@/services/premium-fetch', () => ({
  premiumFetch: vi.fn(),
}));
vi.mock('@/services/generated-rpc-clients', () => ({
  IntelligenceServiceClient: class {},
}));

import { CorrelationEngine } from './engine';
import type { DomainAdapter } from './types';

Object.defineProperty(globalThis, 'document', {
  value: { dispatchEvent() {} },
  configurable: true,
});

const emptyAdapter: DomainAdapter = {
  domain: 'military',
  label: 'Performance warning test',
  clusterMode: 'geographic',
  spatialRadius: 500,
  timeWindow: 24,
  threshold: 0,
  weights: {},
  collectSignals: () => [],
  generateTitle: () => 'test',
};

function createEngine(): CorrelationEngine {
  const engine = new CorrelationEngine();
  engine.registerAdapter(emptyAdapter);
  return engine;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CorrelationEngine performance warning', () => {
  it('retains the selected runtime mode at the strategy handoff boundary', async () => {
    const engine = createEngine();

    await engine.run({} as Parameters<CorrelationEngine['run']>[0], 'exact');
    expect(engine.getRuntimeMode()).toBe('exact');

    await engine.run({} as Parameters<CorrelationEngine['run']>[0], 'fuzzy');
    expect(engine.getRuntimeMode()).toBe('fuzzy');
  });

  it('reports that it computed so callers can skip publishing a skipped run', async () => {
    const engine = createEngine();

    // run() is synchronous end to end today, so the `this.running` re-entrancy
    // guard is not reachable from outside and is deliberately NOT asserted here
    // -- a concurrency test would pass for the wrong reason. This pins only the
    // contract the caller depends on: a run that computed reports true.
    await expect(
      engine.run({} as Parameters<CorrelationEngine['run']>[0], 'legacy'),
    ).resolves.toBe(true);
  });

  it('does not warn for an isolated cold-start breach', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(158)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(240);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = createEngine();

    await engine.run({} as Parameters<CorrelationEngine['run']>[0]);
    await engine.run({} as Parameters<CorrelationEngine['run']>[0]);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the target is breached on consecutive runs', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(158)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(342)
      .mockReturnValueOnce(400)
      .mockReturnValueOnce(580);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = createEngine();

    await engine.run({} as Parameters<CorrelationEngine['run']>[0]);
    await engine.run({} as Parameters<CorrelationEngine['run']>[0]);
    await engine.run({} as Parameters<CorrelationEngine['run']>[0]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[CorrelationEngine] run() exceeded 100ms for 2 consecutive runs '
      + '(latest 142ms, peak 158ms)',
    );
  });
});
