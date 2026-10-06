/**
 * #7074 — the ForecastPanel track-record strip.
 *
 * The strip reads GET /api/forecast/v1/get-forecast-scorecard through the
 * panel's session client and renders the headline Brier, the base-rate
 * comparison derived from skill.yesCount (#8891), and the void rate, each
 * with its sample size, plus a link to /accuracy/. Every state the response
 * can put it in is pinned here: loading, ready, stale, insufficient sample,
 * degraded, and a failed request. The degraded and insufficient cases assert
 * that no zero is ever shown as a result.
 *
 * Lives under tests/dom/ because `Panel` needs a DOM and `@/services/i18n`'s
 * `import.meta.glob` graph, both unreachable from the `tsx --test` profile.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';
import { recordHref } from '@/components/forecast-record';

import { initTestI18n } from './helpers/i18n.mts';

const SCORECARD_PATH = '/api/forecast/v1/get-forecast-scorecard';

function readyScorecard(overrides: Partial<GetForecastScorecardResponse> = {}): GetForecastScorecardResponse {
  return {
    schemaVersion: 1,
    generatedAt: Date.parse('2026-10-05T06:00:00Z'),
    rollingWindowDays: 180,
    methodology: '',
    totals: { entries: 240, resolved: 60, pending: 150, pendingJudge: 30, scored: 55, void: 5, voidRate: 5 / 60, publicationCoverage: 0.9 },
    overall: { count: 55, brier: 0.19, logScore: -0.5 },
    byDomain: [],
    byGenerationOrigin: [],
    calibration: [],
    skill: { count: 42, brier: 0.182, logScore: -0.51, excludedScored: 13, excludedOrigins: ['synthetic_backfill'], yesCount: 13 },
    degraded: false,
    stale: false,
    error: '',
    ...overrides,
  };
}

/** The handler's all-zero body when Redis is unreachable. */
function degradedScorecard(): GetForecastScorecardResponse {
  return {
    schemaVersion: 1,
    generatedAt: 0,
    rollingWindowDays: 180,
    methodology: '',
    totals: { entries: 0, resolved: 0, pending: 0, pendingJudge: 0, scored: 0, void: 0, voidRate: 0, publicationCoverage: 0 },
    byDomain: [],
    byGenerationOrigin: [],
    calibration: [],
    degraded: true,
    stale: false,
    error: 'forecast_scorecard_backend_unavailable',
  };
}

function forecast(): Forecast {
  return {
    id: 'fc-1',
    title: 'Ceasefire holds through October',
    probability: 0.62,
    domain: 'conflict',
    region: 'Middle East',
    trend: 'stable',
    signals: [],
  } as unknown as Forecast;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function stubScorecardFetch(respond: () => Promise<Response>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(SCORECARD_PATH)) return respond();
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

function contentOf(panel: ForecastPanel): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

async function stripIn(panel: ForecastPanel, kind: string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const strip = contentOf(panel).querySelector<HTMLElement>(`[data-fc-record="${kind}"]`);
    expect(strip, `strip in state ${kind}`).not.toBeNull();
    return strip!;
  });
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
  document.body.innerHTML = '';
});

