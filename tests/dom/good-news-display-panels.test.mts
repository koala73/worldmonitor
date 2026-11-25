import { expect, it, vi } from 'vitest';

vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  setContentNodes(node: Node) { this.content.replaceChildren(node); }
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
import { BreakthroughsTickerPanel } from '@/components/BreakthroughsTickerPanel';
import { ProgressChartsPanel } from '@/components/ProgressChartsPanel';

it('keeps the looping ticker clone out of the accessibility tree and tab order', () => {
  const panel = new BreakthroughsTickerPanel();
  const items = ['A', 'B'].map((title) => ({ title, source: 'Nature', link: `https://example.org/${title}` }));
  panel.setItems(items as never);
  const links = [...panel['content'].querySelectorAll<HTMLAnchorElement>('a.ticker-item')];
  expect(links).toHaveLength(4);
  const exposed = links.filter((a) => a.getAttribute('aria-hidden') !== 'true' && a.tabIndex !== -1);
  expect(exposed.map((a) => a.textContent)).toEqual(['NatureA', 'NatureB']);
});

it('shows the real direction of a lower-is-better indicator', () => {
  const panel = new ProgressChartsPanel();
  panel.setData({
    source: 'hydrated',
    datasets: [{
      indicator: { id: 'poverty', code: 'SI.POV.DDAY', label: 'Extreme Poverty', unit: '%', color: '#000', years: 30, invertTrend: true },
      data: [{ year: 1990, value: 40 }, { year: 2023, value: 10 }],
      oldestValue: 40,
      latestValue: 10,
      changePercent: 75,
    }],
  });
  expect(panel['content'].querySelector('.progress-chart-meta')?.textContent).toBe('-75.0% since 1990 (%)');
});
