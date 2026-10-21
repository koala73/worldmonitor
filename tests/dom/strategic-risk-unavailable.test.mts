import { expect, it, vi } from 'vitest';

vi.mock('@/services/cached-risk-scores', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/cached-risk-scores')>(),
  fetchCachedRiskScores: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/geo-convergence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/geo-convergence')>(),
  detectConvergence: vi.fn().mockReturnValue([]),
}));

vi.mock('@/services/cached-theater-posture', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/cached-theater-posture')>(),
  getCachedPosture: vi.fn().mockReturnValue(null),
}));

import { StrategicRiskPanel } from '@/components/StrategicRiskPanel';

interface TestPanelState {
  overview: { compositeScore: number } | null;
  alerts: Array<{ id: string }>;
  convergenceAlerts: unknown[];
  freshnessSummary: unknown;
  breakingAlerts: Map<string, unknown>;
  breakingExpiryTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController;
  element: HTMLElement;
  setDataBadge: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
}

it('clears stale Strategic Risk state when canonical scores are unavailable', async () => {
  const state: TestPanelState = {
    overview: { compositeScore: 87 },
    alerts: [{ id: 'stale-alert' }],
    convergenceAlerts: [],
    freshnessSummary: null,
    breakingAlerts: new Map(),
    breakingExpiryTimer: null,
    abortController: new AbortController(),
    element: document.createElement('section'),
    setDataBadge: vi.fn(),
    showError: vi.fn(),
  };
  document.body.append(state.element);

  const panel = Object.assign(Object.create(StrategicRiskPanel.prototype), state) as StrategicRiskPanel;
  const panelState = panel as unknown as TestPanelState;
  const changed = await panel.refresh();

  expect(changed).toBe(false);
  expect(panelState.overview).toBeNull();
  expect(panelState.alerts).toEqual([]);
  expect(panelState.setDataBadge).toHaveBeenCalledWith('unavailable');
  expect(panelState.showError).toHaveBeenCalledOnce();
});
