import { afterEach, expect, it, vi } from 'vitest';
import { shareHappyCard } from '@/services/happy-share-renderer';
afterEach(() => vi.unstubAllGlobals());
// WKWebView can reject share() with an AbortError that is not `instanceof DOMException`,
// so cancellation must be recognised by name alone.
it.each<[string, () => unknown, number]>([
  ['AbortError', () => new DOMException('share ended', 'AbortError'), 0],
  ['a non-DOMException AbortError', () => ({ name: 'AbortError' }), 0],
  ['NotAllowedError', () => new DOMException('share ended', 'NotAllowedError'), 1],
  ['DataError', () => new DOMException('share ended', 'DataError'), 1],
])('handles %s without mistaking a failure for cancellation', async (_label, error, calls) => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [] } });
  const ctx = new Proxy({} as CanvasRenderingContext2D, { get: (_target, key) => key === 'measureText' ? () => ({ width: 10 }) : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {} });
  const canvas2d: { getContext(id: '2d'): CanvasRenderingContext2D | null } = HTMLCanvasElement.prototype;
  vi.spyOn(canvas2d, 'getContext').mockReturnValue(ctx);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['png'], { type: 'image/png' })));
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('ClipboardItem', class {});
  vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(error()), canShare: () => true, clipboard: { write } });
  await shareHappyCard({ title: 'Test news', source: 'test', isAlert: false, link: 'https://example.com', pubDate: new Date() });
  expect(write).toHaveBeenCalledTimes(calls);
});
