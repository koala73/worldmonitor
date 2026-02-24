/**
 * Standalone settings window: panel toggles only.
 * Loaded when the app is opened with ?settings=1 (e.g. from the main window's Settings button).
 */
import type { PanelConfig } from '@/types';
import { DEFAULT_PANELS, STORAGE_KEYS } from '@/config';
import { loadFromStorage, saveToStorage, isMobileDevice } from '@/utils';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';

const INTEL_FINDINGS_KEY = 'worldmonitor-intel-findings';

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

  let panelSettings = loadFromStorage<Record<string, PanelConfig>>(
    STORAGE_KEYS.panels,
    DEFAULT_PANELS
  );

  const isDesktopApp = isDesktopRuntime();
  const isMobile = isMobileDevice();

  function getFindingsEnabled(): boolean {
    return localStorage.getItem(INTEL_FINDINGS_KEY) !== 'hidden';
  }

  function setFindingsEnabled(enabled: boolean): void {
    if (enabled) {
      localStorage.removeItem(INTEL_FINDINGS_KEY);
    } else {
      localStorage.setItem(INTEL_FINDINGS_KEY, 'hidden');
    }
  }

  function render(): void {
    const panelEntries = Object.entries(panelSettings).filter(
      ([key]) => key !== 'runtime-config' || isDesktopApp
    );
    const panelHtml = panelEntries
      .map(
        ([key, panel]) => `
        <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}" data-panel="${key}">
          <div class="panel-toggle-checkbox">${panel.enabled ? '✓' : ''}</div>
          <span class="panel-toggle-label">${getLocalizedPanelName(key, panel.name)}</span>
        </div>
      `
      )
      .join('');

    const findingsHtml = isMobile
      ? ''
      : `
      <div class="panel-toggle-item ${getFindingsEnabled() ? 'active' : ''}" data-panel="intel-findings">
        <div class="panel-toggle-checkbox">${getFindingsEnabled() ? '✓' : ''}</div>
        <span class="panel-toggle-label">Intelligence Findings</span>
      </div>
    `;

    const grid = document.getElementById('panelToggles');
    if (grid) {
      grid.innerHTML = panelHtml + findingsHtml;
      grid.querySelectorAll('.panel-toggle-item').forEach((item) => {
        item.addEventListener('click', () => {
          const panelKey = (item as HTMLElement).dataset.panel!;
          if (panelKey === 'intel-findings') {
            const next = !getFindingsEnabled();
            setFindingsEnabled(next);
            render();
            return;
          }
          const config = panelSettings[panelKey];
          if (config) {
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
