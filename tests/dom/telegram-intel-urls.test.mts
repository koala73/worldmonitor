import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';

beforeAll(initTestI18n);

describe('Telegram DOM URLs', () => {
  it('preserves source and media queries and rejects executable URLs', () => {
    const panel = new TelegramIntelPanel();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const source = 'https://t.me/example/1?a=1&b=%22x%22';
    const image = 'https://example.com/image.png?a=1&b=2';
    const video = 'https://example.com/video.mp4?a=1&b=2';
    try {
      panel.setData({ source: 'telegram', earlySignal: true, enabled: true, count: 1,
        updatedAt: new Date().toISOString(), items: [{
          id: 'example:1', source: 'telegram', channel: 'example', channelTitle: 'Example',
          url: source, ts: new Date().toISOString(), text: 'URL fixture', topic: 'breaking',
          tags: [], earlySignal: true, mediaUrls: [image, video, 'javascript:alert(1)'],
        }],
      });
      const root = panel.getElement();
      expect(root.querySelector('a.telegram-follow-btn')?.getAttribute('href')).toBe(source);
      expect(root.querySelector('video')?.getAttribute('src')).toBe(video);
      const images = root.querySelectorAll('img.telegram-intel-image');
      expect(images[0]?.getAttribute('src')).toBe(image);
      images[0]?.dispatchEvent(new MouseEvent('click'));
      expect(open).toHaveBeenCalledWith(image, '_blank', 'noopener,noreferrer');
      expect(images[1]?.getAttribute('src')).toBe('');
      images[1]?.dispatchEvent(new MouseEvent('click'));
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      panel.destroy();
      open.mockRestore();
    }
  });
});
