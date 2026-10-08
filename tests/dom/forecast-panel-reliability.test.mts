/**
 * #5092 — the per-card reliability badge in ForecastPanel.
 *
 * Each forecast card shows how its domain has scored, from the
 * published-origin per-domain rows (`publishedByDomain`) of the same
 * get-forecast-scorecard response the track-record strip reads. The pooled
 * `byDomain` rows mix shadow and synthetic origins, so the badge must never
 * read them. The domain's skill against its historical rate shows once the
 * seeder wrote the row's bss, which it does only for a domain that meets the
 * family minimums (#8990); "not yet measured" otherwise, and nothing when the
 * scorecard is unavailable. The badge links to /accuracy/.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';
import { SKILL_MIN_FAMILIES, SKILL_MIN_OUTCOME_FAMILIES, reliabilityHref } from '@/components/forecast-record';
import { readdirSync, readFileSync } from 'node:fs';
// @ts-expect-error -- untyped seeder module; this test reads two numeric constants from it.
import * as producer from '../../scripts/_forecast-scorecard.mjs';

import { initTestI18n } from './helpers/i18n.mts';

// Pins the lifted state; forecast-panel-under-audit.test.mts pins the audited one (#8990).
vi.mock('../../shared/forecast-accuracy-audit', () => ({ FORECAST_ACCURACY_AUDIT: null }));

const SCORECARD_PATH = '/api/forecast/v1/get-forecast-scorecard';

type PublishedDomain = NonNullable<GetForecastScorecardResponse['publishedByDomain']>[number];

/** bss is present only on a domain the seeder found measurable. */
function published(domain: string, count: number, brier: number, yesCount: number, bss?: number): PublishedDomain {
  return { domain, count, brier, yesCount, ...(bss === undefined ? {} : { bss }) };
}

/** A pooled market row with a large all-origin sample the badge must ignore. */
const POOLED_MARKET = { domain: 'market', resolved: 420, scored: 400, void: 20, voidRate: 20 / 420, brier: 0.243, logScore: -0.7 };

function scorecard(rows: PublishedDomain[], overrides: Partial<GetForecastScorecardResponse> = {}): GetForecastScorecardResponse {
  return {
    schemaVersion: 2,
    generatedAt: Date.parse('2026-10-05T06:00:00Z'),
    rollingWindowDays: 180,
    methodology: '',
    totals: { entries: 240, resolved: 60, pending: 150, pendingJudge: 30, scored: 55, void: 5, voidRate: 5 / 60, publicationCoverage: 0.9 },
    overall: { count: 55, brier: 0.19, logScore: -0.5 },
    byDomain: [POOLED_MARKET],
    byGenerationOrigin: [],
    calibration: [],
    skill: { count: 42, brier: 0.182, logScore: -0.51, excludedScored: 13, excludedOrigins: [], yesCount: 13 },
    publishedByDomain: rows,
    familyOutcomes: [],
    receipts: [],
    degraded: false,
    stale: false,
    error: '',
    ...overrides,
  };
}

function forecast(id: string, domain: string): Forecast {
  return {
    id,
    title: `Forecast ${id}`,
    probability: 0.62,
    domain,
    region: 'Middle East',
    trend: 'stable',
    signals: [],
  } as unknown as Forecast;
}

function stubScorecard(respond: () => Promise<Response>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(SCORECARD_PATH)) return respond();
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

function contentOf(panel: ForecastPanel): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function cardFor(panel: ForecastPanel, title: string): HTMLElement {
  const card = Array.from(contentOf(panel).querySelectorAll<HTMLElement>('.fc-prob-item'))
    .find((el) => el.querySelector('.fc-forecast-title')?.textContent === title);
  expect(card, `card ${title}`).toBeDefined();
  return card!;
}

async function settled(panel: ForecastPanel): Promise<void> {
  await vi.waitFor(() => {
    expect(contentOf(panel).querySelector('[data-fc-record="loading"]')).toBeNull();
    expect(contentOf(panel).querySelector('[data-fc-record]')).not.toBeNull();
  });
}

