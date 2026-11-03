import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import type { TelegramItem } from '@/services/telegram-intel';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function renderWithMedia(mediaUrl: string): HTMLImageElement {
  const panel = new TelegramIntelPanel();
  document.body.appendChild(panel.getElement());
  const item: TelegramItem = {
    id: 'ClashReport:1',
    source: 'telegram',
    channel: 'ClashReport',
    channelTitle: 'Clash Report',
    url: 'https://t.me/ClashReport/1',
    ts: '2026-01-01T00:00:00.000Z',
    text: 'Image post',
    topic: 'conflict',
    tags: [],
    earlySignal: true,
    mediaUrls: [mediaUrl],
  };
  panel.setData({
    source: 'telegram', earlySignal: true, enabled: true, count: 1,
    updatedAt: new Date().toISOString(),
    items: [item],
  });
  const image = panel.getElement().querySelector<HTMLImageElement>('.telegram-intel-image');
  if (!image) throw new Error('media image was not rendered');
  return image;
}

describe('TelegramIntelPanel media popup', () => {
  it('opens nothing when the media URL fails validation', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithMedia('javascript:alert(1)').click();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a valid media URL once in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithMedia('https://cdn.example.com/photo.jpg').click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://cdn.example.com/photo.jpg', '_blank', 'noopener,noreferrer');
  });
});
