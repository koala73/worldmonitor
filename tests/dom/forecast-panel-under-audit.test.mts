/**
 * #8990: while the accuracy audit switch is set, the forecast panel shows no
 * score. The track-record strip and every card badge read "Accuracy under
 * audit" and link to /accuracy/, whatever the scorecard carries. The per-card
 * resolution chips stay, as recorded outcomes in neutral colour, never as a
 * verified grade. The sibling suites mock the switch to null to pin the
 * lifted state; this one runs against the real switch.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';
import { recordHref } from '@/components/forecast-record';
import { FORECAST_ACCURACY_AUDIT } from '../../shared/forecast-accuracy-audit';

import { initTestI18n } from './helpers/i18n.mts';

const SCORECARD_PATH = '/api/forecast/v1/get-forecast-scorecard';

/** The live shape the audit found: a cyber Brier of 0.074 over 205 artifact rows. */
function scorecard(overrides: Partial<GetForecastScorecardResponse> = {}): GetForecastScorecardResponse {
  return {
    schemaVersion: 2,
    generatedAt: Date.parse('2026-10-07T06:00:00Z'),
    rollingWindowDays: 180,
    methodology: '',
    totals: { entries: 400, resolved: 260, pending: 100, pendingJudge: 40, scored: 243, void: 17, voidRate: 17 / 260, publicationCoverage: 0.6 },
    overall: { count: 243, brier: 0.111, logScore: 0.36 },
    byDomain: [],
    byGenerationOrigin: [],
    calibration: [],
    skill: { count: 243, brier: 0.110775, logScore: 0.36, excludedScored: 0, excludedOrigins: [], yesCount: 20 },
    publishedByDomain: [{ domain: 'cyber', count: 205, brier: 0.074, yesCount: 9 }],
    familyOutcomes: [
      { forecastId: 'fc-0', outcome: 'NO', voidReason: '' },
      { forecastId: 'fc-0', outcome: 'YES', voidReason: '' },
      { forecastId: 'fc-1', outcome: 'VOID', voidReason: 'no_archive_evidence' },
    ],
    receipts: [],
    degraded: false,
    stale: false,
    error: '',
    ...overrides,
  } as GetForecastScorecardResponse;
}

function forecast(id: string, domain: string): Forecast {
  return { id, title: `Forecast ${id}`, probability: 0.62, domain, region: 'Middle East', trend: 'stable', signals: [] } as unknown as Forecast;
}

function stubScorecard(respond: () => Promise<Response>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(SCORECARD_PATH)) return respond();
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

const contentOf = (panel: ForecastPanel): HTMLElement => (panel as unknown as { content: HTMLElement }).content;

