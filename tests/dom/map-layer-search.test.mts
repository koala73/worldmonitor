import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindLayerSearch,
  LAYER_REGISTRY,
  LAYER_SYNONYMS,
} from '@/config/map-layer-definitions';

describe('Canada Roads layer discovery', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="layer-picker">
        <input class="layer-search" />
        <div class="layer-toggle-row">
          <label class="layer-toggle" data-layer="canadaRoads">Canada Roads</label>
        </div>
        <div class="layer-toggle-row">
          <label class="layer-toggle" data-layer="conflicts">Conflict Zones</label>
        </div>
      </div>
    `;
  });

  it('names Manitoba in the fallback label and jurisdiction synonyms', () => {
    expect(LAYER_REGISTRY.canadaRoads.fallbackLabel).toContain('Manitoba');
    expect(LAYER_SYNONYMS.manitoba).toContain('canadaRoads');
  });

  it('finds Canada Roads when the picker is searched for Manitoba', () => {
    const picker = document.querySelector<HTMLElement>('#layer-picker');
    const search = picker?.querySelector<HTMLInputElement>('.layer-search');
    const canadaRoads = picker?.querySelector<HTMLElement>('[data-layer="canadaRoads"]')?.closest<HTMLElement>('.layer-toggle-row');
    const conflicts = picker?.querySelector<HTMLElement>('[data-layer="conflicts"]')?.closest<HTMLElement>('.layer-toggle-row');

    expect(picker).not.toBeNull();
    expect(search).not.toBeNull();
    expect(canadaRoads).not.toBeNull();
    expect(conflicts).not.toBeNull();

    bindLayerSearch(picker!);
    search!.value = 'manitoba';
    search!.dispatchEvent(new Event('input'));

    expect(canadaRoads!.style.display).toBe('');
    expect(conflicts!.style.display).toBe('none');
  });
});
