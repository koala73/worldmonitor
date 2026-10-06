/**
 * #5092 — the per-card reliability badge in ForecastPanel.
 *
 * Each forecast card shows how its domain has scored, from the same
 * get-forecast-scorecard response the track-record strip reads: the domain's
 * Brier with its sample size once the sample reaches the scorecard's
 * minimum, an explicit "not yet measured" state below it, and nothing at all
 * when the scorecard is unavailable. The badge links to /accuracy/.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Forecast, GetForecastScorecardResponse } from '@/services/forecast';
import { ForecastPanel } from '@/components/ForecastPanel';
import { DOMAIN_RELIABILITY_MIN_SAMPLE } from '@/components/forecast-record';
// @ts-expect-error -- untyped seeder module; this test reads one numeric constant from it.
import { INTERVAL_MIN_SAMPLE } from '../../scripts/_forecast-scorecard.mjs';

import { initTestI18n } from './helpers/i18n.mts';

const SCORECARD_PATH = '/api/forecast/v1/get-forecast-scorecard';

type ScorecardDomainGroup = GetForecastScorecardResponse['byDomain'][number];

function domainGroup(domain: string, scored: number, brier?: number): ScorecardDomainGroup {
  return { domain, resolved: scored + 2, scored, void: 2, voidRate: 2 / (scored + 2), brier, logScore: brier === undefined ? undefined : -0.5 };
}

function scorecard(byDomain: ScorecardDomainGroup[], overrides: Partial<GetForecastScorecardResponse> = {}): GetForecastScorecardResponse {
  return {
    schemaVersion: 1,
    generatedAt: Date.parse('2026-10-05T06:00:00Z'),
    rollingWindowDays: 180,
    methodology: '',
    totals: { entries: 240, resolved: 60, pending: 150, pendingJudge: 30, scored: 55, void: 5, voidRate: 5 / 60, publicationCoverage: 0.9 },
    overall: { count: 55, brier: 0.19, logScore: -0.5 },
    byDomain,
    byGenerationOrigin: [],
    calibration: [],
    skill: { count: 42, brier: 0.182, logScore: -0.51, excludedScored: 13, excludedOrigins: [], yesCount: 13 },
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
  it('uses the scorecard interval minimum as its sample floor', () => {
    expect(DOMAIN_RELIABILITY_MIN_SAMPLE).toBe(INTERVAL_MIN_SAMPLE);
  });

  it('shows the domain Brier with its sample size once the sample reaches the minimum', async () => {
    stubScorecard(async () => Response.json(scorecard([domainGroup('conflict', 45, 0.2134)])));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    await settled(panel);

    const badge = await vi.waitFor(() => {
      const el = cardFor(panel, 'Forecast fc-1').querySelector<HTMLAnchorElement>('a.fc-reliability');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(badge.dataset.fcReliabilityState).toBe('measured');
    expect(badge.textContent).toContain('Conflict Brier 0.213 (n=45)');
    expect(badge.getAttribute('href')).toBe('/accuracy/');
    expect(badge.getAttribute('title')).toContain('45');
  });

  it('says not yet measured below the minimum and never shows that domain Brier', async () => {
    stubScorecard(async () => Response.json(scorecard([
      domainGroup('conflict', 45, 0.2134),
      domainGroup('market', 12, 0.31),
    ])));

    panel.updateForecasts([forecast('fc-1', 'conflict'), forecast('fc-2', 'market'), forecast('fc-3', 'cyber')]);
    await settled(panel);

    for (const [title, n] of [['Forecast fc-2', '12'], ['Forecast fc-3', '0']] as const) {
      const badge = cardFor(panel, title).querySelector<HTMLAnchorElement>('a.fc-reliability');
      expect(badge, title).not.toBeNull();
      expect(badge!.dataset.fcReliabilityState).toBe('unmeasured');
      expect(badge!.textContent).toContain('Not yet measured');
      expect(badge!.textContent).not.toContain('Brier');
      expect(badge!.textContent).not.toContain('0.310');
      expect(badge!.getAttribute('title')).toContain(n);
      expect(badge!.getAttribute('href')).toBe('/accuracy/');
    }
  });

  it('patches badges in place so an open card is not rebuilt', async () => {
    let release!: (r: Response) => void;
    stubScorecard(() => new Promise<Response>((resolve) => { release = resolve; }));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    const card = await vi.waitFor(() => cardFor(panel, 'Forecast fc-1'));
    expect(card.querySelector('.fc-reliability')).toBeNull();

    release(Response.json(scorecard([domainGroup('conflict', 45, 0.2134)])));
    await vi.waitFor(() => expect(card.querySelector('a.fc-reliability')).not.toBeNull());
    expect(card.isConnected).toBe(true);
  });

  it('renders no badge when the scorecard request fails', async () => {
    stubScorecard(async () => new Response('forbidden', { status: 403 }));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    await settled(panel);
    expect(contentOf(panel).querySelector('.fc-reliability')).toBeNull();
  });

  it('renders no badge when the scorecard is degraded', async () => {
    stubScorecard(async () => Response.json(scorecard([domainGroup('conflict', 45, 0.2134)], { degraded: true, error: 'forecast_scorecard_backend_unavailable' })));

    panel.updateForecasts([forecast('fc-1', 'conflict')]);
    await settled(panel);
    expect(contentOf(panel).querySelector('.fc-reliability')).toBeNull();
  });
});
