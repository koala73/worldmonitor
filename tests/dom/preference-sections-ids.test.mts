/**
 * Each preference page mounts alone, so a change handler can only reach
 * controls rendered on its own page. A control moved to another section, or a
 * coupling that reaches across sections, fails here instead of silently doing
 * nothing in the shipped modal.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { MAP_THEME_OPTIONS, getMapProvider, type MapProvider } from '@/config/basemap';
import { SETTINGS_SECTION_IDS, isPreferenceSection } from '@/config/settings-sections';
import { preferenceSectionControlIds, renderPreferenceSection } from '@/services/preferences-content';
import { setAiFlowSetting } from '@/services/ai-flow-settings';

const PREFERENCE_IDS = SETTINGS_SECTION_IDS.filter(isPreferenceSection);
const host = { isDesktopApp: false, isSignedIn: true };

function mount(id: (typeof PREFERENCE_IDS)[number]): { root: HTMLElement; detach: () => void } {
  const root = document.createElement('section');
  const section = renderPreferenceSection(id, host);
  root.innerHTML = section.html;
  document.body.append(root);
  return { root, detach: section.attach(root) };
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('preference sections', () => {
  it('covers every preference page in the registry', () => {
    expect(PREFERENCE_IDS).toEqual(['display', 'map', 'ai', 'video', 'sync']);
  });

  it.each(PREFERENCE_IDS)('renders every control the %s handlers own', (id) => {
    const { root, detach } = mount(id);
    try {
      const owned = preferenceSectionControlIds(id);
      expect(owned.length).toBeGreaterThan(0);
      for (const controlId of owned) {
        expect(root.querySelector(`#${controlId}`), `${id} renders #${controlId}`).not.toBeNull();
      }
    } finally {
      detach();
    }
  });

  it('gives each control exactly one owning section', () => {
    const owners = PREFERENCE_IDS.flatMap((id) => preferenceSectionControlIds(id));
    expect(new Set(owners).size).toBe(owners.length);
  });

  it('repopulates the map theme list on the same page when the provider changes', () => {
    const { root, detach } = mount('map');
    try {
      const provider = root.querySelector<HTMLSelectElement>('#us-map-provider')!;
      const next = [...provider.options].map((option) => option.value as MapProvider)
        .find((value) => value !== getMapProvider())!;
      provider.value = next;
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      const themes = [...root.querySelectorAll<HTMLOptionElement>('#us-map-theme option')].map((option) => option.value);
      expect(themes).toEqual(MAP_THEME_OPTIONS[next].map((option) => option.value));
    } finally {
      detach();
    }
  });

  it('enables Headline Memory on the AI page when the browser model turns on', () => {
    setAiFlowSetting('browserModel', false);
    const { root, detach } = mount('ai');
    try {
      const memory = root.querySelector<HTMLInputElement>('#us-headline-memory')!;
      expect(memory.disabled).toBe(true);
      const browser = root.querySelector<HTMLInputElement>('#us-browser')!;
      browser.checked = true;
      browser.dispatchEvent(new Event('change', { bubbles: true }));
      expect(memory.disabled).toBe(false);
      expect(root.querySelector<HTMLElement>('.ai-flow-toggle-warn')!.style.display).toBe('block');
    } finally {
      detach();
    }
  });

  it('ignores a change from a control outside the page', () => {
    const display = mount('display');
    const map = mount('map');
    try {
      const before = getMapProvider();
      const other = [...map.root.querySelectorAll<HTMLOptionElement>('#us-map-provider option')]
        .map((option) => option.value).find((value) => value !== before)!;
      const stray = document.createElement('select');
      stray.id = 'us-map-provider';
      stray.innerHTML = `<option value="${other}" selected>x</option>`;
      display.root.append(stray);
      stray.dispatchEvent(new Event('change', { bubbles: true }));
      expect(getMapProvider()).toBe(before);
    } finally {
      display.detach();
      map.detach();
    }
  });
});
