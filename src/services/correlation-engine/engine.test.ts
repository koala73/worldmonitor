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

import { haversineKm } from '@/utils/distance';
import { CorrelationEngine } from './engine';
import type { DomainAdapter, SignalEvidence } from './types';

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

describe('CorrelationEngine geographic clustering', () => {
  const signalAt = (lat: number, lon: number, label: string): SignalEvidence => ({
    type: 'test', source: 'test', severity: 50, lat, lon, timestamp: 0, label,
  });

  // Cluster labels as a sorted list of sorted groups, so two partitions compare by value.
  const partition = (clusters: Array<{ signals: SignalEvidence[] }>): string[][] =>
    clusters.map((c) => c.signals.map((s) => s.label).sort()).sort((a, b) => a.join().localeCompare(b.join()));

  const clusterByProximity = (signals: SignalEvidence[], radiusKm: number) =>
    (createEngine() as unknown as {
      clusterByProximity(s: SignalEvidence[], r: number): Array<{ signals: SignalEvidence[] }>;
    }).clusterByProximity(signals, radiusKm);

  // Reference: union every pair within the radius, keep groups of two or more.
  const bruteForce = (signals: SignalEvidence[], radiusKm: number) => {
    const parent = signals.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < signals.length; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        const a = signals[i]!, b = signals[j]!;
        if (haversineKm(a.lat!, a.lon!, b.lat!, b.lon!) <= radiusKm) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, SignalEvidence[]>();
    signals.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
    return [...groups.values()].filter((g) => g.length >= 2).map((g) => ({ signals: g }));
  };

  it('clusters two signals 455 km apart at different latitudes', () => {
    const a = signalAt(32.44, 139, 'a');
    const b = signalAt(36.53, 139, 'b');
    expect(haversineKm(a.lat!, a.lon!, b.lat!, b.lon!)).toBeLessThan(500);

    expect(partition(clusterByProximity([a, b], 500))).toEqual([['a', 'b']]);
  });

  it('clusters a near-pole pair far apart in longitude, in either input order', () => {
    // 120° of longitude at 89.5°N is ~96 km; the row is near enough the pole that
    // the column scan must fall back to every column.
    const a = signalAt(89.5, 0, 'a');
    const b = signalAt(89.5, 120, 'b');
    expect(partition(clusterByProximity([a, b], 500))).toEqual([['a', 'b']]);
    expect(partition(clusterByProximity([b, a], 500))).toEqual([['a', 'b']]);
  });

  it('returns no clusters for a non-positive radius instead of scanning forever', () => {
    // spatialRadius 0 means "no proximity clustering" (types.ts), and a zero cell
    // size makes the column span infinite; the guard must return first.
    const pair = [signalAt(10, 10, 'a'), signalAt(10, 10, 'b')];
    expect(clusterByProximity(pair, 0)).toEqual([]);
    expect(clusterByProximity(pair, -5)).toEqual([]);
  });

  it('matches brute-force pairwise clustering at mid and high latitudes', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    // Longitudes stay clear of the antimeridian seam, which the grid does not wrap.
    const regions = [
      { lat: [25, 45], lon: [120, 150] },
      { lat: [50, 75], lon: [100, 170] },
      { lat: [80, 89.9], lon: [-150, 150] },
      { lat: [-60, -40], lon: [-80, -40] },
    ];
    for (const region of regions) {
      for (let scene = 0; scene < 100; scene++) {
        const signals = Array.from({ length: 12 }, (_, i) => signalAt(
          region.lat[0]! + rand() * (region.lat[1]! - region.lat[0]!),
          region.lon[0]! + rand() * (region.lon[1]! - region.lon[0]!),
          `s${i}`,
        ));
        expect(partition(clusterByProximity(signals, 500))).toEqual(partition(bruteForce(signals, 500)));
      }
    }
  });
});
