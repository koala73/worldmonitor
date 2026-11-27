import { expect, it, vi } from 'vitest';

const hydrated = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  showError(message: string) { this.content.textContent = `error:${message}`; }
  setSafeContent(value: unknown) { this.content.innerHTML = String(value); }
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => hydrated.value }));
import { AAIISentimentPanel } from '@/components/AAIISentimentPanel';

it('shows the survey date without the internal acquisition tag', async () => {
  const latest = { date: '2026-11-19', bullish: 33.3, bearish: 42.2, neutral: 24.4, spread: -8.9 };
  hydrated.value = {
    seededAt: '2026-11-20T00:00:00.000Z', fallback: false, source: 'html', latest, previous: null, avg8w: null,
    historicalAvg: { bullish: 37.5, bearish: 31, neutral: 31.5 },
    extremes: { spreadBelow20: 0, bullishAbove50: 0, bearishAbove50: 0 }, weeks: [latest],
  };
  await new AAIISentimentPanel().fetchData();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Survey: 2026-11-19');
  expect(text).not.toContain('(html)');
  expect(text).not.toContain('8-Week Moving Average');
});
