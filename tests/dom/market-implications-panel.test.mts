/**
 * AI Market Implications cards are not scored (#8869): no card may carry a
 * HIGH/MEDIUM/LOW confidence badge, and the panel must say the cards are
 * unscored scenarios. The payload keeps its `confidence` field.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18next from 'i18next';

import { initTestI18n } from './helpers/i18n.mts';

import { MarketImplicationsPanel } from '@/components/MarketImplicationsPanel';
import type { MarketImplicationCard } from '@/services/market-implications';

const CONTENT_DEBOUNCE_MS = 150;

function card(ticker: string, confidence: string): MarketImplicationCard {
  return {
    ticker,
    name: `${ticker} fixture`,
    direction: 'LONG',
    timeframe: '1M',
    confidence,
    title: `${ticker} thesis`,
    narrative: 'Fixture narrative.',
    riskCaveat: '',
    driver: '',
  };
}

let panel: MarketImplicationsPanel | undefined;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  vi.useRealTimers();
});

describe('MarketImplicationsPanel', () => {
  it('renders no confidence badge and labels the cards as unscored', () => {
    panel = new MarketImplicationsPanel();
    panel.renderImplications({
      cards: [card('GLD', 'HIGH'), card('SPY', 'MEDIUM'), card('USO', 'LOW')],
      degraded: false,
      emptyReason: '',
      generatedAt: '',
    });
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const content = panel.getElement().querySelector('.panel-content');
    expect(content?.querySelectorAll('.signal-card')).toHaveLength(3);
    const badges = [...(content?.querySelectorAll('.signal-badge') ?? [])].map((el) => el.textContent?.trim());
    expect(badges).not.toContain('HIGH');
    expect(badges).not.toContain('MEDIUM');
    expect(badges).not.toContain('LOW');

    const unscored = i18next.t('components.marketImplications.unscored');
    expect(unscored).not.toBe('components.marketImplications.unscored');
    expect(content?.textContent).toContain(unscored);
  });
});
