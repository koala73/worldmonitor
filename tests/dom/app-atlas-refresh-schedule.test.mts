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
  nearViewport: Set<string>;
} {
  const registrations = new Map<string, Registration>();
  const record = (name: string, fn: () => unknown, intervalMs: number, condition?: () => boolean) => {
    registrations.set(name, { fn, intervalMs, condition });
  };
  const panels = Object.fromEntries(ATLAS_PANELS.map(([id]) => [id, { fetchData: vi.fn() }]));
  const viewportChecks: string[] = [];
  // Panels the stub reports as near the viewport; the test moves them in and out.
  const nearViewport = new Set<string>();

  const app = Object.create(App.prototype) as App;
  Reflect.set(app, 'state', { panels, mapLayers: {} });
  Reflect.set(app, 'dataLoader', new Proxy({}, { get: () => () => undefined }));
  Reflect.set(app, 'refreshScheduler', {
    scheduleRefresh: record,
    registerAll: (regs: Array<{ name: string } & Registration>) => {
      for (const reg of regs) record(reg.name, reg.fn, reg.intervalMs, reg.condition);
    },
  });
  Reflect.set(app, 'isPanelNearViewport', (id: string) => { viewportChecks.push(id); return nearViewport.has(id); });
  Reflect.set(app, 'isAnyPanelNearViewport', () => true);

  (Reflect.get(app, 'setupRefreshIntervals') as () => void).call(app);
  return { registrations, panels, viewportChecks, nearViewport };
}

describe('App refresh schedule for the energy-atlas panels', () => {
  it('registers a recurring, viewport-gated refresh that re-fetches each atlas panel', () => {
    expect(SITE_VARIANT).not.toBe('happy');
    const { registrations, panels, viewportChecks, nearViewport } = scheduleWithRecordingScheduler();

    for (const [panelId, interval] of ATLAS_PANELS) {
      const reg = registrations.get(panelId);
      expect(reg, `${panelId} must be scheduled`).toBeDefined();
      expect(interval).toBeGreaterThan(0);
      expect(reg!.intervalMs).toBe(interval);

      reg!.fn();
      expect(panels[panelId]!.fetchData).toHaveBeenCalledTimes(1);

      expect(reg!.condition, `${panelId} refresh must be viewport-gated`).toBeTypeOf('function');
      viewportChecks.length = 0;
      nearViewport.clear();
      expect(reg!.condition!(), `${panelId} must not refresh offscreen`).toBe(false);
      expect(viewportChecks).toEqual([panelId]);

      // Another panel being on screen must not wake this one.
      for (const [otherId] of ATLAS_PANELS) if (otherId !== panelId) nearViewport.add(otherId);
      expect(reg!.condition!(), `${panelId} must follow its own viewport state`).toBe(false);

      nearViewport.clear();
      nearViewport.add(panelId);
      expect(reg!.condition!(), `${panelId} must refresh near the viewport`).toBe(true);
    }
  });
});
