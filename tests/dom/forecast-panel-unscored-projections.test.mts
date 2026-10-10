/**
 * The 24h/7d/30d horizon projections are editorial curve multipliers that no
 * outcome ledger scores (#7075). The panel must show the scored headline
 * probability and never present the projections as probabilities.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Forecast } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';

import { initTestI18n } from './helpers/i18n.mts';

const CONTENT_DEBOUNCE_MS = 150;

function forecastWithProjections(): Forecast {
  return {
    id: 'fc-conflict-test-1',
    domain: 'conflict',
    region: 'Iran',
    title: 'Escalation risk: Iran (test data)',
    scenario: '',
    probability: 0.62,
    confidence: 0.6,
    timeHorizon: '7d',
    signals: [{ type: 'cii', value: 'Iran CII 87', weight: 0.4 }],
    cascades: [],
    trend: 'rising',
    priorProbability: 0.55,
    calibration: undefined,
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
    perspectives: undefined,
    projections: { h24: 0.37, d7: 0.71, d30: 0.53 },
    feedbackLoopIds: [],
  } as unknown as Forecast;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('ForecastPanel horizon projections (#7075)', () => {
  it('shows the headline probability and none of the unscored projection values', () => {
    const panel = new ForecastPanel();
    document.body.appendChild(panel.getElement());

    panel.updateForecasts([forecastWithProjections()], { generatedAt: 1_790_000_000_000 });
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const html = panel.getElement().innerHTML;
    expect(html).toContain('Escalation risk: Iran (test data)');
    expect(panel.getElement().querySelector('.fc-prob-pct')?.textContent).toBe('62%');
    for (const projected of ['37%', '71%', '53%']) {
      expect(html).not.toContain(projected);
    }
    expect(html).not.toMatch(/\b(24h|7d|30d)\s*:?\s*\d+%/);
  });

  it('names the horizons that have a scorer, never a mutable projection value, with a note on how they are graded', () => {
    const panel = new ForecastPanel();
    document.body.appendChild(panel.getElement());

    const scored = { ...forecastWithProjections(), scoredHorizons: ['h24', 'd30'] } as unknown as Forecast;
    panel.updateForecasts([scored], { generatedAt: 1_790_000_000_000 });
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const line = panel.getElement().querySelector<HTMLDetailsElement>('details.fc-horizons');
    expect(line, 'scored horizons disclosure').not.toBeNull();
    expect(line!.querySelector('summary')?.textContent).toBe('Also scored at: 24h, 30d');
    // The ledger grades the value first published for each window; the payload
    // carries the current projection, which can differ, so no value is shown.
    for (const projected of ['37%', '71%', '53%']) expect(line!.textContent).not.toContain(projected);
    // A native disclosure opens on tap and from the keyboard, unlike a title tooltip.
    const hint = line!.querySelector('.fc-horizons-hint')?.textContent ?? '';
    expect(hint).toMatch(/first published/);
    expect(hint).toMatch(/own horizon/);
    expect(hint).not.toMatch(/not graded at all/);
    expect(line!.hasAttribute('title')).toBe(false);

    const toggleRow = panel.getElement().querySelector<HTMLElement>('.fc-toggle-row')!;
    const before = toggleRow.style.display;
    line!.querySelector<HTMLElement>('summary')!.click();
    expect(toggleRow.style.display, 'opening the hint leaves the card action row alone').toBe(before);
  });

  it('ignores unknown horizon names', () => {
    const panel = new ForecastPanel();
    document.body.appendChild(panel.getElement());

    const odd = { ...forecastWithProjections(), scoredHorizons: ['<img src=x>', 'd30'] } as unknown as Forecast;
    panel.updateForecasts([odd], { generatedAt: 1_790_000_000_000 });
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(panel.getElement().querySelector('.fc-horizons summary')?.textContent).toBe('Also scored at: 30d');
    expect(panel.getElement().querySelector('img')).toBeNull();
  });
});
