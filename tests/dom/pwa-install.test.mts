import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/services/analytics', () => ({ track: vi.fn() }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/services/desktop-runtime', () => ({ isDesktopRuntime: () => desktop }));
let desktop = false;
import { initPwaInstall, mountInstallEntry, needsIosInstall, openIosInstallSheet } from '@/services/pwa-install';
import { track } from '@/services/analytics';

let stop: () => void;
let unmount: () => void;
beforeEach(() => {
  desktop = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/140.0 Safari/537.36');
  stop = initPwaInstall();
});
afterEach(() => {
  unmount?.();
  stop();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.mocked(track).mockClear();
});
function mount() {
  const root = document.createElement('div');
  document.body.append(root);
  unmount = mountInstallEntry(root);
  return root;
}
function offer(outcome = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  window.dispatchEvent(event);
  return { event, prompt };
}
it.each(['accepted', 'dismissed'])('consumes the native prompt once and tracks %s', async outcome => {
  const root = mount();
  expect(root.querySelector('button')).toBeNull();
  const { event, prompt } = offer(outcome);
  expect(event.defaultPrevented).toBe(true);
  root.querySelector('button')!.click();
  await vi.waitFor(() => expect(track).toHaveBeenCalledWith('pwa-install-outcome', { outcome }));
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(root.querySelector('button')).toBeNull();
  expect(track).toHaveBeenCalledWith('pwa-install-entry-shown', { platform: 'native' });
  expect(track).toHaveBeenCalledWith('pwa-install-clicked', { platform: 'native' });
});
it('keeps keyboard focus in Settings when the consumed native entry disappears', async () => {
  const root = mount();
  const { prompt } = offer();
  const button = root.querySelector('button')!;
  button.focus();
  button.click();
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  expect(root.querySelector('button')).toBeNull();
  expect(document.activeElement).toBe(root);
});
it('clears an available prompt on appinstalled', () => {
  const root = mount();
  offer();
  window.dispatchEvent(new Event('appinstalled'));
  expect(root.querySelector('button')).toBeNull();
  offer();
  expect(root.querySelector('button')).toBeNull();
  expect(track).toHaveBeenCalledWith('pwa-installed');
});
it('hides an existing offer when display mode becomes standalone', () => {
  const root = mount();
  offer();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  window.dispatchEvent(new Event('beforeinstallprompt'));
  unmount();
  unmount = mountInstallEntry(root);
  expect(root.querySelector('button')).toBeNull();
});
it('contains a failed native prompt without reusing it', async () => {
  const root = mount();
  const { prompt } = offer();
  prompt.mockRejectedValue(new Error('Browser refused prompt'));
  root.querySelector('button')!.click();
  await vi.waitFor(() => expect(track).toHaveBeenCalledWith('pwa-install-outcome', { outcome: 'error' }));
  expect(root.querySelector('button')).toBeNull();
});
it('removes an unmounted entry from subsequent install updates', () => {
  const root = mount();
  unmount();
  offer();
  expect(root.querySelector('button')).toBeNull();
});
it.each([
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
])('offers iOS instructions without a native event', ua => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5);
  expect(needsIosInstall()).toBe(true);
  expect(mount().querySelector('button')).not.toBeNull();
});
it.each(['FBAN/FBIOS', 'Instagram', 'CriOS/140.0', 'FxiOS/140.0', 'EdgiOS/140.0'])('hides iOS installation in %s', browser => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`iPhone AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1 ${browser}`);
  expect(needsIosInstall()).toBe(false);
  const root = mount();
  offer();
  expect(root.querySelector('button')).toBeNull();
});
it('hides installation in Tauri and standalone', () => {
  desktop = true;
  const root = mount();
  offer();
  expect(root.querySelector('button')).toBeNull();
  desktop = false;
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  offer();
  expect(root.querySelector('button')).toBeNull();
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
});
it('does not intercept install events in an Android webview', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 Version/4.0 Chrome/140.0 Mobile Safari/537.36');
  const root = mount();
  const { event } = offer();
  expect(event.defaultPrevented).toBe(false);
  expect(root.querySelector('button')).toBeNull();
});
it('opens no unsolicited sheet and only one sheet on demand', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit Version/18.0 Mobile Safari/604.1');
  mount();
  expect(document.querySelector('dialog')).toBeNull();
  openIosInstallSheet();
  openIosInstallSheet();
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(document.querySelector('dialog')?.textContent).toContain('pwaInstall.share');
  expect(track).toHaveBeenCalledWith('pwa-ios-sheet-opened');
});
