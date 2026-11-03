import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import enShell from '@/locales/en.shell.json';
import en from '@/locales/en.json';
import type { MapLayers } from '@/types';

const loading = vi.hoisted(() => ({ ready: Promise.resolve() }));
vi.mock('@/services/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/i18n')>(),
  initI18n: () => loading.ready,
}));

import { MapComponent } from '@/components/Map';
import { DeckGLMap } from '@/components/DeckGLMap';
import { GlobeMap } from '@/components/GlobeMap';

type ExplanationMap = {
  container: HTMLElement;
  destroyed: boolean;
  showLayerExplanation: (layer: keyof MapLayers) => Promise<void>;
  getLayerControlLabel: (layer: keyof MapLayers) => string;
  clearLayerExplanationOutsideClickHandler: () => void;
};

let release: () => void;
const maps: ExplanationMap[] = [];

beforeEach(async () => {
  document.body.replaceChildren();
  if (i18next.isInitialized) i18next.removeResourceBundle('en', 'translation');
  await i18next.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: structuredClone(enShell) } } });
  loading.ready = new Promise<void>((resolve) => {
    release = () => {
      i18next.addResourceBundle('en', 'translation', en, true, true);
      resolve();
    };
  });
});

afterEach(() => {
  for (const map of maps.splice(0)) map.clearLayerExplanationOutsideClickHandler?.();
  vi.clearAllTimers();
  vi.useRealTimers();
});

for (const [name, Component] of Object.entries({ SVG: MapComponent, DeckGL: DeckGLMap, Globe: GlobeMap })) {
  describe(`${name} explanation translation loading`, () => {
    function createMap(): ExplanationMap {
      const map = Object.create(Component.prototype) as ExplanationMap;
      map.container = document.createElement('div');
      map.destroyed = false;
      map.getLayerControlLabel = () => 'Intel Hotspots';
      document.body.append(map.container);
      maps.push(map);
      return map;
    }

    it('waits for full English copy, then opens a complete card that can close', async () => {
      vi.useFakeTimers();
      const map = createMap();
      const opening = map.showLayerExplanation('hotspots');
      expect(map.container.querySelector('.layer-explanation-popup')).toBeNull();
      release();
      await opening;
      const popup = map.container.querySelector<HTMLElement>('.layer-explanation-popup')!;
      expect(popup.textContent).toContain(en.layerExplanation.layers.hotspots.purpose);
      expect(popup.textContent).toContain(en.layerExplanation.labels.source);
      expect(popup.textContent).not.toContain('layerExplanation.');
      await vi.advanceTimersByTimeAsync(100);
      popup.querySelector<HTMLButtonElement>('.layer-explanation-close')!.click();
      expect(map.container.querySelector('.layer-explanation-popup')).toBeNull();
    });

    it('keeps a failed load closed and allows a later retry', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = createMap();
      loading.ready = Promise.reject(new Error('Locale download failed'));
      await map.showLayerExplanation('hotspots');
      expect(map.container.querySelector('.layer-explanation-popup')).toBeNull();
      release();
      loading.ready = Promise.resolve();
      await map.showLayerExplanation('hotspots');
      expect(map.container.querySelector('.layer-explanation-popup')?.textContent)
        .toContain(en.layerExplanation.layers.hotspots.purpose);
      await vi.advanceTimersByTimeAsync(100);
    });

    it('does not create a card after its map is destroyed while text is loading', async () => {
      vi.useFakeTimers();
      const map = createMap();
      const opening = map.showLayerExplanation('hotspots');
      map.destroyed = true;
      release();
      await opening;
      expect(map.container.querySelector('.layer-explanation-popup')).toBeNull();
    });
  });
}
