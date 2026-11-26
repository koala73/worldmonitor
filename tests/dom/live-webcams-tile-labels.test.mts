import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveWebcamsPanel } from '@/components/LiveWebcamsPanel';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const { withFixtureWebcamCatalog } = await import('./helpers/webcam-catalog.mts');
  return withFixtureWebcamCatalog(await importOriginal<typeof import('@/config/live-video-sources')>());
});

class FakeIntersectionObserver {
  readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  observer: FakeIntersectionObserver | null;
}

let panel: LiveWebcamsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function mountOnScreen(): void {
  panel = new LiveWebcamsPanel();
  document.body.appendChild(internals().element);
  const observer = internals().observer;
  if (!observer) throw new Error('webcam visibility observer missing');
  observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
}

function showRegion(region: string): void {
  const button = internals().element.querySelector<HTMLButtonElement>(`.webcam-region-btn[data-region="${region}"]`);
  if (!button) throw new Error(`no ${region} region button`);
  button.click();
}

function previewTiles(): { title: string; meta: string }[] {
  return Array.from(internals().content.querySelectorAll<HTMLElement>('.webcam-preview-tile')).map((tile) => ({
    title: tile.querySelector('.webcam-preview-title')?.textContent ?? '',
    meta: tile.querySelector('.webcam-preview-meta')?.textContent ?? '',
  }));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Live Webcams preview tile labels', () => {
  it('names each space feed and says Space once', () => {
    mountOnScreen();
    showRegion('space');

    expect(previewTiles()).toEqual([
      { title: 'ISS Earth View', meta: 'Space' },
      { title: 'Sen 4K Earth View', meta: 'Space' },
    ]);
  });

  it('drops a country that repeats the camera name', () => {
    mountOnScreen();
    showRegion('europe');

    expect(previewTiles()).toContainEqual({ title: 'Ukraine', meta: 'europe' });
    expect(previewTiles()).toContainEqual({ title: 'Paris', meta: 'France · europe' });
  });
});
