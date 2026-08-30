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

  it('does not grant trust badges from a custom channel title', () => {
    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    panel.setData({
      source: 'telegram',
      earlySignal: true,
      enabled: true,
      count: 1,
      updatedAt: new Date().toISOString(),
      items: [telegramItem({
        id: 'untrusted_feed:3',
        channel: 'untrusted_feed',
        channelTitle: 'IDF Official',
        watchlist: true,
      })],
    });

    const item = panel.getElement().querySelector('.telegram-intel-item');
    // The spoofing guard: a channel TITLED "IDF Official" must not inherit that
    // outlet's tier badge, because provenance is resolved from the immutable
    // handle only.
    expect(item?.querySelector('.tier-badge')).toBeNull();
    expect(item?.querySelector('.propaganda-badge.high')).toBeNull();
    // But it must still be marked unreviewed rather than merely unlabelled —
    // an unvetted channel showing no badge at all reads as "nothing to flag".
    const risk = item?.querySelector('.propaganda-badge');
    expect(risk).not.toBeNull();
    expect(risk?.className).toContain('unknown');
    expect(risk?.textContent).toContain('Unreviewed');
    expect(item?.querySelector('.telegram-intel-custom-tag')).not.toBeNull();
  });

  it('deduplicates handle casing and keeps curated metadata', () => {
    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    panel.setData({
      source: 'telegram',
      earlySignal: true,
      enabled: true,
      count: 2,
      updatedAt: new Date().toISOString(),
      items: [
        telegramItem({
          id: 'IDFOFFICIAL:7',
          channel: 'IDFOFFICIAL',
          channelTitle: 'Custom title',
          watchlist: true,
        }),
        telegramItem({
          id: 'idfofficial:7',
          channel: 'IDFofficial',
          channelTitle: 'IDF Official',
          watchlist: false,
        }),
      ],
    });

    const items = panel.getElement().querySelectorAll('.telegram-intel-item');
    expect(items).toHaveLength(1);
    expect(items[0]?.querySelector('.telegram-intel-channel')?.textContent).toBe('IDF Official');
    expect(items[0]?.querySelector('.telegram-intel-custom-tag')).toBeNull();
  });
});
