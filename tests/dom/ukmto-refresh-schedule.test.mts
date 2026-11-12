import { expect, it, vi } from 'vitest';

vi.mock('@/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config')>(),
  SITE_VARIANT: 'happy',
}));

import { App } from '@/App';

it('refreshes an enabled UKMTO panel on Happy and stops when disabled', () => {
  type Registration = { fn: () => unknown; intervalMs: number; condition?: () => boolean };
  const registrations = new Map<string, Registration>();
  const record = (name: string, fn: () => unknown, intervalMs: number, condition?: () => boolean) => {
    registrations.set(name, { fn, intervalMs, condition });
  };
  const loadUkmtoIncidents = vi.fn();
  const state = { panels: {}, mapLayers: { ais: true }, panelSettings: { 'ukmto-incidents': { enabled: true } } };
  const app = Object.create(App.prototype);
  Object.assign(app, {
    state,
    dataLoader: { loadUkmtoIncidents },
    refreshScheduler: {
      scheduleRefresh: record,
      registerAll: (items: Array<Registration & { name: string }>) => {
        for (const item of items) record(item.name, item.fn, item.intervalMs, item.condition);
      },
    },
  });
  app.setupRefreshIntervals();
  const refresh = registrations.get('ukmtoIncidents');
  expect(refresh).toBeDefined();
  expect(refresh!.intervalMs).toBe(60_000);
  expect(refresh!.condition!()).toBe(true);
  refresh!.fn();
  expect(loadUkmtoIncidents).toHaveBeenCalledOnce();
  state.panelSettings['ukmto-incidents'].enabled = false;
  expect(refresh!.condition!()).toBe(false);
});
