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
import { readdirSync, readFileSync } from 'node:fs';
// @ts-expect-error -- untyped seeder module; this test reads the void-reason label table.
import { RECEIPT_VOID_REASON_LABELS } from '../../scripts/_forecast-scorecard.mjs';

import { initTestI18n } from './helpers/i18n.mts';

// Pins the lifted state; forecast-panel-under-audit.test.mts pins the audited one (#8990).
vi.mock('../../shared/forecast-accuracy-audit', () => ({ FORECAST_ACCURACY_AUDIT: null }));

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

  it('translates every resolution string in every catalog, with the reviewed domain terms', () => {
    const resolution = (locale: string) => JSON.parse(readFileSync(`src/locales/${locale}.json`, 'utf8')).components.forecast.resolution;
    const flat = (o: Record<string, unknown>, prefix = ''): [string, string][] => Object.entries(o)
      .flatMap(([k, v]) => (typeof v === 'object' && v ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]]));
    const en = new Map(flat(resolution('en')));
    const locales = readdirSync('src/locales').filter((f) => f.endsWith('.json') && !f.startsWith('en.')).map((f) => f.slice(0, -5));
    expect(locales).toHaveLength(27);
    for (const locale of locales) {
      const strings = new Map(flat(resolution(locale)));
      expect([...strings.keys()].sort(), locale).toEqual([...en.keys()].sort());
      for (const [key, value] of strings) {
        if (!key.startsWith('outcome.')) expect(value, `${locale} ${key} is untranslated`).not.toBe(en.get(key));
        for (const slot of en.get(key)!.match(/\{\{\w+\}\}/g) ?? []) expect(value, `${locale} ${key}`).toContain(slot);
      }
    }
    expect(resolution('de').void.no_establishable_metric).toContain('keinen Messwert');
    expect(resolution('zh').last).toContain('上次');
    expect(resolution('zh-TW').last).toContain('上次');
    expect(resolution('ar').void.missing_deadline).toContain('موعدًا نهائيًا');
    expect(resolution('bg').void.other, 'Bulgarian, not Russian').not.toMatch(/может/);
    expect(resolution('ja').lastSr).not.toContain('フォーキャスト');
    expect(Object.keys(resolution('en').void)).toContain('withheld_unpublished');
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
    expect(card!.querySelector('.fc-res-reasons')?.textContent).toBe('Recent windows, newest first: YES, NO, VOID (The judges disagreed)');
    const voidMark = history!.querySelector<HTMLElement>('[data-outcome="VOID"]');
    expect(voidMark?.getAttribute('title')).toBe('The judges disagreed');
    expect(history!.querySelector('[data-outcome="YES"]')?.hasAttribute('title')).toBe(false);
  });

  it('names the reason when the last window was voided', async () => {
    const [card] = await cardsWith([{ forecastId: 'fc-v', outcome: 'VOID', voidReason: 'no_archive_evidence' }], ['fc-v']);
    const chip = card!.querySelector<HTMLElement>('.fc-res-chip');
    expect(chip?.dataset.outcome).toBe('VOID');
    expect(chip?.textContent).toContain('Last: VOID');
    expect(chip?.getAttribute('title')).toBe('The news archive had nothing on the subject');
    expect(card!.querySelector('.fc-res-history'), 'one window needs no history').toBeNull();
  });

  it('puts a VOID reason behind a disclosure that touch and keyboard users can open', async () => {
    const [voided, history, plain] = await cardsWith([
      { forecastId: 'fc-v', outcome: 'VOID', voidReason: 'no_archive_evidence' },
      { forecastId: 'fc-h', outcome: 'YES', voidReason: '' },
      { forecastId: 'fc-h', outcome: 'VOID', voidReason: 'judge_disagreement' },
      { forecastId: 'fc-p', outcome: 'NO', voidReason: '' },
    ], ['fc-v', 'fc-h', 'fc-p']);
    const disclosure = voided!.querySelector<HTMLDetailsElement>('details.fc-res-void');
    expect(disclosure, 'a VOID window opens a disclosure').not.toBeNull();
    expect(disclosure!.open).toBe(false);
    expect(disclosure!.querySelector(':scope > summary .fc-res-chip')).not.toBeNull();
    const reason = disclosure!.querySelector<HTMLElement>(':scope > .fc-res-reasons');
    expect(reason?.textContent).toBe('The news archive had nothing on the subject');
    expect(reason?.closest('.fc-sr-only, [aria-hidden="true"]')).toBeNull();
    const earlier = history!.querySelector<HTMLDetailsElement>('details.fc-res-void');
    expect(earlier?.querySelector(':scope > summary .fc-res-history')).not.toBeNull();
    expect(earlier?.querySelector('.fc-res-reasons')?.textContent).toBe('Recent windows, newest first: YES, VOID (The judges disagreed)');
    expect(plain!.querySelector('details'), 'nothing to disclose without a VOID').toBeNull();
    expect(plain!.querySelector('.fc-res-chip')).not.toBeNull();
  });

  it('opens the VOID disclosure without toggling the card row', async () => {
    const [card] = await cardsWith([{ forecastId: 'fc-v', outcome: 'VOID', voidReason: 'judge_disagreement' }], ['fc-v']);
    const toggleRow = card!.querySelector<HTMLElement>('.fc-toggle-row')!;
    const before = toggleRow.style.display;
    card!.querySelector<HTMLElement>('details.fc-res-void > summary')!.click();
    expect(card!.querySelector<HTMLDetailsElement>('details.fc-res-void')!.open).toBe(true);
    expect(toggleRow.style.display).toBe(before);
  });

  it('keeps an open VOID disclosure open across re-renders and the scorecard patch, keyed by forecast id', async () => {
    const outcomes = [
      { forecastId: 'fc-v', outcome: 'VOID', voidReason: 'judge_disagreement' },
      { forecastId: 'fc-w', outcome: 'VOID', voidReason: 'no_archive_evidence' },
    ];
    const [card] = await cardsWith(outcomes, ['fc-v', 'fc-w']);
    card!.querySelector<HTMLElement>('details.fc-res-void > summary')!.click();
    await vi.waitFor(() => expect(card!.querySelector<HTMLDetailsElement>('details.fc-res-void')!.open).toBe(true));
    panel.updateForecasts([forecast('fc-v'), forecast('fc-w')]);
    await settled(panel);
    const openState = () => ['fc-v', 'fc-w'].map((id) => cardFor(panel, id).querySelector<HTMLDetailsElement>('details.fc-res-void')!.open);
    await vi.waitFor(() => expect((panel as unknown as { recordPromise: unknown }).recordPromise).toBeNull());
    expect(openState(), 'only the opened card stays open').toEqual([true, false]);
    cardFor(panel, 'fc-v').querySelector<HTMLElement>('details.fc-res-void > summary')!.click();
    await vi.waitFor(() => expect(openState()[0]).toBe(false));
    panel.updateForecasts([forecast('fc-v'), forecast('fc-w')]);
    await vi.waitFor(() => expect((panel as unknown as { recordPromise: unknown }).recordPromise).toBeNull());
    expect(openState(), 'a closed disclosure stays closed').toEqual([false, false]);
  });

  it('reserves the same line slots while loading and once loaded, whatever the family history', async () => {
    let release!: (r: Response) => void;
    stubScorecard(() => new Promise<Response>((resolve) => { release = resolve; }));
    const ids = ['fc-none', 'fc-one', 'fc-many', 'fc-void'];
    panel.updateForecasts(ids.map(forecast));
    await vi.waitFor(() => cardFor(panel, 'fc-none'));
    const shape = (id: string) => {
      const meta = cardFor(panel, id).querySelector<HTMLElement>('[data-fc-reliability]')!;
      const slot = meta.querySelector<HTMLElement>(':scope > .fc-res-slot');
      const lines = slot?.querySelector(':scope > details > summary') ?? slot;
      return {
        children: Array.from(meta.children).map((el) => (el.classList.contains('fc-res-slot') ? 'slot' : 'badge')),
        lines: lines ? Array.from(lines.children).filter((el) => !el.classList.contains('fc-sr-only')).length : 0,
      };
    };
    const loading = ids.map(shape);
    release(Response.json(scorecard([
      { forecastId: 'fc-one', outcome: 'YES', voidReason: '' },
      { forecastId: 'fc-many', outcome: 'NO', voidReason: '' },
      { forecastId: 'fc-many', outcome: 'YES', voidReason: '' },
      { forecastId: 'fc-void', outcome: 'VOID', voidReason: 'other' },
      { forecastId: 'fc-void', outcome: 'NO', voidReason: '' },
    ])));
    await vi.waitFor(() => expect(cardFor(panel, 'fc-many').querySelector('.fc-res-chip')).not.toBeNull());
    const loaded = ids.map(shape);
    for (const s of [...loading, ...loaded]) expect(s).toEqual({ children: ['slot', 'badge'], lines: 2 });
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

  it('names the #5233 envelope-bug void instead of falling back to other', async () => {
    const [card] = await cardsWith([{ forecastId: 'fc-env', outcome: 'VOID', voidReason: 'resolver_envelope_bug' }], ['fc-env']);
    expect(card!.querySelector('.fc-res-chip')?.getAttribute('title')).toBe('Scored against a data feed we could not read correctly');
    expect(card!.querySelector('.fc-res-reasons')?.textContent).toBe('Scored against a data feed we could not read correctly');
  });

  it('shows nothing on a card whose family has no resolved window', async () => {
    const [card] = await cardsWith([{ forecastId: 'fc-other', outcome: 'YES', voidReason: '' }], ['fc-new']);
    expect(card!.querySelector('.fc-res-chip')).toBeNull();
    expect(card!.querySelector('.fc-reliability'), 'the badge still renders').not.toBeNull();
  });

  it('shows no chips when the scorecard fails or is degraded', async () => {
    const [degraded] = await cardsWith([{ forecastId: 'fc-a', outcome: 'YES', voidReason: '' }], ['fc-a'], { degraded: true, error: '' });
    expect(degraded!.querySelector('.fc-res-chip'), 'degraded with no error').toBeNull();
    vi.restoreAllMocks();
    panel.destroy();
    panel = new ForecastPanel();
    document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
    const [failed] = await cardsWith([{ forecastId: 'fc-a', outcome: 'YES', voidReason: '' }], ['fc-a'], { error: 'forecast_scorecard_backend_unavailable' });
    expect(failed!.querySelector('.fc-res-chip'), 'error with degraded false').toBeNull();
    vi.restoreAllMocks();
    panel.destroy();
    panel = new ForecastPanel();
    document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
    stubScorecard(async () => new Response('forbidden', { status: 403 }));
    panel.updateForecasts([forecast('fc-a')]);
    await settled(panel);
    expect(cardFor(panel, 'fc-a').querySelector('.fc-res-chip')).toBeNull();
  });

  it('lays the chip line out by column width, never by data: one line when wide, a fixed stack of line boxes when narrow', () => {
    new ForecastPanel().destroy();
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    const rule = (selector: string) => css.match(new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`))?.[0] ?? '';
    expect(rule('.fc-card-meta')).toMatch(/contain:\s*inline-size/);
    expect(rule('.fc-res-chip')).not.toMatch(/(^|[;{\s])border:/);
    expect(rule('.fc-reliability')).not.toMatch(/contain:/);
    // Wrapping would make a card's height depend on how many outcomes it has, which shifts cards when the scorecard lands.
    expect(rule('.fc-card-meta'), 'a closed row never wraps').not.toMatch(/flex-wrap/);
    expect(rule('.fc-prob-label')).toMatch(/container-type:\s*inline-size/);
    const narrow = css.match(/@container \(max-width: \d+px\) \{[\s\S]*?\n {4}\}/g) ?? [];
    expect(narrow, 'two width steps').toHaveLength(2);
    expect(narrow[0]).toMatch(/\.fc-card-meta \{[^}]*flex-direction:\s*column/);
    expect(narrow[0]).toMatch(/\.fc-res-gap \{[^}]*display:\s*block/);
    expect(narrow[1]).toMatch(/\.fc-res-slot, \.fc-res-void > summary \{[^}]*flex-direction:\s*column/);
    const badge = rule('.fc-card-meta .fc-reliability');
    expect(badge).toMatch(/flex:\s*1 1 \d+(\.\d+)?em/);
    expect(badge).toMatch(/max-width:\s*max-content/);
    // A label column narrower than one chip clips the chip inside the column instead of spilling over the probability bar.
    for (const selector of ['.fc-res-chip, .fc-res-history, .fc-res-gap', '.fc-res-void']) {
      expect(rule(selector), selector).toMatch(/min-width:\s*0/);
      expect(rule(selector), selector).not.toMatch(/flex:\s*none/);
    }
    expect(rule('.fc-res-chip, .fc-res-history, .fc-res-gap')).toMatch(/overflow:\s*hidden/);
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