describe('ForecastPanel track-record strip', () => {
  it('shows a loading note until the scorecard request settles', async () => {
    const gate = deferred<Response>();
    stubScorecardFetch(() => gate.promise);

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'loading');
    expect(strip.textContent).toContain('Loading');
    expect(strip.textContent).not.toContain('Brier');

    gate.resolve(Response.json(readyScorecard()));
    await stripIn(panel, 'ready');
  });

  it('updates only the strip when the scorecard settles, so open forecast panes survive', async () => {
    const gate = deferred<Response>();
    stubScorecardFetch(() => gate.promise);

    panel.updateForecasts([forecast()]);
    await stripIn(panel, 'loading');
    const row = contentOf(panel).querySelector('.fc-prob-item');
    expect(row).not.toBeNull();

    gate.resolve(Response.json(readyScorecard()));
    await stripIn(panel, 'ready');
    expect(row!.isConnected, 'the forecast row was not rebuilt').toBe(true);
  });

  it('links to the hosted record from the desktop app, where /accuracy/ is not bundled', () => {
    expect(recordHref(false)).toBe('/accuracy/');
    expect(recordHref(true)).toBe('https://www.worldmonitor.app/accuracy/');
  });

  it('renders the headline Brier, base-rate comparison, and void rate, each with its sample size', async () => {
    stubScorecardFetch(async () => Response.json(readyScorecard()));

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'ready');
    const text = strip.textContent ?? '';

    expect(text).toContain('Brier 0.182 (n=42)');
    // p = 13/42; always answering p scores p(1-p) = 0.2137.
    expect(text).toContain('Base rate 0.214 (n=42)');
    expect(text).toContain('Void 8.3% (5 of 60)');
    expect(text).not.toContain('Out of date');

    const link = strip.querySelector<HTMLAnchorElement>('a.fc-record-link');
    expect(link?.getAttribute('href')).toBe('/accuracy/');
    expect(link?.textContent).toContain('Full record');

    const hinted = Array.from(strip.querySelectorAll<HTMLElement>('.fc-record-item'));
    expect(hinted.length).toBe(3);
    for (const item of hinted) expect(item.getAttribute('title')?.length ?? 0).toBeGreaterThan(20);
  });

  it('omits the base-rate comparison when the seed predates skill.yesCount', async () => {
    const seed = readyScorecard();
    delete (seed.skill as unknown as Record<string, unknown>).yesCount;
    stubScorecardFetch(async () => Response.json(seed));

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'ready');
    expect(strip.textContent).toContain('Brier 0.182 (n=42)');
    expect(strip.textContent).not.toContain('Base rate');
  });

  it('marks a stale record as out of date while keeping the numbers visible', async () => {
    stubScorecardFetch(async () => Response.json(readyScorecard({ stale: true })));

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'ready');
    expect(strip.textContent).toContain('Out of date');
    expect(strip.textContent).toContain('Brier 0.182 (n=42)');
    expect(strip.querySelector('.fc-record-stale')?.getAttribute('title')).toContain('2026');
  });

  it('says there are not enough graded forecasts instead of showing a zero Brier', async () => {
    const seed = readyScorecard({
      skill: { count: 0, excludedScored: 13, excludedOrigins: ['synthetic_backfill'], yesCount: 0 },
    });
    stubScorecardFetch(async () => Response.json(seed));

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'insufficient');
    const text = strip.textContent ?? '';
    expect(text).toContain('Not enough graded forecasts yet');
    expect(text).not.toContain('Brier');
    expect(text).not.toContain('n=0');
    expect(text).not.toContain('0.000');
    expect(strip.querySelector('a.fc-record-link')?.getAttribute('href')).toBe('/accuracy/');
  });

  it('shows the record as unavailable on a degraded response, never as zeros', async () => {
    stubScorecardFetch(async () => Response.json(degradedScorecard()));

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'unavailable');
    const text = strip.textContent ?? '';
    expect(text).toContain('Unavailable right now');
    expect(text).not.toContain('Brier');
    expect(text).not.toContain('0.000');
    expect(text).not.toContain('n=0');
    expect(text).not.toContain('0 of 0');
    expect(text).not.toContain('0%');
  });

  it('shows the record as unavailable when the request itself fails', async () => {
    stubScorecardFetch(async () => new Response('forbidden', { status: 403 }));

    panel.updateForecasts([forecast()]);
    const strip = await stripIn(panel, 'unavailable');
    expect(strip.textContent).toContain('Unavailable right now');
    expect(strip.textContent).not.toContain('Brier');
  });

  it('keeps the strip when the forecast list itself is empty', async () => {
    stubScorecardFetch(async () => Response.json(readyScorecard()));

    panel.updateForecasts([], { generatedAt: 0, degraded: false, stale: false, error: 'forecast_bootstrap_unavailable' });
    const strip = await stripIn(panel, 'ready');
    expect(strip.textContent).toContain('Brier 0.182 (n=42)');
  });
});