async function badgesFor(rows: PublishedDomain[], domains: string[], overrides: Partial<GetForecastScorecardResponse> = {}): Promise<HTMLAnchorElement[]> {
  stubScorecard(async () => Response.json(scorecard(rows, overrides)));
  panel.updateForecasts(domains.map((domain, i) => forecast(`fc-${i}`, domain)));
  await settled(panel);
  return domains.map((_, i) => {
    const badge = cardFor(panel, `Forecast fc-${i}`).querySelector<HTMLAnchorElement>('a.fc-reliability');
    expect(badge, `badge for fc-${i}`).not.toBeNull();
    return badge!;
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
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ForecastPanel reliability badge', () => {
  it('names the scorecard family minimums in its hint', () => {
    expect(SKILL_MIN_FAMILIES).toBe(producer.SKILL_MIN_FAMILIES);
    expect(SKILL_MIN_OUTCOME_FAMILIES).toBe(producer.SKILL_MIN_OUTCOME_FAMILIES);
  });

  it('leads with the domain skill against its historical rate, with the Brier pair in the hint', async () => {
    // p = 15/45, p(1-p) = 0.2222, so the seeder's bss is 1 - 0.2134 / 0.2222 = 0.04.
    const [badge, worse] = await badgesFor(
      [published('conflict', 45, 0.2134, 15, 0.0398), published('market', 45, 0.3, 15, -0.35)],
      ['conflict', 'market'],
    );
    expect(badge!.dataset.fcReliabilityState).toBe('measured');
    expect(badge!.textContent).toBe('Conflict n=45 · skill +0.04 vs historical rate');
    expect(worse!.textContent).toBe('Market n=45 · skill -0.35 vs historical rate');
    expect(badge!.getAttribute('href')).toBe('/accuracy/#by-domain');
    const hint = badge!.getAttribute('aria-label') ?? '';
    expect(hint).toContain('45');
    expect(hint).toContain('Brier 0.213 against 0.222 for the historical rate');
    expect(hint).toContain('above 0 is better, below 0 is worse');
    expect(hint).not.toMatch(/coin flip/i);
  });

  it('links to the published domain table, hosted on desktop', () => {
    expect(reliabilityHref(false)).toBe('/accuracy/#by-domain');
    expect(reliabilityHref(true)).toBe('https://www.worldmonitor.app/accuracy/#by-domain');
  });

  it('carries its hint once, in the accessible name, with no duplicate title', async () => {
    const [badge] = await badgesFor([published('conflict', 45, 0.2134, 15)], ['conflict']);
    expect(badge!.hasAttribute('title')).toBe(false);
    expect(badge!.getAttribute('aria-label')).toContain('45');
  });

  it('keeps a long badge on one line with an ellipsis', () => {
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    const rule = css.match(/\.fc-reliability\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    // A block link spans the label column; fit-content keeps blank space beside it unclickable.
    expect(rule).toMatch(/width:\s*fit-content/);
    expect(rule).toMatch(/max-width:\s*100%/);
    // Size containment gives the badge a zero intrinsic width, so fit-content collapses it to 0px.
    expect(rule).not.toMatch(/contain:/);
    // Without it the 1fr label track grows to the badge's nowrap width and pushes the other columns out.
    const label = css.match(/\.fc-prob-label\s*\{[^}]*\}/)?.[0] ?? '';
    expect(label).toMatch(/min-width:\s*0/);
  });

  it('treats a non-integer yesCount as unmeasured, matching the /accuracy/ table', async () => {
    const [badge] = await badgesFor([published('conflict', 45, 0.2134, 15.5, 0.04)], ['conflict']);
    expect(badge!.dataset.fcReliabilityState).toBe('unmeasured');
  });

  it('uses corrected hu, el and de wording', () => {
    const locale = (code: string) => JSON.parse(readFileSync(`src/locales/${code}.json`, 'utf8')).components.forecast.reliability;
    const hu = locale('hu');
    expect(hu.measured).toContain('történelmi arány');
    expect(JSON.stringify(hu)).not.toContain('alapsáv');
    const el = locale('el');
    expect(JSON.stringify(el).replace(/\{\{\w+\}\}/g, '')).not.toMatch(/base rate|domain/i);
    expect(locale('de').unmeasuredHint).not.toContain('Domain');
    expect(locale('de').unmeasuredHint).toContain('Bereich');
    expect(locale('cs').measured).toContain('historická míra');
    expect(JSON.stringify(locale('de'))).not.toContain('Domain');
    for (const file of readdirSync('src/locales').filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f) && f !== 'en.json')) {
      expect(locale(file.replace('.json', '')).measured, file).not.toMatch(/base rate|historical rate/i);
    }
  });

  it('never reads the pooled all-origin byDomain row', async () => {
    const [market, cyber] = await badgesFor([published('market', 12, 0.2, 4)], ['market', 'cyber']);
    for (const badge of [market!, cyber!]) {
      expect(badge.dataset.fcReliabilityState).toBe('unmeasured');
      expect(badge.textContent).not.toContain('0.243');
      expect(badge.getAttribute('aria-label')).not.toContain('400');
    }
    expect(market!.getAttribute('aria-label')).toContain('12');
  });

  it('shows no badge when the response predates publishedByDomain', async () => {
    const absent = scorecard([]);
    delete (absent as unknown as Record<string, unknown>).publishedByDomain;
    // The handler fills a missing field with [], so a schema-1 seed reads as an empty list.
    const backfilled = scorecard([], { schemaVersion: 1 });
    for (const legacy of [absent, backfilled]) {
      stubScorecard(async () => Response.json(legacy));
      panel.updateForecasts([forecast('fc-1', 'market')]);
      await settled(panel);
      expect(contentOf(panel).querySelector('.fc-reliability')).toBeNull();
      vi.restoreAllMocks();
      panel.destroy();
      panel = new ForecastPanel();
      document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
    }
  });

  it('says not yet measured when a current seed has no published-origin entries', async () => {
    const [badge] = await badgesFor([], ['market']);
    expect(badge!.dataset.fcReliabilityState).toBe('unmeasured');
  });

  it('gates on the seeder family verdict: many rows without bss stay unmeasured, a row with bss is measured (#8990)', async () => {
    const [many, gated] = await badgesFor(
      [published('conflict', 300, 0.2, 100), published('market', 30, 0.21, 10, 0.055)],
      ['conflict', 'market'],
    );
    expect(many!.dataset.fcReliabilityState).toBe('unmeasured');
    expect(many!.textContent).not.toContain('skill');
    const hint = many!.getAttribute('aria-label') ?? '';
    expect(hint).toContain('300');
    expect(hint).toContain('at least 30 separate forecast questions, with at least 5 that came true and 5 that did not');
    expect(gated!.dataset.fcReliabilityState).toBe('measured');
    expect(gated!.textContent).toBe('Market n=30 · skill +0.06 vs historical rate');
  });

  it('says not yet measured below the minimum and for a domain with no published row', async () => {
    const [market, cyber] = await badgesFor([published('market', 12, 0.31, 3)], ['market', 'cyber']);
    for (const [badge, n] of [[market!, '12'], [cyber!, '0']] as const) {
      expect(badge.dataset.fcReliabilityState).toBe('unmeasured');
      expect(badge.textContent).toContain('Not yet measured');
      expect(badge.textContent).not.toContain('Brier');
      expect(badge.textContent).not.toContain('0.310');
      expect(badge.getAttribute('aria-label')).toContain(n);
      expect(badge.getAttribute('href')).toBe('/accuracy/#by-domain');
    }
  });

  it('marks badges from a stale scorecard as out of date', async () => {
    const [measured, unmeasured] = await badgesFor(
      [published('conflict', 45, 0.2134, 15, 0.0398)],
      ['conflict', 'cyber'],
      { stale: true },
    );
    // Stale and n lead, so an ellipsis on a narrow card never cuts them.
    expect(measured!.textContent).toBe('Out of date · Conflict n=45 · skill +0.04 vs historical rate');
    expect(unmeasured!.textContent).toBe('Out of date · Not yet measured');
  });

  it('names the domain and says it is the domain record in the accessible name', async () => {
    const [measured, unmeasured] = await badgesFor([published('conflict', 45, 0.2134, 15, 0.0398)], ['conflict', 'cyber']);
    const measuredName = measured!.getAttribute('aria-label') ?? '';
    expect(measuredName).toContain('Conflict');
    expect(measuredName).toContain("This is the domain's record, not this forecast's");
    const unmeasuredName = unmeasured!.getAttribute('aria-label') ?? '';
    expect(unmeasuredName).toContain('Not yet measured');
    expect(unmeasuredName).toContain('Cyber');
  });

  it('reserves one line for the badge while the scorecard loads, then releases it', async () => {
    let release!: (r: Response) => void;
    stubScorecard(() => new Promise<Response>((resolve) => { release = resolve; }));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    const card = await vi.waitFor(() => cardFor(panel, 'Forecast fc-1'));
    const slot = card.querySelector<HTMLElement>('[data-fc-reliability]')!;
    expect(slot.classList.contains('fc-reliability-pending')).toBe(true);
    expect(slot.querySelector('.fc-reliability-placeholder')?.getAttribute('aria-hidden')).toBe('true');

    release(new Response('forbidden', { status: 403 }));
    await vi.waitFor(() => expect(slot.classList.contains('fc-reliability-pending')).toBe(false));
    expect(slot.querySelector('.fc-reliability')).toBeNull();
    expect(slot.querySelector('.fc-reliability-placeholder')).toBeNull();
  });

  it('patches badges in place so an open Analysis pane stays open', async () => {
    let release!: (r: Response) => void;
    stubScorecard(() => new Promise<Response>((resolve) => { release = resolve; }));

    const open = { ...forecast('fc-1', 'conflict'), caseFile: { supportingEvidence: [], counterEvidence: [], triggers: [] } } as unknown as Forecast;
    panel.updateForecasts([open]);
    const card = await vi.waitFor(() => cardFor(panel, 'Forecast fc-1'));
    expect(card.querySelector('.fc-reliability')).toBeNull();
    card.querySelector<HTMLElement>('[data-fc-toggle="detail-fc-1"]')!.click();
    const pane = card.querySelector<HTMLElement>('[data-fc-panel="detail-fc-1"]')!;
    expect(pane.classList.contains('fc-hidden')).toBe(false);

    release(Response.json(scorecard([published('conflict', 45, 0.2134, 15)])));
    await vi.waitFor(() => expect(card.querySelector('a.fc-reliability')).not.toBeNull());
    expect(card.isConnected).toBe(true);
    expect(pane.isConnected).toBe(true);
    expect(pane.classList.contains('fc-hidden')).toBe(false);
  });

  it('follows the badge link without toggling the card action row', async () => {
    const [badge] = await badgesFor([published('conflict', 45, 0.2134, 15)], ['conflict']);
    const toggleRow = cardFor(panel, 'Forecast fc-0').querySelector<HTMLElement>('.fc-toggle-row')!;
    const before = toggleRow.style.display;
    document.addEventListener('click', (e) => e.preventDefault(), { once: true });
    badge!.click();
    expect(toggleRow.style.display).toBe(before);
  });

  it('renders no badge when the scorecard request fails', async () => {
    stubScorecard(async () => new Response('forbidden', { status: 403 }));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    await settled(panel);
    expect(contentOf(panel).querySelector('.fc-reliability')).toBeNull();
  });

  it('renders no badge when the scorecard is degraded', async () => {
    stubScorecard(async () => Response.json(scorecard([published('conflict', 45, 0.2134, 15)], { degraded: true, error: 'forecast_scorecard_backend_unavailable' })));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    await settled(panel);
    expect(contentOf(panel).querySelector('.fc-reliability')).toBeNull();
  });
});
