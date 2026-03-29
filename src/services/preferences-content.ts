import { LANGUAGES, getCurrentLanguage, changeLanguage, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting, getStreamQuality, setStreamQuality, STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import { getMapProvider, setMapProvider, MAP_PROVIDER_OPTIONS, MAP_THEME_OPTIONS, getMapTheme, setMapTheme, type MapProvider } from '@/config/basemap';
import { getLiveStreamsAlwaysOn, setLiveStreamsAlwaysOn } from '@/services/live-stream-settings';
import { getGlobeVisualPreset, setGlobeVisualPreset, GLOBE_VISUAL_PRESET_OPTIONS, type GlobeVisualPreset } from '@/services/globe-render-settings';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/utils/theme-manager';
import { getFontFamily, setFontFamily, type FontFamily } from '@/services/font-settings';
import { escapeHtml } from '@/utils/sanitize';
import { trackLanguageChange } from '@/services/analytics';
import { exportSettings, importSettings, type ImportResult } from '@/utils/settings-persistence';
import {
  getChannelsData,
  createPairingToken,
  setEmailChannel,
  setSlackChannel,
  deleteChannel,
  saveAlertRules,
  type NotificationChannel,
  type ChannelType,
} from '@/services/notification-channels';
import { getCurrentClerkUser } from '@/services/clerk';
import { SITE_VARIANT } from '@/config/variant';
import {
  loadFrameworkLibrary,
  saveImportedFramework,
  deleteImportedFramework,
  renameImportedFramework,
  getActiveFrameworkForPanel,
  type AnalysisPanelId,
} from '@/services/analysis-framework-store';

const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export interface PreferencesHost {
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  isSignedIn?: boolean;
}

export interface PreferencesResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

function toggleRowHtml(id: string, label: string, desc: string, checked: boolean): string {
  return `
    <div class="ai-flow-toggle-row">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label">${label}</div>
        <div class="ai-flow-toggle-desc">${desc}</div>
      </div>
      <label class="ai-flow-switch">
        <input type="checkbox" id="${id}"${checked ? ' checked' : ''}>
        <span class="ai-flow-slider"></span>
      </label>
    </div>
  `;
}

function renderMapThemeDropdown(container: HTMLElement, provider: MapProvider): void {
  const select = container.querySelector<HTMLSelectElement>('#us-map-theme');
  if (!select) return;
  const currentTheme = getMapTheme(provider);
  select.innerHTML = MAP_THEME_OPTIONS[provider]
    .map(opt => `<option value="${opt.value}"${opt.value === currentTheme ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
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

export function renderPreferences(host: PreferencesHost): PreferencesResult {
  const settings = getAiFlowSettings();
  const currentLang = getCurrentLanguage();
  let html = '';

  // ── Display group ──
  html += `<details class="wm-pref-group" open>`;
  html += `<summary>${t('preferences.display')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  // Appearance
  const currentThemePref = getThemePreference();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.theme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.themeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-theme">`;
  for (const opt of [
    { value: 'auto', label: t('preferences.themeAuto') },
    { value: 'dark', label: t('preferences.themeDark') },
    { value: 'light', label: t('preferences.themeLight') },
  ] as { value: ThemePreference; label: string }[]) {
    const selected = opt.value === currentThemePref ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Font family
  const currentFont = getFontFamily();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.fontFamily')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.fontFamilyDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-font-family">`;
  for (const opt of [
    { value: 'mono', label: t('preferences.fontMono') },
    { value: 'system', label: t('preferences.fontSystem') },
  ] as { value: FontFamily; label: string }[]) {
    const selected = opt.value === currentFont ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Map tile provider
  const currentProvider = getMapProvider();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.mapProvider')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapProviderDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-provider">`;
  for (const opt of MAP_PROVIDER_OPTIONS) {
    const selected = opt.value === currentProvider ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Map theme
  const currentMapTheme = getMapTheme(currentProvider);
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.mapTheme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapThemeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-theme">`;
  for (const opt of MAP_THEME_OPTIONS[currentProvider]) {
    const selected = opt.value === currentMapTheme ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += toggleRowHtml('us-map-flash', t('components.insights.mapFlashLabel'), t('components.insights.mapFlashDesc'), settings.mapNewsFlash);

  // 3D Globe Visual Preset
  const currentPreset = getGlobeVisualPreset();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.globePreset')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.globePresetDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-globe-visual-preset">`;
  for (const opt of GLOBE_VISUAL_PRESET_OPTIONS) {
    const selected = opt.value === currentPreset ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Language
  html += `<div class="ai-flow-section-label">${t('header.languageLabel')}</div>`;
  html += `<select class="unified-settings-lang-select" id="us-language">`;
  for (const lang of LANGUAGES) {
    const selected = lang.code === currentLang ? ' selected' : '';
    html += `<option value="${lang.code}"${selected}>${lang.flag} ${escapeHtml(lang.label)}</option>`;
  }
  html += `</select>`;
  if (currentLang === 'vi') {
    html += `<div class="ai-flow-toggle-desc">${t('components.languageSelector.mapLabelsFallbackVi')}</div>`;
  }

  html += `</div></details>`;

  // ── Intelligence group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.intelligence')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

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

  html += toggleRowHtml('us-headline-memory', t('components.insights.headlineMemoryLabel'), t('components.insights.headlineMemoryDesc'), settings.headlineMemory);

  html += `</div></details>`;

  // ── Analysis Frameworks group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('components.insights.analysisFrameworksLabel')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  // Per-panel active framework display
  const panelIds: Array<{ id: AnalysisPanelId; label: string }> = [
    { id: 'insights', label: 'Insights' },
    { id: 'country-brief', label: 'Country Brief' },
    { id: 'daily-market-brief', label: 'Market Brief' },
    { id: 'deduction', label: 'Deduction' },
  ];
  html += `<div class="ai-flow-section-label">${t('components.insights.analysisFrameworksActivePerPanel')}</div>`;
  html += `<div class="fw-panel-status-list" id="fwPanelStatusList">`;
  for (const { id, label } of panelIds) {
    const active = getActiveFrameworkForPanel(id);
    html += `<div class="fw-panel-status-row">
      <span class="fw-panel-status-name">${escapeHtml(label)}</span>
      <span class="fw-panel-status-val">${active ? escapeHtml(active.name) : t('components.insights.analysisFrameworksDefaultNeutral')}</span>
    </div>`;
  }
  html += `</div>`;

  // Skill library list
  html += `<div class="ai-flow-section-label">${t('components.insights.analysisFrameworksSkillLibrary')}</div>`;
  html += `<div class="fw-library-list" id="fwLibraryList">`;
  html += renderFrameworkLibraryHtml();
  html += `</div>`;

  // Import button
  html += `<div class="fw-import-row">
    <button type="button" class="settings-btn settings-btn-secondary fw-import-btn" id="fwImportBtn">${t('components.insights.analysisFrameworksImportBtn')}</button>
  </div>`;

  // Import modal (hidden by default)
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
          <label class="fw-import-label">agentskills.io URL or ID</label>
          <input type="text" class="fw-import-input" id="fwAgentskillsUrl" placeholder="https://agentskills.io/skills/..." />
        </div>
        <button type="button" class="settings-btn settings-btn-secondary" id="fwFetchBtn">Fetch</button>
        <div class="fw-import-preview" id="fwAgentskillsPreview" style="display:none">
          <div class="fw-import-preview-name" id="fwPreviewName"></div>
          <div class="fw-import-preview-desc" id="fwPreviewDesc"></div>
          <button type="button" class="settings-btn settings-btn-primary fw-save-btn" id="fwAgentskillsSaveBtn">${t('components.insights.analysisFrameworksSaveToLibrary')}</button>
        </div>
        <div class="fw-import-error" id="fwAgentskillsError" style="display:none"></div>
      </div>
      <div class="fw-import-tab-panel" id="fwTabPanelJson">
        <div class="fw-import-field">
          <label class="fw-import-label">${t('components.insights.analysisFrameworksPasteJson')}</label>
          <textarea class="fw-import-textarea" id="fwJsonInput" rows="6" placeholder='{ "name": "...", "instructions": "..." }'></textarea>
        </div>
        <div class="fw-import-error" id="fwJsonError" style="display:none"></div>
        <button type="button" class="settings-btn settings-btn-primary fw-save-btn" id="fwJsonSaveBtn">${t('components.insights.analysisFrameworksSaveToLibrary')}</button>
      </div>
    </div>
  </div>`;

  html += `</div></details>`;

  // ── Media group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.media')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  const currentQuality = getStreamQuality();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('components.insights.streamQualityLabel')}</div>
      <div class="ai-flow-toggle-desc">${t('components.insights.streamQualityDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-stream-quality">`;
  for (const opt of STREAM_QUALITY_OPTIONS) {
    const selected = opt.value === currentQuality ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += toggleRowHtml(
    'us-live-streams-always-on',
    t('components.insights.streamAlwaysOnLabel'),
    t('components.insights.streamAlwaysOnDesc'),
    getLiveStreamsAlwaysOn(),
  );

  html += `</div></details>`;

  // ── Panels group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.panels')}</summary>`;
  html += `<div class="wm-pref-group-content">`;
  html += toggleRowHtml('us-badge-anim', t('components.insights.badgeAnimLabel'), t('components.insights.badgeAnimDesc'), settings.badgeAnimation);
  html += `</div></details>`;

  // ── Data & Community group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.dataAndCommunity')}</summary>`;
  html += `<div class="wm-pref-group-content">`;
  html += `
    <div class="us-data-mgmt">
      <button type="button" class="settings-btn settings-btn-secondary" id="usExportBtn">${t('components.settings.exportSettings')}</button>
      <button type="button" class="settings-btn settings-btn-secondary" id="usImportBtn">${t('components.settings.importSettings')}</button>
      <input type="file" id="usImportInput" accept=".json" class="us-hidden-input" />
    </div>
    <div class="us-data-mgmt-toast" id="usDataMgmtToast"></div>
  `;
  html += `<a href="https://discord.gg/re63kWKxaz" target="_blank" rel="noopener noreferrer" class="us-discussion-link">
    <span class="us-discussion-dot"></span>
    <span>${t('components.community.joinDiscussion')}</span>
  </a>`;
  html += `</div></details>`;

  // ── Notifications group (web-only, signed-in) ──
  if (!host.isDesktopApp) {
    if (!host.isSignedIn) {
      html += `<div class="ai-flow-toggle-desc us-notif-signin">Sign in to link notification channels.</div>`;
    } else {
      html += `<details class="wm-pref-group" id="usNotifGroup">`;
      html += `<summary>Notifications</summary>`;
      html += `<div class="wm-pref-group-content">`;
      html += `<div class="us-notif-loading" id="usNotifLoading">Loading...</div>`;
      html += `<div class="us-notif-content" id="usNotifContent" style="display:none"></div>`;
      html += `</div></details>`;
    }
  }

  // AI status footer (web-only)
  if (!host.isDesktopApp) {
    html += `<div class="ai-flow-popup-footer"><span class="ai-flow-status-dot" id="usStatusDot"></span><span class="ai-flow-status-text" id="usStatusText"></span></div>`;
  }

  return {
    html,
    attach(container: HTMLElement): () => void {
      const ac = new AbortController();
      const { signal } = ac;

      container.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;

        if (target.id === 'usImportInput') {
          const file = target.files?.[0];
          if (!file) return;
          importSettings(file).then((result: ImportResult) => {
            showToast(container, t('components.settings.importSuccess', { count: String(result.keysImported) }), true);
          }).catch(() => {
            showToast(container, t('components.settings.importFailed'), false);
          });
          target.value = '';
          return;
        }

        if (target.id === 'us-stream-quality') {
          setStreamQuality(target.value as StreamQuality);
          return;
        }
        if (target.id === 'us-globe-visual-preset') {
          setGlobeVisualPreset(target.value as GlobeVisualPreset);
          return;
        }
        if (target.id === 'us-theme') {
          setThemePreference(target.value as ThemePreference);
          return;
        }
        if (target.id === 'us-font-family') {
          setFontFamily(target.value as FontFamily);
          return;
        }
        if (target.id === 'us-map-provider') {
          const provider = target.value as MapProvider;
          setMapProvider(provider);
          renderMapThemeDropdown(container, provider);
          host.onMapProviderChange?.(provider);
          window.dispatchEvent(new CustomEvent('map-theme-changed'));
          return;
        }
        if (target.id === 'us-map-theme') {
          const provider = getMapProvider();
          setMapTheme(provider, target.value);
          window.dispatchEvent(new CustomEvent('map-theme-changed'));
          return;
        }
        if (target.id === 'us-live-streams-always-on') {
          setLiveStreamsAlwaysOn(target.checked);
          return;
        }
        if (target.id === 'us-language') {
          trackLanguageChange(target.value);
          void changeLanguage(target.value);
          return;
        }
        if (target.id === 'us-cloud') {
          setAiFlowSetting('cloudLlm', target.checked);
          updateAiStatus(container);
        } else if (target.id === 'us-browser') {
          setAiFlowSetting('browserModel', target.checked);
          const warn = container.querySelector('.ai-flow-toggle-warn') as HTMLElement;
          if (warn) warn.style.display = target.checked ? 'block' : 'none';
          updateAiStatus(container);
        } else if (target.id === 'us-map-flash') {
          setAiFlowSetting('mapNewsFlash', target.checked);
        } else if (target.id === 'us-headline-memory') {
          setAiFlowSetting('headlineMemory', target.checked);
        } else if (target.id === 'us-badge-anim') {
          setAiFlowSetting('badgeAnimation', target.checked);
        }
      }, { signal });

      container.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#usExportBtn')) {
          try {
            exportSettings();
            showToast(container, t('components.settings.exportSuccess'), true);
          } catch {
            showToast(container, t('components.settings.exportFailed'), false);
          }
          return;
        }
        if (target.closest('#usImportBtn')) {
          container.querySelector<HTMLInputElement>('#usImportInput')?.click();
          return;
        }

        // ── Framework settings handlers ──

        if (target.closest('#fwImportBtn')) {
          const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
          if (backdrop) backdrop.style.display = 'flex';
          return;
        }

        if (target.closest('#fwImportModalClose') || target.id === 'fwImportModalBackdrop') {
          const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
          if (backdrop) backdrop.style.display = 'none';
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
          if (!urlVal.includes('agentskills.io')) {
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
              showImportError(errEl, 'Too many import requests. Try again in an hour.');
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
            const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
            if (backdrop) backdrop.style.display = 'none';
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
            const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
            if (backdrop) backdrop.style.display = 'none';
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

      if (!host.isDesktopApp) updateAiStatus(container);

      // ── Notifications section ──
      if (!host.isDesktopApp && host.isSignedIn) {
        let notifPollInterval: ReturnType<typeof setInterval> | null = null;

        function clearNotifPoll(): void {
          if (notifPollInterval !== null) {
            clearInterval(notifPollInterval);
            notifPollInterval = null;
          }
        }

        signal.addEventListener('abort', clearNotifPoll);

        function renderChannelRow(channel: NotificationChannel | null, type: ChannelType): string {
          if (channel?.verified) {
            const label = type === 'telegram' ? `@${channel.chatId ?? 'Telegram'}`
              : type === 'email' ? (channel.email ?? 'Email')
              : 'Slack webhook';
            return `<div class="us-notif-channel-row" data-channel-type="${type}">
              <span class="us-notif-channel-label">${escapeHtml(label)}</span>
              <button type="button" class="settings-btn settings-btn-secondary us-notif-disconnect" data-channel="${type}">Disconnect</button>
            </div>`;
          }
          if (type === 'telegram') {
            return `<div class="us-notif-channel-row" data-channel-type="telegram">
              <button type="button" class="settings-btn us-notif-telegram-connect" id="usConnectTelegram">Connect Telegram</button>
            </div>`;
          }
          if (type === 'email') {
            return `<div class="us-notif-channel-row" data-channel-type="email">
              <button type="button" class="settings-btn us-notif-email-connect" id="usConnectEmail">Link Email</button>
            </div>`;
          }
          if (type === 'slack') {
            return `<div class="us-notif-channel-row" data-channel-type="slack">
              <input type="url" class="unified-settings-select" id="usSlackWebhookUrl" placeholder="https://hooks.slack.com/services/..." />
              <button type="button" class="settings-btn us-notif-slack-connect" id="usConnectSlack">Connect Slack</button>
            </div>`;
          }
          return '';
        }

        function renderNotifContent(data: Awaited<ReturnType<typeof getChannelsData>>): string {
          const channelTypes: ChannelType[] = ['telegram', 'email', 'slack'];
          const alertRule = data.alertRules?.[0] ?? null;
          const sensitivity = alertRule?.sensitivity ?? 'all';

          let html = '<div class="ai-flow-section-label">Channels</div>';
          for (const type of channelTypes) {
            const channel = data.channels.find(c => c.channelType === type) ?? null;
            html += renderChannelRow(channel, type);
          }

          html += `<div class="ai-flow-section-label">Alert Rules</div>
            <div class="ai-flow-toggle-row">
              <div class="ai-flow-toggle-label-wrap">
                <div class="ai-flow-toggle-label">Enable notifications</div>
                <div class="ai-flow-toggle-desc">Receive alerts for events matching your filters</div>
              </div>
              <label class="ai-flow-switch">
                <input type="checkbox" id="usNotifEnabled"${alertRule?.enabled ? ' checked' : ''}>
                <span class="ai-flow-slider"></span>
              </label>
            </div>
            <div class="ai-flow-section-label">Sensitivity</div>
            <select class="unified-settings-select" id="usNotifSensitivity">
              <option value="all"${sensitivity === 'all' ? ' selected' : ''}>All events</option>
              <option value="high"${sensitivity === 'high' ? ' selected' : ''}>High &amp; critical</option>
              <option value="critical"${sensitivity === 'critical' ? ' selected' : ''}>Critical only</option>
            </select>`;
          return html;
        }

        function reloadNotifSection(): void {
          const loadingEl = container.querySelector<HTMLElement>('#usNotifLoading');
          const contentEl = container.querySelector<HTMLElement>('#usNotifContent');
          if (!loadingEl || !contentEl) return;
          loadingEl.style.display = 'block';
          contentEl.style.display = 'none';
          if (signal.aborted) return;
          getChannelsData().then((data) => {
            if (signal.aborted) return;
            contentEl.innerHTML = renderNotifContent(data);
            loadingEl.style.display = 'none';
            contentEl.style.display = 'block';
          }).catch(() => {
            if (signal.aborted) return;
            if (loadingEl) loadingEl.textContent = 'Failed to load notification settings.';
          });
        }

        reloadNotifSection();

        let alertRuleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        signal.addEventListener('abort', () => {
          if (alertRuleDebounceTimer !== null) {
            clearTimeout(alertRuleDebounceTimer);
            alertRuleDebounceTimer = null;
          }
        });

        container.addEventListener('change', (e) => {
          const target = e.target as HTMLInputElement;
          if (target.id === 'usNotifEnabled' || target.id === 'usNotifSensitivity') {
            if (alertRuleDebounceTimer) clearTimeout(alertRuleDebounceTimer);
            alertRuleDebounceTimer = setTimeout(() => {
              const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
              const sensitivityEl = container.querySelector<HTMLSelectElement>('#usNotifSensitivity');
              const enabled = enabledEl?.checked ?? false;
              const sensitivity = (sensitivityEl?.value ?? 'all') as 'all' | 'high' | 'critical';
              const connectedChannelTypes = Array.from(
                container.querySelectorAll<HTMLElement>('[data-channel-type]'),
              )
                .filter(el => el.querySelector('.us-notif-disconnect'))
                .map(el => el.dataset.channelType as ChannelType);
              void saveAlertRules({
                variant: SITE_VARIANT,
                enabled,
                eventTypes: [],
                sensitivity,
                channels: connectedChannelTypes,
              });
            }, 1000);
          }
        }, { signal });

        container.addEventListener('click', (e) => {
          const target = e.target as HTMLElement;

          if (target.closest('#usConnectTelegram')) {
            const rowEl = target.closest('.us-notif-channel-row') as HTMLElement | null;
            if (!rowEl) return;
            createPairingToken().then(({ token, expiresAt }) => {
              if (signal.aborted) return;
              const botUsername = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TELEGRAM_BOT_USERNAME as string | undefined) ?? 'WorldMonitorBot';
              const deepLink = `https://t.me/${botUsername}?start=${token}`;
              const secsLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
              rowEl.innerHTML = `
                <a href="${escapeHtml(deepLink)}" target="_blank" rel="noopener noreferrer" class="settings-btn us-notif-tg-link">Open Telegram to pair</a>
                <span class="us-notif-tg-countdown" id="usTgCountdown">${secsLeft}s</span>
              `;
              let remaining = secsLeft;
              clearNotifPoll();
              notifPollInterval = setInterval(() => {
                if (signal.aborted) { clearNotifPoll(); return; }
                remaining -= 3;
                const countdownEl = container.querySelector<HTMLElement>('#usTgCountdown');
                if (countdownEl) countdownEl.textContent = `${Math.max(0, remaining)}s`;
                const expired = remaining <= 0;
                if (expired) clearNotifPoll();
                getChannelsData().then((data) => {
                  const tg = data.channels.find(c => c.channelType === 'telegram');
                  if (tg?.verified || expired) {
                    reloadNotifSection();
                  }
                }).catch(() => {
                  if (expired) reloadNotifSection();
                });
              }, 3000);
            }).catch(() => {});
            return;
          }

          if (target.closest('#usConnectEmail')) {
            const user = getCurrentClerkUser();
            const email = user?.email;
            if (!email) {
              const rowEl = target.closest('.us-notif-channel-row') as HTMLElement | null;
              if (rowEl) {
                rowEl.querySelector('.us-notif-error')?.remove();
                rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">No email found on your account</span>');
              }
              return;
            }
            setEmailChannel(email).then(() => {
              if (!signal.aborted) reloadNotifSection();
            }).catch(() => {});
            return;
          }

          if (target.closest('#usConnectSlack')) {
            const input = container.querySelector<HTMLInputElement>('#usSlackWebhookUrl');
            const url = input?.value?.trim() ?? '';
            const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[a-zA-Z0-9]+$/;
            if (!SLACK_RE.test(url)) {
              const rowEl = target.closest('.us-notif-channel-row') as HTMLElement | null;
              if (rowEl) {
                const existing = rowEl.querySelector('.us-notif-error');
                if (existing) existing.remove();
                rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">Invalid Slack webhook URL format</span>');
              }
              return;
            }
            setSlackChannel(url).then(() => {
              if (!signal.aborted) reloadNotifSection();
            }).catch(() => {});
            return;
          }

          const disconnectBtn = target.closest<HTMLElement>('.us-notif-disconnect[data-channel]');
          if (disconnectBtn?.dataset.channel) {
            const channelType = disconnectBtn.dataset.channel as ChannelType;
            deleteChannel(channelType).then(() => {
              if (!signal.aborted) reloadNotifSection();
            }).catch(() => {});
            return;
          }
        }, { signal });
      }

      return () => ac.abort();
    },
  };
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
  if (list) list.innerHTML = renderFrameworkLibraryHtml();
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
  toast.innerHTML = success
    ? `${escapeHtml(msg)} <a href="#" class="us-toast-reload">${t('components.settings.reloadNow')}</a>`
    : escapeHtml(msg);
  toast.querySelector('.us-toast-reload')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.reload();
  });
}
