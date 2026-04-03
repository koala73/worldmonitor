import { LANGUAGES, getCurrentLanguage, changeLanguage, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting, getStreamQuality, setStreamQuality, STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import { getMapProvider, setMapProvider, MAP_PROVIDER_OPTIONS, MAP_THEME_OPTIONS, getMapTheme, setMapTheme, type MapProvider } from '@/config/basemap';
import { getLiveStreamsAlwaysOn, setLiveStreamsAlwaysOn } from '@/services/live-stream-settings';
import { getGlobeVisualPreset, setGlobeVisualPreset, GLOBE_VISUAL_PRESET_OPTIONS, type GlobeVisualPreset } from '@/services/globe-render-settings';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/utils/theme-manager';
import { getFontFamily, setFontFamily, type FontFamily } from '@/services/font-settings';
import { escapeHtml } from '@/utils/sanitize';
import { renderSVG } from 'uqr';
import { trackLanguageChange } from '@/services/analytics';
import { exportSettings, importSettings, type ImportResult } from '@/utils/settings-persistence';
import {
  getChannelsData,
  createPairingToken,
  setEmailChannel,
  startSlackOAuth,
  startDiscordOAuth,
  deleteChannel,
  saveAlertRules,
  setQuietHours,
  setDigestSettings,
  type NotificationChannel,
  type ChannelType,
  type QuietHoursOverride,
  type DigestMode,
} from '@/services/notification-channels';
import { getCurrentClerkUser } from '@/services/clerk';
import { SITE_VARIANT } from '@/config/variant';
// When VITE_QUIET_HOURS_BATCH_ENABLED=0 the relay does not honour batch_on_wake.
// Hide that option so users cannot select a mode that silently behaves as critical_only.
const QUIET_HOURS_BATCH_ENABLED = import.meta.env.VITE_QUIET_HOURS_BATCH_ENABLED !== '0';
// When VITE_DIGEST_CRON_ENABLED=0 the Railway cron has not been deployed yet.
// Hide non-realtime digest options so users cannot enter a blackhole state
// where the relay skips their rule and the cron never runs.
const DIGEST_CRON_ENABLED = import.meta.env.VITE_DIGEST_CRON_ENABLED !== '0';
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

        function channelIcon(type: ChannelType): string {
          if (type === 'telegram') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`;
          if (type === 'email') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;
          if (type === 'discord') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>`;
        }

        const CHANNEL_LABELS: Record<ChannelType, string> = { telegram: 'Telegram', email: 'Email', slack: 'Slack', discord: 'Discord' };

        function renderChannelRow(channel: NotificationChannel | null, type: ChannelType): string {
          const icon = channelIcon(type);
          const name = CHANNEL_LABELS[type];

          if (channel?.verified) {
            let sub: string;
            let manageLink = '';
            if (type === 'telegram') {
              sub = `@${escapeHtml(channel.chatId ?? 'connected')}`;
            } else if (type === 'email') {
              sub = escapeHtml(channel.email ?? 'connected');
            } else if (type === 'discord') {
              sub = 'Connected';
            } else {
              // Slack: show #channel · team from OAuth metadata
              const rawCh = channel.slackChannelName ?? '';
              const ch = rawCh ? `#${escapeHtml(rawCh.startsWith('#') ? rawCh.slice(1) : rawCh)}` : 'connected';
              const team = channel.slackTeamName ? ` · ${escapeHtml(channel.slackTeamName)}` : '';
              sub = ch + team;
              if (channel.slackConfigurationUrl) {
                manageLink = `<a href="${escapeHtml(channel.slackConfigurationUrl)}" target="_blank" rel="noopener noreferrer" class="us-notif-manage-link">Manage</a>`;
              }
            }
            return `<div class="us-notif-ch-row us-notif-ch-on" data-channel-type="${type}">
              <div class="us-notif-ch-icon">${icon}</div>
              <div class="us-notif-ch-body">
                <div class="us-notif-ch-name">${name}</div>
                <div class="us-notif-ch-sub">${sub}</div>
              </div>
              <div class="us-notif-ch-actions">
                <span class="us-notif-ch-badge">Connected</span>
                ${manageLink}
                <button type="button" class="us-notif-ch-btn us-notif-disconnect" data-channel="${type}">Remove</button>
              </div>
            </div>`;
          }

          if (type === 'telegram') {
            return `<div class="us-notif-ch-row" data-channel-type="telegram">
              <div class="us-notif-ch-icon">${icon}</div>
              <div class="us-notif-ch-body">
                <div class="us-notif-ch-name">${name}</div>
                <div class="us-notif-ch-sub">Not connected</div>
              </div>
              <div class="us-notif-ch-actions">
                <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-telegram-connect" id="usConnectTelegram">Connect</button>
              </div>
            </div>`;
          }

          if (type === 'email') {
            return `<div class="us-notif-ch-row" data-channel-type="email">
              <div class="us-notif-ch-icon">${icon}</div>
              <div class="us-notif-ch-body">
                <div class="us-notif-ch-name">${name}</div>
                <div class="us-notif-ch-sub">Use your account email</div>
              </div>
              <div class="us-notif-ch-actions">
                <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-email-connect" id="usConnectEmail">Link</button>
              </div>
            </div>`;
          }

          if (type === 'slack') {
            return `<div class="us-notif-ch-row" data-channel-type="slack">
              <div class="us-notif-ch-icon">${icon}</div>
              <div class="us-notif-ch-body">
                <div class="us-notif-ch-name">${name}</div>
                <div class="us-notif-ch-sub">Not connected</div>
              </div>
              <div class="us-notif-ch-actions">
                <button type="button" class="us-notif-slack-oauth" id="usConnectSlack">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;vertical-align:-1px"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>
                  Add to Slack
                </button>
              </div>
            </div>`;
          }

          if (type === 'discord') {
            return `<div class="us-notif-ch-row" data-channel-type="discord">
              <div class="us-notif-ch-icon">${icon}</div>
              <div class="us-notif-ch-body">
                <div class="us-notif-ch-name">${name}</div>
                <div class="us-notif-ch-sub">Not connected</div>
              </div>
              <div class="us-notif-ch-actions">
                <button type="button" class="us-notif-discord-oauth" id="usConnectDiscord">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;vertical-align:-1px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                  Connect Discord
                </button>
              </div>
            </div>`;
          }

          return '';
        }

        const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        function renderNotifContent(data: Awaited<ReturnType<typeof getChannelsData>>): string {
          const channelTypes: ChannelType[] = ['telegram', 'email', 'slack', 'discord'];
          const alertRule = data.alertRules?.[0] ?? null;
          const sensitivity = alertRule?.sensitivity ?? 'all';

          let html = '<div class="ai-flow-section-label">Channels</div>';
          for (const type of channelTypes) {
            const channel = data.channels.find(c => c.channelType === type) ?? null;
            html += renderChannelRow(channel, type);
          }

          const qhEnabled = alertRule?.quietHoursEnabled ?? false;
          const qhStart = alertRule?.quietHoursStart ?? 22;
          const qhEnd = alertRule?.quietHoursEnd ?? 7;
          const qhOverride = alertRule?.quietHoursOverride ?? 'critical_only';

          const digestMode = alertRule?.digestMode ?? 'realtime';
          const digestHour = alertRule?.digestHour ?? 8;

          const hourOptions = Array.from({ length: 24 }, (_, h) => {
            const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
            return `<option value="${h}"${h === qhStart ? ' selected' : ''}>${label}</option>`;
          }).join('');
          const hourOptionsEnd = Array.from({ length: 24 }, (_, h) => {
            const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
            return `<option value="${h}"${h === qhEnd ? ' selected' : ''}>${label}</option>`;
          }).join('');
          const hourOptionsDigest = Array.from({ length: 24 }, (_, h) => {
            const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
            return `<option value="${h}"${h === digestHour ? ' selected' : ''}>${label}</option>`;
          }).join('');

          const TZ_LIST = [
            'UTC',
            'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
            'America/Anchorage', 'America/Honolulu', 'America/Phoenix',
            'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
            'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Bogota',
            'America/Lima', 'America/Santiago', 'America/Caracas',
            'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
            'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Oslo',
            'Europe/Zurich', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Bucharest',
            'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Moscow', 'Europe/Kyiv',
            'Africa/Cairo', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Johannesburg',
            'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka',
            'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong',
            'Asia/Tokyo', 'Asia/Seoul', 'Asia/Manila',
            'Australia/Sydney', 'Australia/Brisbane', 'Australia/Perth',
            'Pacific/Auckland', 'Pacific/Fiji',
          ];
          const makeTzOptions = (current: string) => {
            const list = TZ_LIST.includes(current) ? TZ_LIST : [current, ...TZ_LIST];
            return list.map(tz => `<option value="${tz}"${tz === current ? ' selected' : ''}>${tz}</option>`).join('');
          };

          const isRealtime = !DIGEST_CRON_ENABLED || digestMode === 'realtime';
          const sharedTz = isRealtime
            ? (alertRule?.quietHoursTimezone ?? alertRule?.digestTimezone ?? detectedTz)
            : (alertRule?.digestTimezone ?? alertRule?.quietHoursTimezone ?? detectedTz);

          html += `<div class="ai-flow-section-label" style="margin-top:8px">Delivery Mode</div>
            ${!DIGEST_CRON_ENABLED ? '<div class="ai-flow-toggle-desc" style="margin-bottom:4px">Digest delivery is not yet active.</div>' : ''}
            <select class="unified-settings-select" id="usDigestMode"${!DIGEST_CRON_ENABLED ? ' disabled' : ''}>
              <option value="realtime"${isRealtime ? ' selected' : ''}>Real-time (immediate)</option>
              ${DIGEST_CRON_ENABLED ? `<option value="daily"${digestMode === 'daily' ? ' selected' : ''}>Daily digest</option>
              <option value="twice_daily"${digestMode === 'twice_daily' ? ' selected' : ''}>Twice daily</option>
              <option value="weekly"${digestMode === 'weekly' ? ' selected' : ''}>Weekly digest</option>` : ''}
            </select>
            <div id="usRealtimeSection" style="${isRealtime ? '' : 'display:none'}">
              <div class="ai-flow-section-label" style="margin-top:8px">Alert Rules</div>
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
              </select>
              <div class="ai-flow-section-label" style="margin-top:8px">Quiet Hours</div>
              <div class="ai-flow-toggle-row">
                <div class="ai-flow-toggle-label-wrap">
                  <div class="ai-flow-toggle-label">Enable quiet hours</div>
                  <div class="ai-flow-toggle-desc">Suppress or batch non-critical alerts during set hours</div>
                </div>
                <label class="ai-flow-switch">
                  <input type="checkbox" id="usQhEnabled"${qhEnabled ? ' checked' : ''}>
                  <span class="ai-flow-slider"></span>
                </label>
              </div>
              <div id="usQhDetails" style="${qhEnabled ? '' : 'display:none'}">
                <div class="ai-flow-toggle-row" style="gap:8px;flex-wrap:wrap">
                  <div class="ai-flow-toggle-label-wrap" style="min-width:60px">
                    <div class="ai-flow-toggle-label">From</div>
                  </div>
                  <select class="unified-settings-select" id="usQhStart" style="width:auto">${hourOptions}</select>
                  <div class="ai-flow-toggle-label-wrap" style="min-width:30px">
                    <div class="ai-flow-toggle-label">To</div>
                  </div>
                  <select class="unified-settings-select" id="usQhEnd" style="width:auto">${hourOptionsEnd}</select>
                </div>
                <div style="margin-top:4px">
                  <div class="ai-flow-toggle-label" style="margin-bottom:4px">During quiet hours</div>
                  <select class="unified-settings-select" id="usQhOverride">
                    <option value="critical_only"${qhOverride === 'critical_only' ? ' selected' : ''}>Critical only (suppress others)</option>
                    <option value="silence_all"${qhOverride === 'silence_all' ? ' selected' : ''}>Silence all</option>
                    ${QUIET_HOURS_BATCH_ENABLED ? `<option value="batch_on_wake"${qhOverride === 'batch_on_wake' ? ' selected' : ''}>Batch — deliver on wake</option>` : ''}
                  </select>
                </div>
              </div>
            </div>
            <div id="usDigestDetails" style="${isRealtime ? 'display:none' : ''}">
              <div class="ai-flow-toggle-row" style="gap:8px;flex-wrap:wrap;margin-top:4px">
                <div class="ai-flow-toggle-label-wrap" style="min-width:60px">
                  <div class="ai-flow-toggle-label">Send at</div>
                </div>
                <select class="unified-settings-select" id="usDigestHour" style="width:auto">${hourOptionsDigest}</select>
              </div>
            </div>
            <div class="ai-flow-section-label" style="margin-top:8px">Timezone</div>
            <select class="unified-settings-select" id="usSharedTimezone" style="width:100%">${makeTzOptions(sharedTz)}</select>`;
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
          }).catch((err) => {
            if (signal.aborted) return;
            console.error('[notifications] Failed to load settings:', err);
            if (loadingEl) loadingEl.textContent = 'Failed to load notification settings.';
          });
        }

        reloadNotifSection();

        // When a new channel is linked, auto-update the rule's channels list
        // so it includes the new channel without requiring a manual toggle.
        function saveRuleWithNewChannel(newChannel: ChannelType): void {
          const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
          const sensitivityEl = container.querySelector<HTMLSelectElement>('#usNotifSensitivity');
          if (!enabledEl) return;
          const enabled = enabledEl.checked;
          const sensitivity = (sensitivityEl?.value ?? 'all') as 'all' | 'high' | 'critical';
          const existing = Array.from(container.querySelectorAll<HTMLElement>('[data-channel-type]'))
            .filter(el => el.classList.contains('us-notif-ch-on'))
            .map(el => el.dataset.channelType as ChannelType);
          const channels = [...new Set([...existing, newChannel])];
          void saveAlertRules({ variant: SITE_VARIANT, enabled, eventTypes: [], sensitivity, channels });
        }

        let slackOAuthPopup: Window | null = null;
        let discordOAuthPopup: Window | null = null;
        let alertRuleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        let qhDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        let digestDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        signal.addEventListener('abort', () => {
          if (alertRuleDebounceTimer !== null) {
            clearTimeout(alertRuleDebounceTimer);
            alertRuleDebounceTimer = null;
          }
          if (qhDebounceTimer !== null) {
            clearTimeout(qhDebounceTimer);
            qhDebounceTimer = null;
          }
          if (digestDebounceTimer !== null) {
            clearTimeout(digestDebounceTimer);
            digestDebounceTimer = null;
          }
        });

        const saveQuietHours = () => {
          if (qhDebounceTimer) clearTimeout(qhDebounceTimer);
          qhDebounceTimer = setTimeout(() => {
            const enabledEl = container.querySelector<HTMLInputElement>('#usQhEnabled');
            const startEl = container.querySelector<HTMLSelectElement>('#usQhStart');
            const endEl = container.querySelector<HTMLSelectElement>('#usQhEnd');
            const tzEl = container.querySelector<HTMLSelectElement>('#usSharedTimezone');
            const overrideEl = container.querySelector<HTMLSelectElement>('#usQhOverride');
            void setQuietHours({
              variant: SITE_VARIANT,
              quietHoursEnabled: enabledEl?.checked ?? false,
              quietHoursStart: startEl ? Number(startEl.value) : 22,
              quietHoursEnd: endEl ? Number(endEl.value) : 7,
              quietHoursTimezone: tzEl?.value || detectedTz,
              quietHoursOverride: (overrideEl?.value ?? 'critical_only') as QuietHoursOverride,
            });
          }, 800);
        };

        const saveDigestSettings = () => {
          if (digestDebounceTimer) clearTimeout(digestDebounceTimer);
          digestDebounceTimer = setTimeout(() => {
            const modeEl = container.querySelector<HTMLSelectElement>('#usDigestMode');
            const hourEl = container.querySelector<HTMLSelectElement>('#usDigestHour');
            const tzEl = container.querySelector<HTMLSelectElement>('#usSharedTimezone');
            void setDigestSettings({
              variant: SITE_VARIANT,
              digestMode: (modeEl?.value ?? 'realtime') as DigestMode,
              digestHour: hourEl ? Number(hourEl.value) : 8,
              digestTimezone: tzEl?.value || detectedTz,
            });
          }, 800);
        };

        container.addEventListener('change', (e) => {
          const target = e.target as HTMLInputElement;
          if (target.id === 'usQhEnabled') {
            const details = container.querySelector<HTMLElement>('#usQhDetails');
            if (details) details.style.display = target.checked ? '' : 'none';
            saveQuietHours();
            return;
          }
          if (target.id === 'usQhStart' || target.id === 'usQhEnd' || target.id === 'usQhOverride') {
            saveQuietHours();
            return;
          }
          if (target.id === 'usDigestMode') {
            const isRt = target.value === 'realtime';
            const realtimeSection = container.querySelector<HTMLElement>('#usRealtimeSection');
            const digestDetails = container.querySelector<HTMLElement>('#usDigestDetails');
            if (realtimeSection) realtimeSection.style.display = isRt ? '' : 'none';
            if (digestDetails) digestDetails.style.display = isRt ? 'none' : '';
            saveDigestSettings();
            // Switching to digest mode: auto-enable the alert rule so the
            // backend schedules digests. The enable toggle is hidden in
            // digest mode, so the user has no other way to turn it on.
            if (!isRt) {
              const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
              if (enabledEl && !enabledEl.checked) {
                enabledEl.checked = true;
                enabledEl.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            return;
          }
          if (target.id === 'usDigestHour') {
            saveDigestSettings();
            return;
          }
          if (target.id === 'usSharedTimezone') {
            saveQuietHours();
            saveDigestSettings();
            return;
          }
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
                .filter(el => el.classList.contains('us-notif-ch-on'))
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

          if (target.closest('.us-notif-tg-copy-btn')) {
            const btn = target.closest('.us-notif-tg-copy-btn') as HTMLButtonElement;
            const cmd = btn.dataset.cmd ?? '';
            const markCopied = () => {
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
            };
            const execFallback = () => {
              const ta = document.createElement('textarea');
              ta.value = cmd;
              ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
              document.body.appendChild(ta);
              ta.select();
              try { document.execCommand('copy'); markCopied(); } catch { /* ignore */ }
              document.body.removeChild(ta);
            };
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(cmd).then(markCopied).catch(execFallback);
            } else {
              execFallback();
            }
            return;
          }

          const startTelegramPairing = (rowEl: HTMLElement) => {
            rowEl.innerHTML = `<div class="us-notif-ch-icon">${channelIcon('telegram')}</div><div class="us-notif-ch-body"><div class="us-notif-ch-name">Telegram</div><div class="us-notif-ch-sub">Generating code…</div></div>`;
            createPairingToken().then(({ token, expiresAt }) => {
              if (signal.aborted) return;
              const botUsername = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TELEGRAM_BOT_USERNAME as string | undefined) ?? 'WorldMonitorBot';
              const deepLink = `https://t.me/${String(botUsername)}?start=${token}`;
              const startCmd = `/start ${token}`;
              const secsLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
              const qrSvg = renderSVG(deepLink, { ecc: 'M', border: 1 });
              rowEl.innerHTML = `
                <div class="us-notif-ch-icon">${channelIcon('telegram')}</div>
                <div class="us-notif-ch-body">
                  <div class="us-notif-ch-name">Connect Telegram</div>
                  <div class="us-notif-ch-sub">Open the bot. If Telegram doesn't send the code automatically, paste this command.</div>
                  <div class="us-notif-tg-pair-layout">
                    <div class="us-notif-tg-cmd-col">
                      <a href="${escapeHtml(deepLink)}" target="_blank" rel="noopener noreferrer" class="us-notif-tg-link">Open Telegram</a>
                      <div class="us-notif-tg-cmd-row">
                        <code class="us-notif-tg-cmd">${escapeHtml(startCmd)}</code>
                        <button type="button" class="us-notif-tg-copy-btn" data-cmd="${escapeHtml(startCmd)}">Copy</button>
                      </div>
                    </div>
                    <div class="us-notif-tg-qr" title="Scan with mobile Telegram">${qrSvg}</div>
                  </div>
                </div>
                <div class="us-notif-ch-actions">
                  <span class="us-notif-tg-countdown" id="usTgCountdown">Waiting… ${secsLeft}s</span>
                </div>
              `;
              let remaining = secsLeft;
              clearNotifPoll();
              notifPollInterval = setInterval(() => {
                if (signal.aborted) { clearNotifPoll(); return; }
                remaining -= 3;
                const countdownEl = container.querySelector<HTMLElement>('#usTgCountdown');
                if (countdownEl) countdownEl.textContent = `Waiting… ${Math.max(0, remaining)}s`;
                const expired = remaining <= 0;
                if (expired) {
                  clearNotifPoll();
                  rowEl.innerHTML = `
                    <div class="us-notif-ch-icon">${channelIcon('telegram')}</div>
                    <div class="us-notif-ch-body">
                      <div class="us-notif-ch-name">Telegram</div>
                      <div class="us-notif-ch-sub us-notif-tg-expired">Code expired</div>
                    </div>
                    <div class="us-notif-ch-actions">
                      <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-tg-regen">Generate new code</button>
                    </div>
                  `;
                  return;
                }
                getChannelsData().then((data) => {
                  const tg = data.channels.find(c => c.channelType === 'telegram');
                  if (tg?.verified) {
                    clearNotifPoll();
                    saveRuleWithNewChannel('telegram');
                    reloadNotifSection();
                  }
                }).catch(() => {});
              }, 3000);
            }).catch(() => {
              rowEl.innerHTML = `<div class="us-notif-ch-icon">${channelIcon('telegram')}</div><div class="us-notif-ch-body"><div class="us-notif-ch-name">Telegram</div><div class="us-notif-ch-sub us-notif-tg-expired">Failed to generate code</div></div><div class="us-notif-ch-actions"><button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-tg-regen">Try again</button></div>`;
            });
          };

          if (target.closest('#usConnectTelegram') || target.closest('.us-notif-tg-regen')) {
            const rowEl = target.closest('.us-notif-ch-row') as HTMLElement | null;
            if (!rowEl) return;
            startTelegramPairing(rowEl);
            return;
          }

          if (target.closest('#usConnectEmail')) {
            const user = getCurrentClerkUser();
            const email = user?.email;
            if (!email) {
              const rowEl = target.closest('.us-notif-ch-row') as HTMLElement | null;
              if (rowEl) {
                rowEl.querySelector('.us-notif-error')?.remove();
                rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">No email found on your account</span>');
              }
              return;
            }
            setEmailChannel(email).then(() => {
              if (!signal.aborted) { saveRuleWithNewChannel('email'); reloadNotifSection(); }
            }).catch(() => {});
            return;
          }

          if (target.closest('#usConnectSlack')) {
            const btn = target.closest<HTMLButtonElement>('#usConnectSlack');
            // Prevent double-open: reuse existing popup if still open
            if (slackOAuthPopup && !slackOAuthPopup.closed) {
              slackOAuthPopup.focus();
              return;
            }
            if (btn) btn.textContent = 'Connecting…';
            startSlackOAuth().then((oauthUrl) => {
              if (signal.aborted) return;
              const popup = window.open(oauthUrl, 'slack-oauth', 'width=600,height=700,menubar=no,toolbar=no');
              if (!popup) {
                // Popup was blocked — redirect-to-Slack fallback doesn't work because
                // the callback page expects window.opener and has no way to return to
                // settings after approval. Show a clear instruction instead.
                if (btn) btn.textContent = 'Add to Slack';
                const rowEl = btn?.closest<HTMLElement>('[data-channel-type="slack"]');
                if (rowEl) {
                  rowEl.querySelector('.us-notif-error')?.remove();
                  rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">Popup blocked — please allow popups for this site, then try again.</span>');
                }
              } else {
                slackOAuthPopup = popup;
              }
            }).catch(() => {
              if (btn && !signal.aborted) btn.textContent = 'Add to Slack';
            });
            return;
          }

          if (target.closest('#usConnectDiscord')) {
            const btn = target.closest<HTMLButtonElement>('#usConnectDiscord');
            if (discordOAuthPopup && !discordOAuthPopup.closed) {
              discordOAuthPopup.focus();
              return;
            }
            if (btn) btn.textContent = 'Connecting…';
            startDiscordOAuth().then((oauthUrl) => {
              if (signal.aborted) return;
              const popup = window.open(oauthUrl, 'discord-oauth', 'width=600,height=700,menubar=no,toolbar=no');
              if (!popup) {
                if (btn) btn.textContent = 'Connect Discord';
                const rowEl = btn?.closest<HTMLElement>('[data-channel-type="discord"]');
                if (rowEl) {
                  rowEl.querySelector('.us-notif-error')?.remove();
                  rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">Popup blocked — please allow popups for this site, then try again.</span>');
                }
              } else {
                discordOAuthPopup = popup;
              }
            }).catch(() => {
              if (btn && !signal.aborted) btn.textContent = 'Connect Discord';
            });
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

        // Listen for OAuth popup completion
        const onMessage = (e: MessageEvent): void => {
          // Bind trust to both: (1) a WM-owned origin (callback is always on worldmonitor.app,
          // but settings may be open on a different *.worldmonitor.app subdomain) and
          // (2) the exact popup window we opened — prevents any sibling subdomain from
          // forging wm:slack_connected and triggering saveRuleWithNewChannel.
          const trustedOrigin = e.origin === window.location.origin ||
            e.origin === 'https://worldmonitor.app' ||
            e.origin === 'https://www.worldmonitor.app' ||
            e.origin.endsWith('.worldmonitor.app');
          const fromSlack = slackOAuthPopup !== null && e.source === slackOAuthPopup;
          const fromDiscord = discordOAuthPopup !== null && e.source === discordOAuthPopup;
          if (!trustedOrigin || (!fromSlack && !fromDiscord)) return;
          if (e.data?.type === 'wm:slack_connected') {
            if (!signal.aborted) { saveRuleWithNewChannel('slack'); reloadNotifSection(); }
          } else if (e.data?.type === 'wm:slack_error') {
            const rowEl = container.querySelector<HTMLElement>('[data-channel-type="slack"]');
            if (rowEl) {
              rowEl.querySelector('.us-notif-error')?.remove();
              rowEl.insertAdjacentHTML('beforeend', `<span class="us-notif-error">Slack connection failed: ${escapeHtml(String(e.data.error ?? 'unknown'))}</span>`);
              const btn = rowEl.querySelector<HTMLButtonElement>('#usConnectSlack');
              if (btn) btn.textContent = 'Add to Slack';
            }
          } else if (e.data?.type === 'wm:discord_connected') {
            if (!signal.aborted) { saveRuleWithNewChannel('discord'); reloadNotifSection(); }
          } else if (e.data?.type === 'wm:discord_error') {
            const rowEl = container.querySelector<HTMLElement>('[data-channel-type="discord"]');
            if (rowEl) {
              rowEl.querySelector('.us-notif-error')?.remove();
              rowEl.insertAdjacentHTML('beforeend', `<span class="us-notif-error">Discord connection failed: ${escapeHtml(String(e.data.error ?? 'unknown'))}</span>`);
              const btn = rowEl.querySelector<HTMLButtonElement>('#usConnectDiscord');
              if (btn) btn.textContent = 'Connect Discord';
            }
          }
        };
        window.addEventListener('message', onMessage, { signal });
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
