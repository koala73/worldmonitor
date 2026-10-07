/**
 * #5092 — per-card resolution chips and family history in ForecastPanel.
 *
 * A live card is the family's open window, so its chip shows the family's
 * most recent resolved window and the history shows its last few outcomes,
 * both from the scorecard's `familyOutcomes` (newest first per forecast id).
 * Cards with no resolved earlier window, and every card when the scorecard
 * fails or is degraded, show nothing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';
import { VOID_REASON_CODES } from '@/components/forecast-record';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- untyped seeder module; this test reads the void-reason label table.
import { RECEIPT_VOID_REASON_LABELS } from '../../scripts/_forecast-scorecard.mjs';

import { initTestI18n } from './helpers/i18n.mts';

const SCORECARD_PATH = '/api/forecast/v1/get-forecast-scorecard';

type FamilyOutcome = NonNullable<GetForecastScorecardResponse['familyOutcomes']>[number];

function scorecard(familyOutcomes: FamilyOutcome[], overrides: Partial<GetForecastScorecardResponse> = {}): GetForecastScorecardResponse {
  return {
    schemaVersion: 2,
    generatedAt: Date.parse('2026-10-06T06:00:00Z'),
    rollingWindowDays: 180,
    methodology: '',
    totals: { entries: 240, resolved: 60, pending: 150, pendingJudge: 30, scored: 55, void: 5, voidRate: 5 / 60, publicationCoverage: 0.9 },
    overall: { count: 55, brier: 0.19, logScore: -0.5 },
    byDomain: [],
    byGenerationOrigin: [],
    calibration: [],
    skill: { count: 42, brier: 0.182, logScore: -0.51, excludedScored: 13, excludedOrigins: [], yesCount: 13 },
    publishedByDomain: [{ domain: 'conflict', count: 45, brier: 0.2134, yesCount: 15 }],
    receipts: [],
    familyOutcomes,
    degraded: false,
    stale: false,
    error: '',
    ...overrides,
  };
}

function forecast(id: string): Forecast {
  return { id, title: `Forecast ${id}`, probability: 0.62, domain: 'conflict', region: 'Middle East', trend: 'stable', signals: [] } as unknown as Forecast;
}

function stubScorecard(respond: () => Promise<Response>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(SCORECARD_PATH)) return respond();
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

function contentOf(panel: ForecastPanel): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function cardFor(panel: ForecastPanel, id: string): HTMLElement {
  const card = Array.from(contentOf(panel).querySelectorAll<HTMLElement>('.fc-prob-item'))
    .find((el) => el.querySelector('.fc-forecast-title')?.textContent === `Forecast ${id}`);
  expect(card, `card ${id}`).toBeDefined();
  return card!;
}

async function settled(panel: ForecastPanel): Promise<void> {
  await vi.waitFor(() => {
    expect(contentOf(panel).querySelector('[data-fc-record="loading"]')).toBeNull();
    expect(contentOf(panel).querySelector('[data-fc-record]')).not.toBeNull();
  });
}

async function cardsWith(outcomes: FamilyOutcome[], ids: string[], overrides: Partial<GetForecastScorecardResponse> = {}): Promise<HTMLElement[]> {
  stubScorecard(async () => Response.json(scorecard(outcomes, overrides)));
  panel.updateForecasts(ids.map(forecast));
  await settled(panel);
  return ids.map((id) => cardFor(panel, id));
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

describe('ForecastPanel resolution chips', () => {
  it('knows every public void reason, worded as the /accuracy/ receipts word it', () => {
    expect([...VOID_REASON_CODES].sort()).toEqual(Object.keys(RECEIPT_VOID_REASON_LABELS).sort());
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).components.forecast.resolution.void;
    expect(en).toEqual(RECEIPT_VOID_REASON_LABELS);
  });

  it("shows the family's last resolved window and its recent history, newest first", async () => {
    const [card] = await cardsWith([
      { forecastId: 'fc-a', outcome: 'YES', voidReason: '' },
      { forecastId: 'fc-a', outcome: 'NO', voidReason: '' },
      { forecastId: 'fc-a', outcome: 'VOID', voidReason: 'judge_disagreement' },
    ], ['fc-a']);
    const chip = card!.querySelector<HTMLElement>('.fc-res-chip');
    expect(chip?.dataset.outcome).toBe('YES');
    expect(chip?.textContent).toContain('Last: YES');
    const history = card!.querySelector<HTMLElement>('.fc-res-history');
    expect(Array.from(history!.querySelectorAll<HTMLElement>('[data-outcome]')).map((el) => el.dataset.outcome)).toEqual(['YES', 'NO', 'VOID']);
    expect(history!.textContent).toContain('Recent windows, newest first: YES, NO, VOID');
  });

  it('names the reason when the last window was voided', async () => {
    const [card] = await cardsWith([{ forecastId: 'fc-v', outcome: 'VOID', voidReason: 'no_archive_evidence' }], ['fc-v']);
    const chip = card!.querySelector<HTMLElement>('.fc-res-chip');
    expect(chip?.dataset.outcome).toBe('VOID');
    expect(chip?.textContent).toContain('Last: VOID');
    expect(chip?.getAttribute('title')).toBe('The news archive had nothing on the subject');
    expect(chip?.textContent).toContain('The news archive had nothing on the subject');
    expect(card!.querySelector('.fc-res-history'), 'one window needs no history').toBeNull();
  });

  it('never renders an unknown reason or outcome as text', async () => {
    const [card, other] = await cardsWith([
      { forecastId: 'fc-x', outcome: 'VOID', voidReason: '<img src=x onerror=alert(1)>' },
      { forecastId: 'fc-y', outcome: '<b>MAYBE</b>', voidReason: '' },
    ], ['fc-x', 'fc-y']);
    expect(card!.querySelector('img')).toBeNull();
    expect(card!.querySelector('.fc-res-chip')?.getAttribute('title')).toBe('Could not be resolved');
    expect(other!.querySelector('.fc-res-chip')).toBeNull();
    expect(other!.innerHTML).not.toContain('MAYBE');
  });

  it('shows nothing on a card whose family has no resolved window', async () => {
    const [card] = await cardsWith([{ forecastId: 'fc-other', outcome: 'YES', voidReason: '' }], ['fc-new']);
    expect(card!.querySelector('.fc-res-chip')).toBeNull();
    expect(card!.querySelector('.fc-reliability'), 'the badge still renders').not.toBeNull();
  });

  it('shows no chips when the scorecard fails or is degraded', async () => {
    const [degraded] = await cardsWith([{ forecastId: 'fc-a', outcome: 'YES', voidReason: '' }], ['fc-a'], { degraded: true, error: 'forecast_scorecard_backend_unavailable' });
    expect(degraded!.querySelector('.fc-res-chip')).toBeNull();
    vi.restoreAllMocks();
    panel.destroy();
    panel = new ForecastPanel();
    document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
    stubScorecard(async () => new Response('forbidden', { status: 403 }));
    panel.updateForecasts([forecast('fc-a')]);
    await settled(panel);
    expect(cardFor(panel, 'fc-a').querySelector('.fc-res-chip')).toBeNull();
  });

  it('keeps chips and badge on one line without growing it: no border on the chip, the row sizes to its column', () => {
    new ForecastPanel().destroy();
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    const rule = (selector: string) => css.match(new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`))?.[0] ?? '';
    expect(rule('.fc-card-meta')).toMatch(/contain:\s*inline-size/);
    expect(rule('.fc-res-chip')).not.toMatch(/(^|[;{\s])border:/);
    expect(rule('.fc-reliability')).not.toMatch(/contain:/);
  });

  it('patches chips in place beside the badge, on the same line slot', async () => {
    let release!: (r: Response) => void;
    stubScorecard(() => new Promise<Response>((resolve) => { release = resolve; }));
    panel.updateForecasts([forecast('fc-a')]);
    const card = await vi.waitFor(() => cardFor(panel, 'fc-a'));
    release(Response.json(scorecard([{ forecastId: 'fc-a', outcome: 'NO', voidReason: '' }])));
    await vi.waitFor(() => expect(card.querySelector('.fc-res-chip')).not.toBeNull());
    expect(card.isConnected).toBe(true);
    const slot = card.querySelector<HTMLElement>('[data-fc-reliability]')!;
    expect(slot.querySelector('.fc-res-chip')).not.toBeNull();
    expect(slot.querySelector('.fc-reliability')).not.toBeNull();
  });
});
