import { afterEach, describe, expect, it, vi } from 'vitest';
import { installUtmInterceptor } from '@/utils/utm';

describe('outbound attribution', () => {
  installUtmInterceptor();
  // Stop happy-dom's native navigation after the real interceptor has run.
  document.addEventListener('click', event => event.preventDefault());
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
  function click(href: string, panel = 'cw-user-id') {
    document.body.innerHTML = `<section data-panel="${panel}"><a target="_blank">Open</a></section>`;
    const anchor = document.querySelector('a')!;
    anchor.href = href;
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return anchor.href;
  }
  it('preserves query-sensitive links and non-web schemes', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const url of ['https://t.me/bot?start=token', 'https://telegram.me/bot', 'https://slack.com/oauth/v2/authorize', 'https://example.com/?signature=abc', 'mailto:help@example.com']) {
      expect(click(url)).toBe(url);
    }
    expect(open).not.toHaveBeenCalled();
  });
  it('attributes a plain web link without modifying the anchor or leaking panel IDs', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(click('https://example.com/article')).toBe('https://example.com/article');
    expect(open).toHaveBeenCalledWith('https://example.com/article?utm_source=worldmonitor&utm_medium=referral&utm_campaign=custom-widget', '_blank', 'noopener,noreferrer');
  });
  it('keeps native modifier, download, and custom referrer navigation', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    document.body.innerHTML = '<a target="_blank" href="https://example.com/article">Open</a>';
    const anchor = document.querySelector('a')!;
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true }));
    }
    for (const attribute of ['download', 'referrerpolicy']) {
      anchor.setAttribute(attribute, '');
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      anchor.removeAttribute(attribute);
    }
    expect(open).not.toHaveBeenCalled();
  });
  it('preserves noreferrer on attributed navigation', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    document.body.innerHTML = '<a target="_blank" rel="noreferrer" href="https://example.com/article">Open</a>';
    document.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith(expect.any(String), '_blank', 'noopener,noreferrer');
  });
});
