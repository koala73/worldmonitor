/**
 * Dashboard focus (#10453, phase 2), Country Instability: each score carries
 * the ISO code of its country. Under a focus the panel lists the chosen
 * countries, then neighbours marked, and counts the rest.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { CIIPanel } from '@/components/CIIPanel';
import type { CachedCIIScore, CachedRiskScores } from '@/services/cached-risk-scores';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};

function score(code: string, name: string, value: number): CachedCIIScore {
  return {
    code,
    name,
    score: value,
    level: value >= 70 ? 'high' : 'elevated',
    trend: 'stable',
    change24h: 0,
    components: { unrest: 1, conflict: 2, security: 3, information: 4 },
    lastUpdated: null,
  };
}

function cached(cii: CachedCIIScore[]): CachedRiskScores {
  return {
    cii,
    strategicRisk: { score: 0, level: 'low', trend: 'stable', lastUpdated: null, contributors: [] } as unknown as CachedRiskScores['strategicRisk'],
    protestCount: 0,
    computedAt: null,
    cached: true,
    degraded: false,
    stale: false,
  };
}

const SCORES = [
  score('US', 'United States', 80),
  score('LA', 'Laos', 75),
  score('TH', 'Thailand', 60),
  score('VN', 'Vietnam', 55),
  score('FR', 'France', 40),
];

let panel: CIIPanel;

beforeEach(() => {
  panel = new CIIPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
});

const el = () => panel.getElement();
const names = () => [...el().querySelectorAll('.cii-country .cii-name')].map((n) => n.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (name: string) => [...el().querySelectorAll('.cii-country')].find((n) => n.querySelector('.cii-name')?.textContent === name);

describe('CIIPanel under a focus', () => {
  it('lists the chosen countries then the marked neighbour, and counts the rest as hidden', () => {
    panel.renderFromCached(cached(SCORES));
    panel.applyScope(scopeOf(['TH', 'VN']));

    expect(names()).toEqual(['Thailand', 'Vietnam', 'Laos']);
    expect(rowFor('Laos')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(rowFor('Thailand')?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('2 hidden by focus');
  });

  it('shows everything again on Show all, and filters again on Apply focus', () => {
    panel.renderFromCached(cached(SCORES));
    panel.applyScope(scopeOf(['TH']));
    stripButton('show-all')!.click();
    expect(names()).toEqual(['United States', 'Laos', 'Thailand', 'Vietnam', 'France']);
    stripButton('apply')!.click();
    expect(names()).toEqual(['Thailand', 'Laos']);
  });

  it('applies a focus set before the data arrives, and clears back to the full list', () => {
    panel.applyScope(scopeOf(['TH'], false));
    panel.renderFromCached(cached(SCORES));
    expect(names()).toEqual(['Thailand']);
    panel.applyScope(null);
    expect(names()).toHaveLength(5);
    expect(strip()?.hidden).toBe(true);
  });

  it('without neighbours lists only the chosen countries', () => {
    panel.renderFromCached(cached(SCORES));
    panel.applyScope(scopeOf(['TH', 'VN'], false));
    expect(names()).toEqual(['Thailand', 'Vietnam']);
  });

  it('says nothing was scored for the focus, distinct from a failure, and keeps the counts reachable', () => {
    panel.renderFromCached(cached(SCORES));
    panel.applyScope(scopeOf(['NZ'], false));
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No instability scores for these countries');
    expect(el().querySelector('.empty-state')).toBeNull();
    expect(strip()?.textContent).toContain('5 hidden by focus');
    stripButton('show-all')!.click();
    expect(names()).toHaveLength(5);
  });

  it('hides the strip while there is no data and after an unavailable load', () => {
    panel.applyScope(scopeOf(['TH']));
    expect(strip()?.hidden).toBe(true);
    panel.renderFromCached(cached(SCORES));
    expect(strip()?.hidden).toBe(false);
    panel.renderUnavailable();
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.empty-state')).not.toBeNull();
  });
});
