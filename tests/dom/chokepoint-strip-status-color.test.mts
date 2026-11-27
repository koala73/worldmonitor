import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { ChokepointStripPanel } from '@/components/ChokepointStripPanel';
import { mountEmbedChokepointStrip } from '@/embed/panels/chokepoint-strip';
import { initTestI18n } from './helpers/i18n.mts';

// get-chokepoint-status sends scoreToStatus() output: 'green' | 'yellow' | 'red'.
const STATUS_BY_ID: Record<string, string> = {
  hormuz_strait: 'red',
  bab_el_mandeb: 'yellow',
  suez: 'green',
};

const response = {
  chokepoints: Object.entries(STATUS_BY_ID).map(([id, status]) => ({
    id,
    name: id,
    status,
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

const RED = '#e74c3c';
const AMBER = '#f39c12';
const GREEN = '#2ecc71';
const expected = { hormuz_strait: RED, bab_el_mandeb: AMBER, suez: GREEN };

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function dotColors(root: ParentNode, chipSelector: string, dotSelector: string): Record<string, string> {
  return Object.fromEntries([...root.querySelectorAll<HTMLElement>(chipSelector)].map((chip) => [
    chip.dataset.cp ?? '',
    chip.querySelector<HTMLElement>(dotSelector)?.style.background ?? '',
  ]));
}

describe('chokepoint strip status dot', () => {
  it('colours the dashboard chip from the server status level', () => {
    vi.useFakeTimers();
    try {
      const panel = new ChokepointStripPanel();
      const harness = panel as unknown as { data: GetChokepointStatusResponse; render(): void };
      harness.data = response;
      harness.render();
      vi.advanceTimersByTime(151);

      expect(dotColors(panel.getElement(), '.cp-chip', '.cp-chip-dot')).toEqual(expected);
      panel.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('colours the partner embed chip from the server status level', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response));
    const root = document.createElement('div');

    await mountEmbedChokepointStrip(root, 'wm_test_key');

    expect(dotColors(root, '.wm-embed-cp-chip', '.wm-embed-cp-dot')).toEqual(expected);
  });
});
