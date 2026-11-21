import { LANGUAGES, getCurrentLanguageTag, changeLanguage, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting, getStreamQuality, setStreamQuality, STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import { getMapProvider, setMapProvider, MAP_PROVIDER_OPTIONS, MAP_THEME_OPTIONS, getMapTheme, setMapTheme, type MapProvider } from '@/config/basemap';
import {
  formatIdleStopMinutes,
  getLiveMediaIdleStop,
  getLiveNewsAutoplay,
  getLiveStreamsAlwaysOn,
  LIVE_MEDIA_IDLE_STOP_OPTIONS,
  parseLiveMediaIdleStop,
  setLiveMediaIdleStop,
  setLiveNewsAutoplay,
  setLiveStreamsAlwaysOn,
} from '@/services/live-stream-settings';
import { getGlobeVisualPreset, setGlobeVisualPreset, GLOBE_VISUAL_PRESET_OPTIONS, type GlobeVisualPreset } from '@/services/globe-render-settings';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/utils/theme-manager';
import { getFontFamily, setFontFamily, type FontFamily } from '@/services/font-settings';
import {
  FONT_SCALE_CHANGED_EVENT,
  FONT_SCALE_STEPS,
  fontScaleLabel,
  getFontScale,
  parseFontScale,
  setFontScale,
  type FontScaleChangedDetail,
} from '@/services/font-scale-settings';
import { escapeHtml } from '@/utils/sanitize';
import { trackLanguageChange } from '@/services/analytics';
import { exportSettings, importSettings, type ImportResult } from '@/utils/settings-persistence';
import { getSyncState, getLastSyncAt, syncNow, isCloudSyncEnabled } from '@/utils/cloud-prefs-sync';
import { declareOverlay } from '@/utils/open-modal';
import { createFocusTrap } from '@/utils/focus-trap';

const SYNC_STATE_LABELS: Record<string, string> = {
  synced: 'Synced', pending: 'Pending', syncing: 'Syncing\u2026',
  conflict: 'Conflict', offline: 'Offline', 'signed-out': 'Signed out', error: 'Error',
};
const SYNC_STATE_COLORS: Record<string, string> = {
  synced: 'var(--color-ok, #34d399)', pending: 'var(--color-warn, #fbbf24)', syncing: 'var(--color-warn, #fbbf24)',
  conflict: 'var(--color-error, #f87171)', offline: 'var(--text-faint, #888)', 'signed-out': 'var(--text-faint, #888)', error: 'var(--color-error, #f87171)',
};
import {
  loadFrameworkLibrary,
  saveImportedFramework,
  deleteImportedFramework,
  renameImportedFramework,
  getActiveFrameworkForPanel,
  type AnalysisPanelId,
} from '@/services/analysis-framework-store';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import type { PreferenceSectionId } from '@/config/settings-sections';


const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export interface PreferencesHost {
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  onSettingSaved?: () => void;
  isSignedIn?: boolean;
}

export interface PreferencesResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

function toggleRowHtml(
  id: string,
  label: string,
  desc: string,
  checked: boolean,
  disabled = false,
): string {
  // The visible text lives outside the wrapping <label>, so the checkbox
  // needs an explicit aria-labelledby/-describedby to have an accessible name.
  return `
    <div class="ai-flow-toggle-row${disabled ? ' is-disabled' : ''}">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label" id="${id}-label">${label}</div>
        <div class="ai-flow-toggle-desc" id="${id}-desc">${desc}</div>
      </div>
      <label class="ai-flow-switch${disabled ? ' is-disabled' : ''}">
        <input type="checkbox" id="${id}" aria-labelledby="${id}-label" aria-describedby="${id}-desc"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="ai-flow-slider"></span>
      </label>
    </div>
  `;
}

function renderMapThemeDropdown(container: HTMLElement, provider: MapProvider): void {
  const select = container.querySelector<HTMLSelectElement>('#us-map-theme');
  if (!select) return;
  const currentTheme = getMapTheme(provider);
  setTrustedHtml(select, trustedHtml(MAP_THEME_OPTIONS[provider]
    .map(opt => `<option value="${opt.value}"${opt.value === currentTheme ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join(''), "legacy direct innerHTML migration"));
}

function updateSyncStatusUI(container: HTMLElement): void {
  const dot = container.querySelector<HTMLElement>('#usSyncDot');
  const label = container.querySelector<HTMLElement>('#usSyncLabel');
  const time = container.querySelector<HTMLElement>('#usSyncTime');
  if (!dot || !label || !time) return;

  const state = getSyncState();
  const lastSync = getLastSyncAt();

  dot.style.background = (SYNC_STATE_COLORS[state] ?? SYNC_STATE_COLORS.error) as string;
  label.textContent = SYNC_STATE_LABELS[state] ?? 'Unknown';
  time.textContent = `Last synced: ${lastSync ? new Date(lastSync).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : 'Never'}`;
}

function updateAiStatus(container: HTMLElement): void {
  const settings = getAiFlowSettings();
  const dot = container.querySelector('#usStatusDot');
  const text = container.querySelector('#usStatusText');
  if (!dot || !text) return;

  dot.className = 'ai-flow-status-dot';
  if (settings.cloudLlm && settings.browserModel) {
    dot.classList.add('active');
    text.textContent = t('components.insights.aiFlowStatusCloudAndBrowser');
  } else if (settings.cloudLlm) {
    dot.classList.add('active');
    text.textContent = t('components.insights.aiFlowStatusActive');
  } else if (settings.browserModel) {
    dot.classList.add('browser-only');
    text.textContent = t('components.insights.aiFlowStatusBrowserOnly');
  } else {
    dot.classList.add('disabled');
    text.textContent = t('components.insights.aiFlowStatusDisabled');
  }
}

type ChangeHandler = (
  target: HTMLInputElement,
  root: HTMLElement,
  host: PreferencesHost,
) => boolean | Promise<boolean>;

interface PreferenceSectionSpec {
  html(host: PreferencesHost): string;
  /**
   * Keyed by control id, or by group id for a radio group. A handler only
   * touches ids inside `root`, its own page.
   */
  onChange: Readonly<Record<string, ChangeHandler>>;
  attach?(root: HTMLElement, host: PreferencesHost, signal: AbortSignal): void;
}

function selectHtml(
  id: string,
  label: string,
  desc: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  current: string,
): string {
  return `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="${id}-label">${label}</div>
      <div class="ai-flow-toggle-desc">${desc}</div>
    </div>
  </div>
  <select class="unified-settings-select" id="${id}" aria-labelledby="${id}-label">${options
    .map(opt => `<option value="${opt.value}"${opt.value === current ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('')}</select>`;
}

/**
 * A short choice as a row of radio buttons sharing the name `id`; the group
 * carries the id. Arrow keys move between options, as in any radio group.
 */
function segmentedHtml(
  id: string,
  label: string,
  desc: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  current: string,
): string {
  return `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="${id}-label">${label}</div>
      <div class="ai-flow-toggle-desc" id="${id}-desc">${desc}</div>
    </div>
  </div>
  <div class="us-segmented" role="radiogroup" id="${id}" aria-labelledby="${id}-label" aria-describedby="${id}-desc">${options
    .map(opt => `<label class="us-segment"><input type="radio" name="${id}" value="${opt.value}"${opt.value === current ? ' checked' : ''}><span>${escapeHtml(opt.label)}</span></label>`)
    .join('')}</div>`;
}

function sectionHeading(label: string): string {
  return `<h3 class="wm-pref-heading">${label}</h3>`;
}

const displaySection: PreferenceSectionSpec = {
  html() {
    // Compared against LANGUAGES[].code below, which carries full tags (`zh-TW`).
    // The region-stripped accessor would mark 简体中文 selected for a Traditional reader.
    const currentLang = getCurrentLanguageTag();
    // The description says what Auto follows, so its segment needs only the short label.
    let html = segmentedHtml('us-theme', t('preferences.theme'), t('preferences.themeDesc'), [
      { value: 'light', label: t('preferences.themeLight') },
      { value: 'dark', label: t('preferences.themeDark') },
      { value: 'auto', label: t('settings.summary.themeAuto') },
    ] satisfies Array<{ value: ThemePreference; label: string }>, getThemePreference());
    html += segmentedHtml('us-font-family', t('preferences.fontFamily'), t('preferences.fontFamilyDesc'), [
      { value: 'mono', label: t('preferences.fontMono') },
      { value: 'system', label: t('preferences.fontSystem') },
    ] satisfies Array<{ value: FontFamily; label: string }>, getFontFamily());
    // Panel font scale. Fixed-geometry map chrome deliberately does not inherit
    // this value; individual panel overrides live in Settings -> Panels.
    html += selectHtml(
      'us-font-scale',
      t('preferences.fontScale', { defaultValue: 'Panel text size' }),
      t('preferences.fontScaleDesc', { defaultValue: 'Sets panel text globally. A panel-specific value replaces this setting.' }),
      FONT_SCALE_STEPS.map(scale => ({ value: String(scale), label: fontScaleLabel(scale) })),
      String(getFontScale()),
    );
    html += `<div class="ai-flow-section-label" id="us-language-label">${t('header.languageLabel')}</div>`;
    html += `<select class="unified-settings-lang-select" id="us-language" aria-labelledby="us-language-label">`;
    for (const lang of LANGUAGES) {
      const selected = lang.code === currentLang ? ' selected' : '';
      html += `<option value="${lang.code}"${selected}>${lang.flag} ${escapeHtml(lang.label)}</option>`;
    }
    html += `</select>`;
    if (currentLang === 'vi') {
      html += `<div class="ai-flow-toggle-desc">${t('components.languageSelector.mapLabelsFallbackVi')}</div>`;
    }
    html += toggleRowHtml('us-badge-anim', t('components.insights.badgeAnimLabel'), t('components.insights.badgeAnimDesc'), getAiFlowSettings().badgeAnimation);
    return html;
  },
  onChange: {
    'us-theme': (target) => {
      setThemePreference(target.value as ThemePreference);
      return true;
    },
    'us-font-family': (target) => {
      setFontFamily(target.value as FontFamily);
      return true;
    },
    'us-font-scale': (target) => {
      const scale = parseFontScale(target.value);
      if (scale === undefined) return false;
      setFontScale(scale);
      return true;
    },
    'us-language': (target) => {
      trackLanguageChange(target.value);
      return changeLanguage(target.value);
    },
    'us-badge-anim': (target) => {
      setAiFlowSetting('badgeAnimation', target.checked);
      return true;
    },
  },
  attach(root, _host, signal) {
    window.addEventListener(FONT_SCALE_CHANGED_EVENT, (event) => {
      const select = root.querySelector<HTMLSelectElement>('#us-font-scale');
      const scale = (event as CustomEvent<FontScaleChangedDetail>).detail?.scale;
      if (select && scale !== undefined) select.value = String(scale);
    }, { signal });
  },
};

const mapSection: PreferenceSectionSpec = {
  html() {
    const currentProvider = getMapProvider();
    let html = selectHtml('us-map-provider', t('preferences.mapProvider'), t('preferences.mapProviderDesc'), MAP_PROVIDER_OPTIONS, currentProvider);
    html += selectHtml('us-map-theme', t('preferences.mapTheme'), t('preferences.mapThemeDesc'), MAP_THEME_OPTIONS[currentProvider], getMapTheme(currentProvider));
    html += toggleRowHtml('us-map-flash', t('components.insights.mapFlashLabel'), t('components.insights.mapFlashDesc'), getAiFlowSettings().mapNewsFlash);
    html += selectHtml('us-globe-visual-preset', t('preferences.globePreset'), t('preferences.globePresetDesc'), GLOBE_VISUAL_PRESET_OPTIONS, getGlobeVisualPreset());
    return html;
  },
  onChange: {
    'us-map-provider': (target, root, host) => {
      const provider = target.value as MapProvider;
      setMapProvider(provider);
      renderMapThemeDropdown(root, provider);
      host.onMapProviderChange?.(provider);
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      return true;
    },
    'us-map-theme': (target) => {
      setMapTheme(getMapProvider(), target.value);
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      return true;
    },
    'us-map-flash': (target) => {
      setAiFlowSetting('mapNewsFlash', target.checked);
      return true;
    },
    'us-globe-visual-preset': (target) => {
      setGlobeVisualPreset(target.value as GlobeVisualPreset);
      return true;
    },
  },
};

const ANALYSIS_PANELS: ReadonlyArray<{ id: AnalysisPanelId; label: string }> = [
  { id: 'insights', label: 'Insights' },
  { id: 'country-brief', label: 'Country Brief' },
  { id: 'daily-market-brief', label: 'Market Brief' },
  { id: 'deduction', label: 'Deduction' },
];

const aiSection: PreferenceSectionSpec = {
  html(host) {
    const settings = getAiFlowSettings();
    let html = '';
    if (!host.isDesktopApp) {
      html += toggleRowHtml('us-cloud', t('components.insights.aiFlowCloudLabel'), t('components.insights.aiFlowCloudDesc'), settings.cloudLlm);
      html += toggleRowHtml('us-browser', t('components.insights.aiFlowBrowserLabel'), t('components.insights.aiFlowBrowserDesc'), settings.browserModel);
      html += `<div class="ai-flow-toggle-warn" style="display:${settings.browserModel ? 'block' : 'none'}">${t('components.insights.aiFlowBrowserWarn')}</div>`;
      html += `
        <div class="ai-flow-cta">
          <div class="ai-flow-cta-title">${t('components.insights.aiFlowOllamaCta')}</div>
          <div class="ai-flow-cta-desc">${t('components.insights.aiFlowOllamaCtaDesc')}</div>
          <a href="${DESKTOP_RELEASES_URL}" target="_blank" rel="noopener noreferrer" class="ai-flow-cta-link">${t('components.insights.aiFlowDownloadDesktop')}</a>
        </div>
      `;
    }

    // Headline Memory requires Browser Local Model (it loads an embeddings
    // model in the ML worker). Disable the toggle when the parent is off so
    // the user sees the dependency rather than wondering why their Headline
    // Memory toggle "did nothing."
    const headlineDisabled = !host.isDesktopApp && !settings.browserModel;
    html += toggleRowHtml(
      'us-headline-memory',
      t('components.insights.headlineMemoryLabel'),
      t('components.insights.headlineMemoryDesc'),
      settings.headlineMemory,
      headlineDisabled,
    );

    html += sectionHeading(t('components.insights.analysisFrameworksLabel'));
    html += `<div class="ai-flow-section-label">${t('components.insights.analysisFrameworksActivePerPanel')}</div>`;
    html += `<div class="fw-panel-status-list" id="fwPanelStatusList">`;
    for (const { id, label } of ANALYSIS_PANELS) {
      const active = getActiveFrameworkForPanel(id);
      html += `<div class="fw-panel-status-row">
        <span class="fw-panel-status-name">${escapeHtml(label)}</span>
        <span class="fw-panel-status-val">${active ? escapeHtml(active.name) : t('components.insights.analysisFrameworksDefaultNeutral')}</span>
      </div>`;
    }
    html += `</div>`;

    html += `<div class="ai-flow-section-label">${t('components.insights.analysisFrameworksSkillLibrary')}</div>`;
    html += `<div class="fw-library-list" id="fwLibraryList">`;
    html += renderFrameworkLibraryHtml();
    html += `</div>`;

    html += `<div class="fw-import-row">
      <button type="button" class="btn btn-secondary fw-import-btn" id="fwImportBtn">${t('components.insights.analysisFrameworksImportBtn')}</button>
    </div>`;

    html += `<div class="fw-import-modal-backdrop" id="fwImportModalBackdrop" style="display:none">
      <div class="fw-import-modal" role="dialog" aria-modal="true" aria-label="Import framework">
        <div class="fw-import-modal-header">
          <span class="fw-import-modal-title">${t('components.insights.analysisFrameworksImportTitle')}</span>
          <button type="button" class="fw-import-modal-close" id="fwImportModalClose" aria-label="Close">&times;</button>
        </div>
        <div class="fw-import-tabs">
          <button type="button" class="fw-import-tab active" data-fw-tab="agentskills" id="fwTabAgentskills">${t('components.insights.analysisFrameworksFromAgentskills')}</button>
          <button type="button" class="fw-import-tab" data-fw-tab="json" id="fwTabJson">${t('components.insights.analysisFrameworksPasteJson')}</button>
        </div>
        <div class="fw-import-tab-panel active" id="fwTabPanelAgentskills">
          <div class="fw-import-field">
            <label class="fw-import-label" for="fwAgentskillsUrl">agentskills.io URL or ID</label>
            <input type="text" class="fw-import-input" id="fwAgentskillsUrl" placeholder="https://agentskills.io/skills/..." />
          </div>
          <button type="button" class="btn btn-secondary" id="fwFetchBtn">Fetch</button>
          <div class="fw-import-preview" id="fwAgentskillsPreview" style="display:none">
            <div class="fw-import-preview-name" id="fwPreviewName"></div>
            <div class="fw-import-preview-desc" id="fwPreviewDesc"></div>
            <button type="button" class="btn btn-primary fw-save-btn" id="fwAgentskillsSaveBtn">${t('components.insights.analysisFrameworksSaveToLibrary')}</button>
          </div>
          <div class="fw-import-error" id="fwAgentskillsError" style="display:none"></div>
        </div>
        <div class="fw-import-tab-panel" id="fwTabPanelJson">
          <div class="fw-import-field">
            <label class="fw-import-label" for="fwJsonInput">${t('components.insights.analysisFrameworksPasteJson')}</label>
            <textarea class="fw-import-textarea" id="fwJsonInput" rows="6" placeholder='{ "name": "...", "instructions": "..." }'></textarea>
          </div>
          <div class="fw-import-error" id="fwJsonError" style="display:none"></div>
          <button type="button" class="btn btn-primary fw-save-btn" id="fwJsonSaveBtn">${t('components.insights.analysisFrameworksSaveToLibrary')}</button>
        </div>
      </div>
    </div>`;

    if (!host.isDesktopApp) {
      html += `<div class="ai-flow-popup-footer"><span class="ai-flow-status-dot" id="usStatusDot"></span><span class="ai-flow-status-text" id="usStatusText"></span></div>`;
    }
    return html;
  },
  onChange: {
    'us-cloud': (target, root) => {
      setAiFlowSetting('cloudLlm', target.checked);
      updateAiStatus(root);
      return true;
    },
    'us-browser': (target, root, host) => {
      setAiFlowSetting('browserModel', target.checked);
      const warn = root.querySelector<HTMLElement>('.ai-flow-toggle-warn');
      if (warn) warn.style.display = target.checked ? 'block' : 'none';
      // Headline Memory is a child of Browser Local Model — keep its
      // toggle's enabled/disabled state in sync without re-rendering
      // the whole panel. The runtime gate (`isHeadlineMemoryEnabled`)
      // already AND-gates both flags; this just mirrors that visually.
      const hmInput = root.querySelector<HTMLInputElement>('#us-headline-memory');
      const hmRow = hmInput?.closest('.ai-flow-toggle-row');
      const hmSwitch = hmInput?.closest('.ai-flow-switch');
      if (hmInput && !host.isDesktopApp) {
        hmInput.disabled = !target.checked;
        hmRow?.classList.toggle('is-disabled', !target.checked);
        hmSwitch?.classList.toggle('is-disabled', !target.checked);
      }
      updateAiStatus(root);
      return true;
    },
    'us-headline-memory': (target) => {
      setAiFlowSetting('headlineMemory', target.checked);
      return true;
    },
  },
  attach(root, host, signal) {
    attachFrameworkHandlers(root, signal);
    if (!host.isDesktopApp) updateAiStatus(root);
  },
};

const videoSection: PreferenceSectionSpec = {
  html() {
    let html = selectHtml('us-stream-quality', t('components.insights.streamQualityLabel'), t('components.insights.streamQualityDesc'), STREAM_QUALITY_OPTIONS, getStreamQuality());
    html += toggleRowHtml(
      'us-live-news-autoplay',
      t('components.insights.liveNewsAutoplayLabel'),
      t('components.insights.liveNewsAutoplayDesc'),
      getLiveNewsAutoplay(),
    );
    html += toggleRowHtml(
      'us-live-streams-always-on',
      t('components.insights.streamAlwaysOnLabel'),
      t('components.insights.streamAlwaysOnDesc'),
      getLiveStreamsAlwaysOn(),
    );
    html += selectHtml(
      'us-live-media-idle-stop',
      t('components.insights.streamIdleStopLabel'),
      t('components.insights.streamIdleStopDesc'),
      LIVE_MEDIA_IDLE_STOP_OPTIONS.map(option => ({
        value: String(option),
        label: option === 'never'
          ? t('components.insights.streamIdleStopNever')
          : formatIdleStopMinutes(option, getCurrentLanguageTag()),
      })),
      String(getLiveMediaIdleStop()),
    );
    return html;
  },
  onChange: {
    'us-stream-quality': (target) => {
      setStreamQuality(target.value as StreamQuality);
      return true;
    },
    'us-live-news-autoplay': (target) => {
      setLiveNewsAutoplay(target.checked);
      return true;
    },
    'us-live-streams-always-on': (target) => {
      setLiveStreamsAlwaysOn(target.checked);
      return true;
    },
    'us-live-media-idle-stop': (target) => {
      const idleStop = parseLiveMediaIdleStop(target.value);
      if (idleStop === undefined) return false;
      setLiveMediaIdleStop(idleStop);
      return true;
    },
  },
};

function showsCloudSync(host: PreferencesHost): boolean {
  return !host.isDesktopApp && host.isSignedIn === true && isCloudSyncEnabled();
}

const syncSection: PreferenceSectionSpec = {
  html(host) {
    let html = '';
    if (showsCloudSync(host)) {
      const syncState = getSyncState();
      const lastSync = getLastSyncAt();
      const lastSyncStr = lastSync
        ? new Date(lastSync).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
        : 'Never';
      html += sectionHeading('Cloud Sync');
      html += `<div class="wm-sync-status-row">
        <div class="wm-sync-status-info">
          <span class="wm-sync-status-dot" id="usSyncDot" style="background:${SYNC_STATE_COLORS[syncState] ?? SYNC_STATE_COLORS.error}"></span>
          <span class="wm-sync-status-label" id="usSyncLabel">${SYNC_STATE_LABELS[syncState] ?? 'Unknown'}</span>
          <span class="wm-sync-status-time" id="usSyncTime">Last synced: ${escapeHtml(lastSyncStr)}</span>
        </div>
        <button type="button" class="btn btn-secondary wm-sync-now-btn" id="usSyncNowBtn">Sync now</button>
      </div>`;
    }
    html += sectionHeading(t('preferences.dataAndCommunity'));
    html += `
      <div class="us-data-mgmt">
        <button type="button" class="btn btn-secondary" id="usExportBtn">${t('components.settings.exportSettings')}</button>
        <button type="button" class="btn btn-secondary" id="usImportBtn">${t('components.settings.importSettings')}</button>
        <input type="file" id="usImportInput" accept=".json" class="us-hidden-input" />
      </div>
      <div class="us-data-mgmt-toast" id="usDataMgmtToast"></div>
    `;
    return html;
  },
  onChange: {
    usImportInput: (target, root) => {
      const file = target.files?.[0];
      if (!file) return false;
      importSettings(file).then((result: ImportResult) => {
        showToast(root, t('components.settings.importSuccess', { count: String(result.keysImported) }), true);
      }).catch(() => {
        showToast(root, t('components.settings.importFailed'), false);
      });
      target.value = '';
      return false;
    },
  },
  attach(root, host, signal) {
    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('#usExportBtn')) {
        try {
          exportSettings();
          showToast(root, t('components.settings.exportSuccess'), true);
        } catch {
          showToast(root, t('components.settings.exportFailed'), false);
        }
        return;
      }
      if (target.closest('#usImportBtn')) {
        root.querySelector<HTMLInputElement>('#usImportInput')?.click();
      }
    }, { signal });

    if (!showsCloudSync(host)) return;
    const syncBtn = root.querySelector<HTMLButtonElement>('#usSyncNowBtn');
    syncBtn?.addEventListener('click', () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      syncNow().finally(() => {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync now';
        updateSyncStatusUI(root);
      });
    }, { signal });
    const syncPollId = setInterval(() => updateSyncStatusUI(root), 2000);
    signal.addEventListener('abort', () => clearInterval(syncPollId));
  },
};

const SECTIONS: { readonly [K in PreferenceSectionId]: PreferenceSectionSpec } = {
  display: displaySection,
  map: mapSection,
  ai: aiSection,
  video: videoSection,
  sync: syncSection,
};

/** The control ids a section's change handlers own. */
export function preferenceSectionControlIds(id: PreferenceSectionId): readonly string[] {
  return Object.keys(SECTIONS[id].onChange);
}

/**
 * One settings page of preferences. `attach` wires one delegated change
 * handler on the page root, so a control only ever reaches its own section's
 * handlers and the ids they touch.
 */
export function renderPreferenceSection(id: PreferenceSectionId, host: PreferencesHost): PreferencesResult {
  const spec = SECTIONS[id];
  return {
    html: spec.html(host),
    attach(root: HTMLElement): () => void {
      const ac = new AbortController();
      const { signal } = ac;
      root.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const key = target.type === 'radio' ? target.name : target.id;
        const handler = Object.prototype.hasOwnProperty.call(spec.onChange, key) ? spec.onChange[key] : undefined;
        if (!handler) return;
        const saveResult = handler(target, root, host);
        if (typeof saveResult === 'boolean') {
          if (saveResult) host.onSettingSaved?.();
          return;
        }
        void saveResult.then((saved) => {
          if (saved) host.onSettingSaved?.();
        }).catch(() => undefined);
      }, { signal });
      spec.attach?.(root, host, signal);
      return () => ac.abort();
    },
  };
}

