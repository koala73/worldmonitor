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
    id: 'defenderdome:1',
    source: 'telegram' as const,
    channel: 'defenderdome',
    channelTitle: 'Defender Dome',
    url: 'https://t.me/defenderdome/1',
    ts: '2026-01-01T00:00:00.000Z',
    text: 'Two sources said early signs suggest China may be behind it. The breach f',
    topic: 'cyber',
    tags: [],
    earlySignal: true,
    ...overrides,
  };
}

function renderedTexts(items: TelegramItem[]): string[] {
  const panel = new TelegramIntelPanel();
  document.body.appendChild(panel.getElement());
  panel.setData({
    source: 'telegram', earlySignal: true, enabled: true, count: items.length,
    updatedAt: new Date().toISOString(), items,
  });
  return [...panel.getElement().querySelectorAll('.telegram-intel-text')].map((node) => node.textContent ?? '');
}

describe('TelegramIntelPanel truncated messages', () => {
  it('marks a message the relay cut at its character limit', () => {
    const [text] = renderedTexts([telegramItem({ textTruncated: true })]);
    expect(text).toBe('Two sources said early signs suggest China may be behind it. The breach f…');
  });

  it('leaves a complete message unmarked', () => {
    const [text] = renderedTexts([telegramItem({ text: 'Complete post.' })]);
    expect(text).toBe('Complete post.');
  });
});
