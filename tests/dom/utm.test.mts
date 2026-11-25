import { afterEach, describe, expect, it, vi } from 'vitest';
import { installUtmInterceptor } from '@/utils/utm';

interface Followed {
  prevented: boolean;
  href: string;
  rel: string[];
}

describe('outbound attribution', () => {
  installUtmInterceptor();
  let followed: Followed | undefined;
  // Runs after the real interceptor, where the browser would follow the link,
  // then stops happy-dom's native navigation.
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a')!;
    followed = { prevented: event.defaultPrevented, href: anchor.href, rel: [...anchor.relList] };
    event.preventDefault();
  });
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); followed = undefined; });
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
  function click(href: string, panel = 'cw-user-id', rel = '') {
    document.body.innerHTML = `<section data-panel="${panel}"><a target="_blank">Open</a></section>`;
    const anchor = document.querySelector('a')!;
    anchor.href = href;
    if (rel) anchor.rel = rel;
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return anchor;
  }
  it('preserves query-sensitive links and non-web schemes', () => {
    for (const url of ['https://t.me/bot?start=token', 'https://telegram.me/bot', 'https://slack.com/oauth/v2/authorize', 'https://example.com/?signature=abc', 'mailto:help@example.com']) {
      click(url);
      expect(followed?.href).toBe(url);
    }
  });
  it('sends the browser itself to the attributed URL, without leaking panel IDs', () => {
    // A browser that refuses scripted tabs (games consoles, some Electron
    // wrappers, Safari blocking pop-ups) still follows a link the user clicked.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    click('https://example.com/article');
    expect(followed).toMatchObject({
      prevented: false,
      href: 'https://example.com/article?utm_source=worldmonitor&utm_medium=referral&utm_campaign=custom-widget',
    });
    expect(open).not.toHaveBeenCalled();
  });
  it('gives the anchor back its own address and rel once the click is over', async () => {
    const anchor = click('https://example.com/article', 'cw-user-id', 'external');
    await nextTask();
    expect(anchor.href).toBe('https://example.com/article');
    expect(anchor.rel).toBe('external');
  });
  it('keeps native modifier, download, and custom referrer navigation', () => {
    document.body.innerHTML = '<a target="_blank" href="https://example.com/article">Open</a>';
    const anchor = document.querySelector('a')!;
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true }));
      expect(followed?.href).toBe('https://example.com/article');
    }
    for (const attribute of ['download', 'referrerpolicy']) {
      anchor.setAttribute(attribute, '');
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(followed?.href).toBe('https://example.com/article');
      anchor.removeAttribute(attribute);
    }
  });
  it('sends attributed navigation without opener or referrer', () => {
    click('https://example.com/article', 'cw-user-id', 'noopener');
    expect(followed?.rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  });
});
