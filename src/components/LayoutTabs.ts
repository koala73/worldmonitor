import { LAYOUT_PRESETS, LAYOUT_STORAGE_KEY, LAYOUT_OVERRIDES_PREFIX } from '@/config/layouts';
import type { LayoutPreset } from '@/config/layouts';
import type { PanelConfig } from '@/types';
import { t } from '@/services/i18n';

export interface LayoutTabsCallbacks {
  getPanelSettings: () => Record<string, PanelConfig>;
  applyLayout: (panelKeys: string[]) => void;
}

export class LayoutTabs {
  private container: HTMLElement;
  private activeLayoutId: string;
  private modified = false;
  private callbacks: LayoutTabsCallbacks;

  constructor(callbacks: LayoutTabsCallbacks) {
    this.callbacks = callbacks;
    this.activeLayoutId = localStorage.getItem(LAYOUT_STORAGE_KEY) || LAYOUT_PRESETS[0]?.id || '';
    this.container = document.createElement('div');
    this.container.className = 'layout-tabs';
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  getActiveLayoutId(): string {
    return this.activeLayoutId;
  }

  /** Check if user has modified the active layout's panel set. */
  checkModified(): void {
    const preset = LAYOUT_PRESETS.find(l => l.id === this.activeLayoutId);
    if (!preset) { this.setModified(false); return; }
    const settings = this.callbacks.getPanelSettings();
    const enabledKeys = new Set(
      Object.entries(settings)
        .filter(([, c]) => c.enabled)
        .map(([k]) => k),
    );
    const presetKeys = new Set(preset.panelKeys);
    const same = enabledKeys.size === presetKeys.size && [...enabledKeys].every(k => presetKeys.has(k));
    this.setModified(!same);
  }

  private setModified(mod: boolean): void {
    if (this.modified === mod) return;
    this.modified = mod;
    const activeTab = this.container.querySelector('.layout-tab.active');
    activeTab?.classList.toggle('modified', mod);
  }

  private render(): void {
    this.container.innerHTML = '';
    for (const preset of LAYOUT_PRESETS) {
      const tab = document.createElement('button');
      tab.className = `layout-tab${preset.id === this.activeLayoutId ? ' active' : ''}`;
      tab.dataset.layoutId = preset.id;
      tab.title = preset.id === this.activeLayoutId && this.modified
        ? t('layouts.clickToReset')
        : t(preset.labelKey);
      tab.innerHTML = `<span class="layout-tab-icon">${preset.icon}</span><span class="layout-tab-label">${t(preset.labelKey)}</span>`;
      tab.addEventListener('click', () => this.onTabClick(preset));
      this.container.appendChild(tab);
    }
  }

  private onTabClick(preset: LayoutPreset): void {
    if (preset.id === this.activeLayoutId && this.modified) {
      // Reset to defaults — clear overrides
      localStorage.removeItem(LAYOUT_OVERRIDES_PREFIX + preset.id);
      this.callbacks.applyLayout(preset.panelKeys);
      this.setModified(false);
      return;
    }
    if (preset.id === this.activeLayoutId) return;

    this.activeLayoutId = preset.id;
    localStorage.setItem(LAYOUT_STORAGE_KEY, preset.id);

    // Check for saved overrides
    const overridesJson = localStorage.getItem(LAYOUT_OVERRIDES_PREFIX + preset.id);
    if (overridesJson) {
      try {
        const overrideKeys: string[] = JSON.parse(overridesJson);
        this.callbacks.applyLayout(overrideKeys);
        this.setModified(true);
      } catch {
        this.callbacks.applyLayout(preset.panelKeys);
        this.setModified(false);
      }
    } else {
      this.callbacks.applyLayout(preset.panelKeys);
      this.setModified(false);
    }

    // Update active tab styling
    this.container.querySelectorAll('.layout-tab').forEach(el => {
      el.classList.toggle('active', (el as HTMLElement).dataset.layoutId === preset.id);
      el.classList.remove('modified');
    });
  }
}
