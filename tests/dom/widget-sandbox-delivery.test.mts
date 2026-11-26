import { afterEach, describe, expect, it, vi } from 'vitest';
import { wrapProWidgetHtml } from '@/utils/widget-sanitizer';

describe('PRO widget HTML delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const mount = async () => {
    const host = document.createElement('div');
    host.innerHTML = wrapProWidgetHtml('<div class="probe">ok</div>');
    document.body.append(host);
    await Promise.resolve(); // let the MutationObserver mount the iframe
    const iframe = host.querySelector<HTMLIFrameElement>('iframe[data-wm-id]')!;
    // The test DOM loads no frame, so stand in for the sandbox window.
    const post = vi.fn();
    const sandbox = { postMessage: post };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: sandbox });
    const ready = () => {
      const event = new MessageEvent('message', {
        data: { type: 'wm-widget-ready', id: iframe.dataset.wmId, token: iframe.dataset.wmToken },
      });
      Object.defineProperty(event, 'source', { value: sandbox });
      window.dispatchEvent(event);
    };
    return { post, ready };
  };

  it('answers the first ready message even in the first second of the page', async () => {
    // A widget restored at startup reports ready before the page is 1s old. The sandbox asks only once.
    vi.spyOn(performance, 'now').mockReturnValue(400);
    const { post, ready } = await mount();
    ready();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ type: 'wm-html' });
  });

  it('still throttles a widget that re-posts ready in a loop', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(5_000);
    const { post, ready } = await mount();
    ready();
    now.mockReturnValue(5_200);
    ready();
    expect(post).toHaveBeenCalledTimes(1);
    now.mockReturnValue(6_100);
    ready();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
