/**
 * #8990: the manual override forces the accuracy audit on for a future
 * incident. It holds before the scorecard answers and over a scorecard that
 * would otherwise lift the standing audit.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('../../shared/forecast-accuracy-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/forecast-accuracy-audit')>();
  const FORCED = Object.freeze({ since: '2027-01-02', issue: 9999, reason: 'Fixture incident.' });
  return {
    ...actual,
    FORECAST_ACCURACY_AUDIT_OVERRIDE: FORCED,
    accuracyAuditOverride: () => FORCED,
    forecastAccuracyAudit: (scorecard: unknown, options = {}) => actual.forecastAccuracyAudit(scorecard, { ...options, override: FORCED }),
  };
});

const SCORECARD_PATH = '/api/forecast/v1/get-forecast-scorecard';

// Measurable: the family-bootstrap interval over the headline says the minimums are met.
const MEASURABLE = {
  schemaVersion: 2,
  generatedAt: Date.parse('2027-01-02T06:00:00Z'),
  rollingWindowDays: 180,
  methodology: '',
  totals: { entries: 400, resolved: 260, pending: 100, pendingJudge: 40, scored: 243, void: 17, voidRate: 17 / 260, publicationCoverage: 0.6 },
  overall: { count: 243, brier: 0.111, logScore: 0.36 },
  byDomain: [],
  byGenerationOrigin: [],
  calibration: [],
  skill: { count: 243, brier: 0.110775, logScore: 0.36, excludedScored: 0, excludedOrigins: [], yesCount: 20, bssCi95: [-0.9, -0.12] },
  publishedByDomain: [{ domain: 'conflict', count: 205, brier: 0.074, yesCount: 9 }],
  uncertainty: {
    method: 'family-level percentile bootstrap (each resample draws whole forecast families), 2000 resamples, seed 7072',
    skillBrier: { count: 243, mean: 0.110775, ci95: [0.09, 0.13], insufficientSample: false },
  },
  familyOutcomes: [],
  receipts: [],
  degraded: false,
  stale: false,
  error: '',
} as unknown as GetForecastScorecardResponse;

function forecast(id: string, domain: string): Forecast {
  return { id, title: `Forecast ${id}`, probability: 0.62, domain, region: 'Middle East', trend: 'stable', signals: [] } as unknown as Forecast;
}

beforeAll(async () => {
  await initTestI18n();
});

let panel: ForecastPanel;

beforeEach(() => {
  panel = new ForecastPanel();
  document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
});

afterEach(() => {
  panel.destroy();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ForecastPanel under a manual accuracy-audit override (#8990)', () => {
  it('shows the override before the scorecard answers and keeps it over a measurable one', async () => {
    let answer!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(SCORECARD_PATH)) return new Promise<Response>((resolve) => { answer = resolve; });
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    panel.updateForecasts(['conflict', 'market'].map((domain, i) => forecast(`fc-${i}`, domain)));
    const root = (panel as unknown as { content: HTMLElement }).content;
    await vi.waitFor(() => expect(root.querySelectorAll('.fc-prob-item')).toHaveLength(2));
    const strip = () => root.querySelector<HTMLElement>('[data-fc-record]')!;
    expect(strip().dataset.fcRecord).toBe('under-audit');
    expect(strip().querySelector('.fc-sr-only')!.textContent).toContain('Jan 2, 2027');
    expect(root.querySelector('.fc-reliability-pending')).toBeNull();
    const badges = () => [...root.querySelectorAll<HTMLAnchorElement>('a.fc-reliability')];
    expect(badges()).toHaveLength(2);
    for (const badge of badges()) expect(badge.dataset.fcReliabilityState).toBe('under-audit');

    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer(Response.json(MEASURABLE));
    await vi.waitFor(() => expect((panel as unknown as { record: { kind: string } }).record.kind).toBe('ready'));
    await vi.waitFor(() => expect((panel as unknown as { recordPromise: unknown }).recordPromise).toBeNull());
    expect(strip().dataset.fcRecord).toBe('under-audit');
    for (const badge of badges()) expect(badge.dataset.fcReliabilityState).toBe('under-audit');
    expect(root.textContent).not.toMatch(/0\.111|0\.074/);
  });
});
