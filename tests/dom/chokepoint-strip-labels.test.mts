import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { ChokepointStripPanel } from '@/components/ChokepointStripPanel';
import { mountEmbedChokepointStrip } from '@/embed/panels/chokepoint-strip';
import { initTestI18n } from './helpers/i18n.mts';

const STRIP_ROWS: Array<[string, string, string]> = [
  ['hormuz_strait', 'Strait of Hormuz', 'Hormuz'],
  ['malacca_strait', 'Strait of Malacca', 'Malacca'],
  ['suez', 'Suez Canal', 'Suez'],
  ['bab_el_mandeb', 'Bab el-Mandeb', 'Bab el-Mandeb'],
  ['bosphorus', 'Bosporus Strait', 'Turkish Straits'],
  ['dover_strait', 'Dover Strait', 'Dover Strait'],
  ['panama', 'Panama Canal', 'Panama'],
];

const response = {
  chokepoints: STRIP_ROWS.map(([id, name]) => ({
    id,
    name,
    status: 'green',
    activeWarnings: 0,
    aisDisruptions: 0,
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    affectedRoutes: [],
    description: '',
    directions: [],
    disruptionScore: 0,
    flowEstimate: { currentMbd: 3, baselineMbd: 3, flowRatio: 1, disrupted: false },
    transitSummary: { dataAvailable: true },
  })),
  fetchedAt: '2026-11-02T00:00:00.000Z',
  upstreamUnavailable: false,
} as unknown as GetChokepointStatusResponse;

const expected = Object.fromEntries(STRIP_ROWS.map(([id, , label]) => [id, label]));

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function chipLabels(root: ParentNode, chipSelector: string, nameSelector: string): Record<string, string> {
  return Object.fromEntries([...root.querySelectorAll<HTMLElement>(chipSelector)].map((chip) => [
    chip.dataset.cp ?? '',
    chip.querySelector(nameSelector)?.textContent?.trim() ?? '',
  ]));
}

describe('chokepoint strip labels', () => {
  it('names the Dover Strait chip Dover Strait in the dashboard strip', () => {
    vi.useFakeTimers();
    try {
      const panel = new ChokepointStripPanel();
      const harness = panel as unknown as { data: GetChokepointStatusResponse; render(): void };
      harness.data = response;
      harness.render();
      vi.advanceTimersByTime(151);

      const labels = chipLabels(panel.getElement(), '.cp-chip', '.cp-chip-name');
      expect(labels).toEqual(expected);
      expect(panel.getElement().textContent).not.toContain('Danish');
      panel.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the Dover Strait chip Dover Strait in the partner embed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response));
    const root = document.createElement('div');

    await mountEmbedChokepointStrip(root, 'wm_test_key');

    expect(chipLabels(root, '.wm-embed-cp-chip', '.wm-embed-cp-name')).toEqual(expected);
    expect(root.textContent).not.toContain('Danish');
  });
});
