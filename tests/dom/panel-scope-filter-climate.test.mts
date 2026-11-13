/**
 * Climate anomalies remain regional zones. Exposure now filters source
 * events before its limits and must not retain an unsupported notice.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { ClimateAnomalyPanel } from '@/components/ClimateAnomalyPanel';
import { PopulationExposurePanel } from '@/components/PopulationExposurePanel';
import { scopeNoticeFor } from '@/components/panel-scope-notice';
import { getPanelScopeBehaviour } from '@/config/panel-scope';
import type { ResolvedScope } from '@/services/tab-focus';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const FOCUS: ResolvedScope = {
  scope: { countries: ['TH'], neighbours: true },
  chosen: ['TH'],
  neighbours: ['KH', 'LA', 'MM', 'MY'],
};

describe('panels that do not filter by country', () => {
  it('climate keeps every zone and shows "Not filtered"', async () => {
    vi.useFakeTimers();
    const panel = new ClimateAnomalyPanel();
    document.body.appendChild(panel.getElement());
    panel.setAnomalies([
      { zone: 'Europe', lat: 51, lon: 10, tempDelta: 2, precipDelta: -3, severity: 'moderate', type: 'warm', period: '7d' },
      { zone: 'Myanmar', lat: 19.8, lon: 96.7, tempDelta: 1, precipDelta: 4, severity: 'normal', type: 'wet', period: '7d' },
    ]);
    panel.applyScope(FOCUS);
    panel.setScopeNotice(scopeNoticeFor(getPanelScopeBehaviour('climate'), panel, FOCUS));
    await vi.advanceTimersByTimeAsync(300);

    expect(panel.filtersByScope()).toBe(false);
    expect(panel.getElement().querySelectorAll('.climate-row')).toHaveLength(2);
    expect(panel.getElement().querySelector('.panel-scope-chip')?.textContent).toBe('Not filtered');
    expect(panel.getElement().querySelector('.panel-scope-strip')).toBeNull();
    panel.destroy();
  });

  it('population exposure no longer claims it is unsupported', () => {
    const panel = new PopulationExposurePanel();
    document.body.appendChild(panel.getElement());
    panel.setScopeNotice(scopeNoticeFor(getPanelScopeBehaviour('population-exposure'), panel, FOCUS));
    expect(panel.filtersByScope()).toBe(true);
    expect(panel.getElement().querySelector('.panel-scope-chip')).toBeNull();
    panel.destroy();
  });
});
