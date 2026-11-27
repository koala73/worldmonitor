import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockGetTechReadinessRankings } = vi.hoisted(() => ({ mockGetTechReadinessRankings: vi.fn() }));

vi.mock('@/services/economic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/economic')>()),
  getTechReadinessRankings: mockGetTechReadinessRankings,
}));

import { TechReadinessPanel } from '@/components/TechReadinessPanel';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
});

const row = (country: string, countryName: string, rank: number) => ({
  country, countryName, rank, score: 80 - rank, componentCount: 4,
  components: { internet: 99, mobile: 80, broadband: 90, rdSpend: 50 },
});

it('shows each country flag from its ISO code', async () => {
  mockGetTechReadinessRankings.mockResolvedValue([
    row('ISL', 'Iceland', 1), row('LIE', 'Liechtenstein', 2), row('MCO', 'Monaco', 3), row('XKX', 'Kosovo', 4),
  ]);
  const panel = new TechReadinessPanel();
  document.body.appendChild(panel.getElement());
  await panel.refresh();
  await vi.waitFor(() => expect(panel.getElement().querySelectorAll('.readiness-flag')).toHaveLength(4));

  const flags = [...panel.getElement().querySelectorAll('.readiness-flag')].map(el => el.textContent);
  expect(flags).toEqual(['🇮🇸', '🇱🇮', '🇲🇨', '🇽🇰']);
  panel.destroy();
});