async function render(respond: () => Promise<Response>, domains = ['cyber', 'conflict']): Promise<HTMLElement> {
  stubScorecard(respond);
  panel.updateForecasts(domains.map((domain, i) => forecast(`fc-${i}`, domain)));
  const root = contentOf(panel);
  await vi.waitFor(() => {
    expect(root.querySelectorAll('a.fc-reliability')).toHaveLength(domains.length);
    expect(root.querySelector('.fc-reliability-pending')).toBeNull();
  });
  return root;
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

describe('ForecastPanel under the accuracy audit (#8990)', () => {
  it('runs against the real switch, which is set', () => {
    expect(FORECAST_ACCURACY_AUDIT?.issue).toBe(8990);
    expect(FORECAST_ACCURACY_AUDIT?.since).toBe('2026-10-07');
  });

  it('replaces the track-record strip with the notice and no number', async () => {
    const root = await render(async () => Response.json(scorecard()));
    const strip = root.querySelector<HTMLElement>('[data-fc-record]')!;
    expect(strip.dataset.fcRecord).toBe('under-audit');
    expect(strip.textContent).toContain('Accuracy under audit');
    expect(strip.textContent).not.toMatch(/Brier|Base rate|Void|\d\.\d{3}/);
    expect(strip.querySelector<HTMLAnchorElement>('a.fc-record-link')!.getAttribute('href')).toBe(recordHref(false));
    expect(strip.querySelector('.fc-sr-only')!.textContent).toContain('Under audit since Oct 7, 2026.');
  });

  it('replaces every domain badge, measured or not, with "Accuracy under audit" linking to /accuracy/', async () => {
    const root = await render(async () => Response.json(scorecard()));
    for (const badge of root.querySelectorAll<HTMLAnchorElement>('a.fc-reliability')) {
      expect(badge.dataset.fcReliabilityState).toBe('under-audit');
      expect(badge.textContent).toBe('Accuracy under audit');
      expect(badge.getAttribute('href')).toBe('/accuracy/');
      expect(badge.getAttribute('aria-label') ?? '').not.toMatch(/Brier|0\.074|205/);
      expect(badge.getAttribute('aria-label')).toContain('errors in how forecasts were scored');
    }
  });

  it('shows the badge before the scorecard answers, since it needs no data from it', async () => {
    stubScorecard(() => new Promise<Response>(() => {}));
    panel.updateForecasts(['cyber', 'conflict'].map((domain, i) => forecast(`fc-${i}`, domain)));
    const root = contentOf(panel);
    await vi.waitFor(() => expect(root.querySelectorAll('.fc-prob-item')).toHaveLength(2));
    expect(root.querySelector('[data-fc-record]')!.getAttribute('data-fc-record')).toBe('under-audit');
    expect(root.querySelector('.fc-reliability-pending')).toBeNull();
    const badges = root.querySelectorAll<HTMLAnchorElement>('a.fc-reliability');
    expect(badges).toHaveLength(2);
    for (const badge of badges) expect(badge.dataset.fcReliabilityState).toBe('under-audit');
  });

  it('shows the notice even when the scorecard request fails', async () => {
    const root = await render(async () => new Response('boom', { status: 500 }));
    expect(root.querySelector<HTMLElement>('[data-fc-record]')!.dataset.fcRecord).toBe('under-audit');
    for (const badge of root.querySelectorAll<HTMLAnchorElement>('a.fc-reliability')) {
      expect(badge.dataset.fcReliabilityState).toBe('under-audit');
    }
  });

  it('keeps the resolution chips as unverified records in neutral colour', async () => {
    const root = await render(async () => Response.json(scorecard()));
    const slots = [...root.querySelectorAll<HTMLElement>('.fc-res-slot')].filter((slot) => slot.querySelector('.fc-res-chip'));
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.hasAttribute('data-unverified')).toBe(true);
      const chip = slot.querySelector<HTMLElement>('.fc-res-chip')!;
      expect(chip.getAttribute('title')).toContain('not verified while accuracy is under audit');
      expect(chip.querySelector('.fc-sr-only')!.textContent).toContain('not verified while accuracy is under audit');
    }
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    expect(css).toMatch(/\.fc-res-slot\[data-unverified\] \.fc-res-chip, \.fc-res-slot\[data-unverified\] \.fc-res-mark \{ color: var\(--text-secondary/);
  });

  it('translates the notice into every catalogue', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).components.forecast.audit;
    for (const file of readdirSync('src/locales').filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f) && f !== 'en.json')) {
      const audit = JSON.parse(readFileSync(`src/locales/${file}`, 'utf8')).components?.forecast?.audit;
      for (const key of ['label', 'hint', 'unverified'] as const) {
        expect(typeof audit?.[key], `${file} ${key}`).toBe('string');
        expect(audit[key], `${file} ${key} must not be English`).not.toBe(en[key]);
      }
      expect(audit.hint, `${file} hint keeps the date token`).toContain('{{date}}');
      expect(`${audit.label} ${audit.hint} ${audit.unverified}`, `${file} leftover English`).not.toMatch(/accuracy|under audit|forecasts?\b|scored|recorded|withdrawn/i);
    }
  });
});
