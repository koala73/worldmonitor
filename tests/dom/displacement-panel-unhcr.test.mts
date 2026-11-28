/**
 * UNHCR Origins tab and worldwide totals (#11273). Figures are the live
 * get-displacement-summary values the issue quotes. A row's status describes
 * the count shown beside it, only countries get a status, and the headline
 * total is the sum of the categories shown above it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatPopulation, type CountryDisplacement, type UnhcrSummary } from '@/services/displacement';

import { initTestI18n, tt } from './helpers/i18n.mts';

const { DisplacementPanel } = await import('@/components/DisplacementPanel');

function origin(code: string, name: string, refugees: number, asylumSeekers: number, idps: number): CountryDisplacement {
  return {
    code, name, refugees, asylumSeekers, idps, stateless: 0, totalDisplaced: refugees + asylumSeekers + idps,
    hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0,
  };
}

const SUMMARY: UnhcrSummary = {
  year: 2026,
  globalTotals: { refugees: 28_505_014, asylumSeekers: 8_577_140, idps: 64_937_492, stateless: 4_738_174, total: 106_757_820 },
  countries: [
    origin('UNK', 'Unknown ', 127_549, 1_536_856, 0),
    origin('ERI', 'Eritrea', 600_000, 98_447, 0),
    origin('ETH', 'Ethiopia', 250_000, 52_045, 2_378_000),
  ],
  topFlows: [],
};

let panel: InstanceType<typeof DisplacementPanel>;

async function render(): Promise<void> {
  panel = new DisplacementPanel();
  document.body.appendChild(panel.getElement());
  panel.setData(SUMMARY);
  // Panel.setSafeContent commits on a 150 ms debounce.
  await vi.advanceTimersByTimeAsync(151);
}

function originRows(): Record<string, { status: string; count: string }> {
  const rows = Array.from(panel.getElement().querySelectorAll<HTMLElement>('.disp-row'));
  return Object.fromEntries(rows.map((row) => [
    row.querySelector('.disp-name')?.firstChild?.textContent?.trim() ?? '',
    {
      status: row.querySelector('.disp-status')?.textContent?.trim() ?? '',
      count: row.querySelector('.disp-count')?.textContent?.trim() ?? '',
    },
  ]));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  panel?.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('UNHCR origins', () => {
  it('gives the unknown-origin aggregate no country status', async () => {
    await render();
    expect(originRows().Unknown).toEqual({ status: '', count: formatPopulation(1_664_405) });
  });

  it('grades each origin by the refugees and asylum seekers it counts', async () => {
    await render();
    const rows = originRows();
    expect(rows.Eritrea).toEqual({ status: tt('components.displacement.badges.high'), count: formatPopulation(698_447) });
    expect(rows.Ethiopia).toEqual({ status: tt('components.displacement.badges.elevated'), count: formatPopulation(302_045) });
  });
});

describe('worldwide totals', () => {
  it('shows every category the total adds up', async () => {
    await render();
    const stats = Array.from(panel.getElement().querySelectorAll('.disp-stat-box')).map((box) => [
      box.querySelector('.disp-stat-label')?.textContent?.trim(),
      box.querySelector('.disp-stat-value')?.textContent?.trim(),
    ]);
    expect(stats).toEqual([
      [tt('components.displacement.refugees'), formatPopulation(28_505_014)],
      [tt('components.displacement.asylumSeekers'), formatPopulation(8_577_140)],
      [tt('components.displacement.idps'), formatPopulation(64_937_492)],
      [tt('components.displacement.stateless'), formatPopulation(4_738_174)],
      [tt('components.displacement.total'), formatPopulation(106_757_820)],
    ]);
  });
});
