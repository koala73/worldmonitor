import { describe, expect, it, vi } from 'vitest';
import { PredictionPanel } from '@/components/PredictionPanel';
import type { PredictionMarket } from '@/services/prediction';

vi.mock('@/components/Panel', () => ({
  Panel: class {
    content = document.createElement('div');
    setSafeContent(html: { toString(): string }) { this.content.innerHTML = html.toString(); }
  },
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

const legacy = 'https://kalshi.com/markets/KXMEETING-27-CN';
const landing = 'https://kalshi.com/markets/kxmeeting';

describe('prediction title display destination', () => {
  for (const [displayUrl, expected] of [[undefined, legacy], [landing, landing], ['', null], ['javascript:alert(1)', null]] as const) {
    it(`keeps identity and renders ${String(displayUrl)} safely`, () => {
      const row: PredictionMarket = { title: 'Will China host the meeting?', yesPrice: 70, source: 'kalshi', url: legacy, ...(displayUrl === undefined ? {} : { displayUrl }) };
      const panel = new PredictionPanel();
      panel.renderPredictions([row]);
      const content = (panel as unknown as { content: HTMLElement }).content;
      expect(content.querySelector('a')?.getAttribute('href') ?? null).toBe(expected);
      expect(content.textContent).toContain(row.title);
      expect(content.textContent).toContain('Kalshi');
      expect(content.textContent).toContain('70%');
      expect(row.url).toBe(legacy);
    });
  }
  it('keeps Polymarket navigation unchanged', () => {
    const row: PredictionMarket = { title: 'China GDP', yesPrice: 68, source: 'polymarket', url: 'https://polymarket.com/event/china-gdp', displayUrl: landing };
    const panel = new PredictionPanel();
    panel.renderPredictions([row]);
    const content = (panel as unknown as { content: HTMLElement }).content;
    expect(content.querySelector('a')?.getAttribute('href')).toBe(row.url);
    expect(content.textContent).toContain('Polymarket');
    expect(content.textContent).toContain('68%');
  });
});
