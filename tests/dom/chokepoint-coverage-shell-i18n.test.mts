import i18next from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { mountEmbedChokepointStrip } from '@/embed/panels/chokepoint-strip';
import enShell from '@/locales/en.shell.json';

// English first paint loads only en.shell.json; the full catalogue arrives
// later. The raw-key healer cannot repair an interpolated string, so the
// partial-coverage banner must read correctly from the shell alone.
beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: enShell as Record<string, unknown> } },
    interpolation: { escapeValue: false },
  });
});

const ROWS: Array<[string, string]> = [
  ['suez', 'Suez Canal'], ['hormuz_strait', 'Strait of Hormuz'], ['korea_strait', 'Korea Strait'],
];

describe('chokepoint coverage banner before the full English catalogue loads', () => {
  it('names the missing chokepoint instead of a raw key or template', async () => {
    const data = {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      upstreamUnavailable: true,
      chokepoints: ROWS.map(([id, name]) => ({
        id,
        name,
        status: 'green',
        activeWarnings: 0,
        aisDisruptions: 0,
        navigationalWarningsAvailable: true,
        aisSnapshotAvailable: true,
        affectedRoutes: [],
        directions: [],
        transitSummary: { dataAvailable: id !== 'korea_strait' },
      })),
    } as unknown as GetChokepointStatusResponse;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(data));
    const root = document.createElement('div');

    await mountEmbedChokepointStrip(root, 'wm_test_key');

    expect(root.querySelector('.wm-embed-cp-warning')?.textContent).toBe('Korea Strait transit data unavailable');
  });
});
