import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PinnedWebcamsPanel } from '@/components/PinnedWebcamsPanel';
import { pinWebcam } from '@/services/webcams/pinned-store';

import { initTestI18n } from './helpers/i18n.mts';

const STORAGE_KEY = 'wm-pinned-webcams';
const PLAYER = 'https://webcams.windy.com/webcams/public/embed/player';

function storedCam(webcamId: string, active: boolean, pinnedAt: number) {
  return {
    webcamId,
    title: `Cam ${webcamId}`,
    lat: -54.9,
    lng: -67.6,
    category: 'city',
    country: 'CL',
    playerUrl: `${PLAYER}/${webcamId}/day`,
    active,
    pinnedAt,
  };
}

function seed(cams: ReturnType<typeof storedCam>[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cams));
}

let panel: PinnedWebcamsPanel | undefined;

function mount(): PinnedWebcamsPanel {
  panel = new PinnedWebcamsPanel();
  document.body.appendChild(panel.getElement());
  return panel;
}

function root(): HTMLElement {
  if (!panel) throw new Error('panel not mounted');
  return panel.getElement();
}

function rowNames(): string[] {
  return [...root().querySelectorAll('.pinned-webcam-row-name')].map(node => node.textContent ?? '');
}

function playingTitles(): string[] {
  return [...root().querySelectorAll('.pinned-webcam-iframe')].map(node => node.getAttribute('title') ?? '');
}

describe('inactive pinned webcams stay manageable', () => {
  beforeAll(() => initTestI18n());

  beforeEach(async () => {
    localStorage.clear();
    await new Promise(resolve => requestAnimationFrame(resolve));
  });

  afterEach(() => {
    panel?.destroy();
    panel?.getElement().remove();
    panel = undefined;
    localStorage.clear();
  });

  it('lists one or two hidden webcams and turns one back on from that list', () => {
    seed([storedCam('horn', false, 1), storedCam('moreno', false, 2)]);
    mount();

    expect(playingTitles()).toEqual([]);
    expect(root().querySelector('.pinned-webcams-list')).not.toBeNull();
    expect(rowNames()).toEqual(['Cam horn', 'Cam moreno']);

    const horn = [...root().querySelectorAll('.pinned-webcam-row')].find(row => row.textContent?.includes('Cam horn'));
    horn?.querySelector<HTMLButtonElement>('.pinned-webcam-row-toggle')?.click();

    expect(playingTitles()).toEqual(['Cam horn']);
    expect(rowNames()).toEqual(['Cam horn', 'Cam moreno']);
    const hornAfter = [...root().querySelectorAll('.pinned-webcam-row')].find(row => row.textContent?.includes('Cam horn'));
    expect(hornAfter?.querySelector('.pinned-webcam-row-toggle')?.textContent).toBe('ON');
  });

  it('removes the last hidden webcam from the list', () => {
    seed([storedCam('horn', false, 1)]);
    mount();

    expect(root().querySelector('.pinned-webcams-list')).not.toBeNull();
    root().querySelector<HTMLButtonElement>('.pinned-webcam-row-remove')?.click();

    expect(root().querySelector('.pinned-webcams-list')).toBeNull();
    expect(playingTitles()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([]);
  });

  it('reveals the list after Hide stream deactivates every visible webcam', () => {
    seed([storedCam('horn', true, 1), storedCam('moreno', true, 2)]);
    mount();

    expect(root().querySelector('.pinned-webcams-list')).toBeNull();
    expect(playingTitles()).toEqual(['Cam horn', 'Cam moreno']);

    for (const button of root().querySelectorAll<HTMLButtonElement>('.pinned-webcam-toggle')) button.click();

    expect(playingTitles()).toEqual([]);
    expect(root().querySelector('.pinned-webcams-list')).not.toBeNull();
    expect(rowNames()).toEqual(['Cam horn', 'Cam moreno']);
    expect([...root().querySelectorAll('.pinned-webcam-row-toggle')].map(button => button.textContent)).toEqual(['OFF', 'OFF']);
  });

  it('keeps the list hidden while every saved webcam is already playing', () => {
    seed([1, 2, 3, 4].map(pinnedAt => storedCam(String(pinnedAt), true, pinnedAt)));
    mount();

    expect(playingTitles()).toEqual(['Cam 1', 'Cam 2', 'Cam 3', 'Cam 4']);
    expect(root().querySelector('.pinned-webcams-list')).toBeNull();
  });

  it('keeps the overflow list when more than four webcams are pinned', () => {
    seed([
      ...[1, 2, 3, 4].map(pinnedAt => storedCam(String(pinnedAt), true, pinnedAt)),
      storedCam('5', false, 5),
    ]);
    mount();

    expect(playingTitles()).toEqual(['Cam 1', 'Cam 2', 'Cam 3', 'Cam 4']);
    expect(rowNames()).toEqual(['Cam 1', 'Cam 2', 'Cam 3', 'Cam 4', 'Cam 5']);
  });

  it('plays a hidden webcam again when it is pinned from the map, within four streams', () => {
    seed([
      ...[1, 2, 3, 4].map(pinnedAt => storedCam(String(pinnedAt), true, pinnedAt)),
      storedCam('5', false, 5),
    ]);
    mount();

    pinWebcam({ webcamId: '5', title: 'Cam 5', lat: -54.9, lng: -67.6, category: 'city', country: 'CL', playerUrl: `${PLAYER}/5/day` });

    expect(playingTitles()).toEqual(['Cam 2', 'Cam 3', 'Cam 4', 'Cam 5']);
    expect(rowNames()).toEqual(['Cam 1', 'Cam 2', 'Cam 3', 'Cam 4', 'Cam 5']);
  });
});
