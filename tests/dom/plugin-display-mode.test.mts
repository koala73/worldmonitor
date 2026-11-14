/**
 * Display-mode DOM helpers shared by the news-and-maps and country MCP Apps views:
 * container fill, safe-area padding, Expand visibility, and the fullscreen request outcomes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyHostLayout, createExpandButton } from '@/plugin-display-mode';
import { hostContextFromInitialize, mergeHostContext, type PluginHostContext } from '@/plugin-host-context';

const offersFullscreen = (hostContext: Record<string, unknown> = {}): PluginHostContext =>
  hostContextFromInitialize({ hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], ...hostContext } });

afterEach(() => {
  document.body.removeAttribute('data-wm-fill');
  document.body.removeAttribute('style');
  delete document.documentElement.dataset.theme;
});

describe('applyHostLayout', () => {
  it('fills the reported height in fullscreen and reports when it leaves fill mode', () => {
    const button = document.createElement('button');
    const fullscreen = offersFullscreen({ displayMode: 'fullscreen', containerDimensions: { width: 380, height: 700 } });
    expect(applyHostLayout(fullscreen, button)).toBe(false);
    expect(document.body.hasAttribute('data-wm-fill')).toBe(true);
    expect(document.body.style.getPropertyValue('--wm-fill-height')).toBe('700px');
    expect(button.hidden).toBe(true);

    expect(applyHostLayout(offersFullscreen(), button)).toBe(true);
    expect(document.body.hasAttribute('data-wm-fill')).toBe(false);
    expect(document.body.style.getPropertyValue('--wm-fill-height')).toBe('');
    expect(button.hidden).toBe(false);
    expect(applyHostLayout(offersFullscreen(), button)).toBe(false);
  });

  it('keeps the button hidden on an inline-only host and applies theme and safe-area insets', () => {
    const button = document.createElement('button');
    const inlineOnly = hostContextFromInitialize({ hostContext: { theme: 'light', availableDisplayModes: ['inline'], safeAreaInsets: { top: 12, left: 4 } } });
    applyHostLayout(inlineOnly, button);
    expect(button.hidden).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.body.style.paddingTop).toBe('12px');
    expect(document.body.style.paddingLeft).toBe('4px');
    expect(document.body.style.paddingBottom).toBe('');
  });
});

describe('createExpandButton', () => {
  function setup(request: (method: string, params: object) => Promise<unknown>) {
    let host = offersFullscreen();
    const setHost = vi.fn((next: PluginHostContext) => { host = next; });
    const onRefused = vi.fn();
    const requestSpy = vi.fn(request);
    const button = createExpandButton({ className: 'x', request: requestSpy, getHost: () => host, setHost, onRefused });
    return { button, setHost, onRefused, requestSpy, getHost: () => host };
  }

  it('sends one fullscreen request synchronously from the click and records the granted mode', async () => {
    const view = setup(async () => ({ mode: 'fullscreen' }));
    expect(view.button.hidden).toBe(true);
    expect(view.button.getAttribute('aria-label')).toBe('Expand');
    view.button.click();
    expect(view.requestSpy).toHaveBeenCalledTimes(1);
    expect(view.requestSpy).toHaveBeenCalledWith('ui/request-display-mode', { mode: 'fullscreen' });
    await vi.waitFor(() => expect(view.setHost).toHaveBeenCalledTimes(1));
    expect(view.getHost().displayMode).toBe('fullscreen');
    expect(view.onRefused).not.toHaveBeenCalled();
  });

  it('keeps a display-mode notification that arrives before the fullscreen answer', async () => {
    let answer!: (value: unknown) => void;
    const view = setup(() => new Promise(resolve => { answer = resolve; }));
    view.button.click();
    // The host enters fullscreen and the user closes it again before the request resolves.
    view.setHost(mergeHostContext(view.getHost(), { displayMode: 'fullscreen', containerDimensions: { width: 700, height: 800 } }));
    view.setHost(mergeHostContext(view.getHost(), { displayMode: 'inline', containerDimensions: { width: 700 } }));
    view.setHost.mockClear();
    answer({ mode: 'fullscreen' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.setHost).not.toHaveBeenCalled();
    expect(view.getHost().displayMode).toBe('inline');
    expect(view.onRefused).not.toHaveBeenCalled();
  });

  it('applies the fullscreen answer over a theme-only update that arrived first, keeping the update', async () => {
    let answer!: (value: unknown) => void;
    const view = setup(() => new Promise(resolve => { answer = resolve; }));
    view.button.click();
    view.setHost(mergeHostContext(view.getHost(), { theme: 'light' }));
    answer({ mode: 'fullscreen' });
    await vi.waitFor(() => expect(view.getHost().displayMode).toBe('fullscreen'));
    expect(view.getHost().theme).toBe('light');
    expect(view.onRefused).not.toHaveBeenCalled();
  });

  it('reports a refusal when the host keeps the view inline', async () => {
    const view = setup(async () => ({ mode: 'inline' }));
    view.button.click();
    await vi.waitFor(() => expect(view.onRefused).toHaveBeenCalledTimes(1));
    expect(view.setHost).not.toHaveBeenCalled();
  });

  it('reports a refusal when the request fails', async () => {
    const view = setup(async () => { throw new Error('no gesture'); });
    view.button.click();
    await vi.waitFor(() => expect(view.onRefused).toHaveBeenCalledTimes(1));
    expect(view.setHost).not.toHaveBeenCalled();
  });
});
