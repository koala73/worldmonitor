/**
 * The desktop main window has a native macOS title bar (#1162 dropped the
 * Overlay style), so the app header must sit directly under it. The desktop
 * shell may not render chrome above the header that the web shell does not.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: vi.fn(async () => null),
  setPersistentCache: vi.fn(async () => {}),
  deletePersistentCache: vi.fn(async () => {}),
  deletePersistentCacheByPrefix: vi.fn(),
}));
vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: false, classifySentiment: vi.fn(async () => null) },
}));

import { PanelLayoutManager } from '@/app/panel-layout';

beforeAll(initTestI18n);

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function chromeAboveHeader(isDesktopApp: boolean): Promise<string[]> {
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
  const container = document.body.appendChild(document.createElement('div'));
  const layout = Object.create(PanelLayoutManager.prototype) as PanelLayoutManager;
  Reflect.set(layout, 'ctx', { container, isDesktopApp, isMobile: false, panels: {}, panelSettings: {} });
  // The shell markup is written first; panel creation after it needs a full App and throws here.
  await layout.renderLayout().catch(() => {});
  const header = container.querySelector('.header');
  expect(header, 'layout rendered the header').not.toBeNull();
  const above: string[] = [];
  for (let el = header!.previousElementSibling; el; el = el.previousElementSibling) {
    above.unshift(`${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join('.')}`);
  }
  container.remove();
  return above;
}

describe('desktop header chrome', () => {
  it('renders the same elements above the header as the web shell', async () => {
    const web = await chromeAboveHeader(false);
    const desktop = await chromeAboveHeader(true);
    expect(web).toEqual(['a#.skip-link', 'div#proBannerSlot.pro-banner-slot']);
    expect(desktop).toEqual(web);
  });
});
