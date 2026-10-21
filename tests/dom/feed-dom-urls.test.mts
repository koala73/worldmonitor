import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MonitorPanel } from '@/components/MonitorPanel';
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => document.body.replaceChildren());
const url = 'https://example.com/story?a=1&b=2';
it('preserves query parameters on a monitor news link', () => {
  const panel = new MonitorPanel([{ id: 'm', keywords: ['news'], color: '#fff' }]);
  document.body.append(panel.getElement());
  panel.renderResults([{ title: 'news', link: url, source: 'test', isAlert: false, pubDate: new Date() }]);
  expect(panel.getElement().querySelector('a')!.getAttribute('href')).toBe(url);
  panel.destroy();
});
it('preserves Telegram source and media URLs through DOM construction and opening', () => {
  const build = (TelegramIntelPanel.prototype as unknown as { buildItem(item: unknown): HTMLElement }).buildItem;
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const item = build.call({}, {
    text: 'news', channel: 'test', topic: 'general', ts: new Date().toISOString(),
    url, mediaUrls: [url, 'https://example.com/video.mp4?a=1&b=2'],
  });
  expect(item.querySelector('a')!.getAttribute('href')).toBe(url);
  expect(item.querySelector('img')!.getAttribute('src')).toBe(url);
  expect(item.querySelector('video')!.getAttribute('src')).toContain('?a=1&b=2');
  item.querySelector('img')!.click();
  expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
});
