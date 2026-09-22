import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveWebcamsPanel } from '@/components/LiveWebcamsPanel';

import { initTestI18n } from './helpers/i18n.mts';

const ALL_REGIONS_WALL = [
  'Jerusalem live webcam',
  'Middle East live webcam',
  'Ukraine live webcam',
  'Washington DC live webcam',
];
const EUROPE_WALL = [
  'London live webcam',
  'Paris live webcam',
  'St. Petersburg live webcam',
  'Ukraine live webcam',
];

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

function setOnScreen(isIntersecting: boolean): void {
  const observer = internals().observer;
  if (!observer) throw new Error('webcam visibility observer missing');
  observer.callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
}

function mountOnScreen(): LiveWebcamsPanel {
  panel = new LiveWebcamsPanel();
  document.body.appendChild(internals().element);
  setOnScreen(true);
  return panel;
}

function playingFeeds(): string[] {
  return Array.from(internals().content.querySelectorAll<HTMLIFrameElement>('.webcam-iframe'))
    .map((iframe) => iframe.title)
    .sort();
}

function previewTileCities(): string[] {
  return Array.from(internals().content.querySelectorAll<HTMLElement>('.webcam-preview-tile .webcam-preview-title'))
    .map((title) => title.textContent ?? '')
    .sort();
}

function clickPanelControl(selector: string): void {
  const control = internals().element.querySelector<HTMLButtonElement>(selector);
  if (!control) throw new Error(`no control matching ${selector}`);
  control.click();
}

function playFromPreview(): void {
  const play = internals().content.querySelector<HTMLButtonElement>('.webcam-preview-play');
  if (!play) throw new Error('no preview play button');
  play.click();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  const prototype = LiveWebcamsPanel.prototype as unknown as { buildEmbedUrl(videoId: string): string };
  vi.spyOn(prototype, 'buildEmbedUrl').mockReturnValue('about:blank');
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('Live Webcams region switch', () => {
  it('keeps the wall playing across a region switch', () => {
    mountOnScreen();
    playFromPreview();
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);

    clickPanelControl('.webcam-region-btn[data-region="europe"]');

    expect(playingFeeds()).toEqual(EUROPE_WALL);
    expect(previewTileCities()).toEqual([]);
  });

  it('leaves a never-played wall on previews across a region switch', () => {
    mountOnScreen();
    expect(playingFeeds()).toEqual([]);

    clickPanelControl('.webcam-region-btn[data-region="europe"]');

    expect(playingFeeds()).toEqual([]);
    expect(previewTileCities()).toEqual(['London', 'Paris', 'St. Petersburg', 'Ukraine']);
  });
});
