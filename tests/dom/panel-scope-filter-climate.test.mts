/**
 * Dashboard focus (#10453): climate anomalies are regional zones and
 * population exposure is a worldwide top-N slice, so neither filters. Under a
 * focus both say "Not filtered" and keep every row.
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

  it('population exposure shows "Not filtered"', () => {
    const panel = new PopulationExposurePanel();
    document.body.appendChild(panel.getElement());
    panel.setScopeNotice(scopeNoticeFor(getPanelScopeBehaviour('population-exposure'), panel, FOCUS));
    expect(panel.filtersByScope()).toBe(false);
    expect(panel.getElement().querySelector<HTMLElement>('.panel-scope-chip')?.dataset.scopeNotice).toBe('unsupported');
    panel.destroy();
  });
});
