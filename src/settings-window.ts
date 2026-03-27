/**
 * Standalone settings window: panel toggles only.
 * Loaded when the app is opened with ?settings=1 (e.g. from the main window's Settings button).
 */
import type { PanelConfig } from '@/types';
import { DEFAULT_PANELS, STORAGE_KEYS, ALL_PANELS, VARIANT_DEFAULTS, getEffectivePanelConfig, isPanelEntitled, FREE_MAX_PANELS } from '@/config';
import { isProUser } from '@/services/widget-store';
import { SITE_VARIANT } from '@/config/variant';
import { loadFromStorage, saveToStorage } from '@/utils';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';

function getLocalizedPanelName(panelKey: string, fallback: string): string {
  if (panelKey === 'runtime-config') {
    return t('modals.runtimeConfig.title');
  }
  const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
  const lookup = `panels.${key}`;
  const localized = t(lookup);
  return localized === lookup ? fallback : localized;
}

export function initSettingsWindow(): void {
  const appEl = document.getElementById('app');
  if (!appEl) return;

  // This window shows only "which panels to display" (panel display settings).
  document.title = `${t('header.settings')} - World Monitor`;

  const panelSettings = loadFromStorage<Record<string, PanelConfig>>(
    STORAGE_KEYS.panels,
    DEFAULT_PANELS
  );
  const variantDefaults = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);
  for (const key of Object.keys(ALL_PANELS)) {
    if (!(key in panelSettings)) {
      panelSettings[key] = { ...getEffectivePanelConfig(key, SITE_VARIANT), enabled: variantDefaults.has(key) };
    }
  }

  const isDesktopApp = isDesktopRuntime();

  function render(): void {
    const panelEntries = Object.entries(panelSettings).filter(
      ([key]) => (key !== 'runtime-config' || isDesktopApp) && (!key.startsWith('cw-') || isProUser())
    );
    const panelHtml = panelEntries
      .map(
        ([key, panel]) => `
        <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}" data-panel="${escapeHtml(key)}">
          <div class="panel-toggle-checkbox">${panel.enabled ? '✓' : ''}</div>
          <span class="panel-toggle-label">${escapeHtml(getLocalizedPanelName(key, panel.name))}</span>
        </div>
      `
      )
      .join('');

    const grid = document.getElementById('panelToggles');
    if (grid) {
      grid.innerHTML = panelHtml;
      grid.querySelectorAll('.panel-toggle-item').forEach((item) => {
        item.addEventListener('click', () => {
          const panelKey = (item as HTMLElement).dataset.panel!;
          const config = panelSettings[panelKey];
          if (config) {
            if (!config.enabled && !isPanelEntitled(panelKey, ALL_PANELS[panelKey] ?? config, isProUser())) return;
            if (!config.enabled && !isProUser()) {
              const enabledCount = Object.entries(panelSettings).filter(([k, p]) => p.enabled && !k.startsWith('cw-')).length;
              if (enabledCount >= FREE_MAX_PANELS) return;
            }
            config.enabled = !config.enabled;
            saveToStorage(STORAGE_KEYS.panels, panelSettings);
            render();
          }
        });
      });
    }
  }

  appEl.innerHTML = `
    <div class="settings-window-shell">
      <div class="settings-window-header">
        <div class="settings-window-header-text">
          <span class="settings-window-title">${escapeHtml(t('header.settings'))}</span>
          <p class="settings-window-caption">${escapeHtml(t('header.panelDisplayCaption'))}</p>
        </div>
        <button type="button" class="modal-close" id="settingsWindowClose">×</button>
      </div>
      <div class="panel-toggle-grid" id="panelToggles"></div>
    </div>
  `;

  document.getElementById('settingsWindowClose')?.addEventListener('click', () => {
    window.close();
  });

  render();
}