function attachFrameworkHandlers(container: HTMLElement, signal: AbortSignal): void {
  // The import modal is authored in the template above, so it declares
  // after mount. Pasted JSON and a URL input make it blocking.
  const importModal = container.querySelector<HTMLElement>('.fw-import-modal');
  if (importModal) declareOverlay(importModal, { reload: 'blocking' });
  const importBackdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
  const closeFrameworkImport = (): void => {
    if (importBackdrop) importBackdrop.style.display = 'none';
    importFocusTrap?.deactivate();
  };
  const importFocusTrap = importModal ? createFocusTrap(importModal, {
    onEscape: closeFrameworkImport,
    initialFocus: () => container.querySelector<HTMLElement>('.fw-import-tab-panel.active input, .fw-import-tab-panel.active textarea'),
  }) : null;
  signal.addEventListener('abort', () => importFocusTrap?.deactivate({ restoreFocus: false }), { once: true });

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    if (target.closest('#fwImportBtn')) {
      if (importBackdrop) {
        importBackdrop.style.display = 'flex';
        importFocusTrap?.activate();
      }
      return;
    }

    if (target.closest('#fwImportModalClose') || target.id === 'fwImportModalBackdrop') {
      closeFrameworkImport();
      return;
    }

    const tab = target.closest<HTMLElement>('[data-fw-tab]');
    if (tab?.dataset.fwTab) {
      const tabId = tab.dataset.fwTab;
      container.querySelectorAll('.fw-import-tab').forEach(el => el.classList.toggle('active', (el as HTMLElement).dataset.fwTab === tabId));
      container.querySelectorAll('.fw-import-tab-panel').forEach(el => {
        const panelEl = el as HTMLElement;
        panelEl.classList.toggle('active', panelEl.id === `fwTabPanel${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
      });
      return;
    }

    if (target.closest('#fwFetchBtn')) {
      const urlInput = container.querySelector<HTMLInputElement>('#fwAgentskillsUrl');
      const errEl = container.querySelector<HTMLElement>('#fwAgentskillsError');
      const preview = container.querySelector<HTMLElement>('#fwAgentskillsPreview');
      if (!urlInput) return;
      hideImportError(errEl);
      if (preview) preview.style.display = 'none';
      const urlVal = urlInput.value.trim();
      let skillHostname = '';
      try { skillHostname = new URL(urlVal).hostname; } catch { /* rejected below */ }
      if (!['agentskills.io', 'www.agentskills.io', 'api.agentskills.io'].includes(skillHostname)) {
        showImportError(errEl, 'Only agentskills.io URLs are supported.');
        return;
      }
      const fetchBtn = container.querySelector<HTMLButtonElement>('#fwFetchBtn');
      if (fetchBtn) fetchBtn.disabled = true;
      fetch('/api/skills/fetch-agentskills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlVal }),
        signal,
      }).then(async (res) => {
        if (res.status === 429) throw new Error('rate-limit');
        if (!res.ok) throw new Error('network');
        return res.json() as Promise<{ name?: string; description?: string; instructions?: string }>;
      }).then((data) => {
        if (!data.instructions) {
          showImportError(errEl, 'This skill has no instructions — it may use tools only (not supported).');
          return;
        }
        const nameEl = container.querySelector<HTMLElement>('#fwPreviewName');
        const descEl = container.querySelector<HTMLElement>('#fwPreviewDesc');
        if (nameEl) nameEl.textContent = data.name ?? 'Unnamed skill';
        if (descEl) descEl.textContent = data.instructions.slice(0, 200) + (data.instructions.length > 200 ? '…' : '');
        if (preview) {
          preview.style.display = 'block';
          (preview as HTMLElement & { _fwData?: { name: string; description: string; instructions: string } })._fwData = {
            name: data.name ?? 'Unnamed skill',
            description: data.description ?? '',
            instructions: data.instructions,
          };
        }
      }).catch((err: Error) => {
        if (err.name === 'AbortError') return;
        if (err.message === 'rate-limit') {
          showImportError(errEl, 'Too many import requests. Try again in a minute.');
        } else {
          showImportError(errEl, 'Could not reach agentskills.io. Check your connection.');
        }
      }).finally(() => {
        if (fetchBtn) fetchBtn.disabled = false;
      });
      return;
    }

    if (target.closest('#fwAgentskillsSaveBtn')) {
      const preview = container.querySelector<HTMLElement>('#fwAgentskillsPreview');
      const errEl = container.querySelector<HTMLElement>('#fwAgentskillsError');
      const fwData = (preview as HTMLElement & { _fwData?: { name: string; description: string; instructions: string } } | null)?._fwData;
      if (!fwData) return;
      try {
        saveImportedFramework({ id: crypto.randomUUID(), name: fwData.name, description: fwData.description, systemPromptAppend: fwData.instructions });
        refreshFrameworkLibrary(container);
        closeFrameworkImport();
      } catch (err) {
        showImportError(errEl, (err as Error).message);
      }
      return;
    }

    if (target.closest('#fwJsonSaveBtn')) {
      const textarea = container.querySelector<HTMLTextAreaElement>('#fwJsonInput');
      const errEl = container.querySelector<HTMLElement>('#fwJsonError');
      if (!textarea) return;
      hideImportError(errEl);
      let parsed: { name?: string; description?: string; instructions?: string };
      try {
        parsed = JSON.parse(textarea.value) as typeof parsed;
      } catch {
        showImportError(errEl, 'Could not parse skill definition. Paste valid JSON.');
        return;
      }
      if (!parsed.instructions) {
        showImportError(errEl, 'This skill has no instructions — it may use tools only (not supported).');
        return;
      }
      try {
        saveImportedFramework({
          id: crypto.randomUUID(),
          name: parsed.name ?? 'Imported skill',
          description: parsed.description ?? '',
          systemPromptAppend: parsed.instructions,
        });
        textarea.value = '';
        refreshFrameworkLibrary(container);
        closeFrameworkImport();
      } catch (err) {
        showImportError(errEl, (err as Error).message);
      }
      return;
    }

    const deleteBtn = target.closest<HTMLElement>('.fw-delete-btn');
    if (deleteBtn?.dataset.fwId) {
      deleteImportedFramework(deleteBtn.dataset.fwId);
      refreshFrameworkLibrary(container);
      return;
    }

    const renameBtn = target.closest<HTMLElement>('.fw-rename-btn');
    if (renameBtn?.dataset.fwId) {
      const fwId = renameBtn.dataset.fwId;
      const current = renameBtn.closest('.fw-library-item')?.querySelector('.fw-library-item-name');
      const currentName = current?.childNodes[0]?.textContent?.trim() ?? '';
      const newName = prompt('Rename framework:', currentName);
      if (newName && newName.trim() && newName.trim() !== currentName) {
        renameImportedFramework(fwId, newName.trim());
        refreshFrameworkLibrary(container);
      }
      return;
    }
  }, { signal });
}

function renderFrameworkLibraryHtml(): string {
  const frameworks = loadFrameworkLibrary();
  if (frameworks.length === 0) return '<div class="fw-library-empty">No frameworks in library.</div>';
  return frameworks.map(fw => `
    <div class="fw-library-item" data-fw-id="${escapeHtml(fw.id)}">
      <div class="fw-library-item-info">
        <div class="fw-library-item-name">${escapeHtml(fw.name)}${fw.isBuiltIn ? ' <span class="fw-builtin-badge">built-in</span>' : ''}</div>
        <div class="fw-library-item-desc">${escapeHtml(fw.description)}</div>
      </div>
      ${!fw.isBuiltIn ? `
        <div class="fw-library-item-actions">
          <button type="button" class="fw-lib-btn fw-rename-btn" data-fw-id="${escapeHtml(fw.id)}">Rename</button>
          <button type="button" class="fw-lib-btn fw-lib-btn-danger fw-delete-btn" data-fw-id="${escapeHtml(fw.id)}">Delete</button>
        </div>
      ` : ''}
    </div>
  `).join('');
}

function refreshFrameworkLibrary(container: HTMLElement): void {
  const list = container.querySelector('#fwLibraryList');
  if (list) setTrustedHtml(list, trustedHtml(renderFrameworkLibraryHtml(), "legacy direct innerHTML migration"));
}

function showImportError(el: HTMLElement | null, msg: string): void {
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideImportError(el: HTMLElement | null): void {
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

function showToast(container: HTMLElement, msg: string, success: boolean): void {
  const toast = container.querySelector('#usDataMgmtToast');
  if (!toast) return;
  toast.className = `us-data-mgmt-toast ${success ? 'ok' : 'error'}`;
  setTrustedHtml(toast, trustedHtml(success
    ? `${escapeHtml(msg)} <a href="#" class="us-toast-reload">${t('components.settings.reloadNow')}</a>`
    : escapeHtml(msg), "legacy direct innerHTML migration"));
  toast.querySelector('.us-toast-reload')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.reload();
  });
}
