/**
 * #8990: while an accuracy audit holds, the forecast panel shows no score. The
 * track-record strip and every card badge read "Accuracy under audit" and link
 * to /accuracy/, whatever the scorecard carries. The per-card resolution chips
 * stay, as recorded outcomes in neutral colour, never as a verified grade. The
 * standing audit holds until the scorecard calls the headline measurable and
 * lifts by itself then. The sibling suites pin the lifted state; this one runs
 * the real gate.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';
import { recordHref, renderForecastRecord, renderReliabilityBadge, renderResolutionChips } from '@/components/forecast-record';

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
    skill: { count: 243, brier: 0.110775, logScore: 0.36, excludedScored: 0, excludedOrigins: [], yesCount: 20, bssCi95: [-0.9, -0.12] },
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

/** The same body once the headline meets the family minimums: the family-bootstrap interval says so. */
const MEASURABLE = scorecard({
  uncertainty: {
    method: 'family-level percentile bootstrap (each resample draws whole forecast families), 2000 resamples, seed 7072',
    skillBrier: { count: 243, mean: 0.110775, ci95: [0.09, 0.13], insufficientSample: false },
  },
} as Partial<GetForecastScorecardResponse>);

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

  it('waits for the scorecard before choosing between the audit and the scores', async () => {
    stubScorecard(() => new Promise<Response>(() => {}));
    panel.updateForecasts(['cyber', 'conflict'].map((domain, i) => forecast(`fc-${i}`, domain)));
    const root = contentOf(panel);
    await vi.waitFor(() => expect(root.querySelectorAll('.fc-prob-item')).toHaveLength(2));
    expect(root.querySelector('[data-fc-record]')!.getAttribute('data-fc-record')).toBe('loading');
    expect(root.querySelectorAll('.fc-reliability-pending')).toHaveLength(2);
    expect(root.querySelector('a.fc-reliability')).toBeNull();
  });

  it('lifts by itself once the scorecard calls the headline measurable', async () => {
    const root = await render(async () => Response.json(MEASURABLE));
    expect(root.querySelector<HTMLElement>('[data-fc-record]')!.dataset.fcRecord).toBe('ready');
    for (const badge of root.querySelectorAll<HTMLAnchorElement>('a.fc-reliability')) {
      expect(badge.dataset.fcReliabilityState).not.toBe('under-audit');
    }
    expect(root.querySelector('.fc-res-slot[data-unverified]')).toBeNull();
    expect(root.textContent).not.toContain('Accuracy under audit');
  });

  it('holds the audit on a stale response, measurable or not', async () => {
    const root = await render(async () => Response.json({ ...MEASURABLE, stale: true }));
    expect(root.querySelector<HTMLElement>('[data-fc-record]')!.dataset.fcRecord).toBe('under-audit');
    for (const badge of root.querySelectorAll<HTMLAnchorElement>('a.fc-reliability')) expect(badge.dataset.fcReliabilityState).toBe('under-audit');
  });

  it('sets the audit before projecting, so a projection that throws leaves no score and frees the request', async () => {
    const broken = { ...MEASURABLE, stale: true, publishedByDomain: [null] };
    stubScorecard(async () => Response.json(broken));
    panel.updateForecasts(['cyber', 'conflict'].map((domain, i) => forecast(`fc-${i}`, domain)));
    const root = contentOf(panel);
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-fc-record]')?.dataset.fcRecord).toBe('under-audit'));
    await vi.waitFor(() => expect((panel as unknown as { recordPromise: unknown }).recordPromise).toBeNull());
    expect((panel as unknown as { record: { kind: string } }).record.kind).toBe('unavailable');
    expect(root.textContent).not.toMatch(/0\.074|0\.111/);
  });

  it('defaults every renderer to the standing audit, never to lifted', () => {
    const ready = { kind: 'ready', brier: 0.11, graded: 243, yesShare: 0.1, voids: null, stale: false, generatedAt: 1, windowDays: 180 } as const;
    expect(renderForecastRecord(ready)).toContain('data-fc-record="under-audit"');
    const table = { windowDays: 180, stale: false, byDomain: new Map([['cyber', { kind: 'measured' as const, brier: 0.074, n: 205, yesShare: 0.04, bss: 0.2 }]]) };
    expect(renderReliabilityBadge(table, 'cyber', 'Cyber')).toContain('data-fc-reliability-state="under-audit"');
    expect(renderResolutionChips(new Map([['fc-0', [{ outcome: 'NO' }]]]) as never, 'fc-0')).toContain('data-unverified');
  });

  it('holds the audit one step below the minimums', async () => {
    const short = { ...MEASURABLE.uncertainty!, skillBrier: { ...MEASURABLE.uncertainty!.skillBrier!, insufficientSample: true } };
    const root = await render(async () => Response.json(scorecard({ ...MEASURABLE, uncertainty: short })));
    expect(root.querySelector<HTMLElement>('[data-fc-record]')!.dataset.fcRecord).toBe('under-audit');
  });

  it('follows the server flag over a measurable-looking body', async () => {
    const root = await render(async () => Response.json({ ...MEASURABLE, underAudit: { since: '2027-01-02', issue: 9999, reason: 'Server incident.' } }));
    expect(root.querySelector<HTMLElement>('[data-fc-record]')!.dataset.fcRecord).toBe('under-audit');
    expect(root.querySelector('[data-fc-record] .fc-sr-only')!.textContent).toContain('Jan 2, 2027');
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

  it('drops the market-calibration claim from the tooltip in every catalogue (#8990 finding 9)', () => {
    for (const file of readdirSync('src/locales').filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f))) {
      const tooltip: string = JSON.parse(readFileSync(`src/locales/${file}`, 'utf8')).components.forecast.infoTooltip;
      expect(tooltip.match(/<li>/g), `${file} keeps the two remaining bullets`).toHaveLength(2);
      expect(tooltip, file).not.toMatch(/Calibrated against prediction market/);
    }
  });
});
