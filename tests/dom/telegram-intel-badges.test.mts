import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import type { TelegramItem } from '@/services/telegram-intel';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function telegramItem(overrides: Partial<Omit<TelegramItem, 'source'>> = {}): TelegramItem {
  return {
    id: 'IDFofficial:1',
    source: 'telegram' as const,
    channel: 'IDFofficial',
    channelTitle: 'IDF Official',
    url: 'https://t.me/IDFofficial/1',
    ts: new Date().toISOString(),
    text: 'Primary government claim',
    topic: 'breaking',
    tags: ['middleeast'],
    earlySignal: true,
    ...overrides,
  };
}

describe('TelegramIntelPanel trust badges (#6600)', () => {
  it('renders existing provenance badges beside the channel title', () => {
    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    panel.setData({
      source: 'telegram',
      earlySignal: true,
      enabled: true,
      count: 2,
      updatedAt: new Date().toISOString(),
      items: [
        telegramItem(),
        telegramItem({
          id: 'ClashReport:2',
          channel: 'ClashReport',
          channelTitle: 'Clash Report',
          text: 'OSINT lead',
          topic: 'conflict',
        }),
      ],
    });

    const items = panel.getElement().querySelectorAll('.telegram-intel-item');
    expect(items.length).toBe(2);

    const idf = items[0];
    expect(idf?.querySelector('.propaganda-badge')?.textContent).toContain('Official Government Source');
    expect(idf?.querySelector('.tier-badge')?.className).toContain('tier-1');

    const clash = items[1];
    expect(clash?.querySelector('.propaganda-badge')?.className).toContain('medium');
    expect(clash?.querySelector('.tier-badge')).toBeNull();
  });

  it('resolves stable handles before mutable channel titles', () => {
    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    panel.setData({
      source: 'telegram',
      earlySignal: true,
      enabled: true,
      count: 2,
      updatedAt: new Date().toISOString(),
      items: [
        telegramItem({ channelTitle: 'IDFofficial' }),
        telegramItem({
          id: 'DDGeopolitics:2',
          channel: 'DDGeopolitics',
          channelTitle: 'Renamed DD title',
          text: 'Partisan lead',
        }),
      ],
    });

    const items = panel.getElement().querySelectorAll('.telegram-intel-item');
    const idf = items[0];
    expect(idf?.querySelector('.propaganda-badge')?.textContent).toContain('Official Government Source');
    expect(idf?.querySelector('.tier-badge')?.className).toContain('tier-1');

    const dd = items[1];
    expect(dd?.querySelector('.propaganda-badge')?.textContent).toContain('Caution');
    expect(dd?.querySelector('.propaganda-badge')?.className).toContain('medium');
  });
});
