import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeckGLMap } from '@/components/DeckGLMap';
import { GlobeMap } from '@/components/GlobeMap';
import { MapComponent } from '@/components/Map';
import type { WebcamLeafLike } from '@/components/map/webcam-click';
import type { WebcamEntry } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import { getActiveWebcams, getPinnedWebcams } from '@/services/webcams/pinned-store';

const PLAYER = 'https://webcams.windy.com/webcams/public/embed/player/horn/day?autoplay=1';
const STORAGE_KEY = 'wm-pinned-webcams';
const TURN_BACK_ON = '\u{1F4CC} Turn back on';
const PINNED = '\u{1F4CC} Pinned';

vi.mock('@/services/webcams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/webcams')>();
  return {
    ...actual,
    fetchWebcamImage: async () => ({
      thumbnailUrl: '',
      playerUrl: PLAYER,
      title: 'Cape Horn',
      windyUrl: 'https://www.windy.com/webcams/horn',
      lastUpdated: '',
      error: '',
    }),
  };
});

function stored(active: boolean, pinnedAt: number) {
  return {
    webcamId: 'horn',
    title: 'Cape Horn',
    lat: -54.9,
    lng: -67.6,
    category: 'city',
    country: 'CL',
    playerUrl: PLAYER,
    active,
    pinnedAt,
  };
}

function seed(active: boolean): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([stored(active, 1)]));
}

type FlatPopup = {
  container: HTMLElement;
  showWebcamTooltip: (cam: WebcamEntry, x: number, y: number) => void;
};

type DeckPopup = {
  container: HTMLElement;
  showWebcamClickPopup: (webcam: WebcamLeafLike, x: number, y: number) => Promise<void>;
};

type GlobePopup = {
  container: HTMLElement;
  tooltipEl: HTMLElement | null;
  tooltipHideTimer: ReturnType<typeof setTimeout> | null;
  popup: { hide: () => void } | null;
  showMarkerTooltip: (marker: unknown, anchor: HTMLElement) => void;
};

const roots: HTMLElement[] = [];

function container(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  roots.push(element);
  return element;
}

function openFlatMap(): HTMLElement {
  const map = Object.create(MapComponent.prototype) as FlatPopup;
  map.container = container();
  map.showWebcamTooltip({
    webcamId: 'horn',
    title: 'Cape Horn',
    lat: -54.9,
    lng: -67.6,
    category: 'city',
    country: 'CL',
  }, 20, 20);
  return map.container;
}

async function openDeckMap(): Promise<HTMLElement> {
  const map = Object.create(DeckGLMap.prototype) as DeckPopup;
  map.container = container();
  await map.showWebcamClickPopup({
    webcamId: 'horn',
    title: 'Cape Horn',
    lat: -54.9,
    lng: -67.6,
    category: 'city',
    country: 'CL',
  }, 20, 20);
  return map.container;
}

function openGlobe(): HTMLElement {
  const map = Object.create(GlobeMap.prototype) as GlobePopup;
  map.container = container();
  map.tooltipEl = null;
  map.tooltipHideTimer = null;
  map.popup = null;
  const anchor = document.createElement('div');
  map.container.appendChild(anchor);
  map.showMarkerTooltip({
    _kind: 'webcam',
    _lat: -54.9,
    _lng: -67.6,
    webcamId: 'horn',
    title: 'Cape Horn',
    category: 'city',
    country: 'CL',
  }, anchor);
  return map.container;
}

async function pinButton(root: ParentNode): Promise<HTMLButtonElement> {
  await vi.waitFor(() => {
    expect(root.querySelector('.webcam-pin-btn')).toBeTruthy();
  });
  const button = root.querySelector<HTMLButtonElement>('.webcam-pin-btn');
  if (!button) throw new Error('pin button missing');
  return button;
}

describe('map pin button for a hidden webcam', () => {
  beforeEach(async () => {
    localStorage.clear();
    await new Promise(resolve => requestAnimationFrame(resolve));
  });

  afterEach(() => {
    for (const root of roots.splice(0)) root.remove();
    localStorage.clear();
  });

  it.each([
    ['flat map', openFlatMap],
    ['deck map', openDeckMap],
    ['globe', openGlobe],
  ] as const)('%s offers Turn back on and activates the saved camera', async (_name, open) => {
    seed(false);
    const button = await pinButton(await open());

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(TURN_BACK_ON);
    expect(button.classList.contains('webcam-pin-btn--pinned')).toBe(false);

    button.click();

    expect(getActiveWebcams().map(cam => cam.webcamId)).toEqual(['horn']);
    expect(getPinnedWebcams()).toHaveLength(1);
    expect(getPinnedWebcams()[0]?.playerUrl).toBe(PLAYER);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(PINNED);
  });

  it('leaves an already playing camera disabled on the flat map', async () => {
    seed(true);
    const button = await pinButton(openFlatMap());

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(PINNED);
    button.click();
    expect(getActiveWebcams().map(cam => cam.webcamId)).toEqual(['horn']);
    expect(getPinnedWebcams()).toHaveLength(1);
  });
});
