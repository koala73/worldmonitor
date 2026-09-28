import { describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { REFRESH_INTERVALS, SITE_VARIANT } from '@/config';

type Registration = { fn: () => unknown; intervalMs: number; condition?: () => boolean };

// The energy-atlas panels are seeded registries and snapshots. Without a
// recurring refresh a long-lived dashboard session keeps the first payload.
const ATLAS_PANELS = [
  ['pipeline-status', REFRESH_INTERVALS.pipelineStatus],
  ['storage-facility-map', REFRESH_INTERVALS.storageFacilityMap],
  ['fuel-shortages', REFRESH_INTERVALS.fuelShortages],
  ['energy-disruptions', REFRESH_INTERVALS.energyDisruptions],
  ['energy-risk-overview', REFRESH_INTERVALS.energyRiskOverview],
  ['chokepoint-strip', REFRESH_INTERVALS.chokepointStrip],
] as const;

function scheduleWithRecordingScheduler(): {
  registrations: Map<string, Registration>;
  panels: Record<string, { fetchData: ReturnType<typeof vi.fn> }>;
  viewportChecks: string[];
} {
  const registrations = new Map<string, Registration>();
  const record = (name: string, fn: () => unknown, intervalMs: number, condition?: () => boolean) => {
    registrations.set(name, { fn, intervalMs, condition });
  };
  const panels = Object.fromEntries(ATLAS_PANELS.map(([id]) => [id, { fetchData: vi.fn() }]));
  const viewportChecks: string[] = [];

  const app = Object.create(App.prototype) as App;
  Reflect.set(app, 'state', { panels, mapLayers: {} });
  Reflect.set(app, 'dataLoader', new Proxy({}, { get: () => () => undefined }));
  Reflect.set(app, 'refreshScheduler', {
    scheduleRefresh: record,
    registerAll: (regs: Array<{ name: string } & Registration>) => {
      for (const reg of regs) record(reg.name, reg.fn, reg.intervalMs, reg.condition);
    },
  });
  Reflect.set(app, 'isPanelNearViewport', (id: string) => { viewportChecks.push(id); return true; });
  Reflect.set(app, 'isAnyPanelNearViewport', () => true);

  (Reflect.get(app, 'setupRefreshIntervals') as () => void).call(app);
  return { registrations, panels, viewportChecks };
}

describe('App refresh schedule for the energy-atlas panels', () => {
  it('registers a recurring, viewport-gated refresh that re-fetches each atlas panel', () => {
    expect(SITE_VARIANT).not.toBe('happy');
    const { registrations, panels, viewportChecks } = scheduleWithRecordingScheduler();

    for (const [panelId, interval] of ATLAS_PANELS) {
      const reg = registrations.get(panelId);
      expect(reg, `${panelId} must be scheduled`).toBeDefined();
      expect(interval).toBeGreaterThan(0);
      expect(reg!.intervalMs).toBe(interval);

      reg!.fn();
      expect(panels[panelId]!.fetchData).toHaveBeenCalledTimes(1);

      viewportChecks.length = 0;
      expect(reg!.condition?.()).toBe(true);
      expect(viewportChecks).toEqual([panelId]);
    }
  });
});
